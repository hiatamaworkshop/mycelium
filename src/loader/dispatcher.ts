// ============================================================
// Dispatcher — cascade orchestration for FeedInstances
// ============================================================
//
// Phase 1: single instance (cascade of 1)
// Phase 2: multiple instances with staggered inject
//
// All instances share the same Mycelium Qdrant collection.
// The tick engine processes ALL nodes together — cross-instance
// interaction is a feature, not a bug.
//
// Cascade timeline (3 instances, cascadeDelay=12):
//   t=0  : A inject (pause others) → A running
//   t=12 : pause A → B inject → A resume, B running
//   t=24 : pause A,B → C inject → A,B resume, C running
//   t=60 : A complete → harvest A
//   t=72 : B complete → harvest B
//   t=84 : C complete → harvest C

import type { MyceliumConfig } from "../types.js";
import type { SourcePoint } from "./source-scroll.js";
import { FeedInstance } from "./feed-instance.js";
import type { SurvivorReport } from "./feed-instance.js";
import { runTick } from "../core/tick.js";
import { ensureCollection } from "../qdrant.js";
import { loadSpeciesMemory } from "../core/digestor.js";

// ---- Dispatcher config ----

export interface DispatcherConfig {
  /** Nodes per instance (soft cap, grouped by sourceId) */
  instanceCapacity: number;
  /** Ticks per instance before harvest */
  targetTicks: number;
  /** Ticks between cascade instance starts */
  cascadeDelayTicks: number;
  /** Milliseconds between ticks */
  tickIntervalMs: number;
}

export const DEFAULT_DISPATCHER_CONFIG: DispatcherConfig = {
  instanceCapacity: 1000,
  targetTicks: 60,
  cascadeDelayTicks: 12,
  tickIntervalMs: 3000,
};

// ---- Dispatcher ----

export class Dispatcher {
  private instances: FeedInstance[] = [];
  private globalTick = 0;
  private allReports: SurvivorReport[] = [];

  constructor(
    private config: MyceliumConfig,
    private dispatchConfig: DispatcherConfig,
  ) {}

  // ---- Partition source points into instance-sized batches ----

  private partitionIntoBatches(sourcePoints: SourcePoint[]): SourcePoint[][] {
    const cap = this.dispatchConfig.instanceCapacity;
    const batches: SourcePoint[][] = [];
    let current: SourcePoint[] = [];

    // Group by sourceId first, then fill batches
    const grouped = new Map<string, SourcePoint[]>();
    for (const p of sourcePoints) {
      const sid = p.payload.sourceId ?? String(p.id);
      const g = grouped.get(sid);
      if (g) g.push(p);
      else grouped.set(sid, [p]);
    }

    for (const [, group] of grouped) {
      // If adding this sourceId exceeds capacity, start new batch
      if (current.length > 0 && current.length + group.length > cap) {
        batches.push(current);
        current = [];
      }
      current.push(...group);
    }
    if (current.length > 0) batches.push(current);

    return batches;
  }

  // ---- Run the full cascade pipeline ----

  async run(sourcePoints: SourcePoint[]): Promise<SurvivorReport[]> {
    // Initialize Qdrant collection
    await ensureCollection(
      this.config.qdrantUrl,
      this.config.collection,
      this.config.embeddingDimension,
    );
    loadSpeciesMemory(this.config);

    // Partition into batches → create FeedInstances
    const batches = this.partitionIntoBatches(sourcePoints);
    this.instances = batches.map(
      (batch, i) => new FeedInstance(`batch-${i}`, batch, this.dispatchConfig.targetTicks),
    );

    console.error(
      `[dispatcher] ${this.instances.length} instance(s), ` +
      `${sourcePoints.length} total points, ` +
      `cascade delay=${this.dispatchConfig.cascadeDelayTicks} ticks`,
    );

    // Schedule: which tick each instance should inject at
    const injectSchedule = this.instances.map(
      (_, i) => i * this.dispatchConfig.cascadeDelayTicks,
    );

    // Track next instance to inject
    let nextInjectIdx = 0;

    // Main loop: run ticks until all instances complete
    while (this.hasWork()) {
      // Check if any pending instance should inject at this tick
      while (
        nextInjectIdx < this.instances.length &&
        this.globalTick >= injectSchedule[nextInjectIdx]
      ) {
        const instance = this.instances[nextInjectIdx];

        // Pause running instances during inject (Qdrant I/O protection)
        // In Phase 1 (single instance) this is a no-op
        const wasRunning = this.instances.filter(i => i.status === "running");
        // "Pause" = we just don't run a tick while injecting
        // The inject is synchronous from the tick loop's perspective

        await instance.inject(this.config, this.globalTick);
        nextInjectIdx++;
      }

      // Run one tick (processes ALL nodes in the collection)
      this.globalTick++;
      await runTick(this.config, this.globalTick);

      // Notify all running instances
      for (const instance of this.instances) {
        instance.onTick();
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
          `pending=${pending} running=${running} done=${done}`,
        );
      }

      // Tick interval
      await sleep(this.dispatchConfig.tickIntervalMs);
    }

    console.error(
      `[dispatcher] complete: ${this.globalTick} ticks, ` +
      `${this.allReports.length} reports`,
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
