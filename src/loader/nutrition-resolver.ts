// ============================================================
// Nutrition Resolver — usage-side fuel intake (Phase F1)
// ============================================================
//
// F0 (isolated-runner.ts inject()) already maps payload.weight (author-side
// signal) to initial w via a linear scale. This module adds the usage-side
// channel: payload.myceliumMetrics, written back by the caller (receptor
// sink) after a prior run, biases w/h/d on top of whatever base F0/jitter
// already resolved.
//
// Formula mirrors the pre-universal-loader engram feeder (git history
// 06b3961:src/core/feeder.ts), generalized from engram's weight/hitCount/
// status=fixed to myceliumMetrics.survived/hits+reads/lastClass. Bias is
// additive and bounded (tanh / capped ratio) — fuel never determines
// outcome, it only nudges initial conditions.

import type { MetabolismSchema } from "../types.js";
import metabolismRaw from "../config/metabolism.json" with { type: "json" };

const M = metabolismRaw as unknown as MetabolismSchema;

/** Usage-side fuel signal — written back by the caller after a prior run. */
export interface MyceliumMetrics {
  /** Count of past runs this point survived as pure or merged. */
  survived?: number;
  /** Classification from the most recent run. */
  lastClass?: "pure" | "merged" | "loner" | "redundant" | "dead";
  /** Agent recall/access count since last write-back. */
  hits?: number;
  /** Agent read (view) count since last write-back — weaker signal than hits. */
  reads?: number;
  /** Epoch ms of last metrics update. Staleness discount is F2 (EMA decay) — not read here. */
  updatedAt?: number;
}

/**
 * Apply myceliumMetrics as an additive bias on top of an already-resolved
 * base w/h/d (from F0 weight scaling, jitter, or metabolism defaults).
 * No-op (returns base unchanged) when metrics is absent.
 */
export function applyUsageNutrition(
  base: { w: number; h: number; d: number },
  metrics: MyceliumMetrics | undefined,
): { w: number; h: number; d: number } {
  if (!metrics) return base;

  const NUT = M.nutrition;

  // survived count → w bias (tanh saturation — more past survivals, warmer birth)
  const wBias = NUT.bias * Math.tanh((metrics.survived ?? 0) / NUT.weightSaturation);

  // hits + reads (reads weighted half of hits) → h bias (warmer), d bias (slower decay)
  const usage = (metrics.hits ?? 0) + (metrics.reads ?? 0) * 0.5;
  const usageRatio = Math.min(usage / NUT.hitCountCap, 1);
  const hBias = NUT.bias * usageRatio;
  const dBias = -NUT.bias * usageRatio;

  // lastClass === "pure" bonus — was the best possible outcome last run
  const wasPure = metrics.lastClass === "pure";
  const pureW = wasPure ? NUT.fixedBonus : 0;
  const pureD = wasPure ? -NUT.fixedBonus : 0;

  return {
    w: base.w * (1 + wBias + pureW),
    h: base.h * (1 + hBias),
    d: base.d * (1 + dBias + pureD),
  };
}
