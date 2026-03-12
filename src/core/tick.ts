// ============================================================
// Mycelium — Tick engine (I/O wrapper)
// ============================================================
//
// Thin wrapper around tick-core.ts that handles Qdrant I/O,
// digestor persistence, and observatory collection.
//
// tick-core.ts contains the pure computation logic shared by
// production (this file), semantic-filter-test, and the loader.

import type { MyceliumConfig } from "../types.js";
import type { MetabolismSchema } from "../types.js";
import metabolismRaw from "../config/metabolism.json" with { type: "json" };
import { scrollAll, setPayload, deletePoints, upsertPoints } from "../qdrant.js";
import { payloadToNode, nodeToPayload } from "./node.js";
import { shouldDigest, digestSpeciesMemory, persistSpeciesMemory, recordAction } from "./digestor.js";
import { shouldCollect, collect as observatoryCollect } from "./observatory.js";
import { tickCore } from "./tick-core.js";
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

// ---- Single tick execution (I/O wrapper) ----

export async function runTick(config: MyceliumConfig, tickNumber: number): Promise<TickResult> {
  const { qdrantUrl, collection } = config;

  // 1. Scroll all nodes with vectors (I/O)
  const points = await scrollAll(qdrantUrl, collection, true);

  if (points.length === 0) {
    return { tick: tickNumber, processed: 0, expired: 0, spawned: 0, actions: {}, interactions: 0 };
  }

  // Convert to NodeWithVector
  const allNodes = points.map(p => ({
    node: payloadToNode(p.id, p.payload),
    vector: p.vector ?? null,
  }));

  // 2. Run pure tick computation
  const result = tickCore(allNodes, M, tickNumber, {
    recordAction,
  });

  // 3. Accumulate death records
  for (const [id, record] of result.deaths) {
    deathLog.set(id, record);
  }

  // 4. Upsert spawn children (I/O)
  if (result.spawns.length > 0) {
    const children = result.spawns.flatMap(s => s.children);
    await upsertPoints(qdrantUrl, collection, children.map(c => ({
      id: c.node.id,
      vector: c.vector,
      payload: nodeToPayload(c.node),
    })));
    console.error(`[mycelium:spawn] ${result.spawnCount} children born from ${result.spawns.length} pairs`);
  }

  // 5. Batch update survivors (I/O)
  if (result.survivors.length > 0) {
    await Promise.all(
      result.survivors.map(({ node }) =>
        setPayload(qdrantUrl, collection, [node.id], nodeToPayload(node)),
      ),
    );
  }

  // 6. Delete expired/consumed nodes (I/O)
  const deleteIds = [...result.deaths.keys()];
  if (deleteIds.length > 0) {
    await deletePoints(qdrantUrl, collection, deleteIds);
  }

  // 7. Observatory (side-effect)
  if (shouldCollect(tickNumber)) {
    observatoryCollect(
      tickNumber,
      result.survivors.map(nv => nv.node),
      result.actionCounts,
      result.mergeCount,
      result.spawnCount,
    );
  }

  // 8. Digestor (side-effect)
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
    processed: points.length,
    expired: deleteIds.length,
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
