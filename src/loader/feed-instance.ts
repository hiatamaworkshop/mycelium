// ============================================================
// FeedInstance — one slot of articles in the cascade pipeline
// ============================================================
//
// Lifecycle: pending → injecting → running → harvesting → done
//
// Each instance tracks:
//   - injected nodeIds (for harvest filtering)
//   - nodeId → qualifiedSourceId mapping (for per-source reporting)
//   - chunk registry (expected chunk counts per sourceId)
//   - death log (filtered from global tick deaths for this instance's nodes)
//
// Harvest: per-sourceId survival + pushback classification
//   (pure / loner / redundant / merged / dead)

import type { MyceliumConfig, MyceliumNode, Species } from "../types.js";
import type { SourcePoint } from "./source-scroll.js";
import type { ChunkRegistry } from "./slot-allocator.js";
import type { DeathRecord } from "../core/pushback.js";
import metabolismRaw from "../config/metabolism.json" with { type: "json" };
import type { MetabolismSchema } from "../types.js";
import { extractRedundantIds, extractLonerIds, extractPureSurvivors, extractMergerClusters } from "../core/pushback.js";
import { createNode, nodeToPayload, payloadToNode, resolveSpecies } from "../core/node.js";
import { getSpeciesMemory, getSpeciesResonanceDelta } from "../core/digestor.js";
import { upsertPoints, deletePoints } from "../qdrant.js";
import * as store from "../core/colony-store.js";

const M = metabolismRaw as unknown as MetabolismSchema;

// ---- Classification ----

export type ChunkClassification = "pure" | "loner" | "redundant" | "merged" | "dead";

/** Per-chunk classification distribution for a sourceId */
export type ClassificationBreakdown = Record<ChunkClassification, number>;

// ---- Survivor report (per sourceId) ----

export interface SurvivorReport {
  /** Qualified sourceId ({collection}:{rawId}) */
  sourceId: string;
  /** Original collection name */
  collection: string;
  /** World name (isolation mode) */
  worldName?: string;
  /** Batch token for slot traceability */
  batchToken: string;
  /** Total chunks injected for this sourceId */
  totalChunks: number;
  /** Chunks that survived the tick cycle */
  survivingChunks: number;
  /** Survival rate (0-1) */
  survivalRate: number;
  /** Species distribution of survivors */
  species: Record<Species, number>;
  /** Sample surviving texts */
  survivingTexts: string[];
  /** Whether all parts were accounted for (survived + died = total) */
  partsComplete: boolean;
  /** Per-chunk 3-axis classification distribution */
  classificationBreakdown: ClassificationBreakdown;
  /** Per-source consensus passing rate (chunks where top vote ≥ threshold / total). Only set in consensus mode. */
  consensusRate?: number;
  /** Doc-level metadata from sidecar (dataset, abstract, etc.) */
  sourceMetadata?: Record<string, unknown>;
}

// ---- Instance status ----

export type InstanceStatus = "pending" | "injecting" | "running" | "harvesting" | "done" | "lost";

// ---- FeedInstance ----

export class FeedInstance {
  readonly id: string;
  readonly batchToken: string;
  readonly sourcePoints: SourcePoint[];
  readonly targetTicks: number;
  readonly chunkRegistry: ChunkRegistry;
  readonly forceSpore: boolean;
  readonly harvestPct: number;

  status: InstanceStatus = "pending";
  startTick = 0;
  ticksElapsed = 0;

  // Mycelium node IDs created by this instance (for harvest filtering)
  private injectedNodeIds: Set<string> = new Set();

  // nodeId → qualifiedSourceId mapping (for per-source harvest)
  private nodeSourceMap: Map<string, string> = new Map();

  // nodeId → sourcePoints index (stable across runs for consensus voting)
  private sourcePointIdxMap: Map<string, number> = new Map();

