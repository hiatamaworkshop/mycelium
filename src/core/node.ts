// ============================================================
// Mycelium — Node core logic (Phase 2)
// ============================================================

import { randomUUID } from "node:crypto";
import type {
  MyceliumNode,
  MyceliumPointPayload,
  Feelings,
  Species,
  SpeciesConfig,
  Action,
  ReactionType,
  BehaviorKey,
  WeightMatrix,
  Environment,
} from "../types.js";
import {
  ACTIONS,
  REACTIONS,
  BEHAVIOR_KEYS,
  FEELING_KEYS,
  FEELINGS_DIM,
  ALL_SPECIES,
  TRIGGER_TO_SPECIES,
} from "../types.js";
import speciesConfigRaw from "../config/species.json" with { type: "json" };
import type { MetabolismSchema } from "../types.js";
import metabolismRaw from "../config/metabolism.json" with { type: "json" };
import speciesMappingRaw from "../config/species-mapping.json" with { type: "json" };

const speciesConfigs = speciesConfigRaw as Record<string, SpeciesConfig>;
const M = metabolismRaw as unknown as MetabolismSchema;

// ---- Species mapping (tag-based) ----

interface MappingRule {
  match: { tags: string[] };
  species: string;
}
const mappingRules = speciesMappingRaw.rules as MappingRule[];
const mappingDefault = (speciesMappingRaw.default ?? "summarizer") as Species;

function resolveByTags(tags: string[]): Species | undefined {
  for (const rule of mappingRules) {
    if (tags.some(t => rule.match.tags.includes(t))) {
      return rule.species as Species;
    }
  }
  return undefined;
}

// ---- Species resolution ----
// Priority: species direct > tags match > trigger match > default

export function resolveSpecies(
  trigger: string,
  tags?: string[],
  species?: string,
): Species {
  if (species && ALL_SPECIES.includes(species as Species)) return species as Species;
  if (tags && tags.length > 0) {
    const matched = resolveByTags(tags);
    if (matched) return matched;
  }
  return TRIGGER_TO_SPECIES[trigger] ?? mappingDefault;
}

export function getSpeciesConfig(species: Species): SpeciesConfig {
  return speciesConfigs[species];
}

// ---- Zero matrices ----

function zeroResonance(): Record<Species, number> {
  return { summarizer: 0, sentinel: 0, herald: 0, anchor: 0, spore: 0 };
}

function zeroMatrix(rows: number, cols: number): WeightMatrix {
  return Array.from({ length: rows }, () => new Array(cols).fill(0));
}

// ---- Node creation ----

/** Optional initial-condition overrides (set by external orchestrator). */
export interface NutritionOverrides {
  w?: number;
  h?: number;
  d?: number;
}

export function createNode(
  summary: string,
  content: string | undefined,
  trigger: string,
  inheritedDelta?: WeightMatrix,
  inheritedResonanceDelta?: Record<Species, number>,
  nutrition?: NutritionOverrides,
  tags?: string[],
  speciesOverride?: string,
): { node: MyceliumNode; textForEmbedding: string } {
  const species = resolveSpecies(trigger, tags, speciesOverride);
  const config = getSpeciesConfig(species);
  const now = Date.now();

  const fullText = content ? `${summary} ${content}` : summary;

  const node: MyceliumNode = {
    id: randomUUID(),
    species,
    contents: content ? [summary, content] : [summary],
    h: nutrition?.h ?? M.birth.initialH,
    w: nutrition?.w ?? M.birth.initialW,
    d: nutrition?.d ?? config.initialDecay,
    ttl: config.initialTtl,
    resonance: zeroResonance(),
    personality: config.personality,
    learnedDelta: inheritedDelta ?? zeroMatrix(BEHAVIOR_KEYS.length, FEELINGS_DIM),
    learnedResonanceDelta: inheritedResonanceDelta ?? zeroResonance(),
    createdAt: now,
    lastActiveAt: now,
  };

  return { node, textForEmbedding: fullText };
}

// ---- Stage 1: Perception (species DNA × rawVec → feelings) ----

