#!/usr/bin/env node
// ============================================================
// Mycelium Universal Loader — CLI entry point
// ============================================================
//
// Reads pre-embedded data from Source Qdrant, runs through
// Mycelium tick engine, harvests survivors.
//
// Usage:
//   npx tsx src/loader/main.ts [options]
//
// Environment:
//   QDRANT_URL          — Qdrant endpoint (default: http://localhost:6333)
//   SOURCE_COLLECTION   — Source Qdrant collection (default: source)
//   MYCELIUM_COLLECTION — Mycelium working collection (default: mycelium_loader)
//   TARGET_TICKS        — Ticks per instance (default: 60)
//   TICK_INTERVAL_MS    — Milliseconds between ticks (default: 3000)
//   INSTANCE_CAPACITY   — Max nodes per instance (default: 1000)
//   CASCADE_DELAY       — Ticks between cascade instance starts (default: 12)

import { DEFAULT_CONFIG } from "../types.js";
import type { MyceliumConfig } from "../types.js";
import { checkQdrantHealth } from "../qdrant.js";
import { scrollSourcePoints } from "./source-scroll.js";
import { Dispatcher, DEFAULT_DISPATCHER_CONFIG } from "./dispatcher.js";
import type { DispatcherConfig } from "./dispatcher.js";
import type { SurvivorReport } from "./feed-instance.js";

// ---- Config from environment ----

const qdrantUrl = process.env.QDRANT_URL ?? DEFAULT_CONFIG.qdrantUrl;
const sourceCollection = process.env.SOURCE_COLLECTION ?? "source";

const myceliumConfig: MyceliumConfig = {
  ...DEFAULT_CONFIG,
  qdrantUrl,
  collection: process.env.MYCELIUM_COLLECTION ?? "mycelium_loader",
};

const dispatchConfig: DispatcherConfig = {
  ...DEFAULT_DISPATCHER_CONFIG,
  targetTicks: parseInt(process.env.TARGET_TICKS ?? "60", 10),
  tickIntervalMs: parseInt(process.env.TICK_INTERVAL_MS ?? "3000", 10),
  instanceCapacity: parseInt(process.env.INSTANCE_CAPACITY ?? "1000", 10),
  cascadeDelayTicks: parseInt(process.env.CASCADE_DELAY ?? "12", 10),
};

// ---- Main ----

async function main(): Promise<void> {
  console.error("=== Mycelium Universal Loader ===");
  console.error(`  qdrant:     ${qdrantUrl}`);
  console.error(`  source:     ${sourceCollection}`);
  console.error(`  mycelium:   ${myceliumConfig.collection}`);
  console.error(`  ticks:      ${dispatchConfig.targetTicks}`);
  console.error(`  interval:   ${dispatchConfig.tickIntervalMs}ms`);
  console.error(`  capacity:   ${dispatchConfig.instanceCapacity} nodes/instance`);
  console.error(`  cascade:    ${dispatchConfig.cascadeDelayTicks} tick delay`);
  console.error("");

  // Health check
  const healthy = await checkQdrantHealth(qdrantUrl);
  if (!healthy) {
    console.error(`[loader] Qdrant unreachable at ${qdrantUrl}`);
    process.exit(1);
  }

  // 1. Scroll source collection
  console.error(`[loader] Scrolling source collection: ${sourceCollection}`);
  const sourcePoints = await scrollSourcePoints(qdrantUrl, sourceCollection);
  if (sourcePoints.length === 0) {
    console.error("[loader] No source points found. Run prepare_source.py first.");
    process.exit(1);
  }
  console.error(`[loader] ${sourcePoints.length} source points loaded`);

  // 2. Dispatch (cascade pipeline)
  const dispatcher = new Dispatcher(myceliumConfig, dispatchConfig);
  const reports = await dispatcher.run(sourcePoints);

  // 3. Output results
  printReports(reports);
}

// ---- Report output ----

function printReports(reports: SurvivorReport[]): void {
  console.error("\n=== Survivor Reports ===\n");

  for (const r of reports) {
    console.error(`[${r.sourceId}]`);
    console.error(`  survival: ${r.survivingChunks}/${r.totalChunks} (${(r.survivalRate * 100).toFixed(1)}%)`);
    console.error(`  species:  ${Object.entries(r.species).filter(([,n]) => n > 0).map(([s,n]) => `${s}:${n}`).join(", ")}`);
    console.error(`  sample:   "${r.survivingTexts[0]?.slice(0, 80) ?? "(none)"}"`);
    console.error("");
  }

  // JSON to stdout for programmatic consumption
  console.log(JSON.stringify(reports, null, 2));
}

// ---- Run ----

main().catch((err) => {
  console.error("[loader] Fatal:", err);
  process.exit(1);
});
