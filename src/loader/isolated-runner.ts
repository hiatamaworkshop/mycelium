// ============================================================
// IsolatedRunner — fully isolated slot executor for parallel runs
// ============================================================
//
// Each IsolatedRunner owns its own:
//   - in-memory node store (Map)
//   - digestor instance
//   - death log
//
// NO global singleton access (colony-store, tick.ts, observatory).
// Calls tickCore() directly for pure computation.
//
// Designed for p-limit style parallel execution: multiple runners
// can operate concurrently without state conflicts.

import type { MyceliumConfig, MyceliumNode, Species, WeightMatrix } from "../types.js";
import type { MetabolismSchema } from "../types.js";
import metabolismRaw from "../config/metabolism.json" with { type: "json" };
import type { SlotAssignment } from "./slot-allocator.js";
import type { DispatcherConfig } from "./dispatcher.js";
import type { SurvivorReport, ChunkClassification, ClassificationBreakdown, ChunkDetail, ClusterDetail, DeadBrief } from "./feed-instance.js";
import type { NodeWithVector } from "../core/tick-core.js";
import type { DeathRecord } from "../core/pushback.js";
import { tickCore } from "../core/tick-core.js";
import { createDigestor } from "../core/digestor.js";
import type { DigestorInstance } from "../core/digestor.js";
import { createNode, nodeToPayload, resolveSpecies } from "../core/node.js";
import {
  extractRedundantIds,
  extractLonerIds,
  extractPureSurvivors,
  extractMergerClusters,
} from "../core/pushback.js";

const M = metabolismRaw as unknown as MetabolismSchema;

// ---- Types ----

interface RunResult {
  reports: SurvivorReport[];
  chunkVotes: Map<number, ChunkClassification>;
}

// ---- IsolatedRunner ----

export class IsolatedRunner {
  private store = new Map<string, NodeWithVector>();
  private initialDelta: Record<string, WeightMatrix> | null = null;
  private initialResonanceDelta: Record<string, Record<string, number>> | null = null;

  constructor(
    private config: MyceliumConfig,
    private dispatchConfig: DispatcherConfig,
  ) {}

  /** Pre-load species memory snapshot (applied to each run's digestor). */
  loadSpeciesMemory(): void {
    const probe = createDigestor();
    if (probe.load(this.config)) {
      this.initialDelta = probe.getDelta();
      this.initialResonanceDelta = probe.getResonanceDeltaAll();
    }
  }

  // ---- Consensus: N runs with majority vote ----

  runConsensus(
    slot: SlotAssignment,
    runs: number,
    threshold: number,
    jitter: number,
  ): SurvivorReport[] {
    const allVotes = new Map<number, ChunkClassification[]>();
    let templateReports: SurvivorReport[] = [];

    for (let run = 0; run < runs; run++) {
      const { reports, chunkVotes } = this.runOnce(slot, jitter);

      for (const [idx, cls] of chunkVotes) {
        const votes = allVotes.get(idx) ?? [];
        votes.push(cls);
        allVotes.set(idx, votes);
      }

      templateReports = reports;
    }

    return this.buildConsensusReports(templateReports, allVotes, runs, threshold, slot);
  }

  // ---- Single run ----

  runOnce(slot: SlotAssignment, jitter: number): RunResult {
    this.store.clear();

    // Fresh digestor per run (with pre-loaded delta if available)
    const digestor = createDigestor({
      initialDelta: this.initialDelta ?? undefined,
      initialResonanceDelta: this.initialResonanceDelta ?? undefined,
    });

    // 1. Inject
    const { injectedNodeIds, nodeSourceMap, sourcePointIdxMap } =
      this.inject(slot, jitter, digestor);

    // 2. Tick loop
    const deathLog = new Map<string, DeathRecord>();
    const clusterSnapshotTick = Math.floor(
      this.dispatchConfig.targetTicks * (M.pushback?.clusterPct ?? 0.6),
    );
    const harvestTick = Math.floor(
      this.dispatchConfig.targetTicks * this.dispatchConfig.harvestPct,
    );
    let clusterSnapshot: MyceliumNode[] | null = null;

    for (let tick = 1; tick <= harvestTick; tick++) {
      const allNodes = Array.from(this.store.values());
      if (allNodes.length === 0) break;

      const result = tickCore(allNodes, M, tick, {
        recordAction: (sp, idx, f) => digestor.recordAction(sp, idx, f),
      });

      // Apply deaths
      for (const [id, record] of result.deaths) {
        this.store.delete(id);
        if (injectedNodeIds.has(id)) {
          deathLog.set(id, record);
        }
      }

      // Update survivors (tickCore mutates nodes in place, but we re-set for spawns)
      for (const nv of result.survivors) {
        this.store.set(nv.node.id, nv);
      }

      // Spawn children → local store only (no Qdrant)
      for (const spawn of result.spawns) {
        for (const child of spawn.children) {
          this.store.set(child.node.id, { node: child.node, vector: child.vector });
        }
      }

      // Cluster snapshot for merger detection
      if (clusterSnapshot === null && tick === clusterSnapshotTick) {
        clusterSnapshot = [];
        for (const id of injectedNodeIds) {
          const nv = this.store.get(id);
          if (nv) clusterSnapshot.push(nv.node);
        }
      }

      // Digestor
      if (digestor.shouldDigest(tick)) {
        const survivors = Array.from(this.store.values()).map(nv => nv.node);
        if (survivors.length > 0) digestor.digest(survivors, tick);
      }
    }

    // 3. Harvest
    return this.harvest(
      slot, injectedNodeIds, nodeSourceMap, sourcePointIdxMap,
      deathLog, clusterSnapshot,
    );
  }