  // Per-chunk classification votes (sourcePoints index → classification)
  // Populated during harvest() for consensus aggregation
  private _chunkVotes: Map<number, ChunkClassification> = new Map();

  // Death log: accumulated from global tick deaths, filtered to this instance's nodes
  private deathLog: Map<string, DeathRecord> = new Map();

  // Cluster snapshot: captured once at ~60% ticks for merger detection
  private clusterSnapshot: MyceliumNode[] | null = null;
  private clusterSnapshotTick: number;

  // Harvest tick: the tick at which survival is judged (harvestPct × targetTicks)
  private harvestTick: number;

  constructor(
    id: string,
    batchToken: string,
    sourcePoints: SourcePoint[],
    targetTicks: number,
    chunkRegistry: ChunkRegistry,
    harvestPct: number = 0.6,
  ) {
    this.id = id;
    this.batchToken = batchToken;
    this.sourcePoints = sourcePoints;
    this.targetTicks = targetTicks;
    this.chunkRegistry = chunkRegistry;
    this.harvestPct = harvestPct;
    this.forceSpore = (process.env.LOADER_FORCE_SPORE ?? "").toLowerCase() === "true";
    this.clusterSnapshotTick = Math.floor(targetTicks * (M.pushback?.clusterPct ?? 0.6));
    this.harvestTick = Math.floor(targetTicks * harvestPct);
  }

  get nodeCount(): number {
    return this.sourcePoints.length;
  }

  /** Per-chunk classification votes (sourcePoints index → classification).
   *  Available after harvest(). Used by consensus aggregation. */
  get chunkVotes(): ReadonlyMap<number, ChunkClassification> {
    return this._chunkVotes;
  }

  // ---- Inject source points into Mycelium Qdrant ----

  async inject(config: MyceliumConfig, currentTick: number): Promise<number> {
    this.status = "injecting";
    this.startTick = currentTick;

    const myceliumPoints: Array<{ id: string; vector: number[]; payload: ReturnType<typeof nodeToPayload> }> = [];

    for (let spIdx = 0; spIdx < this.sourcePoints.length; spIdx++) {
      const sp = this.sourcePoints[spIdx];
      const tags = sp.payload.tags ?? [];
      const trigger = "manual";
      // Species resolution: forceSpore treats all external data as unverified hypothesis
      // Set LOADER_SPECIES_FROM_TAGS=true to use tag-based species mapping instead
      const species = this.forceSpore
        ? resolveSpecies(trigger, [])   // ignore tags → trigger "manual" → spore
        : resolveSpecies(trigger, tags);
      const inherited = getSpeciesMemory(species);
      const inheritedRes = getSpeciesResonanceDelta(species);

      const { node } = createNode(
        sp.payload.text,
        undefined,  // no secondary content
        trigger,
        inherited,
        inheritedRes,
        undefined,   // no nutrition override
        tags,
        this.forceSpore ? "spore" : undefined,  // speciesOverride bypasses tag mapping
      );

      const qualifiedSid = sp.payload.sourceId ?? String(sp.id);

      myceliumPoints.push({
        id: node.id,
        vector: sp.vector,
        payload: nodeToPayload(node),
      });

      this.injectedNodeIds.add(node.id);
      this.nodeSourceMap.set(node.id, qualifiedSid);
      this.sourcePointIdxMap.set(node.id, spIdx);
    }

    // Add to colony store (in-memory) + persist to Qdrant
    for (const pt of myceliumPoints) {
      store.addNode({
        node: payloadToNode(pt.id, pt.payload),
        vector: pt.vector,
      });
    }
    const BATCH = 100;
    for (let i = 0; i < myceliumPoints.length; i += BATCH) {
      await upsertPoints(config.qdrantUrl, config.collection, myceliumPoints.slice(i, i + BATCH));
    }

    this.status = "running";
    console.error(
      `[loader:${this.id}] injected ${myceliumPoints.length} nodes ` +
      `(${this.chunkRegistry.size} sourceIds) at tick ${currentTick} ` +
      `[batch: ${this.batchToken}]`,
    );

    return myceliumPoints.length;
  }