export function computeFeelings(node: MyceliumNode, env: Environment): Feelings {
  const config = getSpeciesConfig(node.species);
  const perception = config.perception; // 4 feelings × 9 raw inputs

  const ttlRatio = node.ttl / config.initialTtl;
  // resonance weighted by species-specific sensitivity (base × (1 + learnedDelta))
  const sensitivity = config.resonanceSensitivity;
  const resDelta = node.learnedResonanceDelta;
  const resonanceSum = ALL_SPECIES.reduce((sum, sp) => {
    const effective = (sensitivity[sp] ?? 0) * (1 + (resDelta[sp] ?? 0));
    return sum + node.resonance[sp] * effective;
  }, 0);

  const rawVec = [
    node.h,              // 0: selfH
    node.w,              // 1: selfW
    node.d,              // 2: selfD
    ttlRatio,            // 3: ttlRatio
    env.neighborField.h, // 4: envH
    env.neighborField.w, // 5: envW
    env.neighborField.d, // 6: envD
    env.kinCount,        // 7: kinCount
    resonanceSum,        // 8: resonanceSum
  ];

  // matrix multiply: perception[4×9] × rawVec[9] → feelings[4]
  const raw: number[] = [];
  for (let i = 0; i < perception.length; i++) {
    let sum = 0;
    for (let j = 0; j < rawVec.length; j++) {
      sum += perception[i][j] * rawVec[j];
    }
    raw.push(clamp01(sum));
  }

  return {
    vigor: raw[0],
    dread: raw[1],
    kinship: raw[2],
    hunger: raw[3],
  };
}

// ---- Stage 2: Decision (personality + learnedDelta × feelings → action) ----

export function assess(feelings: Feelings, personality: WeightMatrix, learnedDelta: WeightMatrix): BehaviorKey {
  const feelingVec = FEELING_KEYS.map(k => feelings[k]);

  // effective weights = personality + learnedDelta (element-wise)
  const scores: number[] = [];
  for (let i = 0; i < BEHAVIOR_KEYS.length; i++) {
    let sum = 0;
    for (let j = 0; j < feelingVec.length; j++) {
      const effective = personality[i][j] * (1 + learnedDelta[i][j]);
      sum += effective * feelingVec[j];
    }
    scores.push(sum);
  }

  return softmaxSelect(BEHAVIOR_KEYS as unknown as string[], scores) as BehaviorKey;
}

// Assess actions only (for initiator in tick — excludes reaction rows)
export function assessAction(feelings: Feelings, personality: WeightMatrix, learnedDelta: WeightMatrix): Action {
  const feelingVec = FEELING_KEYS.map(k => feelings[k]);

  const scores: number[] = [];
  for (let i = 0; i < ACTIONS.length; i++) {
    let sum = 0;
    for (let j = 0; j < feelingVec.length; j++) {
      const effective = personality[i][j] * (1 + learnedDelta[i][j]);
      sum += effective * feelingVec[j];
    }
    scores.push(sum);
  }

  return softmaxSelect(ACTIONS as unknown as string[], scores) as Action;
}

// Assess reactions only (for receiver in receptor — rows 4-8)
// signalFeelings: incoming signal's emotional content (how the initiator "touches" the target)
// receptivity: species-specific sensitivity to incoming feelings (α)
// blended = targetFeelings + α × signalFeelings — the dog reacts to both its mood and how it's touched
export function assessReaction(
  feelings: Feelings,
  personality: WeightMatrix,
  learnedDelta: WeightMatrix,
  signalFeelings?: Feelings,
  receptivity: number = 0,
  mergeContext?: { similarity: number },
): ReactionType {
  let feelingVec = FEELING_KEYS.map(k => feelings[k]);

  if (signalFeelings && receptivity > 0) {
    const signalVec = FEELING_KEYS.map(k => signalFeelings[k]);
    feelingVec = feelingVec.map((v, i) => clamp01(v + receptivity * signalVec[i]));
  }

  const reactionOffset = ACTIONS.length; // 4

  const scores: number[] = [];
  for (let i = 0; i < REACTIONS.length; i++) {
    const rowIdx = reactionOffset + i;
    let sum = 0;
    for (let j = 0; j < feelingVec.length; j++) {
      const effective = personality[rowIdx][j] * (1 + learnedDelta[rowIdx][j]);
      sum += effective * feelingVec[j];
    }
    scores.push(sum);
  }

  // Merge: similarity gates acceptance — close neighbors accept, distant ones reject
  if (mergeContext) {
    const sim = mergeContext.similarity;
    const acceptIdx = REACTIONS.indexOf("accept" as ReactionType);
    const rejectIdx = REACTIONS.indexOf("reject" as ReactionType);
    if (acceptIdx >= 0) scores[acceptIdx] *= sim;
    if (rejectIdx >= 0) scores[rejectIdx] *= (1 - sim);
  }

  return softmaxSelect(REACTIONS as unknown as string[], scores) as ReactionType;
}

