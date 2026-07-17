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
//   QDRANT_URL            — Qdrant endpoint for mycelium working collections (default: http://localhost:6334)
//   SOURCE_QDRANT_URL     — Qdrant endpoint for source data (default: QDRANT_URL)
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
//   FILTER_ROUNDS         — Rounds per slot, 1-3 (default: 1 = current behavior). Round 2+ re-injects
//                           only the previous round's survivors into a fresh dish, carrying each
//                           chunk's learnedDelta/learnedResonanceDelta forward (Phase 4a, experimental)
//   NODE_LEARN_RATE       — Per-node online learning rate (Phase 4a, e.g. 0.05). 0/unset = disabled.
//                           Required for FILTER_ROUNDS carryover to be meaningful — without it,
//                           nodes never diverge from the species memory they were injected with
//   CONSENSUS_RUNS        — Number of runs for majority-vote consensus (default: 10)
//   CONSENSUS_THRESHOLD   — Min vote ratio to consider a chunk's classification stable (default: 0.4)
//   CONSENSUS_JITTER      — Per-run initial w/h perturbation (0-1, default: 0.1 = ±10%)
//   FILTER_SOURCE_IDS     — Comma-separated source IDs to process (e.g. "8,14" or "source_arxiv:8")
//   EXCLUDE_TAGS          — Comma-separated tags to exclude from source scroll (e.g. previously-cached
//                           survivor nodes on a self-referential source — prevents recursive re-ingestion)
//   FUEL_OFF              — "true" to ignore both fuel channels (payload.weight / myceliumMetrics) — flat audit run (F3)
//   AUDIT_AB              — "true" to run every slot twice (fueled + flat) and emit a fuel drift audit JSON instead of reports (F3)
//                           AUDIT_AB + FUEL_OFF = flat vs flat — measures the jitter noise floor to compare drift against
//   CROSS_FILE            — "true" to run a raw cross-file affinity 2nd pass (all survivors → herald,
//                           merge/resonance matrix by source). Coarse — see META_WORLD for the cluster-level version
//   CROSS_FILE_CAPACITY   — Max survivors injected into the cross-file pass (default: 300)
//   META_WORLD            — "true" to run the Phase 4c meta-world 2nd pass: injects each source's anchor
//                           chunks (kept as anchor) + cluster origin nodes (→ herald) — NOT raw chunks —
//                           to discover cross-file cluster relationships. Splices `links`/`metaClusterId`
//                           into mergerClusters before reports are printed (visible in VIEW_FORMAT=digest)
//   META_WORLD_CAPACITY   — Max representative nodes injected into the meta-world pass (default: 200)
//   META_WORLD_RUNS       — Trials on the frozen representative set for stability filtering (default: 5).
//                           Single-run output is noisy — eval on source_patent found 64% of raw relations
//                           appear in exactly 1/15 trials. Only relations recurring in >= META_WORLD_THRESHOLD
//                           of trials become links
//   META_WORLD_THRESHOLD  — Min fraction of META_WORLD_RUNS trials a relation must recur in (default: 0.5)
//   VIEW_FORMAT           — Output format: "digest" | "manifest" | "compact" | "detailed" | "structured" (default: raw JSON)
//   REPORT_DIR            — Directory for report files. UNSET = no files written (stdout only, subsystem mode)
//   REPORT_KEEP           — FIFO retention when REPORT_DIR is set (default: 5 runs)
//
//   Digest query (progressive disclosure — only applied when VIEW_FORMAT=digest):
//   DIGEST_TIERS          — Comma-separated tiers: "meta", "pure", "clusters" (default: all)
//   DIGEST_ROLES          — Comma-separated role filter: "claim", "constraint", "foundation", "synthesis", "hypothesis"
//   DIGEST_MIN_CLUSTER    — Min cluster size to include (default: 0)
//   DIGEST_CONTEXT_RADIUS — Override context extraction radius (default: 40)
//   DIGEST_MAX_PURE       — Max pure entries per source
//   DIGEST_MAX_CLUSTERS   — Max cluster entries per source

