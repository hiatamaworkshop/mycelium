#!/usr/bin/env node
// ============================================================
// Mycelium Universal Loader — CLI entry point
// ============================================================
//
// Reads pre-embedded data from Source Qdrant collections,
// allocates into capacity-bounded slots, and runs through the
// Mycelium tick engine with optional world isolation.
//
// Usage:
//   npx tsx src/loader/main.ts
//
// Environment:
//   QDRANT_URL            — Qdrant endpoint (default: http://localhost:6334)
//   SOURCE_COLLECTIONS    — Comma-separated source collection names (default: source)
//   MYCELIUM_COLLECTION   — Default Mycelium collection (default: mycelium_loader)
//   ISOLATION             — "shared" | "domain" | "custom" (default: shared)
//   WORLD_MAP             — Custom world grouping (custom mode only)
//                           Format: "name1=col1,col2;name2=col3"
//   CLEAN_WORLDS          — "true" to delete world collections before run
//   TARGET_TICKS          — Ticks per instance (default: 60)
//   TICK_INTERVAL_MS      — Milliseconds between ticks (default: 0)
//   SLOT_CAPACITY         — Max nodes per slot (default: 100)
//   CASCADE_MAX_DELAY     — Max ticks between cascade inject (default: 30)
//   CASCADE_MIN_DELAY     — Min ticks before considering next inject (default: 5)
//   ABSORPTION_RATIO      — Interaction spike absorption threshold (default: 0.4)
//   FILTER_HARDNESS       — "soft" | "mid" | "hard" (default: mid)
//   CONSENSUS_RUNS        — Number of runs for majority-vote consensus (default: 10)
//   CONSENSUS_THRESHOLD   — Min vote ratio to consider a chunk's classification stable (default: 0.4)
//   CONSENSUS_JITTER      — Per-run initial w/h perturbation (0-1, default: 0.1 = ±10%)

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../types.js";
import type { MyceliumConfig } from "../types.js";
import { checkQdrantHealth, deleteCollection } from "../qdrant.js";
import { loadSourceCollections, allocateSlots } from "./slot-allocator.js";
import type { SourceCollectionConfig, SlotAssignment } from "./slot-allocator.js";
import { Dispatcher, DEFAULT_DISPATCHER_CONFIG } from "./dispatcher.js";
import type { DispatcherConfig } from "./dispatcher.js";
import type { SurvivorReport } from "./feed-instance.js";
import { parseIsolationMode, buildWorldDefinitions } from "./world-config.js";
import { resolveHardness } from "./hardness.js";

// ---- Config from environment ----

const { level: hardnessLevel, preset: hardnessPreset } = resolveHardness(process.env.FILTER_HARDNESS);

const qdrantUrl = process.env.QDRANT_URL ?? "http://localhost:6334";

const sourceCollectionNames = (process.env.SOURCE_COLLECTIONS ?? "source")
  .split(",")
  .map(s => s.trim())
  .filter(s => s.length > 0);

const slotCapacity = parseInt(process.env.SLOT_CAPACITY ?? "100", 10);
const cleanWorlds = (process.env.CLEAN_WORLDS ?? "").toLowerCase() === "true";
const consensusRuns = Math.max(1, parseInt(process.env.CONSENSUS_RUNS ?? "10", 10));
const consensusThreshold = parseFloat(process.env.CONSENSUS_THRESHOLD ?? "0.4");
const consensusJitter = parseFloat(process.env.CONSENSUS_JITTER ?? "0.1");

const myceliumConfig: MyceliumConfig = {
  ...DEFAULT_CONFIG,
  qdrantUrl,
  collection: process.env.MYCELIUM_COLLECTION ?? "mycelium_loader",
};

const dispatchConfig: DispatcherConfig = {
  ...DEFAULT_DISPATCHER_CONFIG,
  targetTicks: parseInt(process.env.TARGET_TICKS ?? "60", 10),
  harvestPct: hardnessPreset.harvestPct,
  tickIntervalMs: parseInt(process.env.TICK_INTERVAL_MS ?? "0", 10),
  cascadeDelayTicks: parseInt(process.env.CASCADE_MAX_DELAY ?? "30", 10),
  cascadeMinDelay: parseInt(process.env.CASCADE_MIN_DELAY ?? "5", 10),
  absorptionRatio: parseFloat(process.env.ABSORPTION_RATIO ?? "0.4"),
};

// ---- Sandwich reorder ----

