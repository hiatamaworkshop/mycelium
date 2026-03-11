// ============================================================
// Mycelium — Observatory (ecosystem snapshot collector)
// ============================================================
//
// Loosely coupled observation layer. tick.ts calls collect() at
// configurable intervals. All analysis happens externally.
//
// Design principles:
//   - collect() is the ONLY entry point from tick.ts
//   - No analysis, no judgment, no side effects
//   - Ring buffer with configurable size
//   - minPopulation gate: low-pop snapshots are noise

import type { Species, MyceliumNode } from "../types.js";
import { ALL_SPECIES } from "../types.js";
import type { MetabolismSchema } from "../types.js";
import metabolismRaw from "../config/metabolism.json" with { type: "json" };

const M = metabolismRaw as unknown as MetabolismSchema;
const OBS = M.observatory;

// ---- Snapshot types ----

export interface NodeSummary {
  id: string;
  species: Species;
  w: number;
  h: number;
  d: number;
  ttl: number;
  contentsCount: number;
  originalCount: number;   // contents without » prefix (depth 0)
  absorbedCount: number;   // contents with » prefix (merged in)
  maxMergeDepth: number;   // deepest » nesting
  resonance: Record<Species, number>;
}

export interface EcosystemSnapshot {
  tick: number;
  timestamp: number;
  population: number;
  nodes: NodeSummary[];
  speciesCounts: Record<Species, number>;
  actionSummary: Record<string, number>;
  mergeCount: number;
  spawnCount: number;
}

// ---- Ring buffer ----

const buffer: EcosystemSnapshot[] = [];
const maxSize: number = OBS.bufferSize;

// ---- Public API ----

export function shouldCollect(tickNumber: number): boolean {
  if (!OBS.enabled) return false;
  return tickNumber > 0 && tickNumber % OBS.intervalTicks === 0;
}

export function collect(
  tickNumber: number,
  nodes: MyceliumNode[],
  actionSummary: Record<string, number>,
  mergeCount: number,
  spawnCount: number,
): EcosystemSnapshot | null {
  // Gate: skip low-population snapshots
  if (nodes.length < OBS.minPopulation) return null;

  const speciesCounts = {} as Record<Species, number>;
  for (const sp of ALL_SPECIES) speciesCounts[sp] = 0;

  const nodeSummaries: NodeSummary[] = nodes.map(n => {
    speciesCounts[n.species]++;

    // Count merge depth from » prefixes
    let originalCount = 0;
    let absorbedCount = 0;
    let maxMergeDepth = 0;
    for (const c of n.contents) {
      let depth = 0;
      while (depth < c.length && c[depth] === "»") depth++;
      if (depth === 0) originalCount++;
      else absorbedCount++;
      if (depth > maxMergeDepth) maxMergeDepth = depth;
    }

    return {
      id: n.id,
      species: n.species,
      w: n.w,
      h: n.h,
      d: n.d,
      ttl: n.ttl,
      contentsCount: n.contents.length,
      originalCount,
      absorbedCount,
      maxMergeDepth,
      resonance: { ...n.resonance },
    };
  });

  const snapshot: EcosystemSnapshot = {
    tick: tickNumber,
    timestamp: Date.now(),
    population: nodes.length,
    nodes: nodeSummaries,
    speciesCounts,
    actionSummary: { ...actionSummary },
    mergeCount,
    spawnCount,
  };

  // Ring buffer: push, evict oldest if full
  if (buffer.length >= maxSize) buffer.shift();
  buffer.push(snapshot);

  return snapshot;
}

export function getSnapshots(): EcosystemSnapshot[] {
  return [...buffer];
}

export function getLatestSnapshot(): EcosystemSnapshot | null {
  return buffer.length > 0 ? buffer[buffer.length - 1] : null;
}

export function getSnapshotCount(): number {
  return buffer.length;
}

export function clearSnapshots(): void {
  buffer.length = 0;
}

// ============================================================
// Analysis utilities (pure functions, no side effects)
// ============================================================
// Used by test scripts and MCP tools to analyze ecosystem state.
// These do NOT depend on the ring buffer above.

import type { DeathRecord } from "./pushback.js";
import { extractRedundantIds, extractLonerIds, extractPureSurvivors, extractMergerClusters } from "./pushback.js";

// ---- Resonance summary per species ----

export interface SpeciesResonanceSummary {
  species: Species;
  count: number;
  avgPosRes: number;
  avgCentrality: number;
  nodes: Array<{ id: string; posRes: number; centrality: number; w: number; ttl: number }>;
}

