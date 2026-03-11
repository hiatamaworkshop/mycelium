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

import type { MyceliumConfig, Species } from "../types.js";
import type { SourcePoint } from "./source-scroll.js";
import type { ChunkRegistry } from "./slot-allocator.js";
import type { DeathRecord } from "../core/pushback.js";
import { extractRedundantIds, extractLonerIds, extractPureSurvivors, extractMergerClusters } from "../core/pushback.js";
import { createNode, nodeToPayload, payloadToNode, resolveSpecies } from "../core/node.js";
import { getSpeciesMemory, getSpeciesResonanceDelta } from "../core/digestor.js";
import { upsertPoints, scrollAll, deletePoints } from "../qdrant.js";

// ---- Classification ----

export type SourceClassification = "pure" | "loner" | "redundant" | "merged" | "dead" | "partial";

// ---- Survivor report (per sourceId) ----

export interface SurvivorReport {
  /** Qualified sourceId ({collection}:{rawId}) */
  sourceId: string;
  /** Original collection name */
  collection: string;
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
  /** Pushback classification */
  classification: SourceClassification;
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

  status: InstanceStatus = "pending";
  startTick = 0;
  ticksElapsed = 0;

  // Mycelium node IDs created by this instance (for harvest filtering)
  private injectedNodeIds: Set<string> = new Set();

  // nodeId → qualifiedSourceId mapping (for per-source harvest)
  private nodeSourceMap: Map<string, string> = new Map();

  // Death log: accumulated from global tick deaths, filtered to this instance's nodes
  private deathLog: Map<string, DeathRecord> = new Map();

  constructor(
    id: string,
    batchToken: string,
    sourcePoints: SourcePoint[],
    targetTicks: number,
    chunkRegistry: ChunkRegistry,
  ) {
    this.id = id;
    this.batchToken = batchToken;
    this.sourcePoints = sourcePoints;
    this.targetTicks = targetTicks;
    this.chunkRegistry = chunkRegistry;
    this.forceSpore = (process.env.LOADER_SPECIES_FROM_TAGS ?? "").toLowerCase() !== "true";
  }

  get nodeCount(): number {
    return this.sourcePoints.length;
  }

  // ---- Inject source points into Mycelium Qdrant ----

  async inject(config: MyceliumConfig, currentTick: number): Promise<number> {
    this.status = "injecting";
    this.startTick = currentTick;

    const myceliumPoints: Array<{ id: string; vector: number[]; payload: ReturnType<typeof nodeToPayload> }> = [];

    for (const sp of this.sourcePoints) {
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
    }

    // Batch upsert (IO control: other instances are paused during inject)
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

  onTick(tickDeaths: Map<string, DeathRecord>): void {
    if (this.status === "running") {
      this.ticksElapsed++;

      // Collect deaths belonging to this instance's nodes
      for (const [nodeId, record] of tickDeaths) {
        if (this.injectedNodeIds.has(nodeId)) {
          this.deathLog.set(nodeId, record);
        }
      }
    }
  }

  isComplete(): boolean {
    return this.status === "running" && this.ticksElapsed >= this.targetTicks;
  }

  // ---- Harvest survivors (per-sourceId reporting with pushback classification) ----

  async harvest(config: MyceliumConfig): Promise<SurvivorReport[]> {
    this.status = "harvesting";

    // Scroll all surviving nodes (with vectors=false, we need payload for pushback)
    const allPoints = await scrollAll(config.qdrantUrl, config.collection, false);

    // Filter to nodes that belong to this instance
    const myNodes = allPoints.filter(p => this.injectedNodeIds.has(p.id));

    // Convert to MyceliumNode for pushback analysis
    const myLivingNodes = myNodes.map(p => payloadToNode(p.id, p.payload));

    // ---- Pushback 3-axis analysis ----
    const pureSurvivorCandidates = extractPureSurvivors(myLivingNodes);
    const pureNodeIds = new Set(pureSurvivorCandidates.map(c => c.nodeId));

    const mergerClusters = extractMergerClusters(myLivingNodes);
    const mergerNodeIds = new Set(mergerClusters.map(c => c.originId));

    // Death-based analysis (relative ticks for this instance)
    const redundantNodeIds = new Set(extractRedundantIds(this.deathLog, this.targetTicks));
    const lonerNodeIds = new Set(extractLonerIds(this.deathLog, this.targetTicks));

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

      // ---- Classification: map nodeId-level pushback to sourceId ----
      const classification = this.classifySource(
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
        classification,
      });
    }

    // Clean up: delete this instance's surviving nodes from Mycelium Qdrant
    const survivorIds = myNodes.map(p => p.id);
    if (survivorIds.length > 0) {
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

  // ---- Classify a sourceId based on its nodes' pushback results ----

  private classifySource(
    _qualifiedSid: string,
    survivors: Array<{ id: string; payload: { species: string; contents: string[] } }>,
    pureNodeIds: Set<string>,
    mergerNodeIds: Set<string>,
    redundantNodeIds: Set<string>,
    lonerNodeIds: Set<string>,
  ): SourceClassification {
    if (survivors.length === 0) {
      // All chunks died — check death causes
      // Get all nodeIds for this sourceId
      const sourceNodeIds = [...this.nodeSourceMap.entries()]
        .filter(([, sid]) => sid === _qualifiedSid)
        .map(([nid]) => nid);

      const allLoner = sourceNodeIds.every(nid => lonerNodeIds.has(nid));
      if (allLoner && sourceNodeIds.length > 0) return "loner";

      const allRedundant = sourceNodeIds.every(nid => redundantNodeIds.has(nid));
      if (allRedundant && sourceNodeIds.length > 0) return "redundant";

      return "dead";
    }

    // Some chunks survived
    const hasPure = survivors.some(p => pureNodeIds.has(p.id));
    const hasMerger = survivors.some(p => mergerNodeIds.has(p.id));

    if (hasMerger) return "merged";
    if (hasPure) return "pure";

    return "partial";
  }

  private summarizeClassifications(reports: SurvivorReport[]): string {
    const counts: Record<string, number> = {};
    for (const r of reports) {
      counts[r.classification] = (counts[r.classification] ?? 0) + 1;
    }
    return Object.entries(counts)
      .map(([k, v]) => `${k}=${v}`)
      .join(" ");
  }
}