  // ---- Tick tracking + death log collection ----

  async onTick(tickDeaths: Map<string, DeathRecord>, config: MyceliumConfig): Promise<void> {
    if (this.status === "running") {
      this.ticksElapsed++;

      // Collect deaths belonging to this instance's nodes
      for (const [nodeId, record] of tickDeaths) {
        if (this.injectedNodeIds.has(nodeId)) {
          this.deathLog.set(nodeId, record);
        }
      }

      // Capture cluster snapshot once at ~60% ticks (for merger detection)
      if (this.clusterSnapshot === null && this.ticksElapsed === this.clusterSnapshotTick) {
        const myNvs = store.getByIds(this.injectedNodeIds);
        this.clusterSnapshot = myNvs.map(nv => nv.node);
        console.error(
          `[loader:${this.id}] cluster snapshot at tick ${this.ticksElapsed}/${this.targetTicks}: ` +
          `${this.clusterSnapshot.length} nodes`,
        );
      }
    }
  }

  isComplete(): boolean {
    return this.status === "running" && this.ticksElapsed >= this.harvestTick;
  }

  // ---- Harvest survivors (per-sourceId reporting with pushback classification) ----

  async harvest(config: MyceliumConfig): Promise<SurvivorReport[]> {
    this.status = "harvesting";

    // Read surviving nodes from in-memory colony store
    const myNvs = store.getByIds(this.injectedNodeIds);

    // Build compatible point-like objects for downstream code
    const myNodes = myNvs.map(nv => ({
      id: nv.node.id,
      payload: nodeToPayload(nv.node),
    }));

    // Convert to MyceliumNode for pushback analysis
    const myLivingNodes = myNvs.map(nv => nv.node);

    // ---- Pushback 3-axis analysis ----
    const pureSurvivorCandidates = extractPureSurvivors(myLivingNodes);
    const pureNodeIds = new Set(pureSurvivorCandidates.map(c => c.nodeId));

    // Use 60% tick snapshot for merger detection if available, fall back to harvest-time nodes
    const mergerClusters = extractMergerClusters(this.clusterSnapshot ?? myLivingNodes);
    const mergerNodeIds = new Set(mergerClusters.map(c => c.originId));

    // Death-based analysis (relative ticks for this instance)
    const redundantNodeIds = new Set(extractRedundantIds(this.deathLog, this.targetTicks));
    const lonerNodeIds = new Set(extractLonerIds(this.deathLog, this.targetTicks));

    // ---- Build per-chunk votes (for consensus aggregation) ----
    const survivorIdSet = new Set(myNodes.map(p => p.id));
    this._chunkVotes.clear();
    for (const [nodeId, spIdx] of this.sourcePointIdxMap) {
      let cls: ChunkClassification;
      if (survivorIdSet.has(nodeId)) {
        cls = pureNodeIds.has(nodeId) ? "pure"
          : mergerNodeIds.has(nodeId) ? "merged"
          : "merged";
      } else {
        cls = lonerNodeIds.has(nodeId) ? "loner"
          : redundantNodeIds.has(nodeId) ? "redundant"
          : "dead";
      }
      this._chunkVotes.set(spIdx, cls);
    }

    // ---- Group surviving nodes by qualifiedSourceId ----
    const survivorsBySource = new Map<string, typeof myNodes>();
    for (const p of myNodes) {
      const sid = this.nodeSourceMap.get(p.id);
      if (!sid) continue;
      const group = survivorsBySource.get(sid);
      if (group) group.push(p);
      else survivorsBySource.set(sid, [p]);
    }

    // ---- Build per-sourceId reports with classification ----
    const reports: SurvivorReport[] = [];

    for (const [qualifiedSid, entry] of this.chunkRegistry) {
      const survivors = survivorsBySource.get(qualifiedSid) ?? [];
      const survivingCount = survivors.length;

      // Species distribution
      const speciesCounts: Record<Species, number> = {
        summarizer: 0, sentinel: 0, herald: 0, anchor: 0, spore: 0,
      };
      const survivingTexts: string[] = [];

      for (const p of survivors) {
        speciesCounts[p.payload.species]++;
        if (p.payload.contents.length > 0) {
          survivingTexts.push(p.payload.contents[0]);
        }
      }

      // Parts complete check
      const partsComplete = survivingCount <= entry.totalChunks;

      // ---- Classification: per-chunk breakdown ----
      const breakdown = this.classifyChunks(
        qualifiedSid, survivors, pureNodeIds, mergerNodeIds,
        redundantNodeIds, lonerNodeIds,
      );

      reports.push({
        sourceId: qualifiedSid,
        collection: entry.collection,
        batchToken: this.batchToken,
        totalChunks: entry.totalChunks,
        survivingChunks: survivingCount,
        survivalRate: entry.totalChunks > 0 ? survivingCount / entry.totalChunks : 0,
        species: speciesCounts,
        survivingTexts,
        partsComplete,
        classificationBreakdown: breakdown,
        sourceMetadata: entry.metadata,
      });
    }

    // Clean up: delete this instance's surviving nodes from store + Qdrant
    const survivorIds = myNodes.map(p => p.id);
    if (survivorIds.length > 0) {
      store.removeNodes(survivorIds);
      await deletePoints(config.qdrantUrl, config.collection, survivorIds);
    }

    this.status = "done";

    // Summary log with pushback breakdown
    const totalSurvived = myNodes.length;
    const totalInjected = this.sourcePoints.length;
    const classBreakdown = this.summarizeClassifications(reports);

    console.error(
      `[loader:${this.id}] harvested: ${totalSurvived}/${totalInjected} survived ` +
      `(${(totalSurvived / totalInjected * 100).toFixed(1)}%) ` +
      `pushback: ${classBreakdown}`,
    );

    return reports;
  }