import { mkdirSync, writeFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../types.js";
import type { MyceliumConfig } from "../types.js";
import { checkQdrantHealth, deleteCollection } from "../qdrant.js";
import { loadSourceCollections, allocateSlots } from "./slot-allocator.js";
import type { SourceCollectionConfig, SlotAssignment, ChunkRegistry } from "./slot-allocator.js";
import { DEFAULT_DISPATCHER_CONFIG } from "./isolated-runner.js";
import type { DispatcherConfig } from "./isolated-runner.js";
import type { SurvivorReport, MetaCluster, MetaRelation, CrossFileLink } from "./feed-instance.js";
import type { Species } from "../types.js";
import type { SourcePoint } from "./source-scroll.js";
import { parseIsolationMode, buildWorldDefinitions } from "./world-config.js";
import { resolveHardness } from "./hardness.js";
import { IsolatedRunner, pLimit } from "./isolated-runner.js";
import type { TrackedMergeEvent, DeltaPool } from "./isolated-runner.js";
import { formatReports } from "../output/formatters.js";
import type { ViewFormat, DigestQuery } from "../output/formatters.js";
import { buildFuelAudit } from "./audit.js";

// ---- Config from environment ----

const { level: hardnessLevel, preset: hardnessPreset } = resolveHardness(process.env.FILTER_HARDNESS);

const qdrantUrl = process.env.QDRANT_URL ?? "http://localhost:6334";
const sourceQdrantUrl = process.env.SOURCE_QDRANT_URL ?? qdrantUrl;

const sourceCollectionNames = (process.env.SOURCE_COLLECTIONS ?? "source")
  .split(",")
  .map(s => s.trim())
  .filter(s => s.length > 0);

const slotCapacity = parseInt(process.env.SLOT_CAPACITY ?? "100", 10);
const cleanWorlds = (process.env.CLEAN_WORLDS ?? "").toLowerCase() === "true";
const parallelSlots = Math.max(1, parseInt(process.env.PARALLEL_SLOTS ?? "3", 10));
const filterRounds = Math.max(1, Math.min(3, parseInt(process.env.FILTER_ROUNDS ?? "1", 10)));
const nodeLearnRate = Math.max(0, parseFloat(process.env.NODE_LEARN_RATE ?? "0"));
const consensusRuns = Math.max(1, parseInt(process.env.CONSENSUS_RUNS ?? "10", 10));
const consensusThreshold = parseFloat(process.env.CONSENSUS_THRESHOLD ?? "0.4");
const consensusJitter = parseFloat(process.env.CONSENSUS_JITTER ?? "0.1");
const viewFormat = (process.env.VIEW_FORMAT ?? "") as ViewFormat | "";
const filterSourceIds = (process.env.FILTER_SOURCE_IDS ?? "")
  .split(",")
  .map(s => s.trim())
  .filter(s => s.length > 0);
const excludeTags = (process.env.EXCLUDE_TAGS ?? "")
  .split(",")
  .map(s => s.trim())
  .filter(s => s.length > 0);
const crossFile = (process.env.CROSS_FILE ?? "").toLowerCase() === "true";
const crossFileCapacity = parseInt(process.env.CROSS_FILE_CAPACITY ?? "300", 10);
const metaWorld = (process.env.META_WORLD ?? "").toLowerCase() === "true";
const metaWorldCapacity = parseInt(process.env.META_WORLD_CAPACITY ?? "200", 10);
const metaWorldRuns = Math.max(1, parseInt(process.env.META_WORLD_RUNS ?? "5", 10));
const metaWorldThreshold = parseFloat(process.env.META_WORLD_THRESHOLD ?? "0.5");
const fuelOff = (process.env.FUEL_OFF ?? "").toLowerCase() === "true";
const auditAB = (process.env.AUDIT_AB ?? "").toLowerCase() === "true";

// Digest query (progressive disclosure)
function buildDigestQuery(): DigestQuery | undefined {
  const tiers = (process.env.DIGEST_TIERS ?? "").split(",").map(s => s.trim()).filter(s => s.length > 0);
  const roles = (process.env.DIGEST_ROLES ?? "").split(",").map(s => s.trim()).filter(s => s.length > 0);
  const minCluster = process.env.DIGEST_MIN_CLUSTER;
  const ctxRadius = process.env.DIGEST_CONTEXT_RADIUS;
  const maxPure = process.env.DIGEST_MAX_PURE;
  const maxClusters = process.env.DIGEST_MAX_CLUSTERS;

  const hasAny = tiers.length > 0 || roles.length > 0 || minCluster || ctxRadius || maxPure || maxClusters;
  if (!hasAny) return undefined;

  return {
    tiers: tiers.length > 0 ? tiers as Array<"meta" | "pure" | "clusters"> : undefined,
    roles: roles.length > 0 ? roles : undefined,
    minClusterSize: minCluster ? parseInt(minCluster, 10) : undefined,
    contextRadius: ctxRadius ? parseInt(ctxRadius, 10) : undefined,
    maxPure: maxPure ? parseInt(maxPure, 10) : undefined,
    maxClusters: maxClusters ? parseInt(maxClusters, 10) : undefined,
  };
}

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

// ---- Phase 4a: build next round's slot from previous round's survivors ----
//
// 上澄み再投入 — only chunks that survived (pure + merged, per chunkDetails)
// go into the new dish. DeltaPool carryover happens separately (see runSlot).

function buildNextRoundSlot(slot: SlotAssignment, reports: SurvivorReport[], roundIdx: number): SlotAssignment {
  const survivingBySource = new Map<string, Set<number>>();
  for (const r of reports) {
    const seqs = new Set<number>();
    for (const c of r.chunkDetails ?? []) seqs.add(c.chunkSeqNo);
    survivingBySource.set(r.sourceId, seqs);
  }

  const points = slot.points.filter((sp, idx) => {
    const sid = sp.payload.sourceId ?? String(sp.id);
    const seqNo = sp.payload.chunkSeqNo ?? idx;
    return survivingBySource.get(sid)?.has(seqNo) ?? false;
  });

  const registry: ChunkRegistry = new Map();
  for (const [sid, entry] of slot.chunkRegistry) {
    const count = points.filter(p => (p.payload.sourceId ?? String(p.id)) === sid).length;
    registry.set(sid, { ...entry, totalChunks: count });
  }

  return {
    slotId: slot.slotId,
    batchToken: `${slot.batchToken}-r${roundIdx}`,
    points,
    chunkRegistry: registry,
  };
}

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
    qdrantUrl: sourceQdrantUrl,
    collection: name,
  }));

  const worlds = buildWorldDefinitions(
    isolationMode,
    sourceConfigs,
    process.env.WORLD_MAP,
    myceliumConfig.collection,
  );

  console.error("=== Mycelium Universal Loader ===");
  console.error(`  source qdrant: ${sourceQdrantUrl}`);
  if (qdrantUrl !== sourceQdrantUrl) console.error(`  work qdrant:   ${qdrantUrl}`);
  console.error(`  sources:       ${sourceCollectionNames.join(", ")}`);
  console.error(`  isolation:     ${isolationMode} (${worlds.length} world(s))`);
  console.error(`  parallel:      ${parallelSlots} slot(s)`);
  console.error(`  hardness:      ${hardnessLevel} (harvest at ${(hardnessPreset.harvestPct * 100).toFixed(0)}% of ticks)`);
  console.error(`  ticks:         ${dispatchConfig.targetTicks}`);
  if (consensusRuns > 1) console.error(`  consensus:     ${consensusRuns} runs (threshold=${(consensusThreshold * 100).toFixed(0)}%, jitter=${(consensusJitter * 100).toFixed(0)}%)`);
  if (filterRounds > 1) console.error(`  rounds:        ${filterRounds} (Phase 4a — learnedDelta carryover, experimental)`);
  if (nodeLearnRate > 0) console.error(`  node learning: rate=${nodeLearnRate} (Phase 4a — per-node online learning)`);
  if (crossFile) console.error(`  cross-file:    enabled (2nd pass, capacity=${crossFileCapacity})`);
  if (metaWorld) console.error(`  meta-world:    enabled (Phase 4c 2nd pass, capacity=${metaWorldCapacity}, runs=${metaWorldRuns}, threshold=${(metaWorldThreshold * 100).toFixed(0)}%)`);
  if (auditAB && fuelOff) console.error(`  fuel audit:    A/B baseline — flat vs flat (jitter noise floor)`);
  else if (auditAB) console.error(`  fuel audit:    A/B — every slot runs twice (fueled + flat)`);
  else if (fuelOff) console.error(`  fuel:          OFF (flat run — weight/myceliumMetrics ignored)`);
  if (cleanWorlds) console.error(`  clean:         enabled (world collections will be recreated)`);
  for (const w of worlds) {
    console.error(`  world "${w.name}": ${w.collection} ← [${w.sourceCollections.map(s => s.collection).join(", ")}]`);
  }
  console.error("");

  // Health check (non-fatal — Qdrant is only needed for CLEAN_WORLDS and legacy paths)
  const healthy = await checkQdrantHealth(sourceQdrantUrl);
  if (!healthy) {
    console.error(`[loader] WARNING: source Qdrant unreachable at ${sourceQdrantUrl}`);
  }

  const allReports: SurvivorReport[] = [];

  // Collect all slots across worlds with their world name
  const slotQueue: Array<{ slot: SlotAssignment; worldName: string }> = [];

  for (let wi = 0; wi < worlds.length; wi++) {
    const world = worlds[wi];
    if (worlds.length > 1) {
      console.error(`\n--- World "${world.name}" ---`);
    }

    // Optional: clean world collection (requires mycelium Qdrant)
    if (cleanWorlds) {
      try {
        const deleted = await deleteCollection(qdrantUrl, world.collection);
        if (deleted) console.error(`[loader:${world.name}] cleaned collection ${world.collection}`);
      } catch {
        console.error(`[loader:${world.name}] CLEAN_WORLDS skipped — Qdrant unreachable at ${qdrantUrl}`);
      }
    }

    // Load source points for this world
    let worldSourcePoints = await loadSourceCollections(world.sourceCollections);
    if (worldSourcePoints.length === 0) {
      console.error(`[loader:${world.name}] no source points, skipping`);
      continue;
    }
    console.error(`[loader:${world.name}] ${worldSourcePoints.length} source points loaded`);

    // Exclude points carrying any EXCLUDE_TAGS tag (e.g. previously-cached
    // survivors on a self-referential source — recursion guard)
    if (excludeTags.length > 0) {
      const before = worldSourcePoints.length;
      worldSourcePoints = worldSourcePoints.filter(p => {
        const tags = Array.isArray(p.payload.tags) ? p.payload.tags as string[] : [];
        return !tags.some(t => excludeTags.includes(t));
      });
      const excluded = before - worldSourcePoints.length;
      if (excluded > 0) console.error(`[loader:${world.name}] excluded ${excluded} point(s) by EXCLUDE_TAGS`);
    }

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

  const runSlot = (slot: SlotAssignment, off: boolean): SurvivorReport[] => {
    let currentSlot = slot;
    let pool: DeltaPool | undefined;
    let reports: SurvivorReport[] = [];

    for (let round = 0; round < filterRounds; round++) {
      const runner = new IsolatedRunner(myceliumConfig, dispatchConfig, { fuelOff: off, nodeLearnRate: nodeLearnRate > 0 ? nodeLearnRate : undefined });
      runner.loadSpeciesMemory();

      if (consensusRuns > 1) {
        const result = runner.runConsensus(currentSlot, consensusRuns, consensusThreshold, consensusJitter, pool);
        reports = result.reports;
        pool = result.survivorDeltaPool;
      } else {
        const result = runner.runOnce(currentSlot, consensusJitter, pool);
        reports = result.reports;
        pool = result.survivorDeltaPool;
      }

      if (filterRounds > 1) {
        const surviving = reports.reduce((s, r) => s + r.survivingChunks, 0);
        const total = reports.reduce((s, r) => s + r.totalChunks, 0);
        console.error(`[runner:${currentSlot.slotId}] round ${round + 1}/${filterRounds}: ${surviving}/${total} survived`);
      }

      if (round < filterRounds - 1) {
        const nextSlot = buildNextRoundSlot(currentSlot, reports, round + 1);
        if (nextSlot.points.length === 0) break;
        currentSlot = nextSlot;
      }
    }

    return reports;
  };

  const reportPromises = slotQueue.map(({ slot, worldName }) =>
    limit(async () => {
      const slotStart = Date.now();
      const sid = [...slot.chunkRegistry.keys()][0] ?? slot.slotId;
      console.error(`[runner:${slot.slotId}] start ${sid} (${slot.points.length} chunks, ${consensusRuns} runs)`);

      // Audit mode compares primary (fueled, or flat when FUEL_OFF=true —
      // flat-vs-flat measures the jitter noise floor) against a flat run
      const reports = runSlot(slot, fuelOff);
      const flatReports = auditAB ? runSlot(slot, true) : undefined;

      // Stamp world name
      for (const r of reports) r.worldName = worldName;
      if (flatReports) for (const r of flatReports) r.worldName = worldName;

      completed++;
      const elapsed = ((Date.now() - slotStart) / 1000).toFixed(1);
      const survival = reports.length > 0
        ? `${reports[0].survivingChunks}/${reports[0].totalChunks}`
        : "0/0";
      console.error(
        `[runner:${slot.slotId}] done ${sid} in ${elapsed}s — ` +
        `survival ${survival}${auditAB ? ` (flat ${flatReports?.[0]?.survivingChunks ?? 0}/${flatReports?.[0]?.totalChunks ?? 0})` : ""} (${completed}/${slotQueue.length} complete)`,
      );

      return { reports, flatReports };
    }),
  );

  const results = await Promise.all(reportPromises);
  const allFlatReports: SurvivorReport[] = [];
  for (const { reports, flatReports } of results) {
    allReports.push(...reports);
    if (flatReports) allFlatReports.push(...flatReports);
  }

  const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.error(`\n[loader] all ${slotQueue.length} slots complete in ${totalElapsed}s`);

  // ---- Meta-World (Phase 4c 2nd pass) — must run before printReports so the
  // splice into allReports[].mergerClusters[].links is visible in the output ----
  if (metaWorld && !auditAB) {
    await runMetaWorld(allReports, slotQueue);
  }

  // Output results
  if (auditAB) {
    // Chunks carrying actual fuel — drift on the rest is jitter noise
    let fueledChunks = 0;
    for (const { slot } of slotQueue) {
      for (const sp of slot.points) {
        if (typeof sp.payload.weight === "number" || sp.payload.myceliumMetrics != null) {
          fueledChunks++;
        }
      }
    }
    printFuelAudit(allReports, allFlatReports, fueledChunks);
  } else {
    printReports(allReports);
  }

  // ---- Cross-file affinity (2nd pass) ----
  if (crossFile && !auditAB) {
    await runCrossFileAffinity(allReports, slotQueue);
  }
}

