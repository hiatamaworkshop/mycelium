// ============================================================
// Mycelium — Spawn (sexual reproduction)
// ============================================================
//
// Two-parent reproduction: both parents consumed, two children created.
// Personality blended by fitness ratio. Contents split by parent.
// Children inherit parent's vector (no re-embedding needed).

import { randomUUID } from "node:crypto";
import type {
  MyceliumNode,
  Species,
  WeightMatrix,
  Lineage,
  ParentInfo,
} from "../types.js";
import {
  BEHAVIOR_KEYS,
  FEELINGS_DIM,
} from "../types.js";
import { ALL_SPECIES } from "../types.js";
import { getSpeciesConfig, zeroMatrix, zeroResonance } from "./node.js";
import { computeFitness } from "./scoring.js";
import type { MetabolismSchema } from "../types.js";
import metabolismRaw from "../config/metabolism.json" with { type: "json" };

const M = metabolismRaw as unknown as MetabolismSchema;

// ---- Spawn eligibility ----

export function isSpawnEligible(node: MyceliumNode): boolean {
  const sc = M.spawn;

  // Knowledge gate: must have accumulated contents (via merge)
  if (node.contents.length < sc.minContents) return false;

  // Health gate: must be fit enough
  const config = getSpeciesConfig(node.species);
  const fitness = computeFitness(node, config.initialTtl);
  if (fitness < sc.minFitness) return false;

  // Maturity gate: must have accumulated positive social resonance
  // Only count positive resonance — negative resonance is rejection history, not maturity
  const positiveResonance = Object.values(node.resonance).reduce((sum, v) => sum + Math.max(0, v), 0);
  if (positiveResonance < sc.minResonance) return false;

  return true;
}

// ---- Partner compatibility check ----

export function isCompatiblePartner(similarity: number): boolean {
  return similarity >= M.spawn.minPartnerSimilarity;
}

// ---- Blend personality matrices ----

function blendMatrix(
  matA: WeightMatrix,
  deltaA: WeightMatrix,
  matB: WeightMatrix,
  deltaB: WeightMatrix,
  ratioA: number,
): WeightMatrix {
  const rows = BEHAVIOR_KEYS.length;
  const cols = FEELINGS_DIM;
  const result: WeightMatrix = [];

  for (let i = 0; i < rows; i++) {
    const row: number[] = [];
    for (let j = 0; j < cols; j++) {
      const effectiveA = matA[i][j] * (1 + deltaA[i][j]);
      const effectiveB = matB[i][j] * (1 + deltaB[i][j]);
      row.push(ratioA * effectiveA + (1 - ratioA) * effectiveB);
    }
    result.push(row);
  }

  return result;
}

// ---- Damped resonance inheritance ----
// Children get a fraction of parents' combined resonance.
// Too high → spawn cascade (children immediately eligible for next spawn).
// Too low → no social advantage over fresh nodes.

const RESONANCE_INHERIT_RATIO = M.spawn.resonanceInheritRatio;

function inheritResonance(
  a: Record<Species, number>,
  b: Record<Species, number>,
): Record<Species, number> {
  const result = {} as Record<Species, number>;
  for (const sp of ALL_SPECIES) {
    result[sp] = (a[sp] + b[sp]) * RESONANCE_INHERIT_RATIO;
  }
  return result;
}

// ---- Spawn result ----

export interface SpawnChild {
  node: MyceliumNode;
  vector: number[];
}

export interface SpawnResult {
  children: [SpawnChild, SpawnChild];
  consumedIds: [string, string];
}

// ---- Execute spawn ----

