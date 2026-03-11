// ============================================================
// Mycelium — Engram Feeder (poll engram Qdrant, birth new nodes)
// ============================================================
//
// Polls the engram Qdrant collection for nodes newer than lastPoll.
// Converts each engram node into a mycelium node (different data shape).
// Reuses engram's embedding vector (same model: all-MiniLM-L6-v2, 384d).
//
// Engram is never modified. Read-only access.

import type { MyceliumConfig, Species } from "../types.js";
import { createNode, nodeToPayload, resolveSpecies, getSpeciesConfig } from "./node.js";
import type { NutritionOverrides } from "./node.js";
import { getSpeciesMemory, getSpeciesResonanceDelta } from "./digestor.js";
import { upsertPoints } from "../qdrant.js";
import type { MetabolismSchema } from "../types.js";
import metabolismRaw from "../config/metabolism.json" with { type: "json" };

const M = metabolismRaw as unknown as MetabolismSchema;

// ---- Engram payload shape (read-only, minimal subset) ----

interface EngramPayload {
  summary: string;
  content?: string;
  tags: string[];
  trigger: string;
  projectId: string;
  ingestedAt: number;
  // Raw engram metrics (used by nutrition mapping)
  weight?: number;
  hitCount?: number;
  status?: string;
  lastAccessedAt?: number;
}

// ---- Nutrition mapping (engram metrics → mycelium birth conditions) ----
// Front-layer orchestrator: engram raw metrics → ±30% bias on baseline w/h/d.
// Not optimization — maternal nutrition from the engram ecosystem.
//
// w ← weight:    tanh(weight/3) × 0.3 — sigmoid, saturates at ±3
// h ← hitCount:  min(hitCount/5, 1) × 0.3 — more recall hits = warmer start
// d ← hitCount:  inverse — more hits = slower decay
// status=fixed:  +15% w, −15% d (already promoted in engram)

const NUT = M.nutrition;

function computeNutrition(p: EngramPayload, species: Species): NutritionOverrides {
  const baseW = M.birth.initialW;
  const baseH = M.birth.initialH;
  const baseD = getSpeciesConfig(species).initialDecay;

  // weight → w bias (±bias%)
  const wBias = NUT.bias * Math.tanh((p.weight ?? 0) / NUT.weightSaturation);

  // hitCount → h bias (+0~bias%), d bias (−0~bias%)
  const hitRatio = Math.min((p.hitCount ?? 0) / NUT.hitCountCap, 1);
  const hBias = NUT.bias * hitRatio;
  const dBias = -NUT.bias * hitRatio;

  // status=fixed bonus
  const fixed = p.status === "fixed";
  const fixedW = fixed ? NUT.fixedBonus : 0;
  const fixedD = fixed ? -NUT.fixedBonus : 0;

  return {
    w: baseW * (1 + wBias + fixedW),
    h: baseH * (1 + hBias),
    d: baseD * (1 + dBias + fixedD),
  };
}

// ---- State ----

let lastPollTimestamp = 0;
let totalIngested = 0;

// ---- Poll engram collection ----

export async function pollEngram(
  config: MyceliumConfig,
  engramCollection: string,
  engramProjectId?: string,
): Promise<number> {
  const { qdrantUrl, collection } = config;

  // Build filter: optional projectId + optional ingestedAt
  const must: Array<Record<string, unknown>> = [];
  if (engramProjectId && engramProjectId !== "all") {
    must.push({ key: "projectId", match: { value: engramProjectId } });
  }
  if (lastPollTimestamp > 0) {
    must.push({ key: "ingestedAt", range: { gt: lastPollTimestamp } });
  }
  const filter = must.length > 0 ? { must } : undefined;

  const points = await scrollEngramNodes(qdrantUrl, engramCollection, filter);

  if (points.length === 0) return 0;

  const myceliumPoints: Array<{ id: string; vector: number[]; payload: ReturnType<typeof nodeToPayload> }> = [];

  // NUTRITION_BYPASS=1 → ignore external w/h/d, use default initial values
  const bypass = process.env.NUTRITION_BYPASS === "1";

  for (const point of points) {
    const p = point.payload;

    // Convert engram trigger → mycelium species (with inherited species memory)
    const trigger = p.trigger || "manual";
    const species = resolveSpecies(trigger);
    const inherited = getSpeciesMemory(species);
    const inheritedRes = getSpeciesResonanceDelta(species);

    // Nutrition: compute from engram metrics (bypass → use metabolism defaults)
    const nutrition: NutritionOverrides | undefined =
      bypass ? undefined : computeNutrition(p, species);

    const { node } = createNode(p.summary, p.content, trigger, inherited, inheritedRes, nutrition);
    node.engramId = String(point.id);

    myceliumPoints.push({
      id: node.id,  // new UUID — not engram's ID
      vector: point.vector,
      payload: nodeToPayload(node),
    });

    // Track highest ingestedAt
    if (p.ingestedAt > lastPollTimestamp) {
      lastPollTimestamp = p.ingestedAt;
    }
  }

  // Batch upsert into mycelium collection
  await upsertPoints(qdrantUrl, collection, myceliumPoints);

  totalIngested += myceliumPoints.length;
  console.error(
    `[mycelium:feeder] ingested ${myceliumPoints.length} nodes from engram (total: ${totalIngested})`,
  );

  return myceliumPoints.length;
}

// ---- Scroll engram Qdrant (raw, typed to engram payload) ----

async function scrollEngramNodes(
  url: string,
  collection: string,
  filter?: Record<string, unknown>,
): Promise<Array<{ id: string; payload: EngramPayload; vector: number[] }>> {
  const allPoints: Array<{ id: string; payload: EngramPayload; vector: number[] }> = [];
  let offset: string | number | null = null;

  do {
    const body: Record<string, unknown> = {
      limit: 100,
      with_payload: true,
      with_vectors: true,
    };
    if (filter) body.filter = filter;
    if (offset !== null) body.offset = offset;

    const res = await fetch(`${url}/collections/${collection}/points/scroll`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      // engram collection might not exist — not fatal
      if (res.status === 404) {
        console.error(`[mycelium:feeder] engram collection "${collection}" not found, skipping`);
        return [];
      }
      const text = await res.text();
      throw new Error(`Engram scroll failed (${res.status}): ${text}`);
    }

    const data = (await res.json()) as {
      result: {
        points: Array<{ id: string; payload: EngramPayload; vector: number[] }>;
        next_page_offset?: string | number | null;
      };
    };
    allPoints.push(...data.result.points);
    offset = data.result.next_page_offset ?? null;
  } while (offset !== null);

  return allPoints;
}

// ---- Stats ----

export function getFeederStats(): { lastPollTimestamp: number; totalIngested: number } {
  return { lastPollTimestamp, totalIngested };
}
