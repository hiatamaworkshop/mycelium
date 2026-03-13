// ============================================================
// Dispatcher — cascade orchestration for FeedInstances
// ============================================================
//
// Two modes:
//
// 1. Shared mode (legacy): All slots share one Mycelium Qdrant collection.
//    Cross-instance interaction. Adaptive injection timing.
//    → run(slots)
//
// 2. World-isolated mode: Each world gets its own collection.
//    Singleton state is reset between worlds. Cascade still applies
//    within a world if it has multiple slots.
//    → runWorld(world, slots)

import type { MyceliumConfig } from "../types.js";
import type { SlotAssignment } from "./slot-allocator.js";
import type { WorldDefinition } from "./world-config.js";
import { FeedInstance } from "./feed-instance.js";
import type { SurvivorReport, ChunkClassification, ClassificationBreakdown } from "./feed-instance.js";
import { runTick, getAndClearDeathLog, resetTickState } from "../core/tick.js";
import type { TickResult } from "../core/tick.js";
import { ensureCollection } from "../qdrant.js";
import { loadSpeciesMemory, resetDefaultDigestor } from "../core/digestor.js";
import { clearSnapshots } from "../core/observatory.js";
import * as store from "../core/colony-store.js";

// ---- Dispatcher config ----

export interface DispatcherConfig {
  /** Ticks per instance before harvest */
  targetTicks: number;
  /** Tick% at which to harvest survivors (0.0–1.0). Controlled by FILTER_HARDNESS */
  harvestPct: number;
  /** Max ticks between cascade instance starts (fallback) */
  cascadeDelayTicks: number;
  /** Minimum ticks after inject before considering next (floor) */
  cascadeMinDelay: number;
  /** Absorption threshold: inject next when interactions drop to
   *  baseline + (peak - baseline) × absorptionRatio */
  absorptionRatio: number;
  /** Milliseconds between ticks */
  tickIntervalMs: number;
}

export const DEFAULT_DISPATCHER_CONFIG: DispatcherConfig = {
  targetTicks: 60,
  harvestPct: 0.6,
  cascadeDelayTicks: 30,
  cascadeMinDelay: 5,
  absorptionRatio: 0.4,
  tickIntervalMs: 3000,
};

// ---- Absorption detector ----

class AbsorptionDetector {
  private baseline = 0;
  private peak = 0;
  private ticksSinceInject = 0;
  private armed = false;

  constructor(
    private minDelay: number,
    private maxDelay: number,
    private ratio: number,
  ) {}

  /** Call before inject to snapshot current interaction baseline */
  recordBaseline(interactions: number): void {
    this.baseline = interactions;
    this.peak = 0;
    this.ticksSinceInject = 0;
    this.armed = true;
  }

  /** Feed each tick result; returns true when absorbed */
  feed(result: TickResult): boolean {
    if (!this.armed) return false;

    this.ticksSinceInject++;

    // Track peak
    if (result.interactions > this.peak) {
      this.peak = result.interactions;
    }

    // Max delay fallback
    if (this.ticksSinceInject >= this.maxDelay) {
      this.armed = false;
      console.error(
        `[dispatcher:absorb] max delay reached (${this.maxDelay} ticks), ` +
        `forcing next inject`,
      );
      return true;
    }

    // Min delay floor
    if (this.ticksSinceInject < this.minDelay) {
      return false;
    }

    // Absorption check: interactions dropped to threshold
    const threshold = this.baseline + (this.peak - this.baseline) * this.ratio;
    if (result.interactions <= threshold) {
      this.armed = false;
      console.error(
        `[dispatcher:absorb] absorbed at tick +${this.ticksSinceInject} ` +
        `(baseline=${this.baseline}, peak=${this.peak}, ` +
        `current=${result.interactions}, threshold=${threshold.toFixed(1)})`,
      );
      return true;
    }

    return false;
  }

  isWaiting(): boolean {
    return this.armed;
  }
}

// ---- Dispatcher ----

export class Dispatcher {
  private instances: FeedInstance[] = [];
  private globalTick = 0;
  private allReports: SurvivorReport[] = [];
  private lastTickResult: TickResult | null = null;

  constructor(
    private config: MyceliumConfig,
    private dispatchConfig: DispatcherConfig,
  ) {}

  // ---- Shared mode (legacy): all slots in one collection ----

  async run(slots: SlotAssignment[]): Promise<SurvivorReport[]> {
    await ensureCollection(
      this.config.qdrantUrl,
      this.config.collection,
      this.config.embeddingDimension,
    );
    loadSpeciesMemory(this.config);
    return this._runInternal(this.config, slots);
  }

  // ---- World-isolated mode: reset state, run in dedicated collection ----