  // ---- Classify each chunk individually, then derive dominant label ----

  private classifyChunks(
    qualifiedSid: string,
    survivors: Array<{ id: string; payload: { species: string; contents: string[] } }>,
    pureNodeIds: Set<string>,
    mergerNodeIds: Set<string>,
    redundantNodeIds: Set<string>,
    lonerNodeIds: Set<string>,
  ): ClassificationBreakdown {
    const breakdown: ClassificationBreakdown = {
      pure: 0, merged: 0, loner: 0, redundant: 0, dead: 0,
    };

    const survivorIds = new Set(survivors.map(s => s.id));

    // Classify ALL nodeIds for this sourceId (both alive and dead)
    const sourceNodeIds = [...this.nodeSourceMap.entries()]
      .filter(([, sid]) => sid === qualifiedSid)
      .map(([nid]) => nid);

    for (const nid of sourceNodeIds) {
      if (survivorIds.has(nid)) {
        // Alive — check pure or merged
        if (pureNodeIds.has(nid)) breakdown.pure++;
        else if (mergerNodeIds.has(nid)) breakdown.merged++;
        else breakdown.merged++;  // survived with absorptions = merged
      } else {
        // Dead — check loner, redundant, or generic death
        if (lonerNodeIds.has(nid)) breakdown.loner++;
        else if (redundantNodeIds.has(nid)) breakdown.redundant++;
        else breakdown.dead++;
      }
    }

    return breakdown;
  }

  private summarizeClassifications(reports: SurvivorReport[]): string {
    const totals: Record<string, number> = {};
    for (const r of reports) {
      for (const [cls, n] of Object.entries(r.classificationBreakdown)) {
        if (n > 0) totals[cls] = (totals[cls] ?? 0) + n;
      }
    }
    return Object.entries(totals)
      .map(([k, v]) => `${k}=${v}`)
      .join(" ");
  }
}
