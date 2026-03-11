// ============================================================
// Mycelium — Species Digestor (Sphere-style learned_weight)
// ============================================================
//
// Sphere pattern:
//   Agent explores → eval-log → Digestor batch computes δ → species-profile → next gen
//
// Mycelium mapping:
//   Tick simulation → recordAction (accumulate feelings per action)
//   → Digest: fitness-gated δ from action×feelings patterns of survivors
//   → speciesMemory (δ) persisted to snapshot file
//   → Next generation: effective = personality × (1 + δ)
//
// No per-tick learning. All learning happens at digest time.
//
// Usage:
//   Main server:  uses module-level default instance (singleton)
//   Test scripts: createDigestor({ initialDelta }) for isolated instances

import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { MyceliumNode, Species, WeightMatrix, MyceliumConfig, Feelings } from "../types.js";
import { ALL_SPECIES, BEHAVIOR_KEYS, FEELINGS_DIM, FEELING_KEYS } from "../types.js";
import { zeroMatrix, zeroResonance, getSpeciesConfig } from "./node.js";
import type { MetabolismSchema } from "../types.js";
import metabolismRaw from "../config/metabolism.json" with { type: "json" };

const M = metabolismRaw as unknown as MetabolismSchema;
const LEARNING_RATE = M.learning.rate;
const DELTA_CLAMP = M.learning.deltaClamp;
const BLEND_ALPHA = M.learning.blendAlpha;
const DELTA_DECAY = M.learning.deltaDecay;

// ---- Digest result ----

export interface DigestResult {
  generation: number;
  tick: number;
  speciesStats: Record<string, {
    count: number;
    fitnessGate: number;
    maxAbsDelta: number;
  }>;
}

export interface DigestorStats {
  generation: number;
  lastDigestTick: number;
  speciesMemorySummary: Record<string, { maxAbsDelta: number }>;
}

// ---- Digestor instance (factory pattern) ----

export interface DigestorInstance {
  getMemory(species: Species): WeightMatrix;
  getResonanceDelta(species: Species): Record<Species, number>;
  recordAction(species: Species, behaviorIdx: number, feelings: Feelings): void;
  digest(survivors: MyceliumNode[], tickNumber: number): DigestResult;
  getStats(): DigestorStats;
  /** Load delta from snapshot file. Mode: "latest", "none", or file path. */
  load(config: MyceliumConfig): boolean;
  /** Persist current delta to snapshot file (timestamped + latest symlink). */
  persist(config: MyceliumConfig): string;
  /** Inject delta directly (for tests / snapshot loading without file). */
  setDelta(delta: Record<string, WeightMatrix>): void;
  /** Export raw delta (for snapshot saving). */
  getDelta(): Record<Species, WeightMatrix>;
  getResonanceDeltaAll(): Record<Species, Record<Species, number>>;
  setResonanceDelta(delta: Record<string, Record<string, number>>): void;
  shouldDigest(tickNumber: number): boolean;
}

export interface DigestorOptions {
  /** Pre-loaded delta to start from (skips Qdrant/file loading). */
  initialDelta?: Record<string, WeightMatrix>;
  /** Pre-loaded resonance sensitivity delta. */
  initialResonanceDelta?: Record<string, Record<string, number>>;
}