  // ---- Inject source points into local store ----

  private inject(
    slot: SlotAssignment,
    jitter: number,
    digestor: DigestorInstance,
  ): {
    injectedNodeIds: Set<string>;
    nodeSourceMap: Map<string, string>;
    sourcePointIdxMap: Map<string, number>;
  } {
    const injectedNodeIds = new Set<string>();
    const nodeSourceMap = new Map<string, string>();
    const sourcePointIdxMap = new Map<string, number>();

    const BODY_ROTATION: Species[] = ["summarizer", "herald", "spore"];

    for (let spIdx = 0; spIdx < slot.points.length; spIdx++) {
      const sp = slot.points[spIdx];
      const tags = sp.payload.tags ?? [];
      const trigger = "manual";

      // Species resolution
      let species: Species;
      if (tags.length > 0) {
        species = resolveSpecies(trigger, tags);
      } else {
        species = BODY_ROTATION[spIdx % BODY_ROTATION.length];
      }

      const inherited = digestor.getMemory(species);
      const inheritedRes = digestor.getResonanceDelta(species);

      // Per-node jitter
      const nutrition = jitter > 0
        ? {
            w: M.birth.initialW * (1 + (Math.random() * 2 - 1) * jitter),
            h: M.birth.initialH * (1 + (Math.random() * 2 - 1) * jitter),
          }
        : undefined;

      const { node } = createNode(
        sp.payload.text,
        undefined,
        trigger,
        inherited,
        inheritedRes,
        nutrition,
        tags,
        tags.length === 0 ? species : undefined,
      );

      const qualifiedSid = sp.payload.sourceId ?? String(sp.id);

      this.store.set(node.id, { node, vector: sp.vector });
      injectedNodeIds.add(node.id);
      nodeSourceMap.set(node.id, qualifiedSid);
      sourcePointIdxMap.set(node.id, spIdx);
    }

    return { injectedNodeIds, nodeSourceMap, sourcePointIdxMap };
  }

  // ---- Harvest: classify chunks, build reports ----

