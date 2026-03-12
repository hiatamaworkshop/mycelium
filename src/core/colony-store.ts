// ============================================================
// Mycelium — Colony Store (in-memory node + vector cache)
// ============================================================
//
// Holds all living nodes + vectors in memory. Eliminates per-tick
// Qdrant round-trips (scrollAll + setPayload × N).
//
// Qdrant is used only for:
//   - Initial load (bootstrap from persistent storage)
//   - Flush on demand (harvest, shutdown, periodic backup)
//   - MCP ingest (write-through: store + Qdrant)
//
// tick-core.ts is unchanged — it receives NodeWithVector[] and
// returns TickCoreResult. This module manages the array lifecycle.

import type { MyceliumNode, MyceliumPointPayload, Species } from "../types.js";
import type { NodeWithVector } from "./tick-core.js";
import { payloadToNode, nodeToPayload } from "./node.js";
import { scrollAll, upsertPoints, deletePoints } from "../qdrant.js";

// ---- Store state ----

const nodes = new Map<string, NodeWithVector>();
let loaded = false;

// ---- Bootstrap from Qdrant ----

export async function loadFromQdrant(qdrantUrl: string, collection: string): Promise<number> {
  const points = await scrollAll(qdrantUrl, collection, true);
  nodes.clear();
  for (const p of points) {
    nodes.set(p.id, {
      node: payloadToNode(p.id, p.payload),
      vector: p.vector ?? null,
    });
  }
  loaded = true;
  console.error(`[colony-store] loaded ${nodes.size} nodes from Qdrant`);
  return nodes.size;
}

export function isLoaded(): boolean {
  return loaded;
}

// ---- Read operations ----

export function getAll(): NodeWithVector[] {
  return Array.from(nodes.values());
}

export function getByIds(ids: Set<string>): NodeWithVector[] {
  const result: NodeWithVector[] = [];
  for (const id of ids) {
    const nv = nodes.get(id);
    if (nv) result.push(nv);
  }
  return result;
}

export function getNode(id: string): NodeWithVector | undefined {
  return nodes.get(id);
}

export function size(): number {
  return nodes.size;
}

export function countBySpecies(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const nv of nodes.values()) {
    counts[nv.node.species] = (counts[nv.node.species] ?? 0) + 1;
  }
  return counts;
}

// ---- Cosine search (brute-force, sufficient for N < ~5000) ----

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

export function search(
  queryVector: number[],
  limit: number,
): Array<{ id: string; score: number; payload: MyceliumPointPayload }> {
  const scored: Array<{ id: string; score: number; nv: NodeWithVector }> = [];
  for (const nv of nodes.values()) {
    if (!nv.vector) continue;
    scored.push({ id: nv.node.id, score: cosine(queryVector, nv.vector), nv });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map(s => ({
    id: s.id,
    score: s.score,
    payload: nodeToPayload(s.nv.node),
  }));
}

// ---- Write operations (in-memory only, no Qdrant) ----

export function applyTickResult(
  survivors: NodeWithVector[],
  deadIds: string[],
): void {
  // Remove dead nodes
  for (const id of deadIds) {
    nodes.delete(id);
  }
  // Update survivors in place (tickCore mutates node objects)
  // and add any new spawn children
  for (const nv of survivors) {
    nodes.set(nv.node.id, nv);
  }
}

export function addNode(nv: NodeWithVector): void {
  nodes.set(nv.node.id, nv);
}

export function removeNodes(ids: string[]): void {
  for (const id of ids) {
    nodes.delete(id);
  }
}

export function clear(): void {
  nodes.clear();
  loaded = false;
}

// ---- Flush to Qdrant (batch upsert + delete) ----

export async function flushToQdrant(
  qdrantUrl: string,
  collection: string,
): Promise<{ upserted: number }> {
  const allNvs = getAll();
  if (allNvs.length === 0) return { upserted: 0 };

  const BATCH = 100;
  const points = allNvs
    .filter(nv => nv.vector !== null)
    .map(nv => ({
      id: nv.node.id,
      vector: nv.vector!,
      payload: nodeToPayload(nv.node),
    }));

  for (let i = 0; i < points.length; i += BATCH) {
    await upsertPoints(qdrantUrl, collection, points.slice(i, i + BATCH));
  }

  console.error(`[colony-store] flushed ${points.length} nodes to Qdrant`);
  return { upserted: points.length };
}

// ---- Write-through for MCP ingest (store + Qdrant) ----

export async function ingestAndPersist(
  qdrantUrl: string,
  collection: string,
  id: string,
  vector: number[],
  node: MyceliumNode,
): Promise<void> {
  nodes.set(id, { node, vector });
  await upsertPoints(qdrantUrl, collection, [{
    id,
    vector,
    payload: nodeToPayload(node),
  }]);
}
