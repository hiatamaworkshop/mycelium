// ============================================================
// Mycelium — Receptor model (Phase 2)
// ============================================================
//
// Active receptor: node emits ActionSignal when acting on another node.
// Passive receptor: target node receives signal, reacts based on own state.
// Interaction resolution: effects applied to both nodes, resonance updated.

import type {
  MyceliumNode,
  Action,
  ReactionType,
  ActionSignal,
  Feelings,
  Environment,
  Species,
} from "../types.js";
import { ALL_SPECIES } from "../types.js";
import { computeFeelings, assessReaction } from "./node.js";
import { computeFitness } from "./scoring.js";
import { getSpeciesConfig } from "./node.js";
import type { MetabolismSchema } from "../types.js";
import metabolismRaw from "../config/metabolism.json" with { type: "json" };

const M = metabolismRaw as unknown as MetabolismSchema;

/** Species → single-char tag for merge content tracking */
const SPECIES_SHORT: Record<string, string> = {
  summarizer: "s", sentinel: "t", herald: "h", anchor: "a", spore: "p",
};

// ---- Emit ActionSignal (active receptor) ----

export function emitSignal(
  node: MyceliumNode,
  action: Action,
  feelings: Feelings,
  intensity: number = 1,
): ActionSignal {
  const config = getSpeciesConfig(node.species);
  return {
    action,
    species: node.species,
    feelings,
    strength: computeFitness(node, config.initialTtl) * intensity,
  };
}

// ---- Receive and React (passive receptor) ----

export function react(
  target: MyceliumNode,
  env: Environment,
  signalFeelings?: Feelings,
  mergeContext?: { similarity: number },
): ReactionType {
  const feelings = computeFeelings(target, env);
  const config = getSpeciesConfig(target.species);
  return assessReaction(feelings, target.personality, target.learnedDelta, signalFeelings, config.receptivity ?? 0, mergeContext);
}

// ---- Interaction resolution ----

export interface InteractionResult {
  initiatorAlive: boolean;
  targetAlive: boolean;
  merged: boolean;
}

export function resolveInteraction(
  initiator: MyceliumNode,
  target: MyceliumNode,
  signal: ActionSignal,
  reaction: ReactionType,
  intensity: number = 1,
  similarity: number = 0,
): InteractionResult {
  // Per-species w boost configs (used in signal+accept)
  const initiatorConfig = getSpeciesConfig(initiator.species);
  const targetConfig = getSpeciesConfig(target.species);
  const rc = M.receptor;
  const result: InteractionResult = { initiatorAlive: true, targetAlive: true, merged: false };

  // Target pays reaction energy cost (ignore = 0, free)
  const rCost = M.energy.reactionCost[reaction] ?? 0;
  if (rCost > 0) {
    target.h = Math.max(0, target.h - target.h * rCost);
  }

  // Resonance receive scaling per species
  const iResScale = initiatorConfig.resonanceReceiveScale ?? 1.0;
  const tResScale = targetConfig.resonanceReceiveScale ?? 1.0;

  switch (signal.action) {
    case "signal":
      resolveSignalInteraction(initiator, target, signal, reaction, rc, intensity, similarity, initiatorConfig, targetConfig, iResScale, tResScale);
      break;
    case "merge":
      resolveMergeInteraction(initiator, target, signal, reaction, rc, result, intensity, similarity, iResScale, tResScale);
      break;
    case "bequeath":
      resolveBequeathInteraction(initiator, target, signal, reaction, rc, result, intensity, tResScale);
      break;
    case "survive":
      // survive is self-directed, no interaction
      break;
  }

  return result;
}

function resolveSignalInteraction(
  initiator: MyceliumNode,
  target: MyceliumNode,
  signal: ActionSignal,
  reaction: ReactionType,
  rc: typeof M.receptor,
  intensity: number,
  similarity: number = 0,
  initiatorConfig?: { signalAcceptWBoost?: number },
  targetConfig?: { signalAcceptWBoost?: number },
  iResScale: number = 1.0,
  tResScale: number = 1.0,
): void {
  switch (reaction) {
    case "accept": {
      // similarity bonus: high cosine match amplifies resonance (rewards good matching)
      const simBonus = 1 + similarity * rc.similarityResonanceBonus;
      // mutual resonance boost (scaled by intensity, similarity, and receive scale)
      initiator.resonance[target.species] += signal.strength * rc.signalAcceptBoost * intensity * simBonus * iResScale;
      target.resonance[initiator.species] += signal.strength * rc.signalAcceptBoost * intensity * simBonus * tResScale;
      // social nourishment: signal+accept warms both parties and feeds weight
      const hBoost = rc.signalHeatBoost;
      if (hBoost > 0) {
        initiator.h = Math.min(1, initiator.h + hBoost * intensity);
        target.h = Math.min(1, target.h + hBoost * intensity);
      }
      // Per-species w boost (toggle: each species opts in independently)
      const iWBoost = initiatorConfig?.signalAcceptWBoost ?? 0;
      const tWBoost = targetConfig?.signalAcceptWBoost ?? 0;
      if (iWBoost > 0) initiator.w += iWBoost * intensity;
      if (tWBoost > 0) target.w += tWBoost * intensity;
      break;
    }
    case "reject":
      initiator.h = Math.max(0, initiator.h - rc.rejectHeatPenalty);
      initiator.resonance[target.species] -= rc.rejectResonancePenalty;
      break;
    case "retaliate":
      initiator.d += rc.retaliateDecayIncrease;
      initiator.resonance[target.species] -= rc.retaliateResonancePenalty;
      break;
    case "ignore":
      // initiator passive receptor: register being ignored (mild resonance fade)
      initiator.resonance[target.species] -= rc.ignoreResonanceFade;
      break;
    case "flee":
      initiator.resonance[target.species] -= rc.ignoreResonanceFade;
      break;
  }
}

