// ============================================================
// Mycelium — Tick engine (I/O wrapper)
// ============================================================
//
// Thin wrapper around tick-core.ts that reads/writes the
// colony-store (in-memory). No per-tick Qdrant I/O.
//
// Qdrant is only touched for:
//   - spawn children upsert (new vectors need persistence)
//   - periodic flush (not yet, future enhancement)
//
// tick-core.ts contains the pure computation logic shared by
// production (this file), semantic-filter-test, and the loader.

import type { MyceliumConfig } from "../types.js";
import type { MetabolismSchema } from "../types.js";
import metabolismRaw from "../config/metabolism.json" with { type: "json" };
import { upsertPoints } from "../qdrant.js";
import { nodeToPayload } from "./node.js";
import { shouldDigest, digestSpeciesMemory, persistSpeciesMemory, recordAction } from "./digestor.js";
import { shouldCollect, collect as observatoryCollect } from "./observatory.js";
import { tickCore } from "./tick-core.js";
import * as store from "./colony-store.js";
import type { DeathRecord } from "./pushback.js";

const M = metabolismRaw as unknown as MetabolismSchema;

// Re-export types that consumers need
export type { NodeWithVector, TickCoreResult, TickCoreCallbacks, MergeEvent, SpawnResult } from "./tick-core.js";
export { tickCore, computeEnvironment, selectTarget } from "./tick-core.js";

// ---- Death log (accumulated across ticks, cleared on retrieval) ----

const deathLog = new Map<string, DeathRecord>();

export function getAndClearDeathLog(): Map<string, DeathRecord> {
  const snapshot = new Map(deathLog);
  deathLog.clear();
  return snapshot;
}

// ---- Tick result (backward-compatible summary) ----

export interface TickResult {
  tick: number;
  processed: number;
  expired: number;
  spawned: number;
  actions: Record<string, number>;
  interactions: number;
}

// ---- Single tick execution (colony-store based) ----

export async function runTick(config: MyceliumConfig, tickNumber: number): Promise<TickResult> {
  // 1. Read all nodes from in-memory store (no Qdrant I/O)
  const allNodes = store.getAll();

  if (allNodes.length === 0) {
    return { tick: tickNumber, processed: 0, expired: 0, spawned: 0, actions: {}, interactions: 0 };
  }

  // 2. Run pure tick computation
  const result = tickCore(allNodes, M, tickNumber, {
    recordAction,
  });

  // 3. Accumulate death records
  for (const [id, record] of result.deaths) {
    deathLog.set(id, record);
  }

  // 4. Update colony-store: apply survivors + deaths
  const deadIds = [...result.deaths.keys()];
  store.applyTickResult(result.survivors, deadIds);

  // 5. Handle spawn children: add to store + persist to Qdrant (new vectors)
  if (result.spawns.length > 0) {
    const children = result.spawns.flatMap(s => s.children);
    for (const c of children) {
      store.addNode(c);
    }
    // Persist new vectors to Qdrant for durability
    await upsertPoints(config.qdrantUrl, config.collection, children.map(c => ({
      id: c.node.id,
      vector: c.vector,
      payload: nodeToPayload(c.node),
    })));
    console.error(`[mycelium:spawn] ${result.spawnCount} children born from ${result.spawns.length} pairs`);
  }

  // 6. Observatory (side-effect)
  if (shouldCollect(tickNumber)) {
    observatoryCollect(
      tickNumber,
      result.survivors.map(nv => nv.node),
      result.actionCounts,
      result.mergeCount,
      result.spawnCount,
    );
  }

  // 7. Digestor (side-effect)
  if (shouldDigest(tickNumber) && result.survivors.length > 0) {
    const digestResult = digestSpeciesMemory(
      result.survivors.map(nv => nv.node),
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
    processed: allNodes.length,
    expired: deadIds.length,
    spawned: result.spawnCount,
    actions: result.actionCounts,
    interactions: result.interactionCount,
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
        `[mycelium] tick #${tickCount}: processed=${lastTickResult.processed} expired=${lastTickResult.expired} spawned=${lastTickResult.spawned} interactions=${lastTickResult.interactions} actions=${JSON.stringify(lastTickResult.actions)}`,
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