export function createDigestor(options?: DigestorOptions): DigestorInstance {
  // Species memory: the δ (persisted across runs)
  const speciesMemory: Record<Species, WeightMatrix> = {
    summarizer: zeroMatrix(BEHAVIOR_KEYS.length, FEELINGS_DIM),
    sentinel: zeroMatrix(BEHAVIOR_KEYS.length, FEELINGS_DIM),
    herald: zeroMatrix(BEHAVIOR_KEYS.length, FEELINGS_DIM),
    anchor: zeroMatrix(BEHAVIOR_KEYS.length, FEELINGS_DIM),
    spore: zeroMatrix(BEHAVIOR_KEYS.length, FEELINGS_DIM),
  };

  // Resonance sensitivity delta: per-species → per-target-species
  const resonanceSensitivityDelta: Record<Species, Record<Species, number>> = {
    summarizer: zeroResonance(),
    sentinel: zeroResonance(),
    herald: zeroResonance(),
    anchor: zeroResonance(),
    spore: zeroResonance(),
  };

  // Apply initial delta if provided
  if (options?.initialDelta) {
    for (const sp of ALL_SPECIES) {
      if (options.initialDelta[sp]) {
        speciesMemory[sp] = options.initialDelta[sp].map(r => [...r]);
      }
    }
  }
  if (options?.initialResonanceDelta) {
    for (const sp of ALL_SPECIES) {
      if (options.initialResonanceDelta[sp]) {
        resonanceSensitivityDelta[sp] = { ...zeroResonance(), ...options.initialResonanceDelta[sp] };
      }
    }
  }

  let generationCount = 0;
  let lastDigestTick = 0;

  // Accumulators (reset at each digest)
  const actionFeelingsSums: Record<Species, WeightMatrix> = {} as any;
  const actionCounts: Record<Species, number[]> = {} as any;

  function resetAccumulators(): void {
    for (const sp of ALL_SPECIES) {
      actionFeelingsSums[sp] = zeroMatrix(BEHAVIOR_KEYS.length, FEELINGS_DIM);
      actionCounts[sp] = new Array(BEHAVIOR_KEYS.length).fill(0);
    }
  }

  resetAccumulators();

  return {
    getMemory(species: Species): WeightMatrix {
      return speciesMemory[species].map(row => [...row]);
    },

    getResonanceDelta(species: Species): Record<Species, number> {
      return { ...resonanceSensitivityDelta[species] };
    },

    recordAction(species: Species, behaviorIdx: number, feelings: Feelings): void {
      const fv = FEELING_KEYS.map(k => feelings[k]);
      for (let j = 0; j < FEELINGS_DIM; j++) {
        actionFeelingsSums[species][behaviorIdx][j] += fv[j];
      }
      actionCounts[species][behaviorIdx] += 1;
    },

    digest(survivors: MyceliumNode[], tickNumber: number): DigestResult {
      generationCount++;
      lastDigestTick = tickNumber;

      const buckets: Record<string, MyceliumNode[]> = {};
      for (const node of survivors) {
        if (!buckets[node.species]) buckets[node.species] = [];
        buckets[node.species].push(node);
      }

      const result: DigestResult = {
        generation: generationCount,
        tick: tickNumber,
        speciesStats: {},
      };

      // Pass 0: exponential decay on existing δ (prevents linear overshoot)
      if (DELTA_DECAY > 0) {
        for (const sp of ALL_SPECIES) {
          for (let i = 0; i < BEHAVIOR_KEYS.length; i++) {
            for (let j = 0; j < FEELINGS_DIM; j++) {
              speciesMemory[sp][i][j] *= (1 - DELTA_DECAY);
            }
          }
          for (const targetSp of ALL_SPECIES) {
            resonanceSensitivityDelta[sp][targetSp] *= (1 - DELTA_DECAY);
          }
        }
      }

      // Pass 1: compute per-species raw signals and learning rates
      const speciesSignals: Record<string, WeightMatrix> = {};
      const speciesLr: Record<string, number> = {};

      for (const sp of ALL_SPECIES) {
        const members = buckets[sp] || [];
        if (members.length === 0) {
          result.speciesStats[sp] = { count: 0, fitnessGate: 0, maxAbsDelta: 0 };
          continue;
        }

        const avgFitness = members.reduce((sum, n) => {
          const config = getSpeciesConfig(n.species);
          return sum + (n.h + Math.min(1, n.w) + n.ttl / config.initialTtl) / 3;
        }, 0) / members.length;

        speciesLr[sp] = LEARNING_RATE * avgFitness;

        // Per-feeling mean across all actions (baseline for this species)
        const feelingMean = new Array(FEELINGS_DIM).fill(0);
        let totalActions = 0;
        for (let i = 0; i < BEHAVIOR_KEYS.length; i++) {
          if (actionCounts[sp][i] === 0) continue;
          for (let j = 0; j < FEELINGS_DIM; j++) {
            feelingMean[j] += actionFeelingsSums[sp][i][j];
          }
          totalActions += actionCounts[sp][i];
        }
        if (totalActions > 0) {
          for (let j = 0; j < FEELINGS_DIM; j++) feelingMean[j] /= totalActions;
        }

        // Raw signal per action×feeling cell
        const sig = zeroMatrix(BEHAVIOR_KEYS.length, FEELINGS_DIM);
        for (let i = 0; i < BEHAVIOR_KEYS.length; i++) {
          if (actionCounts[sp][i] === 0) continue;
          for (let j = 0; j < FEELINGS_DIM; j++) {
            sig[i][j] = actionFeelingsSums[sp][i][j] / actionCounts[sp][i] - feelingMean[j];
          }
        }
        speciesSignals[sp] = sig;
      }

      // Pass 2: compute all-species mean signal, blend, and apply
      const activeSpecies = ALL_SPECIES.filter(sp => speciesSignals[sp]);
      const meanSignal = zeroMatrix(BEHAVIOR_KEYS.length, FEELINGS_DIM);
      if (activeSpecies.length > 0 && BLEND_ALPHA < 1.0) {
        for (const sp of activeSpecies) {
          for (let i = 0; i < BEHAVIOR_KEYS.length; i++) {
            for (let j = 0; j < FEELINGS_DIM; j++) {
              meanSignal[i][j] += speciesSignals[sp][i][j];
            }
          }
        }
        for (let i = 0; i < BEHAVIOR_KEYS.length; i++) {
          for (let j = 0; j < FEELINGS_DIM; j++) {
            meanSignal[i][j] /= activeSpecies.length;
          }
        }
      }

      for (const sp of activeSpecies) {
        const lr = speciesLr[sp];
        let maxAbs = 0;
        for (let i = 0; i < BEHAVIOR_KEYS.length; i++) {
          for (let j = 0; j < FEELINGS_DIM; j++) {
            const blended = BLEND_ALPHA * speciesSignals[sp][i][j]
                          + (1 - BLEND_ALPHA) * meanSignal[i][j];
            speciesMemory[sp][i][j] += lr * blended;
            speciesMemory[sp][i][j] = Math.max(-DELTA_CLAMP, Math.min(DELTA_CLAMP, speciesMemory[sp][i][j]));
            maxAbs = Math.max(maxAbs, Math.abs(speciesMemory[sp][i][j]));
          }
        }

        const members = buckets[sp]!;
        result.speciesStats[sp] = {
          count: members.length,
          fitnessGate: speciesLr[sp] / LEARNING_RATE,
          maxAbsDelta: maxAbs,
        };
      }

      // Pass 3: resonance sensitivity learning
      // For each species, compute average resonance toward each other species from survivors.
      // Positive avg → strengthen sensitivity, negative → weaken.
      for (const sp of ALL_SPECIES) {
        const members = buckets[sp] || [];
        if (members.length === 0) continue;
        const resScale = getSpeciesConfig(sp as Species).resonanceReceiveScale ?? 1.0;
        const lr = (speciesLr[sp] ?? LEARNING_RATE * M.learning.resonanceLrScale) * resScale;
        for (const targetSp of ALL_SPECIES) {
          let sum = 0;
          for (const n of members) sum += n.resonance[targetSp];
          const avgRes = sum / members.length;
          // Signal: normalized resonance (tanh-like soft clamp)
          const signal = Math.tanh(avgRes);
          // Blend with cross-species mean
          let crossMean = 0;
          if (activeSpecies.length > 1) {
            for (const otherSp of activeSpecies) {
              if (otherSp === sp) continue;
              const otherMembers = buckets[otherSp] || [];
              if (otherMembers.length === 0) continue;
              let s = 0;
              for (const n of otherMembers) s += n.resonance[targetSp];
              crossMean += Math.tanh(s / otherMembers.length);
            }
            crossMean /= (activeSpecies.length - 1);
          }
          const blended = BLEND_ALPHA * signal + (1 - BLEND_ALPHA) * crossMean;
          resonanceSensitivityDelta[sp][targetSp] += lr * blended;
          resonanceSensitivityDelta[sp][targetSp] = Math.max(-DELTA_CLAMP, Math.min(DELTA_CLAMP, resonanceSensitivityDelta[sp][targetSp]));
        }
      }

      resetAccumulators();
      return result;
    },

    getStats(): DigestorStats {
      const summary: Record<string, { maxAbsDelta: number }> = {};
      for (const sp of ALL_SPECIES) {
        let maxAbs = 0;
        for (const row of speciesMemory[sp]) {
          for (const v of row) maxAbs = Math.max(maxAbs, Math.abs(v));
        }
        summary[sp] = { maxAbsDelta: maxAbs };
      }
      return { generation: generationCount, lastDigestTick, speciesMemorySummary: summary };
    },

    load(config: MyceliumConfig): boolean {
      const mode = config.speciesMemory;

      if (mode === "none") {
        console.error("[mycelium:digestor] species memory: none (zero delta)");
        return false;
      }

      const filePath = mode === "latest"
        ? resolveLatestSnapshot(config.snapshotDir)
        : mode;

      if (!filePath) {
        console.error("[mycelium:digestor] no snapshot found in", config.snapshotDir);
        return false;
      }

      try {
        const raw = JSON.parse(readFileSync(filePath, "utf-8"));
        const delta = raw.delta as Record<string, number[][]> | undefined;
        if (!delta) {
          console.error(`[mycelium:digestor] snapshot has no delta field: ${filePath}`);
          return false;
        }
        let loaded = 0;
        for (const sp of ALL_SPECIES) {
          if (delta[sp]) {
            speciesMemory[sp] = delta[sp].map(r => [...r]);
            loaded++;
          }
        }
        // Load resonance sensitivity delta if present
        const resDelta = raw.resonanceDelta as Record<string, Record<string, number>> | undefined;
        if (resDelta) {
          for (const sp of ALL_SPECIES) {
            if (resDelta[sp]) {
              resonanceSensitivityDelta[sp] = { ...zeroResonance(), ...resDelta[sp] };
            }
          }
        }
        console.error(`[mycelium:digestor] loaded species memory from ${filePath} (${loaded} species)`);
        return loaded > 0;
      } catch (e) {
        console.error(`[mycelium:digestor] failed to load snapshot ${filePath}:`, e);
        return false;
      }
    },

    persist(config: MyceliumConfig): string {
      if (!existsSync(config.snapshotDir)) {
        mkdirSync(config.snapshotDir, { recursive: true });
      }

      const ts = new Date().toISOString().replace(/[-:]/g, "").replace("T", "T").slice(0, 15);
      const filename = `species-weights-${ts}.json`;
      const filePath = join(config.snapshotDir, filename);

      const data = {
        savedAt: new Date().toISOString(),
        generation: generationCount,
        delta: {} as Record<string, WeightMatrix>,
        resonanceDelta: {} as Record<string, Record<string, number>>,
      };
      for (const sp of ALL_SPECIES) {
        data.delta[sp] = speciesMemory[sp].map(r => [...r]);
        data.resonanceDelta[sp] = { ...resonanceSensitivityDelta[sp] };
      }

      writeFileSync(filePath, JSON.stringify(data, null, 2));
      console.error(`[mycelium:digestor] persisted species memory to ${filePath}`);
      return filePath;
    },

    setDelta(delta: Record<string, WeightMatrix>): void {
      for (const sp of ALL_SPECIES) {
        if (delta[sp]) {
          speciesMemory[sp] = delta[sp].map(r => [...r]);
        }
      }
    },

    getDelta(): Record<Species, WeightMatrix> {
      const out = {} as Record<Species, WeightMatrix>;
      for (const sp of ALL_SPECIES) {
        out[sp] = speciesMemory[sp].map(r => [...r]);
      }
      return out;
    },

    getResonanceDeltaAll(): Record<Species, Record<Species, number>> {
      const out = {} as Record<Species, Record<Species, number>>;
      for (const sp of ALL_SPECIES) {
        out[sp] = { ...resonanceSensitivityDelta[sp] };
      }
      return out;
    },

    setResonanceDelta(delta: Record<string, Record<string, number>>): void {
      for (const sp of ALL_SPECIES) {
        if (delta[sp]) {
          resonanceSensitivityDelta[sp] = { ...zeroResonance(), ...delta[sp] };
        }
      }
    },

    shouldDigest(tickNumber: number): boolean {
      const interval = M.scoring.digestIntervalTicks;
      return tickNumber > 0 && tickNumber % interval === 0;
    },
  };
}

