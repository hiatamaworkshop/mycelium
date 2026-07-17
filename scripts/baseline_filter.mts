// ============================================================
// Phase V baseline — cheap deterministic filter for comparison
// ============================================================
//
// The control arm of the Phase V validation: cosine dedup → greedy leader
// clustering → medoid selection, budget-matched to mycelium's per-file
// survivor count. No simulation, no randomness, no learned state.
// If this ~100-line pipeline matches mycelium's downstream quality
// (Q&A answerability), the tick-engine core is not earning its cost.
//
// Usage:
//   npx tsx scripts/baseline_filter.mts <collection> [--budget budgets.json] [--out out.json]
//
// budgets.json: { "<qualifiedSourceId>": <k>, ... } — from a mycelium run.
// Missing sourceIds fall back to ceil(chunks * 0.2) (~mycelium's typical rate).

import { writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { loadSourceCollections } from "../src/loader/slot-allocator.js";
import type { SourcePoint } from "../src/loader/source-scroll.js";

const QDRANT_URL = process.env.QDRANT_URL ?? "http://localhost:6334";
const DEDUP_THRESHOLD = parseFloat(process.env.BASELINE_DEDUP ?? "0.92");
const CLUSTER_THRESHOLD = parseFloat(process.env.BASELINE_CLUSTER ?? "0.5");

const args = process.argv.slice(2);
const collection = args[0];
if (!collection) {
  console.error("usage: baseline_filter.mts <collection> [--budget budgets.json] [--out out.json]");
  process.exit(1);
}
const budgetPath = args.includes("--budget") ? args[args.indexOf("--budget") + 1] : undefined;
const outPath = args.includes("--out") ? args[args.indexOf("--out") + 1] : undefined;
const budgets: Record<string, number> = budgetPath ? JSON.parse(readFileSync(budgetPath, "utf-8")) : {};

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

interface Selected { chunkSeqNo: number; text: string; clusterSize: number }

function filterFile(points: SourcePoint[], k: number): { selected: Selected[]; dedupDropped: number; clusters: number } {
  // 1. Cosine dedup — keep first occurrence (document order), drop near-dupes
  const kept: SourcePoint[] = [];
  for (const p of points) {
    const isDupe = kept.some(q => cosine(p.vector, q.vector) >= DEDUP_THRESHOLD);
    if (!isDupe) kept.push(p);
  }
  const dedupDropped = points.length - kept.length;

  // 2. Greedy leader clustering — join a cluster if cosine to its leader >= threshold
  const clusters: SourcePoint[][] = [];
  for (const p of kept) {
    let placed = false;
    for (const cl of clusters) {
      if (cosine(p.vector, cl[0].vector) >= CLUSTER_THRESHOLD) {
        cl.push(p);
        placed = true;
        break;
      }
    }
    if (!placed) clusters.push([p]);
  }

  // 3. Medoid per cluster — max mean cosine to other members (leader for singletons)
  const medoids = clusters.map(cl => {
    if (cl.length === 1) return { point: cl[0], size: 1 };
    let best = cl[0], bestScore = -Infinity;
    for (const p of cl) {
      let s = 0;
      for (const q of cl) if (q !== p) s += cosine(p.vector, q.vector);
      const mean = s / (cl.length - 1);
      if (mean > bestScore) { bestScore = mean; best = p; }
    }
    return { point: best, size: cl.length };
  });

  // 4. Budget matching: k medoids, largest clusters first; if k exceeds the
  //    cluster count, top up with the globally most-central remaining chunks
  medoids.sort((a, b) => b.size - a.size);
  const picked = medoids.slice(0, k);
  if (picked.length < k) {
    const pickedSet = new Set(picked.map(m => m.point));
    const rest = kept
      .filter(p => !pickedSet.has(p))
      .map(p => {
        let s = 0;
        for (const q of kept) if (q !== p) s += cosine(p.vector, q.vector);
        return { point: p, centrality: s / Math.max(1, kept.length - 1) };
      })
      .sort((a, b) => b.centrality - a.centrality);
    for (const r of rest.slice(0, k - picked.length)) picked.push({ point: r.point, size: 1 });
  }

  const selected = picked
    .map((m, i) => ({
      chunkSeqNo: m.point.payload.chunkSeqNo ?? i,
      text: m.point.payload.text,
      clusterSize: m.size,
    }))
    .sort((a, b) => a.chunkSeqNo - b.chunkSeqNo);

  return { selected, dedupDropped, clusters: clusters.length };
}

async function main() {
  const t0 = Date.now();
  const points = await loadSourceCollections([{ qdrantUrl: QDRANT_URL, collection }]);

  const bySource = new Map<string, SourcePoint[]>();
  for (const p of points) {
    const sid = p.payload.sourceId ?? String(p.id);
    const group = bySource.get(sid);
    if (group) group.push(p);
    else bySource.set(sid, [p]);
  }
  for (const group of bySource.values()) {
    group.sort((a, b) => (a.payload.chunkSeqNo ?? 0) - (b.payload.chunkSeqNo ?? 0));
  }

  const out: Record<string, { totalChunks: number; k: number; dedupDropped: number; clusters: number; selected: Selected[] }> = {};
  for (const [sid, group] of bySource) {
    const k = budgets[sid] ?? Math.max(1, Math.ceil(group.length * 0.2));
    const t = Date.now();
    const result = filterFile(group, k);
    out[sid] = { totalChunks: group.length, k, ...result };
    console.error(`[baseline] ${sid}: ${group.length} chunks → dedup -${result.dedupDropped} → ${result.clusters} clusters → ${result.selected.length} selected (k=${k}) in ${Date.now() - t}ms`);
  }

  const elapsed = Date.now() - t0;
  console.error(`[baseline] total: ${bySource.size} files in ${elapsed}ms (dedup>=${DEDUP_THRESHOLD}, cluster>=${CLUSTER_THRESHOLD})`);

  const json = JSON.stringify({ collection, elapsed, dedupThreshold: DEDUP_THRESHOLD, clusterThreshold: CLUSTER_THRESHOLD, files: out }, null, 2);
  if (outPath) {
    writeFileSync(outPath, json, "utf-8");
    console.error(`[baseline] written: ${outPath}`);
  } else {
    console.log(json);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