// ---- Fuel audit output (F3) ----
//
// Audit mode is a pure measurement: stdout carries only the audit JSON
// (no SurvivorReport dump → receptor sink won't write metrics back for
// audit runs), stderr carries the human-readable drift summary.

function printFuelAudit(fueled: SurvivorReport[], flat: SurvivorReport[], fueledChunks?: number): void {
  const audit = buildFuelAudit(fueled, flat, consensusRuns, fueledChunks);
  const a = audit.fuelAudit;

  console.error("\n=== Fuel Audit (fueled vs flat) ===\n");
  console.error(`  chunks compared:  ${a.chunks} (${a.sources} source(s)${a.fueledChunks != null ? `, ${a.fueledChunks} carrying fuel` : ""})`);
  console.error(`  agreement:        ${(a.agreementRate * 100).toFixed(1)}% exact, ${(a.survivalAgreementRate * 100).toFixed(1)}% survivor/dead`);
  console.error(`  drift:            ${(a.drift * 100).toFixed(1)}%`);
  console.error(`  survival:         fueled ${(a.survivalRate.fueled * 100).toFixed(1)}% / flat ${(a.survivalRate.flat * 100).toFixed(1)}%`);
  console.error(`  avg consensus:    fueled ${(a.avgConsensusRate.fueled * 100).toFixed(1)}% / flat ${(a.avgConsensusRate.flat * 100).toFixed(1)}%`);
  console.error(`  fuel-dependent:   ${a.fuelDependents.length} chunk(s) survive only with fuel`);
  console.error(`  fuel-suppressed:  ${a.fuelSuppressed.length} chunk(s) survive only without fuel`);
  const transitions = Object.entries(a.transitions);
  if (transitions.length > 0) {
    console.error(`  transitions:      ${transitions.map(([t, n]) => `${t}:${n}`).join(" ")}`);
  }
  console.error("");

  console.log(JSON.stringify(audit, null, 2));
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
    console.log(formatReports(reports, { format: viewFormat, query: buildDigestQuery() }));
  } else {
    console.log(JSON.stringify(reports, null, 2));
  }

  // Save to file
  saveReports(reports);
}