  async runWorld(world: WorldDefinition, slots: SlotAssignment[]): Promise<SurvivorReport[]> {
    // 1. Reset all singleton state for clean isolation
    store.clear();
    resetTickState();
    clearSnapshots();
    resetDefaultDigestor();

    // 2. World-specific config
    const worldConfig: MyceliumConfig = {
      ...this.config,
      collection: world.collection,
    };

    // 3. Initialize world's Qdrant collection + species memory
    await ensureCollection(
      worldConfig.qdrantUrl,
      worldConfig.collection,
      worldConfig.embeddingDimension,
    );
    loadSpeciesMemory(worldConfig);

    // 4. Reset instance state
    this.instances = [];
    this.globalTick = 0;
    this.allReports = [];
    this.lastTickResult = null;

    console.error(
      `[dispatcher:world] "${world.name}" → collection=${world.collection}, ` +
      `${slots.length} slot(s), ${slots.reduce((s, sl) => s + sl.points.length, 0)} points`,
    );

    // 5. Run cascade within this world
    return this._runInternal(worldConfig, slots);
  }

  // ---- Internal cascade loop (shared by both modes) ----

  private async _runInternal(
    config: MyceliumConfig,
    slots: SlotAssignment[],
  ): Promise<SurvivorReport[]> {
    // Create FeedInstances from slot assignments
    this.instances = slots.map(
      (slot) => new FeedInstance(
        slot.slotId,
        slot.batchToken,
        slot.points,
        this.dispatchConfig.targetTicks,
        slot.chunkRegistry,
        this.dispatchConfig.harvestPct,
      ),
    );

    const totalPoints = slots.reduce((sum, s) => sum + s.points.length, 0);
    console.error(
      `[dispatcher] ${this.instances.length} slot(s), ` +
      `${totalPoints} total points, ` +
      `adaptive inject (min=${this.dispatchConfig.cascadeMinDelay}, ` +
      `max=${this.dispatchConfig.cascadeDelayTicks}, ` +
      `ratio=${this.dispatchConfig.absorptionRatio})`,
    );

    // Absorption detector for adaptive inject timing
    const detector = new AbsorptionDetector(
      this.dispatchConfig.cascadeMinDelay,
      this.dispatchConfig.cascadeDelayTicks,
      this.dispatchConfig.absorptionRatio,
    );

    // Track next instance to inject
    let nextInjectIdx = 0;
    let readyToInject = true; // first slot injects immediately

    // Main loop: run ticks until all instances complete
    while (this.hasWork()) {
      // Check if next pending instance should inject
      if (nextInjectIdx < this.instances.length && readyToInject) {
        const instance = this.instances[nextInjectIdx];

        // Record baseline before inject
        const baselineInteractions = this.lastTickResult?.interactions ?? 0;
        detector.recordBaseline(baselineInteractions);

        // IO control: inject is synchronous from tick loop's perspective
        // Other instances don't tick during inject (Qdrant I/O protection)
        await instance.inject(config, this.globalTick);
        nextInjectIdx++;
        readyToInject = false; // wait for absorption
      }

      // Run one tick (processes ALL nodes in the collection)
      this.globalTick++;
      const tickResult = await runTick(config, this.globalTick);
      this.lastTickResult = tickResult;

      // Collect death log from this tick and route to instances
      const tickDeaths = getAndClearDeathLog();
      for (const instance of this.instances) {
        await instance.onTick(tickDeaths, config);
      }

      // Check absorption: is the ecosystem ready for next inject?
      if (detector.isWaiting() && nextInjectIdx < this.instances.length) {
        if (detector.feed(tickResult)) {
          readyToInject = true;
        }
      }

      // Check for completed instances → harvest
      for (const instance of this.instances) {
        if (instance.isComplete()) {
          const reports = await instance.harvest(config);
          this.allReports.push(...reports);
        }
      }

      // Progress log every 10 ticks
      if (this.globalTick % 10 === 0) {
        const running = this.instances.filter(i => i.status === "running").length;
        const done = this.instances.filter(i => i.status === "done").length;
        const pending = this.instances.filter(i => i.status === "pending").length;
        console.error(
          `[dispatcher] tick ${this.globalTick}: ` +
          `pending=${pending} running=${running} done=${done} ` +
          `interactions=${tickResult.interactions} actions=${JSON.stringify(tickResult.actions)}`,
        );
      }

      // Tick interval
      await sleep(this.dispatchConfig.tickIntervalMs);
    }

    console.error(
      `[dispatcher] complete: ${this.globalTick} ticks, ` +
      `${this.allReports.length} source reports`,
    );

    return this.allReports;
  }

  private hasWork(): boolean {
    return this.instances.some(i => i.status !== "done" && i.status !== "lost");
  }

  // ---- Consensus mode: N-run majority vote ----

