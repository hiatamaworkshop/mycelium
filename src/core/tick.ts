// ============================================================
// Mycelium — Tick engine (Phase 2)
// ============================================================
// Production tick logic. scripts/semantic-filter-test.cjs replicates this
// behavior in-memory for offline consensus testing.
// All config values come from metabolism.json (M).
//
// Each tick:
//   1. Poll engram for new seeds
//   2. Scroll all nodes (with vectors)
//   3. Compute Environment per node (cosine neighbors → neighborField, kinCount, neighborSpecies)
//   4. computeFeelings → assessAction → select target
//   5. Emit ActionSignal (active receptor)
//   6. Target: computeFeelings → assessReaction (passive receptor)
//   7. Resolve interaction → update resonance
//   8. Apply decay (w *= 1-d, h cooling, ttl--)
//   9. Expire dead nodes, batch update survivors
//  10. Species digestor: batch δ computation at digest intervals

import type { MyceliumConfig, Environment, MyceliumNode, Action } from "../types.js";
import { scrollAll, setPayload, deletePoints, upsertPoints } from "../qdrant.js";
import { payloadToNode, nodeToPayload, computeFeelings, assessAction, assessActionWithProbs, updateFrustration, getSpeciesConfig, clamp01, computeReflection } from "./node.js";
import { emitSignal, react, resolveInteraction } from "./receptor.js";
import { isSpawnEligible, isCompatiblePartner, executeSpawn } from "./spawn.js";
import { pollEngram } from "./feeder.js";
import { shouldDigest, digestSpeciesMemory, persistSpeciesMemory, recordAction } from "./digestor.js";
import { shouldCollect, collect as observatoryCollect } from "./observatory.js";
import { ACTIONS, REACTIONS, ALL_SPECIES } from "../types.js";
import type { DeathRecord } from "./pushback.js";
import type { MetabolismSchema } from "../types.js";
import metabolismRaw from "../config/metabolism.json" with { type: "json" };

const M = metabolismRaw as unknown as MetabolismSchema;

// ---- Death log (accumulated across ticks, cleared on retrieval) ----

const deathLog = new Map<string, DeathRecord>();

function recordDeath(node: MyceliumNode, tick: number, cause: string, cosine?: number): void {
  const posRes = ALL_SPECIES.reduce((s, sp) => s + Math.max(0, node.resonance[sp]), 0);
  deathLog.set(node.id, { tick, cause, cosine, posRes });
}

export function getAndClearDeathLog(): Map<string, DeathRecord> {
  const snapshot = new Map(deathLog);
  deathLog.clear();
  return snapshot;
}

// ---- Cosine similarity (vectors are pre-normalized) ----

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

// ---- Compute Environment for a node ----

export interface NodeWithVector {
  node: MyceliumNode;
  vector: number[] | null;
}