function resolveMergeInteraction(
  initiator: MyceliumNode,
  target: MyceliumNode,
  signal: ActionSignal,
  reaction: ReactionType,
  rc: typeof M.receptor,
  result: InteractionResult,
  intensity: number,
  similarity: number = 0,
  iResScale: number = 1.0,
  tResScale: number = 1.0,
): void {
  switch (reaction) {
    case "accept":
      // merge proceeds: transfer scaled by intensity × similarity (close = efficient, distant = lossy)
      // Contents carry merge depth prefix: » = absorbed once, »» = twice, etc.
      // Each merge appends species tag + |cosine at the end for quality filtering.
      // Format: »[h]content|0.91  »»[h]content|0.91|0.82 (depth = leading », species = [x], cosines = trailing |values)
      // Species tag: [s]=summarizer [t]=sentinel [h]=herald [a]=anchor [p]=spore
      const sim2 = similarity.toFixed(2);
      const spTag = `[${SPECIES_SHORT[initiator.species] ?? "?"}]`;
      target.contents = [
        ...target.contents,
        ...initiator.contents.map(c => "»" + spTag + c + "|" + sim2),
      ];
      target.w += initiator.w * rc.mergeWeightTransfer * intensity * similarity;
      target.ttl += Math.floor(initiator.ttl * rc.mergeTtlTransfer * intensity * similarity);
      target.resonance[initiator.species] += signal.strength * rc.mergeResonanceBoost * intensity * tResScale;
      initiator.resonance[target.species] += signal.strength * rc.mergeResonanceBoost * intensity * iResScale;
      // Transfer initiator's accumulated positive resonance to target (like w/ttl transfer)
      const resTransfer = rc.mergeResonanceTransfer ?? 0.5;
      for (const sp of ALL_SPECIES) {
        const transfer = Math.max(0, initiator.resonance[sp]) * resTransfer * intensity * similarity * tResScale;
        target.resonance[sp] += transfer;
      }
      result.initiatorAlive = false; // initiator consumed
      result.merged = true;
      break;
    case "reject":
      initiator.h = Math.max(0, initiator.h - rc.rejectHeatPenalty);
      initiator.resonance[target.species] -= rc.rejectResonancePenalty;
      break;
    case "retaliate":
      initiator.d += rc.retaliateDecayIncrease;
      initiator.resonance[target.species] -= rc.retaliateResonancePenalty;
      break;
    case "ignore":
      initiator.resonance[target.species] -= rc.ignoreResonanceFade;
      break;
    case "flee":
      initiator.resonance[target.species] -= rc.ignoreResonanceFade;
      break;
  }
}

function resolveBequeathInteraction(
  initiator: MyceliumNode,
  target: MyceliumNode,
  signal: ActionSignal,
  reaction: ReactionType,
  rc: typeof M.receptor,
  result: InteractionResult,
  intensity: number,
  tResScale: number = 1.0,
): void {
  switch (reaction) {
    case "accept":
      // bequeath: give lifespan to struggling friend (no w transfer — preserves info quality)
      const ttlGift = Math.floor(initiator.ttl * (rc.bequeathTtlRatio ?? 0.3) * intensity);
      initiator.ttl -= ttlGift;
      target.ttl += ttlGift;
      target.d *= (rc.bequeathDecayReduction ?? 0.95);
      target.resonance[initiator.species] += signal.strength * rc.bequeathResonanceBoost * intensity * tResScale;
      break;
    case "reject":
      initiator.h = Math.max(0, initiator.h - rc.rejectHeatPenalty);
      initiator.resonance[target.species] -= rc.rejectResonancePenalty;
      break;
    case "retaliate":
      initiator.d += rc.retaliateDecayIncrease;
      initiator.resonance[target.species] -= rc.retaliateResonancePenalty;
      break;
    case "ignore":
      initiator.resonance[target.species] -= rc.ignoreResonanceFade;
      break;
    case "flee":
      initiator.resonance[target.species] -= rc.ignoreResonanceFade;
      break;
  }
}

