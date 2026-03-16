#!/usr/bin/env node
// Bridge engram Qdrant (localhost:6333) → mycelium source collection (localhost:6334)
// Maps: summary→text, projectId→sourceId, tags passthrough

const ENGRAM_URL = "http://localhost:6333";
const MYCELIUM_URL = "http://localhost:6334";
const SOURCE_COLLECTION = "source_engram";
const ENGRAM_COLLECTION = "engram";

async function main() {
  // 1. Ensure target collection
  await fetch(`${MYCELIUM_URL}/collections/${SOURCE_COLLECTION}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ vectors: { size: 384, distance: "Cosine" } }),
  }).catch(() => {});

  // 2. Scroll all engram points
  let offset = null;
  let total = 0;

  do {
    const body = { limit: 50, with_payload: true, with_vectors: true };
    if (offset !== null) body.offset = offset;

    const res = await fetch(`${ENGRAM_URL}/collections/${ENGRAM_COLLECTION}/points/scroll`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    const points = data.result.points;

    if (points.length === 0) break;

    // Transform to SourcePoint schema
    const transformed = points.map(p => ({
      id: p.id,
      vector: p.vector,
      payload: {
        text: [p.payload.summary || "", p.payload.content || ""].filter(Boolean).join(" — "),
        sourceId: p.payload.projectId || "engram",
        tags: p.payload.tags || [],
        timestamp: p.payload.ingestedAt || Date.now(),
        engram_status: p.payload.status,
        engram_weight: p.payload.weight,
        engram_trigger: p.payload.trigger,
      },
    }));

    // Upsert to mycelium Qdrant
    const upsertRes = await fetch(`${MYCELIUM_URL}/collections/${SOURCE_COLLECTION}/points`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ points: transformed }),
    });

    if (!upsertRes.ok) {
      console.error(`[bridge] Upsert failed: ${await upsertRes.text()}`);
      process.exit(1);
    }

    total += transformed.length;
    console.error(`[bridge] Upserted ${transformed.length} points (total: ${total})`);

    offset = data.result.next_page_offset ?? null;
  } while (offset !== null);

  console.error(`[bridge] Done. ${total} points → ${MYCELIUM_URL}/collections/${SOURCE_COLLECTION}`);
}

main().catch(err => { console.error(err); process.exit(1); });