// ---- Report file persistence (opt-in) ----
//
// mycelium is a stdout filter — it does NOT save files unless the caller
// explicitly sets REPORT_DIR. Persistence is the caller's responsibility
// (receptor sink, local runs with REPORT_DIR=./data/reports).

function saveReports(reports: SurvivorReport[]): void {
  const reportDir = process.env.REPORT_DIR;
  if (!reportDir) return;
  mkdirSync(reportDir, { recursive: true });

  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

  // Derive source label from collections/sourceIds
  const sourceIds = [...new Set(reports.map(r => r.sourceId))];
  const collections = [...new Set(reports.map(r => r.collection))];
  let sourceLabel: string;
  if (collections.length === 1) {
    sourceLabel = collections[0].replace(/^source_/, "");
  } else {
    sourceLabel = collections.map(c => c.replace(/^source_/, "")).join("+");
  }
  if (sourceLabel.length > 40) sourceLabel = `${collections.length}sources`;

  const basename = `${sourceLabel}_${ts}`;

  // 1. Raw SurvivorReport (always saved)
  const rawPath = join(reportDir, `${basename}.json`);
  writeFileSync(rawPath, JSON.stringify(reports, null, 2), "utf-8");

  // 2. Formatted output (if VIEW_FORMAT specified)
  if (viewFormat) {
    const formatted = formatReports(reports, { format: viewFormat, query: buildDigestQuery() });
    const ext = viewFormat === "compact" ? "txt" : "json";
    const fmtPath = join(reportDir, `${basename}.${viewFormat}.${ext}`);
    writeFileSync(fmtPath, formatted, "utf-8");
    console.error(`[loader] Report saved: ${fmtPath}`);
  } else {
    console.error(`[loader] Report saved: ${rawPath}`);
  }

  // 3. FIFO cleanup — keep only 5 most recent runs
  const reportKeep = parseInt(process.env.REPORT_KEEP ?? "5", 10);
  if (reportKeep > 0) {
    const timestamped = readdirSync(reportDir)
      .filter(f => !f.startsWith("latest.") && !f.startsWith("."))
      .sort();
    const basenames = [...new Set(timestamped.map(f => f.replace(/\.(digest|manifest|compact|detailed|structured)\.(json|txt)$/, ".json")))];
    if (basenames.length > reportKeep) {
      const removeSet = new Set<string>();
      for (const b of basenames.slice(0, basenames.length - reportKeep)) {
        const prefix = b.replace(/\.json$/, "");
        for (const f of timestamped) {
          if (f.startsWith(prefix)) removeSet.add(f);
        }
      }
      for (const f of removeSet) {
        try { unlinkSync(join(reportDir, f)); } catch {}
      }
    }
  }

  // 4. latest files — clean old latest.* then write current
  for (const f of readdirSync(reportDir)) {
    if (f.startsWith("latest.")) {
      try { unlinkSync(join(reportDir, f)); } catch {}
    }
  }
  writeFileSync(join(reportDir, "latest.json"), JSON.stringify(reports, null, 2), "utf-8");
  if (viewFormat) {
    const formatted = formatReports(reports, { format: viewFormat, query: buildDigestQuery() });
    const ext = viewFormat === "compact" ? "txt" : "json";
    writeFileSync(join(reportDir, `latest.${viewFormat}.${ext}`), formatted, "utf-8");
  }
}