// ---- Per-node online learning (Phase 4a) ----
// Individual counterpart of the digestor's species-level signal: cell [i][j]
// grows when action i co-occurs with feeling j above this node's own running
// baseline. Gated by the node's fitness (same gate as digestor's species lr).
// Mutates node.learnedDelta / node.feelingEma in place.

export function learnFromAction(
  node: MyceliumNode,
  actionIdx: number,
  feelings: Feelings,
  learning: MetabolismSchema["learning"],
): void {
  const rate = learning.nodeRate ?? 0;
  if (rate <= 0) return;

  const fv = FEELING_KEYS.map(k => feelings[k]);
  if (!node.feelingEma) {
    // First action: establish baseline, no deviation signal yet
    node.feelingEma = [...fv];
    return;
  }

  const config = getSpeciesConfig(node.species);
  const fitness = (node.h + Math.min(1, node.w) + node.ttl / config.initialTtl) / 3;
  const lr = rate * fitness;
  const beta = learning.nodeEmaBeta ?? 0.2;
  const clamp = learning.deltaClamp;

  for (let j = 0; j < FEELINGS_DIM; j++) {
    const sig = fv[j] - node.feelingEma[j];
    const v = node.learnedDelta[actionIdx][j] + lr * sig;
    node.learnedDelta[actionIdx][j] = Math.max(-clamp, Math.min(clamp, v));
    node.feelingEma[j] = (1 - beta) * node.feelingEma[j] + beta * fv[j];
  }
}

// ---- Softmax + probabilistic selection ----

function softmaxProbs(scores: number[]): number[] {
  const temp = M.decision?.temperature ?? 1.0;
  const maxScore = Math.max(...scores);
  const exps = scores.map(s => Math.exp((s - maxScore) / temp));
  const sumExp = exps.reduce((a, b) => a + b, 0);
  return exps.map(e => e / sumExp);
}

function softmaxSelect(keys: string[], scores: number[]): string {
  const probs = softmaxProbs(scores);

  const rand = Math.random();
  let cumulative = 0;
  for (let i = 0; i < probs.length; i++) {
    cumulative += probs[i];
    if (rand < cumulative) return keys[i];
  }
  return keys[keys.length - 1];
}

/** Select action and return both choice + full probability vector (for frustration update). */
export function assessActionWithProbs(
  feelings: Feelings,
  personality: WeightMatrix,
  learnedDelta: WeightMatrix,
): { action: Action; probs: number[] } {
  const feelingVec = FEELING_KEYS.map(k => feelings[k]);

  const scores: number[] = [];
  for (let i = 0; i < ACTIONS.length; i++) {
    let sum = 0;
    for (let j = 0; j < feelingVec.length; j++) {
      const effective = personality[i][j] * (1 + learnedDelta[i][j]);
      sum += effective * feelingVec[j];
    }
    scores.push(sum);
  }

  const probs = softmaxProbs(scores);
  const rand = Math.random();
  let cumulative = 0;
  let chosenIdx = probs.length - 1;
  for (let i = 0; i < probs.length; i++) {
    cumulative += probs[i];
    if (rand < cumulative) { chosenIdx = i; break; }
  }

  return { action: ACTIONS[chosenIdx], probs };
}

/**
 * Update frustration: Lorenz hydraulic model.
 * Chosen action drains (satisfied), unchosen actions accumulate (unfulfilled).
 * Frustration is projected back into feelings space via P_actions^T.
 *
 * frustration_new = decay × frustration_old + accum × P_actions^T × (probs - one_hot(chosen))
 */
export function updateFrustration(
  personality: WeightMatrix,
  probs: number[],
  chosenIdx: number,
  oldFrustration: Feelings | undefined,
  decay: number,
  accum: number,
): Feelings {
  // unfulfilled = probs - one_hot(chosen)
  const unfulfilled = probs.map((p, i) => i === chosenIdx ? p - 1 : p);

  // P_actions^T × unfulfilled → feelings-space projection
  // P_actions is rows 0..3 (actions) × 4 cols (feelings)
  // P^T[j][i] = P[i][j], so projection[j] = sum_i P[i][j] × unfulfilled[i]
  const projection: number[] = [];
  for (let j = 0; j < FEELINGS_DIM; j++) {
    let sum = 0;
    for (let i = 0; i < ACTIONS.length; i++) {
      sum += personality[i][j] * unfulfilled[i];
    }
    projection.push(sum);
  }

  // Combine with decayed old frustration
  const old = oldFrustration ?? { vigor: 0, dread: 0, kinship: 0, hunger: 0 };
  return {
    vigor:   decay * old.vigor   + accum * projection[0],
    dread:   decay * old.dread   + accum * projection[1],
    kinship: decay * old.kinship + accum * projection[2],
    hunger:  decay * old.hunger  + accum * projection[3],
  };
}

