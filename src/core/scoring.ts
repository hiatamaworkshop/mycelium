// ============================================================
// Mycelium — Scoring system (Phase 2)
// ============================================================
//
// Digestor-inspired neutral fitness evaluation.
// No species bias in scoring — species differences emerge from behavior, not evaluation.

import type { MyceliumNode, Species, MetabolismSchema } from "../types.js";
import metabolismRaw from "../config/metabolism.json" with { type: "json" };

const M = metabolismRaw as unknown as MetabolismSchema;

// ---- Fitness (computed on demand, never stored) ----

export function computeFitness(node: MyceliumNode, initialTtl: number): number {
  const sc = M.scoring;
  const ttlRatio = initialTtl > 0 ? node.ttl / initialTtl : 0;

  // balanced quality value — equal-weight across dimensions
  const bqv = sc.dimensions.wWeight * Math.min(node.w, 1)
    + sc.dimensions.hWeight * node.h
    + sc.dimensions.ttlWeight * ttlRatio;

  // time decay — freshness bonus
  const ageHours = (Date.now() - node.createdAt) / 3_600_000;
  const timeDecay = Math.exp(-ageHours / sc.halfLifeHours);

  return bqv * timeDecay;
}

// ---- Hunger-based pruning threshold ----

export function hungerThreshold(populationSize: number): number {
  const { low, mid } = M.scoring.hungerThresholds;
  const floor = M.scoring.hungerFloor;
  const ceil = M.scoring.hungerCeil;

  if (populationSize < low) return floor;
  if (populationSize > mid) return ceil;

  // linear ramp between low and mid
  const t = (populationSize - low) / (mid - low);
  return floor + t * (ceil - floor);
}

export function shouldPrune(
  node: MyceliumNode,
  initialTtl: number,
  populationSize: number,
  speciesCount: Record<Species, number>,
): boolean {
  const fitness = computeFitness(node, initialTtl);
  const threshold = hungerThreshold(populationSize);

  // species protection — don't prune below minimum
  const count = speciesCount[node.species] ?? 0;
  if (count <= M.scoring.speciesProtection) return false;

  return fitness < threshold;
}

// ---- Per-species profile snapshot ----

export interface SpeciesProfile {
  species: Species;
  avgW: number;
  avgH: number;
  avgTtlRatio: number;
  avgFitness: number;
  count: number;
}

export function computeSpeciesProfiles(
  nodes: MyceliumNode[],
  initialTtls: Record<Species, number>,
): SpeciesProfile[] {
  const buckets: Record<string, { sumW: number; sumH: number; sumTtlR: number; sumFit: number; count: number }> = {};

  for (const node of nodes) {
    if (!buckets[node.species]) {
      buckets[node.species] = { sumW: 0, sumH: 0, sumTtlR: 0, sumFit: 0, count: 0 };
    }
    const b = buckets[node.species];
    const initTtl = initialTtls[node.species] ?? 100;
    b.sumW += node.w;
    b.sumH += node.h;
    b.sumTtlR += initTtl > 0 ? node.ttl / initTtl : 0;
    b.sumFit += computeFitness(node, initTtl);
    b.count++;
  }

  return Object.entries(buckets).map(([species, b]) => ({
    species: species as Species,
    avgW: b.count > 0 ? b.sumW / b.count : 0,
    avgH: b.count > 0 ? b.sumH / b.count : 0,
    avgTtlRatio: b.count > 0 ? b.sumTtlR / b.count : 0,
    avgFitness: b.count > 0 ? b.sumFit / b.count : 0,
    count: b.count,
  }));
}
