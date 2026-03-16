// ============================================================
// Source Qdrant scroll — fetch SourcePoints from external collection
// ============================================================
//
// Source Qdrant contains pre-embedded data (prepare_source.py output).
// Payload conforms to Mycelium System Protocol.

// ---- Source point shape (read from Source Qdrant) ----

export interface SourcePoint {
  id: string;
  vector: number[];
  payload: {
    text: string;
    sourceId?: string;
    chunkSeqNo?: number;
    tags?: string[];
    timestamp?: number;
    [key: string]: unknown;
  };
}

// ---- Scroll all source points (paginated) ----

export async function scrollSourcePoints(
  qdrantUrl: string,
  collection: string,
): Promise<SourcePoint[]> {
  const allPoints: SourcePoint[] = [];
  let offset: string | number | null = null;

  do {
    const body: Record<string, unknown> = {
      limit: 100,
      with_payload: true,
      with_vectors: true,
    };
    if (offset !== null) body.offset = offset;

    const res = await fetch(`${qdrantUrl}/collections/${collection}/points/scroll`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      if (res.status === 404) {
        throw new Error(`Source collection "${collection}" not found`);
      }
      const text = await res.text();
      throw new Error(`Source scroll failed (${res.status}): ${text}`);
    }

    const data = (await res.json()) as {
      result: {
        points: SourcePoint[];
        next_page_offset?: string | number | null;
      };
    };
    allPoints.push(...data.result.points.map(normalizePayload));
    offset = data.result.next_page_offset ?? null;
  } while (offset !== null);

  return allPoints;
}

// ---- Payload normalization (external schema → SourcePoint) ----

function normalizePayload(raw: SourcePoint): SourcePoint {
  const p = raw.payload;

  // text: fallback to summary + content (engram schema)
  if (!p.text) {
    const summary = typeof p.summary === "string" ? p.summary : "";
    const content = typeof p.content === "string" ? p.content : "";
    p.text = [summary, content].filter(Boolean).join(" — ") || String(raw.id);
  }

  // sourceId: fallback to projectId (engram schema)
  if (!p.sourceId && typeof p.projectId === "string") {
    p.sourceId = p.projectId;
  }

  // tags: ensure array
  if (!Array.isArray(p.tags)) {
    p.tags = [];
  }

  return raw;
}

// ---- Group source points by sourceId ----

export function groupBySourceId(points: SourcePoint[]): Map<string, SourcePoint[]> {
  const groups = new Map<string, SourcePoint[]>();
  for (const p of points) {
    const sid = p.payload.sourceId ?? String(p.id);
    const group = groups.get(sid);
    if (group) {
      group.push(p);
    } else {
      groups.set(sid, [p]);
    }
  }
  return groups;
}
