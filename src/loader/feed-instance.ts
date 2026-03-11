// ============================================================
// FeedInstance — one batch of articles in the cascade pipeline
// ============================================================
//
// Lifecycle: pending → injecting → running → harvesting → done
// Each instance tracks its own sourceIds and tick count.
// All instances share the same Mycelium Qdrant collection.

import type { MyceliumConfig, Species } from "../types.js";
import type { SourcePoint } from "./source-scroll.js";
import { createNode, nodeToPayload, resolveSpecies } from "../core/node.js";
import { getSpeciesMemory, getSpeciesResonanceDelta } from "../core/digestor.js";
import { upsertPoints, scrollAll, deletePoints } from "../qdrant.js";
import type { MyceliumPointPayload } from "../types.js";
import { payloadToNode } from "../core/node.js";

// ---- Survivor report ----

export interface SurvivorReport {
  sourceId: string;
  totalChunks: number;
  survivingChunks: number;
  survivalRate: number;
  species: Record<Species, number>;
  survivingTexts: string[];
  resonancePartners: string[];  // sourceIds of resonance partners (future)
}

// ---- Instance status ----

export type InstanceStatus = "pending" | "injecting" | "running" | "harvesting" | "done" | "lost";

// ---- FeedInstance ----

export class FeedInstance {
  readonly id: string;
  readonly sourcePoints: SourcePoint[];
  readonly sourceIds: Set<string>;
  readonly targetTicks: number;

  status: InstanceStatus = "pending";
  startTick = 0;
  ticksElapsed = 0;

  // Mycelium node IDs created by this instance (for harvest filtering)
  private injectedNodeIds: Set<string> = new Set();

  constructor(id: string, sourcePoints: SourcePoint[], targetTicks: number) {
    this.id = id;
    this.sourcePoints = sourcePoints;
    this.targetTicks = targetTicks;

    // Collect unique sourceIds
    this.sourceIds = new Set<string>();
    for (const p of sourcePoints) {
      this.sourceIds.add(p.payload.sourceId ?? String(p.id));
    }
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
        undefined,   // no nutrition override (use defaults)
        tags,
      );

      // Track sourceId on the node (stored in contents for now)
      // The sourceId is preserved via the injectedNodeIds + sourceIds mapping

      myceliumPoints.push({
        id: node.id,
        vector: sp.vector,
        payload: nodeToPayload(node),
      });

      this.injectedNodeIds.add(node.id);
    }

    // Batch upsert
    const BATCH = 100;
    for (let i = 0; i < myceliumPoints.length; i += BATCH) {
      await upsertPoints(config.qdrantUrl, config.collection, myceliumPoints.slice(i, i + BATCH));
    }

    this.status = "running";
    console.error(
      `[loader:${this.id}] injected ${myceliumPoints.length} nodes ` +
      `(${this.sourceIds.size} sourceIds) at tick ${currentTick}`,
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

  // ---- Harvest survivors ----

  async harvest(config: MyceliumConfig): Promise<SurvivorReport[]> {
    this.status = "harvesting";

    // Scroll all surviving nodes
    const allPoints = await scrollAll(config.qdrantUrl, config.collection, false);

    // Filter to nodes that belong to this instance
    const myNodes = allPoints.filter(p => this.injectedNodeIds.has(p.id));

    // Build reports grouped by sourceId
    // Since we don't store sourceId on the mycelium node yet,
    // we use a flat report for now (all nodes in this instance)
    const reports: SurvivorReport[] = [];

    // Group surviving nodes (all belong to this instance's sourceIds)
    const survivingCount = myNodes.length;
    const totalCount = this.sourcePoints.length;

    // Species distribution of survivors
    const speciesCounts: Record<Species, number> = {
      summarizer: 0, sentinel: 0, herald: 0, anchor: 0, spore: 0,
    };
    const survivingTexts: string[] = [];

    for (const p of myNodes) {
      speciesCounts[p.payload.species]++;
      if (p.payload.contents.length > 0) {
        survivingTexts.push(p.payload.contents[0]);
      }
    }

    reports.push({
      sourceId: this.id,  // instance-level report
      totalChunks: totalCount,
      survivingChunks: survivingCount,
      survivalRate: totalCount > 0 ? survivingCount / totalCount : 0,
      species: speciesCounts,
      survivingTexts,
      resonancePartners: [],
    });

    // Clean up: delete this instance's surviving nodes from Mycelium Qdrant
    const survivorIds = myNodes.map(p => p.id);
    if (survivorIds.length > 0) {
      await deletePoints(config.qdrantUrl, config.collection, survivorIds);
    }

    this.status = "done";
    console.error(
      `[loader:${this.id}] harvested: ${survivingCount}/${totalCount} survived ` +
      `(${(reports[0].survivalRate * 100).toFixed(1)}%) — ` +
      `species: ${Object.entries(speciesCounts).filter(([,n]) => n > 0).map(([s,n]) => `${s}:${n}`).join(", ")}`,
    );

    return reports;
  }
}