export function executeSpawn(
  parentA: MyceliumNode,
  vectorA: number[],
  parentB: MyceliumNode,
  vectorB: number[],
): SpawnResult {
  const configA = getSpeciesConfig(parentA.species);
  const configB = getSpeciesConfig(parentB.species);

  const fitnessA = computeFitness(parentA, configA.initialTtl);
  const fitnessB = computeFitness(parentB, configB.initialTtl);
  const totalFitness = fitnessA + fitnessB;
  const ratioA = totalFitness > 0 ? fitnessA / totalFitness : 0.5;

  // Species inheritance: probabilistic by fitness ratio (each child rolls independently)
  const pickSpecies = (): Species =>
    Math.random() < ratioA ? parentA.species : parentB.species;
  const speciesChildA = pickSpecies();
  const speciesChildB = pickSpecies();
  const configChildA = getSpeciesConfig(speciesChildA);
  const configChildB = getSpeciesConfig(speciesChildB);

  // Blend personality (effective = base × (1 + delta))
  const blendMode = M.spawn.blendMode;

  // "same"  → both children get identical blend (ratioA)
  // "cross" → child A gets parentB-dominant, child B gets parentA-dominant (genetic crossover)
  const personalityForChildA = blendMatrix(
    parentA.personality, parentA.learnedDelta,
    parentB.personality, parentB.learnedDelta,
    blendMode === "cross" ? (1 - ratioA) : ratioA,
  );
  const personalityForChildB = blendMode === "cross"
    ? blendMatrix(
        parentA.personality, parentA.learnedDelta,
        parentB.personality, parentB.learnedDelta,
        ratioA,
      )
    : personalityForChildA;

  // Generation = max of parents + 1
  const genA = parentA.lineage?.generation ?? 0;
  const genB = parentB.lineage?.generation ?? 0;
  const generation = Math.max(genA, genB) + 1;

  const parentInfoA: ParentInfo = { id: parentA.id, species: parentA.species, fitness: fitnessA };
  const parentInfoB: ParentInfo = { id: parentB.id, species: parentB.species, fitness: fitnessB };
  const lineage: Lineage = { parentA: parentInfoA, parentB: parentInfoB, generation };

  const now = Date.now();

  // Inherit social history: midpoint of parents' resonance
  const inheritedResonance = inheritResonance(parentA.resonance, parentB.resonance);

  // Blend resonance sensitivity delta from parents (fitness-weighted)
  const blendResonanceDelta = (rA: number): Record<Species, number> => {
    const out = zeroResonance();
    for (const sp of ALL_SPECIES) {
      out[sp] = rA * (parentA.learnedResonanceDelta[sp] ?? 0)
              + (1 - rA) * (parentB.learnedResonanceDelta[sp] ?? 0);
    }
    return out;
  };
  const resDeltaChildA = blendResonanceDelta(blendMode === "cross" ? (1 - ratioA) : ratioA);
  const resDeltaChildB = blendMode === "cross" ? blendResonanceDelta(ratioA) : { ...resDeltaChildA };

  // Child A: inherits parent A's contents + vector + engramId
  const childA: MyceliumNode = {
    id: randomUUID(),
    species: speciesChildA,
    contents: [...parentA.contents],
    h: M.birth.initialH,
    w: M.birth.initialW,
    d: configChildA.initialDecay,
    ttl: Math.max(parentA.ttl, Math.floor(configChildA.initialTtl * M.spawn.childTtlRatio)),
    resonance: { ...inheritedResonance },
    personality: personalityForChildA,
    learnedDelta: zeroMatrix(BEHAVIOR_KEYS.length, FEELINGS_DIM),
    learnedResonanceDelta: resDeltaChildA,
    engramId: parentA.engramId,
    lineage,
    createdAt: now,
    lastActiveAt: now,
  };

  // Child B: inherits parent B's contents + vector + engramId
  const childB: MyceliumNode = {
    id: randomUUID(),
    species: speciesChildB,
    contents: [...parentB.contents],
    h: M.birth.initialH,
    w: M.birth.initialW,
    d: configChildB.initialDecay,
    ttl: Math.max(parentB.ttl, Math.floor(configChildB.initialTtl * M.spawn.childTtlRatio)),
    resonance: { ...inheritedResonance },
    personality: personalityForChildB,
    learnedDelta: zeroMatrix(BEHAVIOR_KEYS.length, FEELINGS_DIM),
    learnedResonanceDelta: resDeltaChildB,
    engramId: parentB.engramId,
    lineage,
    createdAt: now,
    lastActiveAt: now,
  };

  return {
    children: [
      { node: childA, vector: vectorA },
      { node: childB, vector: vectorB },
    ],
    consumedIds: [parentA.id, parentB.id],
  };
}
