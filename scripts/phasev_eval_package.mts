// ============================================================
// Phase V eval package builder — budgets + blinded comparison sets
// ============================================================
//
// Two modes:
//
// 1. budgets — extract per-file survivor counts from a mycelium report JSON,
//    for budget-matching the baseline run:
//      npx tsx scripts/phasev_eval_package.mts budgets <mycelium_report.json> <out_budgets.json>
//
// 2. package — build blinded per-file eval packages. For each file: full text
//    (all chunks, document order), Set X and Set Y (mycelium survivors vs
//    baseline selection, label assignment randomized per file). The label→
//    pipeline mapping goes ONLY into the key file, which the judge must not
//    read until all answerability judgments are recorded:
//      npx tsx scripts/phasev_eval_package.mts package <collection> \
//        <mycelium_report.json> <baseline_out.json> <out_dir> <key_file.json>

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadSourceCollections } from "../src/loader/slot-allocator.js";

const QDRANT_URL = process.env.QDRANT_URL ?? "http://localhost:6334";

interface ReportChunk { chunkSeqNo: number; text: string }
interface Report { sourceId: string; totalChunks: number; survivingChunks: number; chunkDetails?: ReportChunk[] }

const mode = process.argv[2];

if (mode === "budgets") {
  const [reportPath, outPath] = process.argv.slice(3);
  const reports: Report[] = JSON.parse(readFileSync(reportPath, "utf-8"));
  const budgets: Record<string, number> = {};
  for (const r of reports) {
    if (r.survivingChunks > 0) budgets[r.sourceId] = r.survivingChunks;
  }
  writeFileSync(outPath, JSON.stringify(budgets, null, 2), "utf-8");
  console.error(`[budgets] ${Object.keys(budgets).length} file(s) → ${outPath}`);
  process.exit(0);
}

if (mode !== "package") {
  console.error("usage: phasev_eval_package.mts budgets|package ...");
  process.exit(1);
}

const [collection, myceliumPath, baselinePath, outDir, keyPath] = process.argv.slice(3);

async function main() {
  const reports: Report[] = JSON.parse(readFileSync(myceliumPath, "utf-8"));
  const baseline = JSON.parse(readFileSync(baselinePath, "utf-8"));

  const points = await loadSourceCollections([{ qdrantUrl: QDRANT_URL, collection }]);
  const bySource = new Map<string, Array<{ seq: number; text: string }>>();
  for (const p of points) {
    const sid = p.payload.sourceId ?? String(p.id);
    const group = bySource.get(sid) ?? [];
    group.push({ seq: p.payload.chunkSeqNo ?? 0, text: p.payload.text });
    bySource.set(sid, group);
  }
  for (const g of bySource.values()) g.sort((a, b) => a.seq - b.seq);

  mkdirSync(outDir, { recursive: true });
  const key: Record<string, { X: string; Y: string }> = {};
  let built = 0;

  for (const r of reports) {
    const sid = r.sourceId;
    const full = bySource.get(sid);
    const base = baseline.files[sid];
    const mycChunks = (r.chunkDetails ?? []).map(c => ({ seq: c.chunkSeqNo, text: c.text }));
    if (!full || !base || mycChunks.length === 0) {
      console.error(`[package] skip ${sid} (full=${!!full} base=${!!base} myc=${mycChunks.length})`);
      continue;
    }
    const baseChunks = base.selected.map((s: { chunkSeqNo: number; text: string }) => ({ seq: s.chunkSeqNo, text: s.text }));

    const mycFirst = Math.random() < 0.5;
    const setX = mycFirst ? mycChunks : baseChunks;
    const setY = mycFirst ? baseChunks : mycChunks;
    key[sid] = { X: mycFirst ? "mycelium" : "baseline", Y: mycFirst ? "baseline" : "mycelium" };

    const fmt = (chunks: Array<{ seq: number; text: string }>) =>
      chunks.map(c => `[${c.seq}] ${c.text}`).join("\n\n");

    const pkg = [
      `# EVAL PACKAGE: ${sid}`,
      `total chunks: ${full.length} | Set X: ${setX.length} | Set Y: ${setY.length}`,
      ``,
      `## FULL TEXT (document order)`,
      ``,
      fmt(full),
      ``,
      `## SET X`,
      ``,
      fmt(setX),
      ``,
      `## SET Y`,
      ``,
      fmt(setY),
      ``,
    ].join("\n");

    const safe = sid.replace(/[^a-zA-Z0-9_-]/g, "_");
    writeFileSync(join(outDir, `${safe}.md`), pkg, "utf-8");
    built++;
  }

  writeFileSync(keyPath, JSON.stringify(key, null, 2), "utf-8");
  console.error(`[package] ${built} package(s) → ${outDir}; key → ${keyPath} (do NOT read until judging is done)`);
}

main().catch(e => { console.error(e); process.exit(1); });
