// ============================================================
// Mycelium — Pushback (engram feedback from ecosystem filtering)
// ============================================================
//
// 3-axis filter:
//   1. Pure survivors (absorbedCount=0, not spawned) = unique knowledge
//   2. Early deaths: redundant (merge + high cosine) OR loner (decay + posRes≈0)
//   3. Mergers (high-w absorbers, depth-1 only) = cluster candidates
//
// This module calls engram gateway HTTP API directly.
// No engram dependency at import time.

import type { MyceliumNode, Species } from "../types.js";
import type { MetabolismSchema } from "../types.js";
import metabolismRaw from "../config/metabolism.json" with { type: "json" };

const M = metabolismRaw as unknown as MetabolismSchema;
const PB = M.pushback;

// ---- Types ----

export interface DeathRecord {
  tick: number;
  cause: string;       // "merge" | "decay" | "prune" | "spawn"
  cosine?: number;     // merge similarity (for redundant detection)
  posRes?: number;     // positive resonance at death (for loner detection)
}

export interface PushbackCandidate {
  engramId: string;
  myceliumId: string;
  species: Species;
  summary: string;
  w: number;
  ttl: number;
}

export interface MergerCluster {
  originEngramId: string;
  species: Species;
  w: number;
  memberEngramIds: string[];   // absorbed nodes' engram IDs
  clusterSize: number;         // total members including origin
  depth1Count: number;         // direct absorptions (» not »»)
  deepChainCount: number;      // chain absorptions (»»+)
}

export interface PushbackResult {
  pureSurvivors: PushbackCandidate[];
  mergerClusters: MergerCluster[];
  flaggedAsRedundant: number;
  flaggedAsLoner: number;
  flagErrors: number;
}

// ---- Analysis ----

/**
 * Extract pure survivors from living nodes.
 * Pure = no absorbed contents (never merged others into it) AND not spawned.
 * These are the nodes that remained unique throughout the simulation.
 */
export function extractPureSurvivors(nodes: MyceliumNode[]): PushbackCandidate[] {
  const results: PushbackCandidate[] = [];

  for (const n of nodes) {
    // Skip spawned nodes (no engram origin)
    if (n.lineage || !n.engramId) continue;

    // Check if pure: no absorbed contents (» prefix)
    const absorbedCount = n.contents.filter(c => c.startsWith("»")).length;
    if (absorbedCount > 0) continue;

    results.push({
      engramId: n.engramId,
      myceliumId: n.id,
      species: n.species,
      summary: n.contents[0]?.slice(0, 150) ?? "",
      w: n.w,
      ttl: n.ttl,
    });
  }

  // Sort by w descending (healthiest = most valuable)
  results.sort((a, b) => b.w - a.w);
  return results;
}

/**
 * Find engram IDs of nodes that died from high-cosine merge in the early phase.
 * These are semantically redundant — near-duplicate data absorbed quickly.
 *
 * Uses tick% (relative to total ticks) instead of absolute tick threshold.
 * Empirical finding: cos ≥ 0.75 + tick% ≤ 40% catches true duplicates
 * without false positives from late-game merges.
 *
 * totalTicks: total simulation length (needed for % calculation)
 * earlyPct: max tick% to be considered "early" (default: 0.4 = 40%)
 * minCosine: minimum merge cosine similarity (default: 0.75)
 */
export function extractRedundantIds(
  allEngramIds: Map<string, string>,  // mycelium ID → engram ID
  deathLog: Map<string, DeathRecord>,
  totalTicks: number,
  earlyPct: number = PB.earlyPct,
  minCosine: number = PB.minCosine,
): string[] {
  const redundant = new Set<string>();
  const tickCutoff = Math.floor(totalTicks * earlyPct);

  for (const [myceliumId, death] of deathLog.entries()) {
    if (death.cause !== "merge" || death.tick > tickCutoff) continue;
    if ((death.cosine ?? 0) < minCosine) continue;
    const engramId = allEngramIds.get(myceliumId);
    if (engramId) redundant.add(engramId);
  }

  return [...redundant];
}

/**
 * Find engram IDs of loner nodes: early death + near-zero positive resonance.
 * These are semantically isolated nodes — no meaningful social interactions.
 *
 * Detection is cause-agnostic: a node dying early with posRes≈0 is isolated
 * regardless of whether it died via decay or low-cosine merge (proximity merge
 * of an isolated node doesn't make it social). Only spawn deaths and
 * high-cosine merges (redundant data, handled by extractRedundantIds) are excluded.
 *
 * Uses tick% (relative to total ticks) — same as extractRedundantIds.
 * posResThreshold: max posRes to be considered a loner (default: 0.05)
 * redundantCosine: merge cosine above this is redundant, not loner (default: 0.75)
 */