  private harvest(
    slot: SlotAssignment,
    injectedNodeIds: Set<string>,
    nodeSourceMap: Map<string, string>,
    sourcePointIdxMap: Map<string, number>,
    deathLog: Map<string, DeathRecord>,
    clusterSnapshot: MyceliumNode[] | null,
  ): RunResult {
    // Surviving injected nodes
    const myLiving: MyceliumNode[] = [];
    const survivorIds = new Set<string>();
    for (const id of injectedNodeIds) {
      const nv = this.store.get(id);
      if (nv) {
        myLiving.push(nv.node);
        survivorIds.add(id);
      }
    }

    // Pushback 3-axis
    const pureNodeIds = new Set(extractPureSurvivors(myLiving).map(c => c.nodeId));
    const mergerClusters = extractMergerClusters(clusterSnapshot ?? myLiving);
    const mergerNodeIds = new Set(mergerClusters.map(c => c.originId));
    const redundantNodeIds = new Set(extractRedundantIds(deathLog, this.dispatchConfig.targetTicks));
    const lonerNodeIds = new Set(extractLonerIds(deathLog, this.dispatchConfig.targetTicks));

    // Per-chunk votes
    const chunkVotes = new Map<number, ChunkClassification>();
    for (const [nodeId, spIdx] of sourcePointIdxMap) {
      let cls: ChunkClassification;
      if (survivorIds.has(nodeId)) {
        cls = pureNodeIds.has(nodeId) ? "pure"
          : mergerNodeIds.has(nodeId) ? "merged"
          : "merged";
      } else {
        cls = lonerNodeIds.has(nodeId) ? "loner"
          : redundantNodeIds.has(nodeId) ? "redundant"
          : "dead";
      }
      chunkVotes.set(spIdx, cls);
    }

    // Group survivors by sourceId
    const survivorsBySource = new Map<string, MyceliumNode[]>();
    for (const node of myLiving) {
      const sid = nodeSourceMap.get(node.id);
      if (!sid) continue;
      const group = survivorsBySource.get(sid);
      if (group) group.push(node);
      else survivorsBySource.set(sid, [node]);
    }

    // Build nodeId → spIdx reverse map for seqNo lookup
    const nodeIdToSpIdx = new Map<string, number>();
    for (const [nid, spIdx] of sourcePointIdxMap) {
      nodeIdToSpIdx.set(nid, spIdx);
    }

    // Build merger origin lookup: nodeId → cluster detail
    const mergerByNodeId = new Map(mergerClusters.map(c => [c.originId, c]));

    // Build per-sourceId reports
    const reports: SurvivorReport[] = [];
    for (const [qualifiedSid, entry] of slot.chunkRegistry) {
      const survivors = survivorsBySource.get(qualifiedSid) ?? [];

      const speciesCounts: Record<Species, number> = {
        summarizer: 0, sentinel: 0, herald: 0, anchor: 0, spore: 0,
      };
      const survivingTexts: string[] = [];
      const survivorTagCounts: Record<string, number> = {};

      for (const node of survivors) {
        speciesCounts[node.species]++;
        if (node.contents.length > 0) survivingTexts.push(node.contents[0]);
      }

      // Per-chunk classification breakdown + detail arrays
      const breakdown: ClassificationBreakdown = {
        pure: 0, merged: 0, loner: 0, redundant: 0, dead: 0,
      };
      const chunkDetails: ChunkDetail[] = [];
      const pureDetails: ChunkDetail[] = [];
      const clusterDetails: ClusterDetail[] = [];
      const deadBriefs: DeadBrief[] = [];

      const sourceNodeIds = [...nodeSourceMap.entries()]
        .filter(([, sid]) => sid === qualifiedSid)
        .map(([nid]) => nid);

      for (const nid of sourceNodeIds) {
        const spIdx = nodeIdToSpIdx.get(nid) ?? -1;
        const seqNo = slot.points[spIdx]?.payload.chunkSeqNo ?? spIdx;
        const text = slot.points[spIdx]?.payload.text ?? "";

        if (survivorIds.has(nid)) {
          const node = myLiving.find(n => n.id === nid);
          const species = node?.species ?? "summarizer";
          const isPure = pureNodeIds.has(nid);
          const cls: ChunkClassification = isPure ? "pure" : "merged";

          // Collect tags from surviving chunks
          const chunkTags: string[] = slot.points[spIdx]?.payload.tags ?? [];
          for (const tag of chunkTags) {
            survivorTagCounts[tag] = (survivorTagCounts[tag] ?? 0) + 1;
          }

          if (isPure) breakdown.pure++;
          else breakdown.merged++;

          const detail: ChunkDetail = {
            chunkSeqNo: seqNo,
            text: node?.contents[0] ?? text,
            species,
            classification: cls,
          };
          chunkDetails.push(detail);
          if (isPure) pureDetails.push(detail);

          // Cluster detail for merger origins
          const mc = mergerByNodeId.get(nid);
          if (mc) {
            clusterDetails.push({
              originChunkSeqNo: seqNo,
              clusterSize: mc.clusterSize,
              depth1Count: mc.depth1Count,
              deepChainCount: mc.deepChainCount,
              species,
              sampleText: (node?.contents[0] ?? text).slice(0, 150),
              composition: mc.composition,
            });
          }
        } else {
          // Dead node — build brief
          let cls: ChunkClassification;
          if (lonerNodeIds.has(nid)) { cls = "loner"; breakdown.loner++; }
          else if (redundantNodeIds.has(nid)) { cls = "redundant"; breakdown.redundant++; }
          else { cls = "dead"; breakdown.dead++; }

          const death = deathLog.get(nid);
          deadBriefs.push({
            chunkSeqNo: seqNo,
            classification: cls as "redundant" | "loner" | "dead",
            snippet: text.slice(0, 80),
            cause: death?.cause,
            cosine: death?.cosine,
            posRes: death?.posRes,
          });
        }
      }

      // Sort by document position
      chunkDetails.sort((a, b) => a.chunkSeqNo - b.chunkSeqNo);
      pureDetails.sort((a, b) => a.chunkSeqNo - b.chunkSeqNo);
      clusterDetails.sort((a, b) => b.clusterSize - a.clusterSize);
      deadBriefs.sort((a, b) => a.chunkSeqNo - b.chunkSeqNo);

      reports.push({
        sourceId: qualifiedSid,
        collection: entry.collection,
        batchToken: slot.batchToken,
        totalChunks: entry.totalChunks,
        survivingChunks: survivors.length,
        survivalRate: entry.totalChunks > 0 ? survivors.length / entry.totalChunks : 0,
        species: speciesCounts,
        survivingTexts,
        partsComplete: survivors.length <= entry.totalChunks,
        classificationBreakdown: breakdown,
        sourceMetadata: entry.metadata,
        survivorTags: Object.keys(survivorTagCounts).length > 0 ? survivorTagCounts : undefined,
        chunkDetails,
        pureSurvivors: pureDetails,
        mergerClusters: clusterDetails,
        deadBriefs,
      });
    }

    return { reports, chunkVotes };
  }