export function computeEnvironment(
  self: NodeWithVector,
  allNodes: NodeWithVector[],
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

// ---- Tick result ----

export interface TickResult {
  tick: number;
  processed: number;
  expired: number;
  ingested: number;
  spawned: number;
  actions: Record<string, number>;
  interactions: number;
}

// ---- Single tick execution ----

export async function runTick(config: MyceliumConfig, tickNumber: number): Promise<TickResult> {
  const { qdrantUrl, collection } = config;

  // 0. Poll engram for new seeds
  let ingested = 0;
  try {
    ingested = await pollEngram(config, config.engramCollection);
  } catch (err) {
    console.error(`[mycelium] feeder error:`, (err as Error).message);
  }

  // 1. Scroll all nodes with vectors
  const points = await scrollAll(qdrantUrl, collection, true);

  if (points.length === 0) {
    return { tick: tickNumber, processed: 0, expired: 0, ingested, spawned: 0, actions: {}, interactions: 0 };
  }

  // Convert to NodeWithVector
  const allNodes: NodeWithVector[] = points.map(p => ({
    node: payloadToNode(p.id, p.payload),
    vector: p.vector ?? null,
  }));

  const toDelete: Set<string> = new Set();
  const actionCounts: Record<string, number> = {};
  let interactionCount = 0;
  let mergeCount = 0;

  // 2. Decay resonance (carry-over across ticks, not reset)
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

  // 3. Phase 2 main loop: each node acts
  for (const nv of allNodes) {
    if (toDelete.has(nv.node.id)) continue;

    const env = computeEnvironment(nv, allNodes);
    const baseFeelings = computeFeelings(nv.node, env);

    // Frustration blend: unfulfilled desires from previous tick tint current feelings
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

    // Self-reflection blend: "how did my last action's outcome feel?" tints current feelings
    if (refl.enabled && nv.node.selfReflection) {
      const rb = refl.blend;
      feelings = {
        vigor:   clamp01(feelings.vigor   + rb * nv.node.selfReflection.vigor),
        dread:   clamp01(feelings.dread   + rb * nv.node.selfReflection.dread),
        kinship: clamp01(feelings.kinship + rb * nv.node.selfReflection.kinship),
        hunger:  clamp01(feelings.hunger  + rb * nv.node.selfReflection.hunger),
      };
    }

    // Action selection (with probability vector for frustration update)
    let action: Action;
    let actionProbs: number[] | null = null;
    if (frust.enabled) {
      const result = assessActionWithProbs(feelings, nv.node.personality, nv.node.learnedDelta);
      action = result.action;
      actionProbs = result.probs;
    } else {
      action = assessAction(feelings, nv.node.personality, nv.node.learnedDelta);
    }

    actionCounts[action] = (actionCounts[action] ?? 0) + 1;

    // Record action for digestor accumulation
    recordAction(nv.node.species, ACTIONS.indexOf(action), feelings);

    // Update frustration: Lorenz hydraulic — chosen drains, unchosen accumulate
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
      nv.node.w -= M.relief.surviveWCost; // isolation tax
      nv.node.ttl += M.relief.surviveTtlRecovery;
      nv.node.d *= M.relief.surviveDecayReduction;
      // No social interaction — selfReflection decays naturally
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

    // Social actions — need a target (signal reach scales with intensity)
    const signalReach = action === "signal"
      ? M.social.neighborLimit + Math.floor(intensity * M.social.signalExtraReach)
      : undefined;
    const match = selectTarget(nv, allNodes, signalReach, action, toDelete);
    if (!match) {
      // No available target — fallback to survive (recover energy spent)
      nv.node.h = Math.min(1, nv.node.h + intensity * baseCost); // refund energy
      nv.node.h = Math.min(1, nv.node.h + M.relief.surviveHRecovery);
      nv.node.w += M.relief.surviveWRecovery;
      nv.node.w -= M.relief.surviveWCost;
      nv.node.ttl += M.relief.surviveTtlRecovery;
      nv.node.d *= M.relief.surviveDecayReduction;
      continue;
    }

    // Proximity merge: selectTarget flags when target is too close to remain separate
    if (match.proximityMerge) {
      const origAction = action;
      action = "merge";
      actionCounts[origAction]--;
      actionCounts["merge"] = (actionCounts["merge"] ?? 0) + 1;
    }

    // Active receptor: emit signal (strength scaled by intensity)
    const signal = emitSignal(nv.node, action, feelings, intensity);

    // Passive receptor: target reacts (receives initiator's emotional signal)
    // Tone: sender's w modulates signal feelings — weak nodes have a quieter voice
    const tone = nv.node.w;
    const tonedFeelings: typeof feelings = {
      vigor:   signal.feelings.vigor * tone,
      hunger:  signal.feelings.hunger * tone,
      dread:   signal.feelings.dread * tone,
      kinship: signal.feelings.kinship * tone,
    };
    const targetEnv = computeEnvironment(match.target, allNodes);
    const mergeCtx = action === "merge" ? { similarity: match.similarity } : undefined;
    const reaction = react(match.target.node, targetEnv, tonedFeelings, mergeCtx);

    // Record target's reaction for digestor accumulation
    const targetFeelings = computeFeelings(match.target.node, targetEnv);
    recordAction(match.target.node.species, ACTIONS.length + REACTIONS.indexOf(reaction), targetFeelings);

    // Resolve interaction (effects scaled by intensity + similarity)
    const result = resolveInteraction(nv.node, match.target.node, signal, reaction, intensity, match.similarity);
    interactionCount++;
    if (result.merged) mergeCount++;

    // Self-reflection: initiator processes the reaction through its own receptor
    // "I acted, they reacted — how does that make me feel?"
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

    if (!result.initiatorAlive) {
      recordDeath(nv.node, tickNumber, result.merged ? "merge" : "interaction", match.similarity);
      toDelete.add(nv.node.id);
    }
    if (!result.targetAlive) {
      recordDeath(match.target.node, tickNumber, "interaction");
      toDelete.add(match.target.node.id);
    }
  }

  // 4. Spawn phase — eligible nodes reproduce with nearest partner
  let spawnCount = 0;
  const spawnConsumed = new Set<string>();
  const spawnChildren: Array<{ id: string; vector: number[]; payload: ReturnType<typeof nodeToPayload> }> = [];

  for (const nv of allNodes) {
    if (toDelete.has(nv.node.id) || spawnConsumed.has(nv.node.id)) continue;
    if (!nv.vector) continue;
    if (!isSpawnEligible(nv.node)) continue;

    // Find nearest partner (not already consumed/deleted)
    const candidates = allNodes
      .filter(n => n.node.id !== nv.node.id && n.vector && !toDelete.has(n.node.id) && !spawnConsumed.has(n.node.id))
      .map(n => ({ nv: n, score: cosine(nv.vector!, n.vector!) }))
      .sort((a, b) => b.score - a.score);

    if (candidates.length === 0) continue;
    const partner = candidates[0];

    // Compatibility gate: partner must be similar enough
    if (!isCompatiblePartner(partner.score)) continue;

    const result = executeSpawn(nv.node, nv.vector, partner.nv.node, partner.nv.vector!);

    // Mark parents consumed (spawn is not a negative signal)
    recordDeath(nv.node, tickNumber, "spawn");
    recordDeath(partner.nv.node, tickNumber, "spawn");
    spawnConsumed.add(result.consumedIds[0]);
    spawnConsumed.add(result.consumedIds[1]);
    toDelete.add(result.consumedIds[0]);
    toDelete.add(result.consumedIds[1]);

    // Queue children for upsert
    for (const child of result.children) {
      spawnChildren.push({
        id: child.node.id,
        vector: child.vector,
        payload: nodeToPayload(child.node),
      });
    }

    spawnCount += 2;
  }

  // Upsert spawn children
  if (spawnChildren.length > 0) {
    await upsertPoints(qdrantUrl, collection, spawnChildren);
    console.error(`[mycelium:spawn] ${spawnCount} children born from ${spawnConsumed.size / 2} pairs`);
  }

  // 5. Apply decay for all surviving nodes (excludes spawn-consumed)
  for (const nv of allNodes) {
    if (toDelete.has(nv.node.id)) continue;

    // Decay (proportional — w approaches 0 asymptotically)
    nv.node.w *= (1 - nv.node.d);
    nv.node.h *= M.pressure.hCooling;
    nv.node.ttl -= M.pressure.ttlStep;

    nv.node.lastActiveAt = Date.now();

    // Check expiry
    if (nv.node.ttl <= M.pressure.deathMinTtl || nv.node.w <= M.pressure.deathMinW) {
      recordDeath(nv.node, tickNumber, "decay");
      toDelete.add(nv.node.id);
    }
  }

  // 6. Batch update survivors
  const survivors = allNodes.filter(nv => !toDelete.has(nv.node.id));
  if (survivors.length > 0) {
    await Promise.all(
      survivors.map(({ node }) =>
        setPayload(qdrantUrl, collection, [node.id], nodeToPayload(node)),
      ),
    );
  }

  // 7. Delete expired/consumed/spawn-parents
  const deleteIds = [...toDelete];
  if (deleteIds.length > 0) {
    await deletePoints(qdrantUrl, collection, deleteIds);
  }

  // 8. Observatory — collect ecosystem snapshot at configured intervals
  if (shouldCollect(tickNumber)) {
    observatoryCollect(
      tickNumber,
      survivors.map(nv => nv.node),
      actionCounts,
      mergeCount,
      spawnCount,
    );
  }

  // 9. Species digestor — aggregate learnedDelta into species memory
  if (shouldDigest(tickNumber) && survivors.length > 0) {
    const digestResult = digestSpeciesMemory(
      survivors.map(nv => nv.node),
      tickNumber,
    );
    console.error(
      `[mycelium:digestor] gen #${digestResult.generation} at tick ${tickNumber}: ` +
      Object.entries(digestResult.speciesStats)
        .filter(([, s]) => s.count > 0)
        .map(([sp, s]) => `${sp}(n=${s.count}, drift=${s.maxAbsDelta.toFixed(3)})`)
        .join(", "),
    );
    try {
      persistSpeciesMemory(config);
    } catch (err) {
      console.error(`[mycelium:digestor] persist failed:`, (err as Error).message);
    }
  }

  return {
    tick: tickNumber,
    processed: points.length,
    expired: deleteIds.length,
    ingested,
    spawned: spawnCount,
    actions: actionCounts,
    interactions: interactionCount,
  };
}

// ---- Tick loop management ----

let tickInterval: ReturnType<typeof setInterval> | null = null;
let lastTickResult: TickResult | null = null;
let tickCount = 0;

export function startTick(config: MyceliumConfig): void {
  if (tickInterval) return;

  tickInterval = setInterval(async () => {
    try {
      tickCount++;
      lastTickResult = await runTick(config, tickCount);
      console.error(
        `[mycelium] tick #${tickCount}: ingested=${lastTickResult.ingested} processed=${lastTickResult.processed} expired=${lastTickResult.expired} spawned=${lastTickResult.spawned} interactions=${lastTickResult.interactions} actions=${JSON.stringify(lastTickResult.actions)}`,
      );
    } catch (err) {
      console.error(`[mycelium] tick #${tickCount} error:`, err);
    }
  }, config.tickIntervalMs);

  console.error(`[mycelium] tick loop started (interval=${config.tickIntervalMs}ms)`);
}

export function stopTick(): void {
  if (tickInterval) {
    clearInterval(tickInterval);
    tickInterval = null;
    console.error(`[mycelium] tick loop stopped`);
  }
}

export function getTickStats(): { tickCount: number; lastResult: TickResult | null; running: boolean } {
  return { tickCount, lastResult: lastTickResult, running: tickInterval !== null };
}