export function extractLonerIds(
  allEngramIds: Map<string, string>,
  deathLog: Map<string, DeathRecord>,
  totalTicks: number,
  earlyPct: number = PB.earlyPct,
  posResThreshold: number = PB.posResThreshold,
  redundantCosine: number = PB.redundantCosine,
): string[] {
  const loners = new Set<string>();
  const tickCutoff = Math.floor(totalTicks * earlyPct);

  for (const [myceliumId, death] of deathLog.entries()) {
    // Skip spawn (healthy reproduction, not isolation signal)
    if (death.cause === "spawn") continue;
    // Skip high-cosine merges (redundant data, not loner — handled by extractRedundantIds)
    if (death.cause === "merge" && (death.cosine ?? 0) >= redundantCosine) continue;
    if (death.tick > tickCutoff) continue;
    if ((death.posRes ?? 0) > posResThreshold) continue;
    const engramId = allEngramIds.get(myceliumId);
    if (engramId) loners.add(engramId);
  }

  return [...loners];
}

// ---- Axis 3: Merger clusters ----

/**
 * Extract absorber nodes as cluster candidates.
 * Called at ~clusterPct ticks (60%) — after early-death phase.
 *
 * Filters absorbed contents by merge cosine:
 *   - cos >= clusterMaxCos (0.75): proximity merge duplicate → exclude
 *   - cos < clusterMinCos (0.35): unrelated noise merge → exclude
 *   - valid range: [clusterMinCos, clusterMaxCos) = meaningful topical merge
 *
 * For deep chains (»»+), the LAST cos value is the merge into this node.
 * w is included for display but does NOT gate detection.
 */
export function extractMergerClusters(
  nodes: MyceliumNode[],
): MergerCluster[] {
  const minCos = PB.clusterMinCos ?? 0.35;
  const maxCos = PB.clusterMaxCos ?? 0.75;
  const clusters: MergerCluster[] = [];

  for (const n of nodes) {
    if (!n.engramId) continue;

    const absorbed = n.contents.filter(c => c.startsWith("»"));
    if (absorbed.length === 0) continue;

    // Filter by merge cosine: last pipe-separated float is the merge cos into this node
    let validD1 = 0;
    let validDeep = 0;
    for (const c of absorbed) {
      const lastPipe = c.lastIndexOf("|");
      if (lastPipe < 0) continue;
      const cos = parseFloat(c.slice(lastPipe + 1));
      if (isNaN(cos)) continue;
      if (cos < minCos || cos >= maxCos) continue; // noise or proximity merge
      if (!c.startsWith("»»")) validD1++;
      else validDeep++;
    }

    if (validD1 + validDeep === 0) continue;

    clusters.push({
      originEngramId: n.engramId,
      species: n.species,
      w: n.w,
      memberEngramIds: [],
      clusterSize: 1 + validD1 + validDeep,
      depth1Count: validD1,
      deepChainCount: validDeep,
    });
  }

  clusters.sort((a, b) => b.clusterSize - a.clusterSize);
  return clusters;
}

// ---- Engram Gateway calls ----

const ENGRAM_GATEWAY = process.env.ENGRAM_GATEWAY_URL || "http://localhost:3100";

/**
 * Flag a list of engram nodes with a negative signal.
 * Calls POST /feedback for each.
 */
export async function flagInEngram(
  engramIds: string[],
  signal: string,
  reason: string,
): Promise<{ flagged: number; errors: number }> {
  let flagged = 0;
  let errors = 0;

  for (const entryId of engramIds) {
    try {
      const res = await fetch(`${ENGRAM_GATEWAY}/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entryId, signal, reason }),
      });

      if (res.ok) {
        const data = await res.json() as { status: string };
        if (data.status === "applied") flagged++;
        else errors++;
      } else {
        errors++;
      }
    } catch {
      errors++;
    }
  }

  return { flagged, errors };
}

/**
 * Full pushback pipeline: analyze survivors, flag redundant + loners, return results.
 */
export async function runPushback(
  livingNodes: MyceliumNode[],
  allEngramIds: Map<string, string>,
  deathLog: Map<string, DeathRecord>,
  options: { totalTicks?: number; dryRun?: boolean } = {},
): Promise<PushbackResult> {
  const { totalTicks = 50, dryRun = false } = options;

  // 1. Extract pure survivors
  const pureSurvivors = extractPureSurvivors(livingNodes);

  // 2. Extract merger clusters
  const mergerClusters = extractMergerClusters(livingNodes);

  // 3. Extract redundant + loner engram IDs
  const redundantIds = extractRedundantIds(allEngramIds, deathLog, totalTicks);
  const lonerIds = extractLonerIds(allEngramIds, deathLog, totalTicks);

  // 4. Flag in engram (unless dry run)
  let flaggedAsRedundant = 0;
  let flaggedAsLoner = 0;
  let flagErrors = 0;

  if (!dryRun) {
    if (redundantIds.length > 0) {
      const r = await flagInEngram(redundantIds, "merged", "mycelium: absorbed in early ticks (redundant data)");
      flaggedAsRedundant = r.flagged;
      flagErrors += r.errors;
    }
    if (lonerIds.length > 0) {
      const r = await flagInEngram(lonerIds, "loner", "mycelium: early death with zero resonance (isolated, no semantic neighbors)");
      flaggedAsLoner = r.flagged;
      flagErrors += r.errors;
    }
  } else {
    flaggedAsRedundant = redundantIds.length;
    flaggedAsLoner = lonerIds.length;
  }

  return { pureSurvivors, mergerClusters, flaggedAsRedundant, flaggedAsLoner, flagErrors };
}
