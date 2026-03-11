// ============================================================
// SlotAllocator — cascade entry layer with IO control
// ============================================================
//
// Reads from multiple source Qdrant collections, groups chunks
// by sourceId (ensuring same-article chunks stay in one slot),
// and assigns groups to capacity-bounded slots.
//
// Qualified sourceId format: "{collection}:{rawSourceId}"
// This prevents ID collisions across collections.

import type { SourcePoint } from "./source-scroll.js";
import { scrollSourcePoints } from "./source-scroll.js";

// ---- Types ----

export interface SourceCollectionConfig {
  /** Qdrant URL (may differ from mycelium Qdrant) */
  qdrantUrl: string;
  /** Source collection name */
  collection: string;
}

export interface ChunkRegistryEntry {
  /** Total chunks expected for this sourceId */
  totalChunks: number;
  /** Original collection name */
  collection: string;
  /** Raw (unqualified) sourceId */
  rawSourceId: string;
}

/** Chunk registry: qualifiedSourceId → metadata */
export type ChunkRegistry = Map<string, ChunkRegistryEntry>;

export interface SlotAssignment {
  /** Slot identifier (e.g. "slot-0") */
  slotId: string;
  /** Unique batch token for tracking */
  batchToken: string;
  /** Source points assigned to this slot */
  points: SourcePoint[];
  /** Chunk registry: qualifiedSourceId → expected count */
  chunkRegistry: ChunkRegistry;
}

// ---- Qualify sourceId ----

export function qualifySourceId(collection: string, rawSourceId: string): string {
  return `${collection}:${rawSourceId}`;
}

// ---- Load & qualify source points from multiple collections ----

export async function loadSourceCollections(
  configs: SourceCollectionConfig[],
): Promise<SourcePoint[]> {
  const allPoints: SourcePoint[] = [];

  for (const cfg of configs) {
    console.error(`[slot-allocator] scrolling ${cfg.collection} from ${cfg.qdrantUrl} ...`);
    const points = await scrollSourcePoints(cfg.qdrantUrl, cfg.collection);

    // Qualify sourceIds to avoid cross-collection collisions
    for (const p of points) {
      const raw = p.payload.sourceId ?? String(p.id);
      p.payload.sourceId = qualifySourceId(cfg.collection, raw);
      // Tag with origin collection for traceability
      (p.payload as Record<string, unknown>)._originCollection = cfg.collection;
    }

    console.error(`  → ${points.length} points from ${cfg.collection}`);
    allPoints.push(...points);
  }

  return allPoints;
}

// ---- Allocate source points into slots ----

export function allocateSlots(
  sourcePoints: SourcePoint[],
  capacity: number,
): SlotAssignment[] {
  // 1. Group by qualified sourceId
  const groups = new Map<string, SourcePoint[]>();
  for (const p of sourcePoints) {
    const sid = p.payload.sourceId ?? String(p.id);
    const g = groups.get(sid);
    if (g) g.push(p);
    else groups.set(sid, [p]);
  }

  // 2. Bin-pack groups into slots respecting capacity
  //    Rule: all chunks of same sourceId MUST go to same slot
  const slots: SlotAssignment[] = [];
  let currentPoints: SourcePoint[] = [];
  let currentRegistry: ChunkRegistry = new Map();

  for (const [qualifiedSid, group] of groups) {
    // If adding this group exceeds capacity, finalize current slot
    if (currentPoints.length > 0 && currentPoints.length + group.length > capacity) {
      slots.push(finalizeSlot(slots.length, currentPoints, currentRegistry));
      currentPoints = [];
      currentRegistry = new Map();
    }

    currentPoints.push(...group);

    // Register chunk count for this sourceId
    const origin = (group[0].payload as Record<string, unknown>)._originCollection as string ?? "unknown";
    const raw = qualifiedSid.includes(":") ? qualifiedSid.split(":").slice(1).join(":") : qualifiedSid;
    currentRegistry.set(qualifiedSid, {
      totalChunks: group.length,
      collection: origin,
      rawSourceId: raw,
    });
  }

  // Finalize last slot
  if (currentPoints.length > 0) {
    slots.push(finalizeSlot(slots.length, currentPoints, currentRegistry));
  }

  // Log allocation summary
  console.error(`[slot-allocator] allocated ${sourcePoints.length} points → ${slots.length} slots:`);
  for (const s of slots) {
    const chunkedSources = [...s.chunkRegistry.entries()]
      .filter(([, e]) => e.totalChunks > 1)
      .map(([sid, e]) => `${sid}(${e.totalChunks} chunks)`);
    const singleSources = [...s.chunkRegistry.entries()].filter(([, e]) => e.totalChunks === 1).length;
    console.error(
      `  ${s.slotId}: ${s.points.length} points, ${s.chunkRegistry.size} sourceIds` +
      (chunkedSources.length > 0 ? ` [chunked: ${chunkedSources.join(", ")}]` : "") +
      (singleSources > 0 ? ` [single: ${singleSources}]` : ""),
    );
  }

  return slots;
}

// ---- Helpers ----

function finalizeSlot(
  index: number,
  points: SourcePoint[],
  registry: ChunkRegistry,
): SlotAssignment {
  const token = `batch-${index}-${Date.now().toString(36)}`;
  return {
    slotId: `slot-${index}`,
    batchToken: token,
    points: [...points],
    chunkRegistry: new Map(registry),
  };
}
