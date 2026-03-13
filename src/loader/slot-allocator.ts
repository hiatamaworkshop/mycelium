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

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { SourcePoint } from "./source-scroll.js";
import { scrollSourcePoints } from "./source-scroll.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const META_DIR = join(__dirname, "..", "..", "data", "meta");

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
  /** Doc-level metadata from sidecar (dataset, abstract, etc.) */
  metadata?: Record<string, unknown>;
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

// ---- Metadata sidecar loading ----

/** Load doc-level metadata from data/meta/{collection}.json if it exists. */
function loadMetaSidecar(collection: string): Map<string, Record<string, unknown>> {
  const metaPath = join(META_DIR, `${collection}.json`);
  const map = new Map<string, Record<string, unknown>>();
  if (!existsSync(metaPath)) return map;
  try {
    const raw = JSON.parse(readFileSync(metaPath, "utf-8")) as Record<string, Record<string, unknown>>;
    for (const [sid, meta] of Object.entries(raw)) {
      map.set(sid, meta);
    }
    console.error(`[slot-allocator] loaded metadata sidecar: ${metaPath} (${map.size} docs)`);
  } catch (e) {
    console.error(`[slot-allocator] failed to load metadata sidecar: ${metaPath}`, e);
  }
  return map;
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

    // Load metadata sidecar for this collection
    const metaSidecar = loadMetaSidecar(cfg.collection);

    // Qualify sourceIds to avoid cross-collection collisions
    for (const p of points) {
      const raw = p.payload.sourceId ?? String(p.id);
      p.payload.sourceId = qualifySourceId(cfg.collection, raw);
      // Tag with origin collection for traceability
      const ext = p.payload as Record<string, unknown>;
      ext._originCollection = cfg.collection;
      // Attach doc-level metadata from sidecar (if available)
      const meta = metaSidecar.get(raw);
      if (meta) ext._sourceMeta = meta;
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

    // Register chunk count + metadata for this sourceId
    const ext = group[0].payload as Record<string, unknown>;
    const origin = ext._originCollection as string ?? "unknown";
    const raw = qualifiedSid.includes(":") ? qualifiedSid.split(":").slice(1).join(":") : qualifiedSid;
    const sourceMeta = ext._sourceMeta as Record<string, unknown> | undefined;
    currentRegistry.set(qualifiedSid, {
      totalChunks: group.length,
      collection: origin,
      rawSourceId: raw,
      metadata: sourceMeta,
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
