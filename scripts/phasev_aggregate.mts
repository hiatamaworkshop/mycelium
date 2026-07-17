// Phase V aggregation — unblind judgments, map X/Y → mycelium/baseline, tally.
import { readFileSync } from "node:fs";

const judgments = readFileSync("data/phasev/judgments.jsonl", "utf-8")
  .trim().split("\n").map(l => JSON.parse(l));
const keyPatent = JSON.parse(readFileSync("data/phasev/eval_key_patent.json", "utf-8"));
const keyArxiv = JSON.parse(readFileSync("data/phasev/eval_key_arxiv.json", "utf-8"));
const key: Record<string, { X: string; Y: string }> = { ...keyPatent, ...keyArxiv };

interface Row { file: string; myc: number; base: number; q: number; delta: number; winner: string }
const rows: Row[] = [];

for (const j of judgments) {
  const k = key[j.file];
  if (!k) { console.error("no key for", j.file); continue; }
  const myc = k.X === "mycelium" ? j.setX : j.setY;
  const base = k.X === "baseline" ? j.setX : j.setY;
  // normalize to answerability rate (answerable / questions)
  const q = j.questions;
  const mycR = myc / q, baseR = base / q;
  const delta = (mycR - baseR) * 100; // pt
  const winner = Math.abs(delta) < 0.01 ? "tie" : delta > 0 ? "mycelium" : "baseline";
  rows.push({ file: j.file, myc: mycR * 100, base: baseR * 100, q, delta, winner });
}

console.log("file".padEnd(18), "myc%".padStart(7), "base%".padStart(7), "Δpt".padStart(7), " winner");
for (const r of rows) {
  console.log(
    r.file.padEnd(18),
    r.myc.toFixed(1).padStart(7),
    r.base.toFixed(1).padStart(7),
    (r.delta >= 0 ? "+" : "") + r.delta.toFixed(1).padStart(6),
    " " + r.winner,
  );
}

const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
const mycMean = mean(rows.map(r => r.myc));
const baseMean = mean(rows.map(r => r.base));
const deltaMean = mean(rows.map(r => r.delta));
const mycWins = rows.filter(r => r.winner === "mycelium").length;
const baseWins = rows.filter(r => r.winner === "baseline").length;
const ties = rows.filter(r => r.winner === "tie").length;
const sameSignFrac = rows.filter(r => Math.sign(r.delta) === Math.sign(deltaMean)).length / rows.length;

console.log("\n=== AGGREGATE (n=" + rows.length + ") ===");
console.log("mycelium mean answerability:", mycMean.toFixed(1) + "%");
console.log("baseline mean answerability:", baseMean.toFixed(1) + "%");
console.log("mean Δ (myc - base):", (deltaMean >= 0 ? "+" : "") + deltaMean.toFixed(1) + "pt");
console.log("per-file wins → mycelium:", mycWins, "baseline:", baseWins, "tie:", ties);
console.log("files agreeing with mean sign:", (sameSignFrac * 100).toFixed(0) + "%");

// Pre-registered rule
let verdict: string;
if (deltaMean >= 5 && mycWins / rows.length >= 0.7) verdict = "MYCELIUM CORE JUSTIFIED (+>=5pt & >=70% same sign)";
else if (Math.abs(deltaMean) <= 5) verdict = "DRAW (±5pt) — value is in view layer + fuel loop + 3-axis vocab; baseline viable as default core";
else verdict = "BASELINE WINS (<=-5pt) — pivot";
console.log("\nVERDICT:", verdict);