/**
 * Compute self-reflection: route reaction outcome back through initiator's own receptor.
 *
 * After acting and receiving a reaction, the initiator processes the experience:
 * - reactionFeelings: the emotional signature of the reaction (target's feelings at reaction time)
 * - initiator's receptivity blends this into its own current feelings
 * - The delta (blended - current) becomes the reflection: how the outcome shifted perception
 * - Decayed and accumulated over ticks like frustration, but softer and species-differentiated
 */
export function computeReflection(
  currentFeelings: Feelings,
  reactionFeelings: Feelings,
  receptivity: number,
  oldReflection: Feelings | undefined,
  decay: number,
): Feelings {
  // Blend: how initiator's receptor interprets the reaction signal
  const blended = {
    vigor:   clamp01(currentFeelings.vigor   + receptivity * reactionFeelings.vigor),
    dread:   clamp01(currentFeelings.dread   + receptivity * reactionFeelings.dread),
    kinship: clamp01(currentFeelings.kinship + receptivity * reactionFeelings.kinship),
    hunger:  clamp01(currentFeelings.hunger  + receptivity * reactionFeelings.hunger),
  };

  // Delta: how much the reaction shifted the initiator's perception
  const delta = {
    vigor:   blended.vigor   - currentFeelings.vigor,
    dread:   blended.dread   - currentFeelings.dread,
    kinship: blended.kinship - currentFeelings.kinship,
    hunger:  blended.hunger  - currentFeelings.hunger,
  };

  // Accumulate with decay (like frustration, but the signal IS the delta)
  const old = oldReflection ?? { vigor: 0, dread: 0, kinship: 0, hunger: 0 };
  return {
    vigor:   decay * old.vigor   + delta.vigor,
    dread:   decay * old.dread   + delta.dread,
    kinship: decay * old.kinship + delta.kinship,
    hunger:  decay * old.hunger  + delta.hunger,
  };
}

// ---- Serialization (node ↔ Qdrant payload) ----

export function nodeToPayload(node: MyceliumNode): MyceliumPointPayload {
  const payload: MyceliumPointPayload = {
    species: node.species,
    contents: node.contents,
    h: node.h,
    w: node.w,
    d: node.d,
    ttl: node.ttl,
    resonance: JSON.stringify(node.resonance),
    personality: JSON.stringify(node.personality),
    learnedDelta: JSON.stringify(node.learnedDelta),
    learnedResonanceDelta: JSON.stringify(node.learnedResonanceDelta),
    createdAt: node.createdAt,
    lastActiveAt: node.lastActiveAt,
  };
  if (node.lineage) {
    payload.lineage = JSON.stringify(node.lineage);
  }
  if (node.frustration) {
    payload.frustration = JSON.stringify(node.frustration);
  }
  if (node.selfReflection) {
    payload.selfReflection = JSON.stringify(node.selfReflection);
  }
  return payload;
}

export function payloadToNode(id: string, payload: MyceliumPointPayload): MyceliumNode {
  const node: MyceliumNode = {
    id,
    species: payload.species,
    contents: payload.contents,
    h: payload.h,
    w: payload.w,
    d: payload.d,
    ttl: payload.ttl,
    resonance: JSON.parse(payload.resonance),
    personality: JSON.parse(payload.personality),
    learnedDelta: JSON.parse(payload.learnedDelta),
    learnedResonanceDelta: payload.learnedResonanceDelta ? JSON.parse(payload.learnedResonanceDelta) : zeroResonance(),
    createdAt: payload.createdAt,
    lastActiveAt: payload.lastActiveAt,
  };
  if (payload.lineage) {
    node.lineage = JSON.parse(payload.lineage);
  }
  if (payload.frustration) {
    node.frustration = JSON.parse(payload.frustration);
  }
  if (payload.selfReflection) {
    node.selfReflection = JSON.parse(payload.selfReflection);
  }
  return node;
}

// ---- Utilities ----

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

export { clamp01, zeroResonance, zeroMatrix };