  // ---- Consensus aggregation ----

  private buildConsensusReports(
    templateReports: SurvivorReport[],
    allVotes: Map<number, ChunkClassification[]>,
    runs: number,
    threshold: number,
    slot: SlotAssignment,
  ): SurvivorReport[] {
    const minVotes = Math.ceil(runs * threshold);

    // Majority vote per chunk
    const consensusVotes = new Map<number, ChunkClassification>();
    const passedThreshold = new Set<number>();

    for (const [idx, votes] of allVotes) {
      const { cls, count } = majorityVote(votes);
      consensusVotes.set(idx, cls);
      if (count >= minVotes) passedThreshold.add(idx);
    }

    // Map sourcePoint index → qualifiedSourceId
    const idxToSourceId = new Map<number, string>();
    for (let pi = 0; pi < slot.points.length; pi++) {
      const sp = slot.points[pi];
      idxToSourceId.set(pi, sp.payload.sourceId ?? String(sp.id));
    }

    // Build per-sourceId consensus breakdown
    const sourceBreakdowns = new Map<string, ClassificationBreakdown>();
    const sourceConsensus = new Map<string, { total: number; passed: number }>();

    for (const [idx, cls] of consensusVotes) {
      const sid = idxToSourceId.get(idx);
      if (!sid) continue;

      const effectiveCls = passedThreshold.has(idx) ? cls : "dead" as ChunkClassification;

      let bd = sourceBreakdowns.get(sid);
      if (!bd) {
        bd = { pure: 0, merged: 0, loner: 0, redundant: 0, dead: 0 };
        sourceBreakdowns.set(sid, bd);
      }
      bd[effectiveCls]++;

      let sc = sourceConsensus.get(sid);
      if (!sc) {
        sc = { total: 0, passed: 0 };
        sourceConsensus.set(sid, sc);
      }
      sc.total++;
      if (passedThreshold.has(idx)) sc.passed++;
    }

    // Build consensus classification lookup: spIdx → effective classification
    const idxConsensus = new Map<number, ChunkClassification>();
    for (const [idx, cls] of consensusVotes) {
      idxConsensus.set(idx, passedThreshold.has(idx) ? cls : "dead" as ChunkClassification);
    }

    // Build seqNo → spIdx reverse map for detail filtering
    const seqToIdx = new Map<number, number>();
    for (let pi = 0; pi < slot.points.length; pi++) {
      const seqNo = slot.points[pi]?.payload.chunkSeqNo ?? pi;
      seqToIdx.set(seqNo, pi);
    }

    // Patch template reports — reconcile detail arrays with consensus
    return templateReports.map(r => {
      const bd = sourceBreakdowns.get(r.sourceId) ?? r.classificationBreakdown;
      const survivorCount = bd.pure + bd.merged;
      const sc = sourceConsensus.get(r.sourceId);
      const rate = sc && sc.total > 0 ? sc.passed / sc.total : 1;

      // Re-classify detail arrays based on consensus votes
      const consensusSurvivorCls = new Set<string>(["pure", "merged"]);

      const chunkDetails = (r.chunkDetails ?? []).filter(c => {
        const spIdx = seqToIdx.get(c.chunkSeqNo);
        if (spIdx == null) return false;
        const cls = idxConsensus.get(spIdx);
        return cls != null && consensusSurvivorCls.has(cls);
      }).map(c => {
        const spIdx = seqToIdx.get(c.chunkSeqNo)!;
        const cls = idxConsensus.get(spIdx)!;
        return { ...c, classification: cls };
      });

      const pureSurvivors = chunkDetails.filter(c => c.classification === "pure");

      // Keep merger clusters only if their origin is still a survivor
      const survivorSeqs = new Set(chunkDetails.map(c => c.chunkSeqNo));
      const mergerClusters = (r.mergerClusters ?? []).filter(c =>
        survivorSeqs.has(c.originChunkSeqNo),
      );

      // Rebuild dead briefs from consensus (non-survivors from template)
      const deadBriefs = (r.deadBriefs ?? []).filter(d => {
        const spIdx = seqToIdx.get(d.chunkSeqNo);
        if (spIdx == null) return true; // keep if unknown
        const cls = idxConsensus.get(spIdx);
        return cls != null && !consensusSurvivorCls.has(cls);
      }).map(d => {
        const spIdx = seqToIdx.get(d.chunkSeqNo);
        const cls = spIdx != null ? idxConsensus.get(spIdx) : undefined;
        if (cls && !consensusSurvivorCls.has(cls)) {
          return { ...d, classification: cls as "redundant" | "loner" | "dead" };
        }
        return d;
      });

      // Also add template survivors that consensus demoted to dead
      const templateSurvivorSeqs = new Set((r.chunkDetails ?? []).map(c => c.chunkSeqNo));
      for (const [spIdx, cls] of idxConsensus) {
        if (consensusSurvivorCls.has(cls)) continue;
        const seqNo = slot.points[spIdx]?.payload.chunkSeqNo ?? spIdx;
        const sid = idxToSourceId.get(spIdx);
        if (sid !== r.sourceId) continue;
        if (templateSurvivorSeqs.has(seqNo) && !deadBriefs.some(d => d.chunkSeqNo === seqNo)) {
          const text = slot.points[spIdx]?.payload.text ?? "";
          deadBriefs.push({
            chunkSeqNo: seqNo,
            classification: cls as "redundant" | "loner" | "dead",
            snippet: text.slice(0, 80),
          });
        }
      }
      deadBriefs.sort((a, b) => a.chunkSeqNo - b.chunkSeqNo);

      // Rebuild survivorTags from consensus survivors
      const survivorTagCounts: Record<string, number> = {};
      for (const c of chunkDetails) {
        const spIdx = seqToIdx.get(c.chunkSeqNo);
        if (spIdx == null) continue;
        const tags: string[] = slot.points[spIdx]?.payload.tags ?? [];
        for (const tag of tags) {
          survivorTagCounts[tag] = (survivorTagCounts[tag] ?? 0) + 1;
        }
      }

      return {
        ...r,
        classificationBreakdown: bd,
        survivingChunks: survivorCount,
        survivalRate: r.totalChunks > 0 ? survivorCount / r.totalChunks : 0,
        consensusRate: rate,
        chunkDetails,
        pureSurvivors: pureSurvivors,
        mergerClusters,
        deadBriefs,
        survivorTags: Object.keys(survivorTagCounts).length > 0 ? survivorTagCounts : undefined,
      };
    });
  }
}

// ---- Helpers ----

function majorityVote(
  votes: ChunkClassification[],
): { cls: ChunkClassification; count: number } {
  const counts: Record<string, number> = {};
  for (const v of votes) counts[v] = (counts[v] ?? 0) + 1;
  let best = votes[0];
  let bestCount = 0;
  for (const [cls, n] of Object.entries(counts)) {
    if (n > bestCount) {
      bestCount = n;
      best = cls as ChunkClassification;
    }
  }
  return { cls: best, count: bestCount };
}

// ---- p-limit style concurrency control ----

export function pLimit(concurrency: number) {
  let active = 0;
  const queue: Array<() => void> = [];

  function next(): void {
    while (queue.length > 0 && active < concurrency) {
      active++;
      const fn = queue.shift()!;
      fn();
    }
  }

  return <T>(fn: () => Promise<T>): Promise<T> => {
    return new Promise<T>((resolve, reject) => {
      queue.push(() => {
        fn().then(resolve, reject).finally(() => {
          active--;
          next();
        });
      });
      next();
    });
  };
}