// ---- Meta-World (Phase 4c: cross-file cluster integration, 2nd pass) ----
//
// Unlike runCrossFileAffinity below (raw chunk dump — every survivor becomes
// herald), this represents each source by structural landmarks only:
//   - anchor chunks, kept as anchor (immovable reference points)
//   - cluster origin nodes, converted to herald (social broadcaster)
// Sources with neither fall back to their top pure survivors so small/simple
// files still participate (deviation from the original spec, for coverage).
// Comparison unit = knowledge cluster, not raw chunk — this is the qualitative
// difference from vector-DB KNN that Phase 4c is meant to demonstrate.
//
// Cross-source merge/resonance events discovered here are grouped into
// connected components (union-find) and spliced back into the 1st-pass
// reports as ClusterDetail.links / .metaClusterId, so VIEW_FORMAT=digest
// can surface "related cluster in file B" without a separate query.

async function runMetaWorld(
  reports: SurvivorReport[],
  slotQueue: Array<{ slot: SlotAssignment; worldName: string }>,
): Promise<void> {
  const FALLBACK_TOP_N = 3;

  // sourceId is already qualified ({collection}:{rawId}) by loadSourceCollections,
  // so this key is unambiguous across worlds/collections.
  const pointLookup = new Map<string, SourcePoint>();
  for (const { slot } of slotQueue) {
    for (let i = 0; i < slot.points.length; i++) {
      const sp = slot.points[i];
      const sid = sp.payload.sourceId ?? String(sp.id);
      const seqNo = sp.payload.chunkSeqNo ?? i;
      pointLookup.set(`${sid}:${seqNo}`, sp);
    }
  }

  interface Participant { sourceId: string; chunkSeqNo: number; species: Species }
  const metaPoints: SourcePoint[] = [];
  const participants = new Map<string, Participant>();

  const addPoint = (sourceId: string, chunkSeqNo: number, species: Species, overrideSpecies: Species | undefined) => {
    const key = `${sourceId}:${chunkSeqNo}`;
    if (participants.has(key)) return;
    const sp = pointLookup.get(key);
    if (!sp) return;
    metaPoints.push({ ...sp, payload: { ...sp.payload, speciesOverride: overrideSpecies } });
    participants.set(key, { sourceId, chunkSeqNo, species });
  };

  for (const report of reports) {
    let added = 0;

    for (const c of report.chunkDetails ?? []) {
      if (c.species === "anchor") {
        addPoint(report.sourceId, c.chunkSeqNo, "anchor", undefined);
        added++;
      }
    }

    for (const c of report.mergerClusters ?? []) {
      addPoint(report.sourceId, c.originChunkSeqNo, c.species, "herald");
      added++;
    }

    if (added === 0) {
      for (const c of (report.pureSurvivors ?? []).slice(0, FALLBACK_TOP_N)) {
        addPoint(report.sourceId, c.chunkSeqNo, c.species, "herald");
      }
    }
  }

  if (metaPoints.length === 0) {
    console.error("[meta-world] No representative nodes to inject (no anchors/clusters/survivors)");
    return;
  }
  if (metaPoints.length > metaWorldCapacity) {
    console.error(`[meta-world] ${metaPoints.length} representatives exceed capacity ${metaWorldCapacity}, truncating`);
    metaPoints.length = metaWorldCapacity;
  }

  const chunkRegistry: ChunkRegistry = new Map();
  const bySource = new Map<string, number>();
  for (const sp of metaPoints) {
    const sid = sp.payload.sourceId ?? String(sp.id);
    bySource.set(sid, (bySource.get(sid) ?? 0) + 1);
  }
  for (const [sid, count] of bySource) {
    chunkRegistry.set(sid, { totalChunks: count, collection: "meta-world", rawSourceId: sid });
  }

  const metaSlot: SlotAssignment = {
    slotId: "meta-world",
    batchToken: `meta-${Date.now().toString(36)}`,
    points: metaPoints,
    chunkRegistry,
  };

  console.error(`\n=== Meta-World (Phase 4c: cross-file cluster integration) ===`);
  console.error(`  representatives: ${metaPoints.length} from ${bySource.size} sources`);

  console.error(`  running ${metaWorldRuns} trial(s) for stability filtering...`);

  // Aggregate cross-source relations across N independent runs on the SAME
  // frozen representative set, instead of trusting a single run. Evaluation
  // on source_patent (15 trials) found 64% of raw relations appear in exactly
  // 1 trial — single-run output is dominated by jitter/softmax noise, the
  // same lesson Phase 4a learned the hard way. Only relations recurring in
  // >= META_WORLD_THRESHOLD of trials are kept.
  const edgeStats = new Map<string, { relation: MetaRelation; count: number; sumCos: number; a: string; b: string }>();

  for (let trial = 0; trial < metaWorldRuns; trial++) {
    // fuelOff: representative payloads still carry weight/myceliumMetrics from
    // the source; relation discovery should be driven by geometry + dynamics
    // only, not by F1 usage bias (decided in Phase V0 review).
    const runner = new IsolatedRunner(myceliumConfig, dispatchConfig, { fuelOff: true });
    runner.loadSpeciesMemory();
    const { mergeEvents, resonanceEvents, nodeChunkSeqMap } = runner.runOnce(metaSlot, consensusJitter);

    // One vote per trial per (pair, relation) — repeated ticks within a
    // single trial don't inflate the stability count.
    const seenThisTrial = new Set<string>();
    const record = (aId: string, bId: string, aSrc: string, bSrc: string, relation: MetaRelation, cos: number) => {
      if (aSrc === bSrc) return;
      const aSeq = nodeChunkSeqMap.get(aId);
      const bSeq = nodeChunkSeqMap.get(bId);
      if (aSeq == null || bSeq == null) return;
      const [x, y] = [`${aSrc}:${aSeq}`, `${bSrc}:${bSeq}`].sort();
      const key = `${x}|${y}|${relation}`;
      if (seenThisTrial.has(key)) return;
      seenThisTrial.add(key);
      const entry = edgeStats.get(key) ?? { relation, count: 0, sumCos: 0, a: x, b: y };
      entry.count++;
      entry.sumCos += cos;
      edgeStats.set(key, entry);
    };

    for (const me of mergeEvents) record(me.absorbedId, me.absorberId, me.absorbedSource, me.absorberSource, "merged", me.cosine);
    for (const re of resonanceEvents) record(re.initiatorId, re.targetId, re.initiatorSource, re.targetSource, "resonant", re.cosine);
  }

  if (edgeStats.size === 0) {
    console.error(`  no cross-file relations detected`);
    console.log(JSON.stringify({ metaWorld: { representativeCount: metaPoints.length, sources: [...bySource.keys()], metaClusters: [] } }, null, 2));
    return;
  }

  const minCount = Math.max(1, Math.ceil(metaWorldRuns * metaWorldThreshold));
  const rawRelationCount = edgeStats.size;
  const uniqueEdges = [...edgeStats.values()]
    .filter(e => e.count >= minCount)
    .map(e => ({ a: e.a, b: e.b, relation: e.relation, cosine: e.sumCos / e.count }));

  console.error(`  ${rawRelationCount} raw relation(s) observed, ${uniqueEdges.length} stable (>=${minCount}/${metaWorldRuns} trials)`);

  if (uniqueEdges.length === 0) {
    console.log(JSON.stringify({ metaWorld: { representativeCount: metaPoints.length, sources: [...bySource.keys()], metaClusters: [] } }, null, 2));
    return;
  }

  // Union-find over participant keys touched by edges → connected component ID
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    if (!parent.has(x)) parent.set(x, x);
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root)!;
    let cur = x;
    while (parent.get(cur) !== root) { const next = parent.get(cur)!; parent.set(cur, root); cur = next; }
    return root;
  };
  const union = (a: string, b: string) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
  for (const e of uniqueEdges) union(e.a, e.b);

  const componentIds = new Map<string, string>();
  let compCounter = 0;
  const componentIdOf = (key: string): string => {
    const root = find(key);
    let id = componentIds.get(root);
    if (!id) { id = `meta-${(compCounter++).toString(36)}`; componentIds.set(root, id); }
    return id;
  };

  // Dedup key: same (from, to, relation) can fire repeatedly across ticks —
  // keep the strongest cosine observed rather than listing every occurrence.
  const linksByKey = new Map<string, Map<string, CrossFileLink>>();
  const addLink = (fromKey: string, toKey: string, relation: MetaRelation, cosine: number) => {
    const to = participants.get(toKey);
    if (!to) return;
    const dedupKey = `${toKey}:${relation}`;
    const map = linksByKey.get(fromKey) ?? new Map<string, CrossFileLink>();
    const existing = map.get(dedupKey);
    if (!existing || cosine > existing.cosine) {
      map.set(dedupKey, { sourceId: to.sourceId, chunkSeqNo: to.chunkSeqNo, relation, cosine });
    }
    linksByKey.set(fromKey, map);
  };

  const metaClusters: MetaCluster[] = [];
  for (const e of uniqueEdges) {
    const pa = participants.get(e.a), pb = participants.get(e.b);
    if (!pa || !pb) continue;
    addLink(e.a, e.b, e.relation, e.cosine);
    addLink(e.b, e.a, e.relation, e.cosine);
    metaClusters.push({
      id: componentIdOf(e.a),
      relation: e.relation,
      participants: [
        { sourceId: pa.sourceId, chunkSeqNo: pa.chunkSeqNo, species: pa.species },
        { sourceId: pb.sourceId, chunkSeqNo: pb.chunkSeqNo, species: pb.species },
      ],
      cosine: e.cosine,
    });
  }

  // Splice links + metaClusterId into the 1st-pass reports. Clusters get both
  // links and metaClusterId; per-chunk details (incl. anchor/pure participants)
  // get links. chunkDetails and pureSurvivors usually share object references,
  // but both are iterated explicitly in case a consensus rebuild broke sharing.
  let splicedCount = 0;
  for (const report of reports) {
    for (const c of report.mergerClusters ?? []) {
      const key = `${report.sourceId}:${c.originChunkSeqNo}`;
      const linkMap = linksByKey.get(key);
      if (linkMap && linkMap.size > 0) {
        c.links = [...linkMap.values()];
        c.metaClusterId = componentIdOf(key);
        splicedCount++;
      }
    }
    for (const list of [report.chunkDetails, report.pureSurvivors]) {
      for (const c of list ?? []) {
        const linkMap = linksByKey.get(`${report.sourceId}:${c.chunkSeqNo}`);
        if (linkMap && linkMap.size > 0) c.links = [...linkMap.values()];
      }
    }
  }

  const mergedCount = metaClusters.filter(m => m.relation === "merged").length;
  const resonantCount = metaClusters.filter(m => m.relation === "resonant").length;
  console.error(`  cross-file relations: ${uniqueEdges.length} stable (${mergedCount} merged, ${resonantCount} resonant; ${rawRelationCount} raw)`);
  console.error(`  linked clusters: ${splicedCount}`);

  console.log(JSON.stringify({
    metaWorld: {
      representativeCount: metaPoints.length,
      sources: [...bySource.keys()],
      metaClusters,
    },
  }, null, 2));
}