interface NodeWithVector {
  node: MyceliumNode;
  vector: number[] | null;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

/**
 * Compute per-species resonance and centrality summary for living nodes.
 */
export function computeResonanceSummary(allNodes: NodeWithVector[]): SpeciesResonanceSummary[] {
  const buckets: Record<string, SpeciesResonanceSummary> = {};

  for (const nv of allNodes) {
    const s = nv.node.species;
    if (!buckets[s]) buckets[s] = { species: s, count: 0, avgPosRes: 0, avgCentrality: 0, nodes: [] };

    const posRes = ALL_SPECIES.reduce((sum, sp) => sum + Math.max(0, nv.node.resonance[sp]), 0);

    let centrSum = 0, centrN = 0;
    if (nv.vector) {
      for (const other of allNodes) {
        if (other.node.id === nv.node.id || !other.vector) continue;
        centrSum += cosine(nv.vector, other.vector!);
        centrN++;
      }
    }
    const centrality = centrN > 0 ? centrSum / centrN : 0;

    buckets[s].count++;
    buckets[s].avgPosRes += posRes;
    buckets[s].avgCentrality += centrality;
    buckets[s].nodes.push({ id: nv.node.id.substring(0, 6), posRes, centrality, w: nv.node.w, ttl: nv.node.ttl });
  }

  for (const b of Object.values(buckets)) {
    if (b.count > 0) {
      b.avgPosRes /= b.count;
      b.avgCentrality /= b.count;
    }
    b.nodes.sort((a, c) => c.posRes - a.posRes);
  }

  return Object.values(buckets).sort((a, b) => b.avgPosRes - a.avgPosRes);
}

// ---- Death histogram (bucket distribution) ----

export interface DeathHistogram {
  bucketSize: number;
  buckets: Array<{ tickStart: number; tickEnd: number; merge: number; spawn: number; decay: number }>;
  maxPerBucket: number;
}

/**
 * Compute death timing distribution in fixed-size tick buckets.
 */
export function computeDeathHistogram(
  deathLog: Map<string, DeathRecord>,
  totalTicks: number,
  bucketSize = 5,
): DeathHistogram {
  const maxBucket = Math.ceil(totalTicks / bucketSize);
  const merge = new Array(maxBucket).fill(0);
  const spawn = new Array(maxBucket).fill(0);
  const decay = new Array(maxBucket).fill(0);

  for (const d of deathLog.values()) {
    const bi = Math.min(Math.floor((d.tick - 1) / bucketSize), maxBucket - 1);
    if (d.cause === "merge") merge[bi]++;
    else if (d.cause === "spawn") spawn[bi]++;
    else if (d.cause === "decay") decay[bi]++;
  }

  const maxPerBucket = Math.max(...merge, ...spawn, ...decay, 1);
  const buckets = [];
  for (let i = 0; i < maxBucket; i++) {
    if (merge[i] + spawn[i] + decay[i] === 0) continue;
    buckets.push({
      tickStart: i * bucketSize + 1,
      tickEnd: (i + 1) * bucketSize,
      merge: merge[i],
      spawn: spawn[i],
      decay: decay[i],
    });
  }

  return { bucketSize, buckets, maxPerBucket };
}

// ---- Death cause summary ----

export interface DeathSummary {
  total: number;
  merge: number;
  decay: number;
  spawn: number;
}

export function summarizeDeaths(deathLog: Map<string, DeathRecord>): DeathSummary {
  let merge = 0, decay = 0, spawn = 0;
  for (const d of deathLog.values()) {
    if (d.cause === "merge") merge++;
    else if (d.cause === "spawn") spawn++;
    else if (d.cause === "decay") decay++;
  }
  return { total: deathLog.size, merge, decay, spawn };
}

// ---- Cross-scenario voting ----

export interface VoteResult {
  confirmed: Array<{ id: string; count: number }>;
  borderline: Array<{ id: string; count: number }>;
  total: number;
}

/**
 * Cross-scenario voting: count how many scenarios flagged each engram ID.
 * IDs appearing in >= threshold scenarios are "confirmed".
 */
export function crossVote(
  scenarioIdLists: string[][],
  threshold: number,
): VoteResult {
  const counts = new Map<string, number>();
  for (const ids of scenarioIdLists) {
    for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
  }

  const confirmed: Array<{ id: string; count: number }> = [];
  const borderline: Array<{ id: string; count: number }> = [];

  for (const [id, count] of counts.entries()) {
    if (count >= threshold) confirmed.push({ id, count });
    else borderline.push({ id, count });
  }

  confirmed.sort((a, b) => b.count - a.count);
  borderline.sort((a, b) => b.count - a.count);

  return { confirmed, borderline, total: counts.size };
}

// ---- Pushback snapshot (combines all axes at a point in time) ----

export interface PushbackSnapshot {
  redundant: number;
  loner: number;
  pure: number;
  merger: number;
  deaths: DeathSummary;
}

/**
 * Compute a pushback snapshot for current state.
 * Wraps pushback module functions into a single call.
 */
export function computePushbackSnapshot(
  engramIdMap: Map<string, string>,
  deathLog: Map<string, DeathRecord>,
  totalTicks: number,
  livingNodes: MyceliumNode[],
): PushbackSnapshot {
  const redundant = extractRedundantIds(engramIdMap, deathLog, totalTicks).length;
  const loner = extractLonerIds(engramIdMap, deathLog, totalTicks).length;
  const pure = extractPureSurvivors(livingNodes).length;
  const merger = extractMergerClusters(livingNodes).length;
  return { redundant, loner, pure, merger, deaths: summarizeDeaths(deathLog) };
}
