// ============================================================
// Hardness — snapshot timing for filtering intensity
// ============================================================
//
// Same ecosystem, different observation point.
// soft = early snapshot (30%), mid = balanced (60%), hard = late (90%).
// The ecosystem runs identically — only when you judge survival changes.

import type { MetabolismSchema, HardnessPreset, HardnessLevel } from "../types.js";
import metabolismRaw from "../config/metabolism.json" with { type: "json" };

const M = metabolismRaw as unknown as MetabolismSchema;

const VALID_LEVELS: Set<string> = new Set(["soft", "mid", "hard"]);

/**
 * Resolve a hardness level string to its preset.
 * Falls back to "mid" for unknown values.
 */
export function resolveHardness(level?: string): { level: HardnessLevel; preset: HardnessPreset } {
  const normalized = (level ?? "mid").toLowerCase().trim();
  const resolved: HardnessLevel = VALID_LEVELS.has(normalized)
    ? (normalized as HardnessLevel)
    : "mid";

  const presets = M.hardness?.presets;
  if (!presets || !presets[resolved]) {
    return { level: resolved, preset: { harvestPct: 0.6 } };
  }

  return { level: resolved, preset: presets[resolved] };
}