// ---- Cross-file affinity (2nd pass) ----

async function runCrossFileAffinity(
  reports: SurvivorReport[],
  slotQueue: Array<{ slot: SlotAssignment; worldName: string }>,
): Promise<void> {
  // Collect source points from 1st pass (pure + merged + loner)
  // Loners are included: isolated within own source but may relate to other sources
  const CROSS_CLASSIFICATIONS = new Set(["pure", "merged", "loner"]);
  const crossPoints: import("./source-scroll.js").SourcePoint[] = [];
  for (const { slot } of slotQueue) {
    for (const report of reports) {
      if (!report.chunkDetails) continue;
      for (const chunk of report.chunkDetails) {
        if (!CROSS_CLASSIFICATIONS.has(chunk.classification)) continue;
        // Find the original source point by seqNo
        const sp = slot.points.find(p =>
          (p.payload.sourceId ?? String(p.id)) === report.sourceId.replace(/^[^:]+:/, "") &&
          p.payload.chunkSeqNo === chunk.chunkSeqNo,
        ) ?? slot.points[chunk.chunkSeqNo];
        if (sp) {
          // Force herald species for cross-file social interaction
          crossPoints.push({ ...sp, payload: { ...sp.payload, speciesOverride: "herald" } });
        }
      }
    }
  }

  if (crossPoints.length === 0) {
    console.error("[cross-file] No surviving chunks to cross-reference");
    return;
  }
  if (crossPoints.length > crossFileCapacity) {
    console.error(`[cross-file] ${crossPoints.length} survivors exceed capacity ${crossFileCapacity}, truncating`);
    crossPoints.length = crossFileCapacity;
  }

  // Build a synthetic slot with all survivors
  const chunkRegistry: import("./slot-allocator.js").ChunkRegistry = new Map();
  const bySource = new Map<string, number>();
  for (const sp of crossPoints) {
    const sid = sp.payload.sourceId ?? String(sp.id);
    bySource.set(sid, (bySource.get(sid) ?? 0) + 1);
  }
  for (const [sid, count] of bySource) {
    chunkRegistry.set(sid, { totalChunks: count, collection: "cross-file", rawSourceId: sid });
  }

  const crossSlot: SlotAssignment = {
    slotId: "cross-file",
    batchToken: `cross-${Date.now().toString(36)}`,
    points: crossPoints,
    chunkRegistry,
  };

  console.error(`\n=== Cross-File Affinity (2nd pass) ===`);
  console.error(`  survivors: ${crossPoints.length} from ${bySource.size} sources`);
  console.error(`  ticks: ${dispatchConfig.targetTicks}, runs: ${consensusRuns}`);

  // Run single consensus pass with all survivors mixed
  const runner = new IsolatedRunner(myceliumConfig, dispatchConfig);
  runner.loadSpeciesMemory();
  const { reports: crossReports, mergeEvents, nodeSourceMap } = runner.runOnce(crossSlot, consensusJitter);

  const sourceIds = [...bySource.keys()];

  // ---- 1. Per-source classification in 2nd pass ----
  const sourceStats: Record<string, { input: number; survived: number; pure: number; merged: number; loner: number; dead: number }> = {};
  for (const sid of sourceIds) {
    sourceStats[sid] = { input: bySource.get(sid) ?? 0, survived: 0, pure: 0, merged: 0, loner: 0, dead: 0 };
  }
  for (const r of crossReports) {
    const sid = r.sourceId;
    if (!sourceStats[sid]) continue;
    sourceStats[sid].survived = r.survivingChunks;
    const bd = r.classificationBreakdown;
    sourceStats[sid].pure = bd.pure;
    sourceStats[sid].merged = bd.merged;
    sourceStats[sid].loner = bd.loner + bd.redundant;
    sourceStats[sid].dead = bd.dead;
  }

  // ---- 2. Cross-source merge affinity ----
  const affinityMap = new Map<string, Map<string, { merges: number; totalCos: number }>>();
  for (const sid of sourceIds) affinityMap.set(sid, new Map());

  for (const me of mergeEvents) {
    const srcA = me.absorbedSource;
    const srcB = me.absorberSource;
    if (srcA === srcB || srcA === "unknown" || srcB === "unknown") continue;
    for (const [a, b] of [[srcA, srcB], [srcB, srcA]]) {
      const row = affinityMap.get(a);
      if (!row) continue;
      const entry = row.get(b) ?? { merges: 0, totalCos: 0 };
      entry.merges++;
      entry.totalCos += me.cosine;
      row.set(b, entry);
    }
  }

  // ---- 3. Cross-source resonance from surviving nodes ----
  // Resonance is species-level, so we map: for each surviving node from source A,
  // sum its positive resonance. Then average across all nodes from source A.
  // Compare per-source avg resonance to detect which sources' nodes are "warmed up".
  const resonanceBySrc: Record<string, { totalPosRes: number; count: number; speciesRes: Record<string, number> }> = {};
  for (const sid of sourceIds) resonanceBySrc[sid] = { totalPosRes: 0, count: 0, speciesRes: {} };

  for (const [nodeId, nv] of runner.getStore()) {
    const sid = nodeSourceMap.get(nodeId);
    if (!sid || !resonanceBySrc[sid]) continue;
    const entry = resonanceBySrc[sid];
    entry.count++;
    for (const [sp, val] of Object.entries(nv.node.resonance)) {
      const posVal = Math.max(0, val);
      entry.totalPosRes += posVal;
      entry.speciesRes[sp] = (entry.speciesRes[sp] ?? 0) + posVal;
    }
  }

  // ---- Output ----
  const crossMergeCount = mergeEvents.filter(e => e.absorbedSource !== e.absorberSource).length;
  const totalMergeCount = mergeEvents.length;

  console.error(`\n  2nd pass results:`);
  console.error(`  ${"source".padEnd(32)} input surv  pure mrgd lonr dead  avgRes`);
  for (const sid of sourceIds) {
    const s = sourceStats[sid];
    const res = resonanceBySrc[sid];
    const avgRes = res.count > 0 ? (res.totalPosRes / res.count).toFixed(3) : "0.000";
    console.error(`  ${sid.slice(-30).padEnd(32)} ${String(s.input).padStart(4)} ${String(s.survived).padStart(4)}  ${String(s.pure).padStart(4)} ${String(s.merged).padStart(4)} ${String(s.loner).padStart(4)} ${String(s.dead).padStart(4)}  ${avgRes}`);
  }

  console.error(`\n  Merge events: ${totalMergeCount} total, ${crossMergeCount} cross-source`);

  console.error(`\n  Affinity Matrix (merge count / avg cosine):`);
  console.error(`  ${"".padEnd(32)} ${sourceIds.map(s => s.slice(-12).padStart(12)).join(" ")}`);
  for (const sid of sourceIds) {
    const row = affinityMap.get(sid)!;
    const cells = sourceIds.map(other => {
      if (other === sid) return "     -     ";
      const entry = row.get(other);
      if (!entry) return "     .     ";
      const avgCos = (entry.totalCos / entry.merges).toFixed(2);
      return `${String(entry.merges).padStart(3)}/${avgCos}`.padStart(11);
    });
    console.error(`  ${sid.slice(-30).padEnd(32)} ${cells.join(" ")}`);
  }

  // Resonance detail per source
  console.error(`\n  Resonance by source (surviving nodes, avg per species):`);
  for (const sid of sourceIds) {
    const res = resonanceBySrc[sid];
    if (res.count === 0) continue;
    const speciesLine = Object.entries(res.speciesRes)
      .filter(([, v]) => v > 0)
      .map(([sp, v]) => `${sp}:${(v / res.count).toFixed(3)}`)
      .join(" ");
    console.error(`  ${sid.slice(-30).padEnd(32)} (${res.count} nodes) ${speciesLine}`);
  }

  // JSON output
  const matrix: Record<string, Record<string, { merges: number; avgCosine: number }>> = {};
  for (const [sid, row] of affinityMap) {
    matrix[sid] = {};
    for (const [other, entry] of row) {
      matrix[sid][other] = { merges: entry.merges, avgCosine: entry.totalCos / entry.merges };
    }
  }
  const resonanceSummary: Record<string, { avgPosResonance: number; survivorCount: number; speciesAvg: Record<string, number> }> = {};
  for (const sid of sourceIds) {
    const res = resonanceBySrc[sid];
    const speciesAvg: Record<string, number> = {};
    for (const [sp, v] of Object.entries(res.speciesRes)) {
      if (v > 0 && res.count > 0) speciesAvg[sp] = v / res.count;
    }
    resonanceSummary[sid] = { avgPosResonance: res.count > 0 ? res.totalPosRes / res.count : 0, survivorCount: res.count, speciesAvg };
  }
  console.log(JSON.stringify({
    crossFileAffinity: {
      sources: sourceIds,
      survivorCount: crossPoints.length,
      sourceStats,
      matrix,
      resonance: resonanceSummary,
    },
  }, null, 2));
}

// ---- Run ----

main().catch((err) => {
  console.error("[loader] Fatal:", err);
  process.exit(1);
});
