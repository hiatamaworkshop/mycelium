// ============================================================
// Mycelium — Qdrant REST client (adapted from engram upper-layer)
// ============================================================

import type { MyceliumPointPayload } from "./types.js";

// ---- Collection management ----

export async function ensureCollection(
  url: string,
  name: string,
  dimension: number,
): Promise<void> {
  const check = await fetch(`${url}/collections/${name}`);
  if (!check.ok) {
    const res = await fetch(`${url}/collections/${name}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        vectors: { size: dimension, distance: "Cosine" },
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Qdrant ensureCollection failed (${res.status}): ${body}`);
    }
  }

  await createIndex(url, name, "species", "keyword");
  await createIndex(url, name, "createdAt", "integer");
  await createIndex(url, name, "lastActiveAt", "integer");
  await createIndex(url, name, "w", "float");
  await createIndex(url, name, "h", "float");
  await createIndex(url, name, "ttl", "integer");
}

async function createIndex(
  url: string,
  collection: string,
  field: string,
  schema: "keyword" | "integer" | "float",
): Promise<void> {
  const res = await fetch(
    `${url}/collections/${collection}/index`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        field_name: field,
        field_schema: schema,
      }),
    },
  );
  if (!res.ok && res.status !== 400) {
    console.warn(`[qdrant] index creation warning for ${field}: ${res.status}`);
  }
}

// ---- Point operations ----

export async function upsertPoints(
  url: string,
  collection: string,
  points: Array<{ id: string; vector: number[]; payload: MyceliumPointPayload }>,
): Promise<void> {
  if (points.length === 0) return;

  const res = await fetch(`${url}/collections/${collection}/points?wait=true`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ points }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Qdrant upsert failed (${res.status}): ${body}`);
  }
}

export async function searchPoints(
  url: string,
  collection: string,
  vector: number[],
  filter?: Record<string, unknown>,
  limit = 10,
): Promise<Array<{ id: string; score: number; payload: MyceliumPointPayload }>> {
  const body: Record<string, unknown> = {
    vector,
    limit,
    with_payload: true,
  };
  if (filter) body.filter = filter;

  const res = await fetch(`${url}/collections/${collection}/points/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Qdrant search failed (${res.status}): ${text}`);
  }

  const data = (await res.json()) as {
    result: Array<{ id: string; score: number; payload: MyceliumPointPayload }>;
  };
  return data.result;
}

export async function scrollPoints(
  url: string,
  collection: string,
  filter: Record<string, unknown>,
  limit: number,
): Promise<Array<{ id: string; payload: MyceliumPointPayload }>> {
  const res = await fetch(`${url}/collections/${collection}/points/scroll`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ filter, limit, with_payload: true }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Qdrant scroll failed (${res.status}): ${text}`);
  }

  const data = (await res.json()) as {
    result: { points: Array<{ id: string; payload: MyceliumPointPayload }> };
  };
  return data.result.points;
}

export async function deletePoints(
  url: string,
  collection: string,
  pointIds: string[],
): Promise<void> {
  if (pointIds.length === 0) return;

  const res = await fetch(`${url}/collections/${collection}/points/delete?wait=true`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ points: pointIds }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Qdrant delete failed (${res.status}): ${text}`);
  }
}

export async function setPayload(
  url: string,
  collection: string,
  pointIds: string[],
  payload: Partial<MyceliumPointPayload>,
): Promise<void> {
  if (pointIds.length === 0) return;

  const res = await fetch(`${url}/collections/${collection}/points/payload?wait=true`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ payload, points: pointIds }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Qdrant setPayload failed (${res.status}): ${text}`);
  }
}

export async function countPoints(
  url: string,
  collection: string,
  filter?: Record<string, unknown>,
): Promise<number> {
  const body: Record<string, unknown> = { exact: true };
  if (filter) body.filter = filter;

  const res = await fetch(`${url}/collections/${collection}/points/count`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Qdrant count failed (${res.status}): ${text}`);
  }

  const data = (await res.json()) as { result: { count: number } };
  return data.result.count;
}

export async function scrollAll(
  url: string,
  collection: string,
  withVectors = false,
  filter?: Record<string, unknown>,
): Promise<Array<{ id: string; payload: MyceliumPointPayload; vector?: number[] }>> {
  const allPoints: Array<{ id: string; payload: MyceliumPointPayload; vector?: number[] }> = [];
  let offset: string | number | null = null;

  do {
    const body: Record<string, unknown> = {
      limit: 100,
      with_payload: true,
      with_vectors: withVectors,
    };
    if (filter) body.filter = filter;
    if (offset !== null) body.offset = offset;

    const res = await fetch(`${url}/collections/${collection}/points/scroll`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Qdrant scrollAll failed (${res.status}): ${text}`);
    }

    const data = (await res.json()) as {
      result: {
        points: Array<{ id: string; payload: MyceliumPointPayload; vector?: number[] }>;
        next_page_offset?: string | number | null;
      };
    };
    allPoints.push(...data.result.points);
    offset = data.result.next_page_offset ?? null;
  } while (offset !== null);

  return allPoints;
}

export async function checkQdrantHealth(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}
