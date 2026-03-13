// ============================================================
// Mycelium — Pushback (ecosystem feedback from filtering)
// ============================================================
//
// 3-axis filter:
//   1. Pure survivors (absorbedCount=0, not spawned) = unique knowledge
//   2. Early deaths: redundant (merge + high cosine) OR loner (decay + posRes≈0)
//   3. Mergers (high-w absorbers, depth-1 only) = cluster candidates

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
  nodeId: string;
  species: Species;
  summary: string;
  w: number;
  ttl: number;
}

export interface MergerCluster {
  originId: string;
  species: Species;
  w: number;
  memberIds: string[];
  clusterSize: number;         // total members including origin
  depth1Count: number;         // direct absorptions (» not »»)
  deepChainCount: number;      // chain absorptions (»»+)
  /** Species composition of absorbed members (excludes origin) */
  composition?: Partial<Record<Species, number>>;
}

export interface PushbackResult {
  pureSurvivors: PushbackCandidate[];
  mergerClusters: MergerCluster[];
  redundantCount: number;
  lonerCount: number;
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
    // Skip spawned nodes (no original source)
    if (n.lineage) continue;

    // Check if pure: no absorbed contents (» prefix)
    const absorbedCount = n.contents.filter(c => c.startsWith("»")).length;
    if (absorbedCount > 0) continue;

    results.push({
      nodeId: n.id,
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
 * Find IDs of nodes that died from high-cosine merge in the early phase.
 * These are semantically redundant — near-duplicate data absorbed quickly.
 *
 * Uses tick% (relative to total ticks) instead of absolute tick threshold.
 * Empirical finding: cos ≥ 0.75 + tick% ≤ 40% catches true duplicates
 * without false positives from late-game merges.
 */
export function extractRedundantIds(
  deathLog: Map<string, DeathRecord>,
  totalTicks: number,
  earlyPct: number = PB.earlyPct,
  minCosine: number = PB.minCosine,
): string[] {
  const redundant = new Set<string>();
  const tickCutoff = Math.floor(totalTicks * earlyPct);

  for (const [nodeId, death] of deathLog.entries()) {
    if (death.cause !== "merge" || death.tick > tickCutoff) continue;
    if ((death.cosine ?? 0) < minCosine) continue;
    redundant.add(nodeId);
  }

  return [...redundant];
}

/**
 * Find IDs of loner nodes: death before lonerPct + near-zero positive resonance.
 * These are semantically isolated nodes — no meaningful social interactions.
 * Uses lonerPct (default 0.6) instead of earlyPct (0.4) because resonance
 * metrics need time to accumulate — nodes dying at tick 25-36 with posRes≈0
 * are genuine loners that lacked initial metric support.
 */
export function extractLonerIds(
  deathLog: Map<string, DeathRecord>,
  totalTicks: number,
  lonerPct: number = PB.lonerPct ?? PB.earlyPct,
  posResThreshold: number = PB.posResThreshold,
  redundantCosine: number = PB.redundantCosine,
): string[] {
  const loners = new Set<string>();
  const tickCutoff = Math.floor(totalTicks * lonerPct);

  for (const [nodeId, death] of deathLog.entries()) {
    if (death.cause === "spawn") continue;
    if (death.cause === "merge" && (death.cosine ?? 0) >= redundantCosine) continue;
    if (death.tick > tickCutoff) continue;
    if ((death.posRes ?? 0) > posResThreshold) continue;
    loners.add(nodeId);
  }

  return [...loners];
}

// ---- Axis 3: Merger clusters ----

/**
 * Extract absorber nodes as cluster candidates.
 * Called at ~clusterPct ticks (60%) — after early-death phase.
 */
/** Reverse map: single-char tag → Species (mirrors receptor.ts SPECIES_SHORT) */
const SHORT_TO_SPECIES: Record<string, Species> = {
  s: "summarizer", t: "sentinel", h: "herald", a: "anchor", p: "spore",
};

/** Extract species tag from absorbed content: »[h]content|0.91 → "h" */
function parseSpeciesTag(entry: string): Species | undefined {
  // Strip leading » characters
  const stripped = entry.replace(/^»+/, "");
  // Check for [x] pattern
  if (stripped.length >= 3 && stripped[0] === "[" && stripped[2] === "]") {
    return SHORT_TO_SPECIES[stripped[1]];
  }
  return undefined; // legacy format without species tag
}

export function extractMergerClusters(
  nodes: MyceliumNode[],
): MergerCluster[] {
  const minCos = PB.clusterMinCos ?? 0.35;
  const maxCos = PB.clusterMaxCos ?? 0.75;
  const clusters: MergerCluster[] = [];

  for (const n of nodes) {
    const absorbed = n.contents.filter(c => c.startsWith("»"));
    if (absorbed.length === 0) continue;

    let validD1 = 0;
    let validDeep = 0;
    const comp: Partial<Record<Species, number>> = {};
    for (const c of absorbed) {
      const lastPipe = c.lastIndexOf("|");
      if (lastPipe < 0) continue;
      const cos = parseFloat(c.slice(lastPipe + 1));
      if (isNaN(cos)) continue;
      if (cos < minCos || cos >= maxCos) continue;
      if (!c.startsWith("»»")) validD1++;
      else validDeep++;
      // Accumulate species composition
      const sp = parseSpeciesTag(c);
      if (sp) comp[sp] = (comp[sp] ?? 0) + 1;
    }

    if (validD1 + validDeep === 0) continue;

    clusters.push({
      originId: n.id,
      species: n.species,
      w: n.w,
      memberIds: [],
      clusterSize: 1 + validD1 + validDeep,
      depth1Count: validD1,
      deepChainCount: validDeep,
      composition: Object.keys(comp).length > 0 ? comp : undefined,
    });
  }

  clusters.sort((a, b) => b.clusterSize - a.clusterSize);
  return clusters;
}

/**
 * Full pushback pipeline: analyze survivors, detect redundant + loners, return results.
 */
export function runPushback(
  livingNodes: MyceliumNode[],
  deathLog: Map<string, DeathRecord>,
  options: { totalTicks?: number } = {},
): PushbackResult {
  const { totalTicks = 50 } = options;

  const pureSurvivors = extractPureSurvivors(livingNodes);
  const mergerClusters = extractMergerClusters(livingNodes);
  const redundantIds = extractRedundantIds(deathLog, totalTicks);
  const lonerIds = extractLonerIds(deathLog, totalTicks);

  return {
    pureSurvivors,
    mergerClusters,
    redundantCount: redundantIds.length,
    lonerCount: lonerIds.length,
  };
}
