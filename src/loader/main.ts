#!/usr/bin/env node
// ============================================================
// Mycelium Universal Loader — CLI entry point
// ============================================================
//
// Reads pre-embedded data from multiple Source Qdrant collections,
// allocates into capacity-bounded slots (chunks stay together),
// runs through Mycelium tick engine, harvests survivors.
//
// Usage:
//   npx tsx src/loader/main.ts
//
// Environment:
//   QDRANT_URL            — Qdrant endpoint (default: http://localhost:6334)
//   SOURCE_COLLECTIONS    — Comma-separated source collection names (default: source)
//   MYCELIUM_COLLECTION   — Mycelium working collection (default: mycelium_loader)
//   TARGET_TICKS          — Ticks per instance (default: 60)
//   TICK_INTERVAL_MS      — Milliseconds between ticks (default: 3000)
//   SLOT_CAPACITY         — Max nodes per slot (default: 100)
//   CASCADE_DELAY         — Ticks between cascade slot starts (default: 12)

import { DEFAULT_CONFIG } from "../types.js";
import type { MyceliumConfig } from "../types.js";
import { checkQdrantHealth } from "../qdrant.js";
import { loadSourceCollections, allocateSlots } from "./slot-allocator.js";
import type { SourceCollectionConfig } from "./slot-allocator.js";
import { Dispatcher, DEFAULT_DISPATCHER_CONFIG } from "./dispatcher.js";
import type { DispatcherConfig } from "./dispatcher.js";
import type { SurvivorReport } from "./feed-instance.js";

// ---- Config from environment ----

const qdrantUrl = process.env.QDRANT_URL ?? "http://localhost:6334";

const sourceCollectionNames = (process.env.SOURCE_COLLECTIONS ?? "source")
  .split(",")
  .map(s => s.trim())
  .filter(s => s.length > 0);

const slotCapacity = parseInt(process.env.SLOT_CAPACITY ?? "100", 10);

const myceliumConfig: MyceliumConfig = {
  ...DEFAULT_CONFIG,
  qdrantUrl,
  collection: process.env.MYCELIUM_COLLECTION ?? "mycelium_loader",
};

const dispatchConfig: DispatcherConfig = {
  ...DEFAULT_DISPATCHER_CONFIG,
  targetTicks: parseInt(process.env.TARGET_TICKS ?? "60", 10),
  tickIntervalMs: parseInt(process.env.TICK_INTERVAL_MS ?? "3000", 10),
  cascadeDelayTicks: parseInt(process.env.CASCADE_MAX_DELAY ?? "30", 10),
  cascadeMinDelay: parseInt(process.env.CASCADE_MIN_DELAY ?? "5", 10),
  absorptionRatio: parseFloat(process.env.ABSORPTION_RATIO ?? "0.4"),
};

// ---- Main ----

async function main(): Promise<void> {
  console.error("=== Mycelium Universal Loader ===");
  console.error(`  qdrant:        ${qdrantUrl}`);
  console.error(`  sources:       ${sourceCollectionNames.join(", ")}`);
  console.error(`  mycelium:      ${myceliumConfig.collection}`);
  console.error(`  slot capacity: ${slotCapacity} nodes/slot`);
  console.error(`  ticks:         ${dispatchConfig.targetTicks}`);
  console.error(`  interval:      ${dispatchConfig.tickIntervalMs}ms`);
  console.error(`  cascade:       adaptive (min=${dispatchConfig.cascadeMinDelay}, max=${dispatchConfig.cascadeDelayTicks}, ratio=${dispatchConfig.absorptionRatio})`);
  console.error("");

  // Health check
  const healthy = await checkQdrantHealth(qdrantUrl);
  if (!healthy) {
    console.error(`[loader] Qdrant unreachable at ${qdrantUrl}`);
    process.exit(1);
  }

  // 1. Load from multiple source collections
  const sourceConfigs: SourceCollectionConfig[] = sourceCollectionNames.map(name => ({
    qdrantUrl,
    collection: name,
  }));

  const allSourcePoints = await loadSourceCollections(sourceConfigs);
  if (allSourcePoints.length === 0) {
    console.error("[loader] No source points found. Run prepare_source.py first.");
    process.exit(1);
  }
  console.error(`[loader] ${allSourcePoints.length} total source points loaded`);

  // 2. Allocate into slots (chunks stay together, capacity bounded)
  const slots = allocateSlots(allSourcePoints, slotCapacity);
  console.error(`[loader] ${slots.length} slot(s) allocated\n`);

  // 3. Dispatch (cascade pipeline)
  const dispatcher = new Dispatcher(myceliumConfig, dispatchConfig);
  const reports = await dispatcher.run(slots);

  // 4. Output results
  printReports(reports);
}

// ---- Report output ----

function printReports(reports: SurvivorReport[]): void {
  console.error("\n=== Survivor Reports ===\n");

  // Group by slot (batchToken)
  const bySlot = new Map<string, SurvivorReport[]>();
  for (const r of reports) {
    const group = bySlot.get(r.batchToken);
    if (group) group.push(r);
    else bySlot.set(r.batchToken, [r]);
  }

  for (const [token, slotReports] of bySlot) {
    const totalChunks = slotReports.reduce((s, r) => s + r.totalChunks, 0);
    const survivingChunks = slotReports.reduce((s, r) => s + r.survivingChunks, 0);
    const slotRate = totalChunks > 0 ? (survivingChunks / totalChunks * 100).toFixed(1) : "0.0";

    console.error(`--- Slot [${token}] ---`);
    console.error(`  sources: ${slotReports.length}, survival: ${survivingChunks}/${totalChunks} (${slotRate}%)`);

    // Highlight chunked sources (multi-part articles)
    const chunked = slotReports.filter(r => r.totalChunks > 1);
    if (chunked.length > 0) {
      console.error(`  chunked sources:`);
      for (const r of chunked) {
        console.error(
          `    ${r.sourceId}: ${r.survivingChunks}/${r.totalChunks} chunks survived ` +
          `(${(r.survivalRate * 100).toFixed(1)}%) parts=${r.partsComplete ? "OK" : "INCOMPLETE"}`,
        );
      }
    }

    // Species aggregate for slot
    const speciesAgg: Record<string, number> = {};
    for (const r of slotReports) {
      for (const [sp, n] of Object.entries(r.species)) {
        speciesAgg[sp] = (speciesAgg[sp] ?? 0) + n;
      }
    }
    const speciesLine = Object.entries(speciesAgg)
      .filter(([, n]) => n > 0)
      .map(([s, n]) => `${s}:${n}`)
      .join(", ");
    if (speciesLine) console.error(`  species: ${speciesLine}`);

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
