// ============================================================
// Mycelium — Tick core (pure computation, no I/O)
// ============================================================
//
// Single-tick ecosystem simulation as a pure function.
// Takes an array of nodes+vectors and metabolism config,
// returns survivors, deaths, merge events, and spawn results.
//
// No imports from qdrant.ts, digestor.ts, or observatory.ts.
// Callers (tick.ts, semantic-filter-test, loader) provide
// callbacks for side-effects like digestor recording.

import type { MyceliumNode, Environment, Action, Feelings, Species } from "../types.js";
import type { MetabolismSchema } from "../types.js";
import { ACTIONS, REACTIONS, ALL_SPECIES } from "../types.js";
import { computeFeelings, assessAction, assessActionWithProbs, updateFrustration, getSpeciesConfig, clamp01, computeReflection } from "./node.js";
import { emitSignal, react, resolveInteraction } from "./receptor.js";
import { isSpawnEligible, isCompatiblePartner, executeSpawn } from "./spawn.js";
import type { DeathRecord } from "./pushback.js";

// ---- Types ----

export interface NodeWithVector {
  node: MyceliumNode;
  vector: number[] | null;
}

export interface MergeEvent {
  absorbedId: string;
  absorberId: string;
  cosine: number;
}

export interface SpawnResult {
  consumedIds: [string, string];
  children: Array<{ node: MyceliumNode; vector: number[] }>;
}

/** Callbacks for optional side-effects during tick computation. */
export interface TickCoreCallbacks {
  /** Called for each action/reaction to accumulate digestor data. */
  recordAction?: (species: Species, behaviorIdx: number, feelings: Feelings) => void;
}

/** Full result of a single tick computation. */
export interface TickCoreResult {
  survivors: NodeWithVector[];
  deaths: Map<string, DeathRecord>;
  mergeEvents: MergeEvent[];
  spawns: SpawnResult[];
  actionCounts: Record<string, number>;
  interactionCount: number;
  mergeCount: number;
  spawnCount: number;
}

// ---- Cosine similarity (vectors are pre-normalized) ----

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

// ---- Compute Environment for a node ----

