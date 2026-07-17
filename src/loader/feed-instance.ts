// ============================================================
// Feed Instance — type definitions for survivor reports
// ============================================================
//
// Shared types used by IsolatedRunner, main.ts, and formatters.
// The FeedInstance class (legacy cascade pipeline) has been removed.

import type { Species } from "../types.js";

// ---- Classification ----

export type ChunkClassification = "pure" | "loner" | "redundant" | "merged" | "dead";

/** Per-chunk classification distribution for a sourceId */
export type ClassificationBreakdown = Record<ChunkClassification, number>;

/** Individual chunk with position + classification */
export interface ChunkDetail {
  chunkSeqNo: number;
  /** Source Qdrant point id — write-back key for external metrics (fuel loop) */
  pointId?: string;
  text: string;
  species: Species;
  classification: ChunkClassification;
  /** Per-chunk consensus agreement rate (topVotes / totalRuns). Only set in consensus mode. */
  consensusRate?: number;
}

/** Dead chunk brief (redundant/loner) — lightweight identifier + snippet */
export interface DeadBrief {
  chunkSeqNo: number;
  /** Source Qdrant point id — write-back key for external metrics (fuel loop) */
  pointId?: string;
  classification: "redundant" | "loner" | "dead";
  snippet: string;           // first ~80 chars
  cause?: string;            // death cause from deathLog
  cosine?: number;           // merge similarity (redundant)
  posRes?: number;           // positive resonance (loner)
  /** Per-chunk consensus agreement rate (topVotes / totalRuns). Only set in consensus mode. */
  consensusRate?: number;
}

/** Merger cluster mapped to source position */
export interface ClusterDetail {
  originChunkSeqNo: number;
  clusterSize: number;
  depth1Count: number;
  deepChainCount: number;
  species: Species;
  sampleText: string;
  /** All contents of the cluster origin node (origin text + absorbed member texts) */
  memberTexts?: string[];
  /** Species composition of absorbed members (excludes origin) */
  composition?: Partial<Record<Species, number>>;
}

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
  /** Post-filter tag frequency among surviving chunks */
  survivorTags?: Record<string, number>;
  /** Per-chunk detail for all survivors (pure + merged) with seqNo */
  chunkDetails?: ChunkDetail[];
  /** Pure survivor chunks only */
  pureSurvivors?: ChunkDetail[];
  /** Merger cluster details */
  mergerClusters?: ClusterDetail[];
  /** Dead chunk briefs (redundant + loner + dead) */
  deadBriefs?: DeadBrief[];
}
