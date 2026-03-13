#!/usr/bin/env node
// ============================================================
// Mycelium Universal Loader — CLI entry point
// ============================================================
//
// Reads pre-embedded data from Source Qdrant collections,
// allocates into capacity-bounded slots, and runs through the
// Mycelium tick engine via isolated parallel runners.
//
// Each slot (1 sourceId = 1 file) runs in its own IsolatedRunner
// with no shared state. p-limit controls concurrency.
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
//   PARALLEL_SLOTS        — Max concurrent slot runners (default: 3)
//   TARGET_TICKS          — Ticks per instance (default: 60)
//   TICK_INTERVAL_MS      — Milliseconds between ticks (default: 0)
//   SLOT_CAPACITY         — Max nodes per slot (default: 100)
//   FILTER_HARDNESS       — "soft" | "mid" | "hard" (default: mid)
//   CONSENSUS_RUNS        — Number of runs for majority-vote consensus (default: 10)
//   CONSENSUS_THRESHOLD   — Min vote ratio to consider a chunk's classification stable (default: 0.4)
//   CONSENSUS_JITTER      — Per-run initial w/h perturbation (0-1, default: 0.1 = ±10%)
//   FILTER_SOURCE_IDS     — Comma-separated source IDs to process (e.g. "8,14" or "source_arxiv:8")
//   VIEW_FORMAT           — Output format: "digest" | "manifest" | "compact" | "detailed" | "structured" (default: raw JSON)

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../types.js";
import type { MyceliumConfig } from "../types.js";
import { checkQdrantHealth, deleteCollection } from "../qdrant.js";
import { loadSourceCollections, allocateSlots } from "./slot-allocator.js";
import type { SourceCollectionConfig, SlotAssignment } from "./slot-allocator.js";
import { DEFAULT_DISPATCHER_CONFIG } from "./dispatcher.js";
import type { DispatcherConfig } from "./dispatcher.js";
import type { SurvivorReport } from "./feed-instance.js";
import { parseIsolationMode, buildWorldDefinitions } from "./world-config.js";
import { resolveHardness } from "./hardness.js";
import { IsolatedRunner, pLimit } from "./isolated-runner.js";
import { formatReports } from "../output/formatters.js";
import type { ViewFormat } from "../output/formatters.js";

// ---- Config from environment ----

const { level: hardnessLevel, preset: hardnessPreset } = resolveHardness(process.env.FILTER_HARDNESS);

const qdrantUrl = process.env.QDRANT_URL ?? "http://localhost:6334";

const sourceCollectionNames = (process.env.SOURCE_COLLECTIONS ?? "source")
  .split(",")
  .map(s => s.trim())
  .filter(s => s.length > 0);

const slotCapacity = parseInt(process.env.SLOT_CAPACITY ?? "100", 10);
const cleanWorlds = (process.env.CLEAN_WORLDS ?? "").toLowerCase() === "true";
const parallelSlots = Math.max(1, parseInt(process.env.PARALLEL_SLOTS ?? "3", 10));
const consensusRuns = Math.max(1, parseInt(process.env.CONSENSUS_RUNS ?? "10", 10));
const consensusThreshold = parseFloat(process.env.CONSENSUS_THRESHOLD ?? "0.4");
const consensusJitter = parseFloat(process.env.CONSENSUS_JITTER ?? "0.1");
const viewFormat = (process.env.VIEW_FORMAT ?? "") as ViewFormat | "";
const filterSourceIds = (process.env.FILTER_SOURCE_IDS ?? "")
  .split(",")
  .map(s => s.trim())
  .filter(s => s.length > 0);

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
  console.error(`  parallel:      ${parallelSlots} slot(s)`);
  console.error(`  hardness:      ${hardnessLevel} (harvest at ${(hardnessPreset.harvestPct * 100).toFixed(0)}% of ticks)`);
  console.error(`  ticks:         ${dispatchConfig.targetTicks}`);
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

  // Collect all slots across worlds with their world name
  const slotQueue: Array<{ slot: SlotAssignment; worldName: string }> = [];

  for (let wi = 0; wi < worlds.length; wi++) {
    const world = worlds[wi];
    if (worlds.length > 1) {
      console.error(`\n--- World "${world.name}" ---`);
    }

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

    // Allocate into slots (1 sourceId = 1 slot)
    let slots = allocateSlots(worldSourcePoints, slotCapacity);

    // Filter by FILTER_SOURCE_IDS if specified (matches raw id or qualified id)
    if (filterSourceIds.length > 0) {
      slots = slots.filter(s => {
        const qualifiedIds = [...s.chunkRegistry.keys()];
        return qualifiedIds.some(qid => {
          const rawId = qid.includes(":") ? qid.split(":").slice(1).join(":") : qid;
          return filterSourceIds.includes(rawId) || filterSourceIds.includes(qid);
        });
      });
      console.error(`[loader:${world.name}] filtered to ${slots.length} slot(s) by FILTER_SOURCE_IDS`);
    }

    console.error(
      `[loader:${world.name}] ${slots.length} slot(s): ` +
      `${slots.map(s => `${s.slotId}(${s.points.length})`).join(", ")}`,
    );

    for (const slot of slots) {
      slotQueue.push({ slot, worldName: world.name });
    }
  }

  if (slotQueue.length === 0) {
    console.error("[loader] No source points found. Run prepare_source.py first.");
    process.exit(1);
  }

  // ---- Parallel execution via p-limit ----
  const limit = pLimit(parallelSlots);
  const startTime = Date.now();
  let completed = 0;

  console.error(
    `\n[loader] starting ${slotQueue.length} slot(s) with concurrency=${parallelSlots}\n`,
  );

  const reportPromises = slotQueue.map(({ slot, worldName }) =>
    limit(async () => {
      const runner = new IsolatedRunner(myceliumConfig, dispatchConfig);
      runner.loadSpeciesMemory();

      const slotStart = Date.now();
      const sid = [...slot.chunkRegistry.keys()][0] ?? slot.slotId;
      console.error(`[runner:${slot.slotId}] start ${sid} (${slot.points.length} chunks, ${consensusRuns} runs)`);

      let reports: SurvivorReport[];
      if (consensusRuns > 1) {
        reports = runner.runConsensus(slot, consensusRuns, consensusThreshold, consensusJitter);
      } else {
        const { reports: r } = runner.runOnce(slot, consensusJitter);
        reports = r;
      }

      // Stamp world name
      for (const r of reports) {
        r.worldName = worldName;
      }

      completed++;
      const elapsed = ((Date.now() - slotStart) / 1000).toFixed(1);
      const survival = reports.length > 0
        ? `${reports[0].survivingChunks}/${reports[0].totalChunks}`
        : "0/0";
      console.error(
        `[runner:${slot.slotId}] done ${sid} in ${elapsed}s — ` +
        `survival ${survival} (${completed}/${slotQueue.length} complete)`,
      );

      return reports;
    }),
  );

  const results = await Promise.all(reportPromises);
  for (const reports of results) {
    allReports.push(...reports);
  }

  const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.error(`\n[loader] all ${slotQueue.length} slots complete in ${totalElapsed}s`);

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

  // Stdout for programmatic consumption
  if (viewFormat) {
    console.log(formatReports(reports, { format: viewFormat }));
  } else {
    console.log(JSON.stringify(reports, null, 2));
  }

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