export function computeEnvironment(
  self: NodeWithVector,
  allNodes: NodeWithVector[],
  M: MetabolismSchema,
): Environment {
  const env: Environment = {
    neighborField: { h: 0, w: 0, d: 0 },
    kinCount: 0,
    neighborSpecies: { summarizer: 0, sentinel: 0, herald: 0, anchor: 0, spore: 0 },
  };

  if (!self.vector) return env;

  const neighbors = allNodes
    .filter(n => n.node.id !== self.node.id && n.vector)
    .map(n => ({
      score: cosine(self.vector!, n.vector!),
      node: n.node,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, M.social.neighborLimit);

  if (neighbors.length === 0) return env;

  let sumH = 0, sumW = 0, sumD = 0;
  for (const n of neighbors) {
    sumH += n.node.h;
    sumW += n.node.w;
    sumD += n.node.d;
    env.neighborSpecies[n.node.species]++;
    if (n.node.species === self.node.species) env.kinCount++;
  }

  env.neighborField.h = sumH / neighbors.length;
  env.neighborField.w = sumW / neighbors.length;
  env.neighborField.d = sumD / neighbors.length;

  return env;
}

// ---- Select interaction target (probabilistic from top-K neighbors) ----

export function selectTarget(
  self: NodeWithVector,
  allNodes: NodeWithVector[],
  M: MetabolismSchema,
  reach?: number,
  action?: string,
  toDelete?: Set<string>,
): { target: NodeWithVector; similarity: number; proximityMerge: boolean } | null {
  if (!self.vector) return null;

  const limit = reach ?? M.social.neighborLimit;
  const bias = getSpeciesConfig(self.node.species).selectionBias;
  const affinity = action ? (M.social.targetAffinity?.[action] ?? 0) : 0;
  const mergeMinSim = action === "merge" ? (M.merge.minSimilarity ?? 0.5) : 0;
  const candidates = allNodes
    .filter(n => n.node.id !== self.node.id && n.vector && (!toDelete || !toDelete.has(n.node.id)))
    .map(n => {
      const sim = cosine(self.vector!, n.vector!);
      const b = bias?.[n.node.species] ?? 1.0;
      const stateBonus = affinity !== 0 ? (1 + affinity * n.node.w) : 1;
      const mergeBias = action === "merge" ? (getSpeciesConfig(n.node.species).mergeTargetBias ?? 1.0) : 1;
      return { nv: n, score: sim * b * stateBonus * mergeBias, similarity: sim };
    })
    .filter(c => c.similarity >= mergeMinSim)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  if (candidates.length === 0) return null;

  // Softmax selection over similarity scores (uses decision temperature)
  const temp = M.decision?.temperature ?? 1.0;
  const maxScore = candidates[0].score;
  const exps = candidates.map(c => Math.exp((c.score - maxScore) / temp));
  const sumExp = exps.reduce((a, b) => a + b, 0);

  const rand = Math.random();
  let cumulative = 0;
  let selected: typeof candidates[0] | undefined;
  for (let i = 0; i < candidates.length; i++) {
    cumulative += exps[i] / sumExp;
    if (rand < cumulative) {
      selected = candidates[i];
      break;
    }
  }
  if (!selected) selected = candidates[candidates.length - 1];

  // Proximity merge: if action is not already merge, target is close enough,
  // and target species allows merge (mergeTargetBias > 0), flag for merge override
  const proxThreshold = M.merge.proximityThreshold;
  const targetMergeBias = getSpeciesConfig(selected.nv.node.species).mergeTargetBias ?? 1.0;
  const proximityMerge = action !== "merge"
    && selected.similarity >= proxThreshold
    && targetMergeBias > 0;

  return { target: selected.nv, similarity: selected.similarity, proximityMerge };
}

// ---- Single tick computation (pure function) ----

export function tickCore(
  allNodes: NodeWithVector[],
  M: MetabolismSchema,
  tickNumber: number,
  callbacks?: TickCoreCallbacks,
): TickCoreResult {
  const toDelete = new Set<string>();
  const actionCounts: Record<string, number> = {};
  let interactionCount = 0;
  let mergeCount = 0;
  const mergeEvents: MergeEvent[] = [];
  const deaths = new Map<string, DeathRecord>();
  const recordActionCb = callbacks?.recordAction;

  // GAP-5 fix: capture pre-tick posRes BEFORE resonance decay and interactions
  const preTickPosRes = new Map<string, number>();
  for (const nv of allNodes) {
    const posRes = ALL_SPECIES.reduce((s, sp) => s + Math.max(0, nv.node.resonance[sp]), 0);
    preTickPosRes.set(nv.node.id, posRes);
  }

  // Helper: record death with pre-tick posRes
  function recordDeath(nodeId: string, cause: string, cos?: number): void {
    deaths.set(nodeId, {
      tick: tickNumber,
      cause,
      cosine: cos,
      posRes: preTickPosRes.get(nodeId) ?? 0,
    });
  }

  // 1. Decay resonance (carry-over across ticks, not reset)
  const resonanceDecay = M.social.resonanceDecay;
  for (const nv of allNodes) {
    for (const sp of ALL_SPECIES) {
      nv.node.resonance[sp] *= resonanceDecay;
    }
  }

  // Frustration config
  const frust = M.frustration;
  // Self-reflection config
  const refl = M.selfReflection;

  // 2. Main loop: each node acts
  for (const nv of allNodes) {
    if (toDelete.has(nv.node.id)) continue;

    const env = computeEnvironment(nv, allNodes, M);
    const baseFeelings = computeFeelings(nv.node, env);

    // Frustration blend
    let feelings = baseFeelings;
    if (frust.enabled && nv.node.frustration) {
      const b = frust.blend;
      feelings = {
        vigor:   clamp01(feelings.vigor   + b * nv.node.frustration.vigor),
        dread:   clamp01(feelings.dread   + b * nv.node.frustration.dread),
        kinship: clamp01(feelings.kinship + b * nv.node.frustration.kinship),
        hunger:  clamp01(feelings.hunger  + b * nv.node.frustration.hunger),
      };
    }

    // Self-reflection blend
    if (refl.enabled && nv.node.selfReflection) {
      const rb = refl.blend;
      feelings = {
        vigor:   clamp01(feelings.vigor   + rb * nv.node.selfReflection.vigor),
        dread:   clamp01(feelings.dread   + rb * nv.node.selfReflection.dread),
        kinship: clamp01(feelings.kinship + rb * nv.node.selfReflection.kinship),
        hunger:  clamp01(feelings.hunger  + rb * nv.node.selfReflection.hunger),
      };
    }

    // Action selection
    let action: Action;
    let actionProbs: number[] | null = null;
    if (frust.enabled) {
      const res = assessActionWithProbs(feelings, nv.node.personality, nv.node.learnedDelta);
      action = res.action;
      actionProbs = res.probs;
    } else {
      action = assessAction(feelings, nv.node.personality, nv.node.learnedDelta);
    }

    actionCounts[action] = (actionCounts[action] ?? 0) + 1;

    // Digestor callback
    if (recordActionCb) {
      recordActionCb(nv.node.species, ACTIONS.indexOf(action), feelings);
    }

    // Frustration update
    if (frust.enabled && actionProbs) {
      const chosenIdx = ACTIONS.indexOf(action);
      nv.node.frustration = updateFrustration(
        nv.node.personality, actionProbs, chosenIdx,
        nv.node.frustration, frust.decay, frust.accum,
      );
    }

    // Self-directed actions
    if (action === "survive") {
      nv.node.h = Math.min(1, nv.node.h + M.relief.surviveHRecovery);
      nv.node.w += M.relief.surviveWRecovery;
      nv.node.w -= M.relief.surviveWCost;
      nv.node.ttl += M.relief.surviveTtlRecovery;
      nv.node.d *= M.relief.surviveDecayReduction;
      if (refl.enabled && nv.node.selfReflection) {
        nv.node.selfReflection = {
          vigor:   refl.decay * nv.node.selfReflection.vigor,
          dread:   refl.decay * nv.node.selfReflection.dread,
          kinship: refl.decay * nv.node.selfReflection.kinship,
          hunger:  refl.decay * nv.node.selfReflection.hunger,
        };
      }
      continue;
    }

    // Social actions — intensity = current h, costs energy
    const intensity = nv.node.h;
    const baseCost = M.energy.baseCost[action] ?? 0.1;
    nv.node.h = Math.max(0, nv.node.h - intensity * baseCost);

    // Target selection
    const signalReach = action === "signal"
      ? M.social.neighborLimit + Math.floor(intensity * M.social.signalExtraReach)
      : undefined;
    const match = selectTarget(nv, allNodes, M, signalReach, action, toDelete);
    if (!match) {
      // No target — fallback to survive
      nv.node.h = Math.min(1, nv.node.h + intensity * baseCost);
      nv.node.h = Math.min(1, nv.node.h + M.relief.surviveHRecovery);
      nv.node.w += M.relief.surviveWRecovery;
      nv.node.w -= M.relief.surviveWCost;
      nv.node.ttl += M.relief.surviveTtlRecovery;
      nv.node.d *= M.relief.surviveDecayReduction;
      continue;
    }

    // Proximity merge override
    if (match.proximityMerge) {
      const origAction = action;
      action = "merge";
      actionCounts[origAction]--;
      actionCounts["merge"] = (actionCounts["merge"] ?? 0) + 1;
    }

    // Active receptor: emit signal
    const signal = emitSignal(nv.node, action, feelings, intensity);

    // Passive receptor: target reacts
    const tone = nv.node.w;
    const tonedFeelings: typeof feelings = {
      vigor:   signal.feelings.vigor * tone,
      hunger:  signal.feelings.hunger * tone,
      dread:   signal.feelings.dread * tone,
      kinship: signal.feelings.kinship * tone,
    };
    const targetEnv = computeEnvironment(match.target, allNodes, M);
    const mergeCtx = action === "merge" ? { similarity: match.similarity } : undefined;
    const reaction = react(match.target.node, targetEnv, tonedFeelings, mergeCtx);

    // Record target reaction for digestor
    const targetFeelings = computeFeelings(match.target.node, targetEnv);
    if (recordActionCb) {
      recordActionCb(match.target.node.species, ACTIONS.length + REACTIONS.indexOf(reaction), targetFeelings);
    }

    // Resolve interaction
    const result = resolveInteraction(nv.node, match.target.node, signal, reaction, intensity, match.similarity);
    interactionCount++;
    if (result.merged) mergeCount++;

    // Self-reflection
    if (refl.enabled && result.initiatorAlive) {
      const initiatorConfig = getSpeciesConfig(nv.node.species);
      nv.node.selfReflection = computeReflection(
        feelings,
        targetFeelings,
        initiatorConfig.receptivity ?? 0,
        nv.node.selfReflection,
        refl.decay,
      );
    }

    // GAP-3 fix: record deaths with proper cause and cosine for BOTH sides
    if (!result.initiatorAlive) {
      recordDeath(nv.node.id, result.merged ? "merge" : "interaction", match.similarity);
      toDelete.add(nv.node.id);
      if (result.merged) {
        mergeEvents.push({ absorbedId: nv.node.id, absorberId: match.target.node.id, cosine: match.similarity });
      }
    }
    if (!result.targetAlive) {
      recordDeath(match.target.node.id, result.merged ? "merge" : "interaction", match.similarity);
      toDelete.add(match.target.node.id);
      if (result.merged) {
        mergeEvents.push({ absorbedId: match.target.node.id, absorberId: nv.node.id, cosine: match.similarity });
      }
    }
  }

  // 3. Spawn phase
  const spawnConsumed = new Set<string>();
  const spawns: SpawnResult[] = [];
  let spawnCount = 0;

  for (const nv of allNodes) {
    if (toDelete.has(nv.node.id) || spawnConsumed.has(nv.node.id)) continue;
    if (!nv.vector || !isSpawnEligible(nv.node)) continue;

    const candidates = allNodes
      .filter(n => n.node.id !== nv.node.id && n.vector && !toDelete.has(n.node.id) && !spawnConsumed.has(n.node.id))
      .map(n => ({ nv: n, score: cosine(nv.vector!, n.vector!) }))
      .sort((a, b) => b.score - a.score);

    if (candidates.length === 0) continue;
    const partner = candidates[0];
    if (!isCompatiblePartner(partner.score)) continue;

    const result = executeSpawn(nv.node, nv.vector, partner.nv.node, partner.nv.vector!);

    recordDeath(nv.node.id, "spawn");
    recordDeath(partner.nv.node.id, "spawn");
    spawnConsumed.add(result.consumedIds[0]);
    spawnConsumed.add(result.consumedIds[1]);
    toDelete.add(result.consumedIds[0]);
    toDelete.add(result.consumedIds[1]);

    spawns.push({
      consumedIds: result.consumedIds as [string, string],
      children: result.children.map(c => ({ node: c.node, vector: c.vector })),
    });

    spawnCount += 2;
  }

  // 4. Apply decay for surviving nodes
  for (const nv of allNodes) {
    if (toDelete.has(nv.node.id)) continue;

    nv.node.w *= (1 - nv.node.d);
    nv.node.h *= M.pressure.hCooling;
    nv.node.ttl -= M.pressure.ttlStep;

    if (nv.node.ttl <= M.pressure.deathMinTtl || nv.node.w <= M.pressure.deathMinW) {
      recordDeath(nv.node.id, "decay");
      toDelete.add(nv.node.id);
    }
  }

  // 5. Partition survivors
  const survivors = allNodes.filter(nv => !toDelete.has(nv.node.id));

  return {
    survivors,
    deaths,
    mergeEvents,
    spawns,
    actionCounts,
    interactionCount,
    mergeCount,
    spawnCount,
  };
}
