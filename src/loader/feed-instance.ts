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
//
// Harvest waits for all parts: reports per-sourceId survival,
// including how many chunks survived vs total expected.

import type { MyceliumConfig, Species } from "../types.js";
import type { SourcePoint } from "./source-scroll.js";
import type { ChunkRegistry } from "./slot-allocator.js";
import { createNode, nodeToPayload, resolveSpecies } from "../core/node.js";
import { getSpeciesMemory, getSpeciesResonanceDelta } from "../core/digestor.js";
import { upsertPoints, scrollAll, deletePoints } from "../qdrant.js";

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

  status: InstanceStatus = "pending";
  startTick = 0;
  ticksElapsed = 0;

  // Mycelium node IDs created by this instance (for harvest filtering)
  private injectedNodeIds: Set<string> = new Set();

  // nodeId → qualifiedSourceId mapping (for per-source harvest)
  private nodeSourceMap: Map<string, string> = new Map();

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
      const species = resolveSpecies(trigger, tags);
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

  // ---- Tick tracking ----

  onTick(): void {
    if (this.status === "running") {
      this.ticksElapsed++;
    }
  }

  isComplete(): boolean {
    return this.status === "running" && this.ticksElapsed >= this.targetTicks;
  }

  // ---- Harvest survivors (per-sourceId reporting with parts check) ----

  async harvest(config: MyceliumConfig): Promise<SurvivorReport[]> {
    this.status = "harvesting";

    // Scroll all surviving nodes
    const allPoints = await scrollAll(config.qdrantUrl, config.collection, false);

    // Filter to nodes that belong to this instance
    const myNodes = allPoints.filter(p => this.injectedNodeIds.has(p.id));

    // Group surviving nodes by qualifiedSourceId
    const survivorsBySource = new Map<string, typeof myNodes>();
    for (const p of myNodes) {
      const sid = this.nodeSourceMap.get(p.id);
      if (!sid) continue;
      const group = survivorsBySource.get(sid);
      if (group) group.push(p);
      else survivorsBySource.set(sid, [p]);
    }

    // Build per-sourceId reports
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

      // Parts complete check: all injected chunks accounted for
      // (survived + died = total → we can verify survived ≤ total)
      const partsComplete = survivingCount <= entry.totalChunks;

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
      });
    }

    // Clean up: delete this instance's surviving nodes from Mycelium Qdrant
    const survivorIds = myNodes.map(p => p.id);
    if (survivorIds.length > 0) {
      await deletePoints(config.qdrantUrl, config.collection, survivorIds);
    }

    this.status = "done";

    // Summary log
    const totalSurvived = myNodes.length;
    const totalInjected = this.sourcePoints.length;
    const chunkedSources = [...this.chunkRegistry.entries()]
      .filter(([, e]) => e.totalChunks > 1);
    const chunkedLog = chunkedSources.length > 0
      ? ` [chunked: ${chunkedSources.map(([sid, e]) => {
          const survived = (survivorsBySource.get(sid) ?? []).length;
          return `${sid}(${survived}/${e.totalChunks})`;
        }).join(", ")}]`
      : "";

    console.error(
      `[loader:${this.id}] harvested: ${totalSurvived}/${totalInjected} survived ` +
      `(${(totalSurvived / totalInjected * 100).toFixed(1)}%)${chunkedLog}`,
    );

    return reports;
  }
}