// ---- Snapshot file resolution ----

function resolveLatestSnapshot(dir: string): string | null {
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir)
    .filter(f => f.startsWith("species-weights-") && f.endsWith(".json") && !f.includes("baseline"))
    .sort();
  if (files.length === 0) return null;
  return join(dir, files[files.length - 1]);
}

// ============================================================
// Default singleton instance (used by main server / tick / feeder)
// ============================================================

const defaultDigestor = createDigestor();

// Convenience re-exports that delegate to the default instance.
// These maintain backward-compat with server.ts, tick.ts, feeder.ts.

export function getSpeciesMemory(species: Species): WeightMatrix {
  return defaultDigestor.getMemory(species);
}

export function getSpeciesResonanceDelta(species: Species): Record<Species, number> {
  return defaultDigestor.getResonanceDelta(species);
}

export function recordAction(species: Species, behaviorIdx: number, feelings: Feelings): void {
  defaultDigestor.recordAction(species, behaviorIdx, feelings);
}

export function digestSpeciesMemory(survivors: MyceliumNode[], tickNumber: number): DigestResult {
  return defaultDigestor.digest(survivors, tickNumber);
}

export function getDigestorStats(): DigestorStats {
  return defaultDigestor.getStats();
}

export function loadSpeciesMemory(config: MyceliumConfig): boolean {
  return defaultDigestor.load(config);
}

export function persistSpeciesMemory(config: MyceliumConfig): string {
  return defaultDigestor.persist(config);
}

export function shouldDigest(tickNumber: number): boolean {
  return defaultDigestor.shouldDigest(tickNumber);
}