function sandwichReorder(slots: SlotAssignment[]): void {
  slots.sort((a, b) => b.points.length - a.points.length);
  const sorted = [...slots];
  slots.length = 0;
  let lo = 0, hi = sorted.length - 1;
  for (let toggle = true; lo <= hi; toggle = !toggle) {
    slots.push(toggle ? sorted[lo++] : sorted[hi--]);
  }
}

// ---- Main ----

async function main(): Promise<void> {
  const isolationMode = parseIsolationMode(process.env.ISOLATION);

  const sourceConfigs: SourceCollectionConfig[] = sourceCollectionNames.map(name => ({
    qdrantUrl,
    collection: name,
  }));

  const worlds = buildWorldDefinitions(
    isolationMode,
    sourceConfigs,
    process.env.WORLD_MAP,
    myceliumConfig.collection,
  );

  console.error("=== Mycelium Universal Loader ===");
  console.error(`  qdrant:        ${qdrantUrl}`);
  console.error(`  sources:       ${sourceCollectionNames.join(", ")}`);
  console.error(`  isolation:     ${isolationMode} (${worlds.length} world(s))`);
  console.error(`  slot capacity: ${slotCapacity} nodes/slot`);
  console.error(`  hardness:      ${hardnessLevel} (harvest at ${(hardnessPreset.harvestPct * 100).toFixed(0)}% of ticks)`);
  console.error(`  ticks:         ${dispatchConfig.targetTicks}`);
  console.error(`  interval:      ${dispatchConfig.tickIntervalMs}ms`);
  console.error(`  cascade:       adaptive (min=${dispatchConfig.cascadeMinDelay}, max=${dispatchConfig.cascadeDelayTicks}, ratio=${dispatchConfig.absorptionRatio})`);
  if (consensusRuns > 1) console.error(`  consensus:     ${consensusRuns} runs (threshold=${(consensusThreshold * 100).toFixed(0)}%, jitter=${(consensusJitter * 100).toFixed(0)}%)`);
  if (cleanWorlds) console.error(`  clean:         enabled (world collections will be recreated)`);
  for (const w of worlds) {
    console.error(`  world "${w.name}": ${w.collection} ← [${w.sourceCollections.map(s => s.collection).join(", ")}]`);
  }
  console.error("");

  // Health check
  const healthy = await checkQdrantHealth(qdrantUrl);
  if (!healthy) {
    console.error(`[loader] Qdrant unreachable at ${qdrantUrl}`);
    process.exit(1);
  }

  const allReports: SurvivorReport[] = [];

  if (isolationMode === "shared") {
    // Legacy shared mode: all sources → one world, use run()
    const allSourcePoints = await loadSourceCollections(sourceConfigs);
    if (allSourcePoints.length === 0) {
      console.error("[loader] No source points found. Run prepare_source.py first.");
      process.exit(1);
    }
    console.error(`[loader] ${allSourcePoints.length} total source points loaded`);

    const slots = allocateSlots(allSourcePoints, slotCapacity);
    sandwichReorder(slots);
    console.error(`[loader] ${slots.length} slot(s) allocated (inject order: ${slots.map(s => s.points.length).join(" → ")})\n`);

    const dispatcher = new Dispatcher(myceliumConfig, dispatchConfig);
    if (consensusRuns > 1) {
      const syntheticWorld = {
        name: "shared",
        collection: myceliumConfig.collection,
        sourceCollections: sourceConfigs,
      };
      const reports = await dispatcher.runWorldConsensus(syntheticWorld, slots, consensusRuns, consensusThreshold, consensusJitter);
      allReports.push(...reports);
    } else {
      const reports = await dispatcher.run(slots);
      allReports.push(...reports);
    }
  } else {
    // World-isolated mode: each world runs independently
    for (let wi = 0; wi < worlds.length; wi++) {
      const world = worlds[wi];
      console.error(`\n${"=".repeat(60)}`);
      console.error(`=== World ${wi + 1}/${worlds.length}: "${world.name}" ===`);
      console.error(`${"=".repeat(60)}`);

      // Optional: clean world collection
      if (cleanWorlds) {
        const deleted = await deleteCollection(qdrantUrl, world.collection);
        if (deleted) console.error(`[loader:${world.name}] cleaned collection ${world.collection}`);
      }

      // Load source points for this world
      const worldSourcePoints = await loadSourceCollections(world.sourceCollections);
      if (worldSourcePoints.length === 0) {
        console.error(`[loader:${world.name}] no source points, skipping`);
        continue;
      }
      console.error(`[loader:${world.name}] ${worldSourcePoints.length} source points loaded`);

      // Allocate into slots + reorder
      const slots = allocateSlots(worldSourcePoints, slotCapacity);
      sandwichReorder(slots);
      console.error(
        `[loader:${world.name}] ${slots.length} slot(s) allocated ` +
        `(inject order: ${slots.map(s => s.points.length).join(" → ")})`,
      );

      // Run world in isolation (with optional consensus)
      const dispatcher = new Dispatcher(myceliumConfig, dispatchConfig);

      let reports: SurvivorReport[];
      if (consensusRuns > 1) {
        reports = await dispatcher.runWorldConsensus(world, slots, consensusRuns, consensusThreshold, consensusJitter);
      } else {
        reports = await dispatcher.runWorld(world, slots);
      }

      // Stamp world name on reports
      for (const r of reports) {
        r.worldName = world.name;
      }

      allReports.push(...reports);
    }
  }

  // Output results
  printReports(allReports);
}