  async runWorldConsensus(
    world: WorldDefinition,
    slots: SlotAssignment[],
    runs: number,
    threshold = 0.4,
  ): Promise<SurvivorReport[]> {
    // Collect per-chunk votes across N runs.
    // Key = global sourcePoint index (slot offset + local index).
    const allVotes: Map<number, ChunkClassification[]> = new Map();

    // We need slot metadata from the first run to rebuild reports.
    let templateReports: SurvivorReport[] = [];

    // Track slot offsets: each slot's sourcePoints get a global index range.
    const slotOffsets: number[] = [];
    let offset = 0;
    for (const slot of slots) {
      slotOffsets.push(offset);
      offset += slot.points.length;
    }

    for (let run = 0; run < runs; run++) {
      console.error(`\n[consensus] run ${run + 1}/${runs} for world "${world.name}"`);

      // Full state reset
      store.clear();
      resetTickState();
      clearSnapshots();
      resetDefaultDigestor();

      const worldConfig: MyceliumConfig = {
        ...this.config,
        collection: world.collection,
      };

      await ensureCollection(
        worldConfig.qdrantUrl,
        worldConfig.collection,
        worldConfig.embeddingDimension,
      );
      loadSpeciesMemory(worldConfig);

      this.instances = [];
      this.globalTick = 0;
      this.allReports = [];
      this.lastTickResult = null;

      const reports = await this._runInternal(worldConfig, slots);

      // Collect per-chunk votes from each instance
      for (let si = 0; si < this.instances.length; si++) {
        const instance = this.instances[si];
        const baseOffset = slotOffsets[si];
        for (const [localIdx, cls] of instance.chunkVotes) {
          const globalIdx = baseOffset + localIdx;
          const votes = allVotes.get(globalIdx) ?? [];
          votes.push(cls);
          allVotes.set(globalIdx, votes);
        }
      }

      // Keep the last run's reports as template (for sourceId, collection, etc.)
      templateReports = reports;
    }

    // ---- Majority vote per chunk (with passing threshold) ----
    const consensusVotes: Map<number, ChunkClassification> = new Map();
    // Track which chunks passed the threshold
    const passedThreshold: Set<number> = new Set();
    const minVotes = Math.ceil(runs * threshold);

    for (const [idx, votes] of allVotes) {
      const { cls, count } = majorityVote(votes);
      consensusVotes.set(idx, cls);
      if (count >= minVotes) passedThreshold.add(idx);
    }

    // ---- Rebuild SurvivorReports from consensus votes ----
    // Map global sourcePoint index → qualifiedSourceId using slot data
    const globalIdxToSourceId: Map<number, string> = new Map();
    for (let si = 0; si < slots.length; si++) {
      const baseOffset = slotOffsets[si];
      for (let pi = 0; pi < slots[si].points.length; pi++) {
        const sp = slots[si].points[pi];
        const qualifiedSid = sp.payload.sourceId ?? String(sp.id);
        globalIdxToSourceId.set(baseOffset + pi, qualifiedSid);
      }
    }

    // Build per-sourceId consensus breakdown + per-source passing rate
    const sourceBreakdowns: Map<string, ClassificationBreakdown> = new Map();
    // Track per-source passing counts: sourceId → { total, passed }
    const sourceConsensus: Map<string, { total: number; passed: number }> = new Map();

    for (const [globalIdx, cls] of consensusVotes) {
      const sid = globalIdxToSourceId.get(globalIdx);
      if (!sid) continue;

      // Breakdown
      let bd = sourceBreakdowns.get(sid);
      if (!bd) {
        bd = { pure: 0, merged: 0, loner: 0, redundant: 0, dead: 0 };
        sourceBreakdowns.set(sid, bd);
      }
      bd[cls]++;

      // Passing rate per source (chunk met threshold?)
      let sc = sourceConsensus.get(sid);
      if (!sc) {
        sc = { total: 0, passed: 0 };
        sourceConsensus.set(sid, sc);
      }
      sc.total++;
      if (passedThreshold.has(globalIdx)) sc.passed++;
    }

    // Patch template reports with consensus breakdowns + per-source passing rate
    const consensusReports: SurvivorReport[] = templateReports.map(r => {
      const bd = sourceBreakdowns.get(r.sourceId) ?? r.classificationBreakdown;
      const survivorCount = bd.pure + bd.merged;
      const sc = sourceConsensus.get(r.sourceId);
      const rate = sc && sc.total > 0 ? sc.passed / sc.total : 1;
      return {
        ...r,
        classificationBreakdown: bd,
        survivingChunks: survivorCount,
        survivalRate: r.totalChunks > 0 ? survivorCount / r.totalChunks : 0,
        consensusRate: rate,
      };
    });

    console.error(
      `[consensus] ${runs} runs complete — ${consensusReports.length} sources ` +
      `(threshold=${(threshold * 100).toFixed(0)}%, minVotes=${minVotes}/${runs})`,
    );
    for (const r of consensusReports) {
      const sc = sourceConsensus.get(r.sourceId);
      console.error(
        `  ${r.sourceId}: passing ${((r.consensusRate ?? 0) * 100).toFixed(0)}% ` +
        `(${sc?.passed ?? 0}/${sc?.total ?? 0} passed)`,
      );
    }

    return consensusReports;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---- Consensus helpers ----

function majorityVote(votes: ChunkClassification[]): { cls: ChunkClassification; count: number } {
  const counts: Record<string, number> = {};
  for (const v of votes) {
    counts[v] = (counts[v] ?? 0) + 1;
  }
  let best: ChunkClassification = votes[0];
  let bestCount = 0;
  for (const [cls, n] of Object.entries(counts)) {
    if (n > bestCount) {
      bestCount = n;
      best = cls as ChunkClassification;
    }
  }
  return { cls: best, count: bestCount };
}

