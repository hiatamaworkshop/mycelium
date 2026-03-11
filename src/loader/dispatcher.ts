// ============================================================
// Dispatcher — cascade orchestration for FeedInstances
// ============================================================
//
// Receives SlotAssignment[] from the SlotAllocator and runs
// the cascade pipeline. Each slot becomes a FeedInstance.
//
// All instances share the same Mycelium Qdrant collection.
// The tick engine processes ALL nodes together — cross-instance
// interaction is a feature, not a bug.
//
// Injection timing: ADAPTIVE (ecosystem-driven)
//   After injecting a slot, monitor TickResult.interactions.
//   When the interaction spike settles (absorbed), inject next.
//   Fallback: cascadeDelayTicks (max wait).
//
// Cascade timeline example (3 slots, adaptive):
//   t=0  : slot-0 inject → slot-0 running
//   t=N  : interactions settled → slot-1 inject
//   t=M  : interactions settled → slot-2 inject
//   t=N+60: slot-0 complete → harvest
//   ...

import type { MyceliumConfig } from "../types.js";
import type { SlotAssignment } from "./slot-allocator.js";
import { FeedInstance } from "./feed-instance.js";
import type { SurvivorReport } from "./feed-instance.js";
import { runTick, getAndClearDeathLog } from "../core/tick.js";
import type { TickResult } from "../core/tick.js";
import { ensureCollection } from "../qdrant.js";
import { loadSpeciesMemory } from "../core/digestor.js";

// ---- Dispatcher config ----

export interface DispatcherConfig {
  /** Ticks per instance before harvest */
  targetTicks: number;
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

  // ---- Run the full cascade pipeline ----

  async run(slots: SlotAssignment[]): Promise<SurvivorReport[]> {
    // Initialize Qdrant collection
    await ensureCollection(
      this.config.qdrantUrl,
      this.config.collection,
      this.config.embeddingDimension,
    );
    loadSpeciesMemory(this.config);

    // Create FeedInstances from slot assignments
    this.instances = slots.map(
      (slot) => new FeedInstance(
        slot.slotId,
        slot.batchToken,
        slot.points,
        this.dispatchConfig.targetTicks,
        slot.chunkRegistry,
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
        await instance.inject(this.config, this.globalTick);
        nextInjectIdx++;
        readyToInject = false; // wait for absorption
      }

      // Run one tick (processes ALL nodes in the collection)
      this.globalTick++;
      const tickResult = await runTick(this.config, this.globalTick);
      this.lastTickResult = tickResult;

      // Collect death log from this tick and route to instances
      const tickDeaths = getAndClearDeathLog();
      for (const instance of this.instances) {
        instance.onTick(tickDeaths);
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
          const reports = await instance.harvest(this.config);
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
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