// ---- Report output ----

function printReports(reports: SurvivorReport[]): void {
  console.error("\n=== Survivor Reports ===\n");

  // Group by world, then by slot
  const byWorld = new Map<string, SurvivorReport[]>();
  for (const r of reports) {
    const key = r.worldName ?? "shared";
    const group = byWorld.get(key);
    if (group) group.push(r);
    else byWorld.set(key, [r]);
  }

  for (const [worldName, worldReports] of byWorld) {
    if (byWorld.size > 1) {
      console.error(`--- World: ${worldName} ---\n`);
    }

    // Group by slot (batchToken)
    const bySlot = new Map<string, SurvivorReport[]>();
    for (const r of worldReports) {
      const group = bySlot.get(r.batchToken);
      if (group) group.push(r);
      else bySlot.set(r.batchToken, [r]);
    }

    for (const [token, slotReports] of bySlot) {
      const totalChunks = slotReports.reduce((s, r) => s + r.totalChunks, 0);
      const survivingChunks = slotReports.reduce((s, r) => s + r.survivingChunks, 0);
      const slotRate = totalChunks > 0 ? (survivingChunks / totalChunks * 100).toFixed(1) : "0.0";

      // Aggregate chunk-level classification breakdown across all sources in slot
      const slotBreakdown: Record<string, number> = {};
      for (const r of slotReports) {
        for (const [cls, n] of Object.entries(r.classificationBreakdown)) {
          if (n > 0) slotBreakdown[cls] = (slotBreakdown[cls] ?? 0) + n;
        }
      }
      const breakdownLine = Object.entries(slotBreakdown)
        .map(([k, v]) => `${k}:${v}`)
        .join(" ");

      console.error(`  Slot [${token}]`);
      console.error(`    sources: ${slotReports.length}, survival: ${survivingChunks}/${totalChunks} (${slotRate}%)`);
      console.error(`    3-axis: ${breakdownLine}`);

      // Per-source detail with chunk-level breakdown
      for (const r of slotReports) {
        const bd = r.classificationBreakdown;
        const bdParts = Object.entries(bd)
          .filter(([, n]) => n > 0)
          .map(([k, v]) => `${k}:${v}`)
          .join(" ");
        const consensusSuffix = r.consensusRate != null
          ? ` passing:${(r.consensusRate * 100).toFixed(0)}%`
          : "";
        console.error(
          `      ${r.sourceId}: ${r.survivingChunks}/${r.totalChunks} survived ` +
          `(${(r.survivalRate * 100).toFixed(1)}%) [${bdParts}]${consensusSuffix}`,
        );
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
      if (speciesLine) console.error(`    species: ${speciesLine}`);

      console.error("");
    }
  }

  // JSON to stdout for programmatic consumption
  console.log(JSON.stringify(reports, null, 2));

  // Save to file
  saveReports(reports);
}

// ---- Report file persistence ----

function saveReports(reports: SurvivorReport[]): void {
  const reportDir = process.env.REPORT_DIR ?? join("data", "reports");
  mkdirSync(reportDir, { recursive: true });

  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

  // Determine world names for filename
  const worldNames = [...new Set(reports.map(r => r.worldName ?? "shared"))];
  const worldLabel = worldNames.length <= 3
    ? worldNames.join("+")
    : `${worldNames.length}worlds`;

  const filename = `${worldLabel}_${ts}.json`;
  const filepath = join(reportDir, filename);

  writeFileSync(filepath, JSON.stringify(reports, null, 2), "utf-8");
  console.error(`[loader] Report saved: ${filepath}`);
}

// ---- Run ----

main().catch((err) => {
  console.error("[loader] Fatal:", err);
  process.exit(1);
});
