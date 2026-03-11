// ============================================================
// Mycelium — Core types (Phase 2)
// ============================================================

// ---- Species (determined by ingestion trigger) ----

export type Species = "summarizer" | "sentinel" | "herald" | "anchor" | "spore";

export const ALL_SPECIES: Species[] = ["summarizer", "sentinel", "herald", "anchor", "spore"];

export const TRIGGER_TO_SPECIES: Record<string, Species> = {
  "session-end": "summarizer",     // session summaries → merge-oriented consolidator
  "milestone": "summarizer",       // knowledge milestones → merge-oriented consolidator
  "error-resolved": "anchor",      // error knowledge → immovable hard facts
  "manual": "spore",               // unverified input → fragile hypothesis
  "git-commit": "herald",          // commits → propagation of changes
  "convention": "sentinel",        // rules/standards → watchdog enforcement
  "environment": "anchor",         // env config → immovable infrastructure
};

// ---- Actions & Reactions ----

export type Action = "signal" | "merge" | "bequeath" | "survive";
export type ReactionType = "accept" | "reject" | "retaliate" | "ignore" | "flee";

export const ACTIONS: Action[] = ["signal", "merge", "bequeath", "survive"];
export const REACTIONS: ReactionType[] = ["accept", "reject", "retaliate", "ignore", "flee"];

// Unified behavior rows: 4 actions + 5 reactions = 9
export const BEHAVIOR_KEYS = [...ACTIONS, ...REACTIONS] as const;
export type BehaviorKey = (typeof BEHAVIOR_KEYS)[number];

// ---- Feelings ----

export interface Feelings {
  vigor: number;     // energized, world is active
  dread: number;     // decaying fast, death is near
  kinship: number;   // kin nearby, being heard
  hunger: number;    // light, disconnected
}

export const FEELING_KEYS: (keyof Feelings)[] = ["vigor", "dread", "kinship", "hunger"];
export const FEELINGS_DIM = 4;

// ---- Weight matrices ----

// WeightMatrix: rows × FEELINGS_DIM columns
export type WeightMatrix = number[][];

// ---- Species config (species.json) ----

export interface SpeciesConfig {
  // Stage 1: perception matrix — 4 feelings × 9 raw inputs (species DNA, immutable)
  perception: WeightMatrix;

  // Stage 2: personality matrix — 9 behaviors × 4 feelings (species DNA, immutable)
  personality: WeightMatrix;

  // resonance sensitivity per species (how this species reacts to resonance from each species)
  resonanceSensitivity: Record<Species, number>;

  // receptivity: how much incoming signal feelings influence this species' reaction
  // 0 = deaf (reacts only from own state), 1 = fully empathetic (incoming feelings dominate)
  receptivity: number;

  // per-species w boost on signal+accept (0 = off, >0 = social nourishment)
  signalAcceptWBoost?: number;

  // resonance receive scale: multiplier on all incoming resonance (1.0=full, 0.3=dampened for anchors)
  resonanceReceiveScale?: number;

  // selection bias: multiplier on cosine score when this species selects a target
  // >1 = prefer, <1 = avoid. Applied as: effectiveScore = cosine × selectionBias[target.species]
  selectionBias?: Record<string, number>;

  // merge target bias: multiplier applied to this species' score when it is a merge target
  // 1.0 = normal, 0 = never targeted for merge. Only applies when initiator's action is "merge".
  // Unlike selectionBias (initiator-side), this is target-side: "how mergeable am I?"
  mergeTargetBias?: number;

  initialDecay: number;
  initialTtl: number;
}

// ---- Environment (tick-local, not stored on node) ----

export interface Environment {
  neighborField: {
    h: number;    // avg heat of cosine neighbors
    w: number;    // avg weight
    d: number;    // avg decay
  };
  kinCount: number;
  neighborSpecies: Record<Species, number>;
}

// ---- ActionSignal (active receptor emission) ----

export interface ActionSignal {
  action: Action;
  species: Species;
  feelings: Feelings;
  strength: number;   // fitness score (computed, not stored)
}

// ---- Lineage (spawn tracking) ----

export interface ParentInfo {
  id: string;
  species: Species;
  fitness: number;
}

export interface Lineage {
  parentA: ParentInfo;
  parentB: ParentInfo;
  generation: number;
}

// ---- MyceliumNode (Phase 2) ----

export interface MyceliumNode {
  id: string;
  species: Species;
  contents: string[];

  // body state (node owns, persisted)
  h: number;        // heat — activity level, 0.0-1.0
  w: number;        // weight — resource accumulation
  d: number;        // decay rate
  ttl: number;      // remaining lifespan in ticks

  // resonance — species-colored interaction receipt (reset each tick)
  resonance: Record<Species, number>;

  // personality (DNA: immutable species base, 9×4)
  personality: WeightMatrix;

  // learned delta (experience: mutable, clamp ±deltaClamp, 9×4)
  learnedDelta: WeightMatrix;

  // learned resonance sensitivity delta (experience: mutable, per-species)
  // effective sensitivity = baseSensitivity * (1 + learnedResonanceDelta[sp])
  learnedResonanceDelta: Record<Species, number>;

  // lineage (spawn origin, undefined for seed nodes)
  lineage?: Lineage;

  // engram origin tracking (undefined for spawned nodes)
  engramId?: string;

  // frustration — unfulfilled action desires projected back into feelings space
  // Lorenz hydraulic model: chosen actions drain, unchosen accumulate
  frustration?: Feelings;

  // selfReflection — how initiator's passive receptor interprets the reaction received
  // "I acted, they reacted — how does that make me feel?"
  // Computed after resolveInteraction, blended into next tick's feelings
  selfReflection?: Feelings;

  // timestamps
  createdAt: number;
  lastActiveAt: number;
}

// ---- Qdrant payload (what we store in Qdrant) ----

export interface MyceliumPointPayload {
  species: Species;
  contents: string[];

  h: number;
  w: number;
  d: number;
  ttl: number;

  // resonance stored as JSON string (Record<Species, number>)
  resonance: string;

  // personality stored as JSON string (WeightMatrix)
  personality: string;

  // learnedDelta stored as JSON string (WeightMatrix)
  learnedDelta: string;

  // learnedResonanceDelta stored as JSON string (Record<Species, number>)
  learnedResonanceDelta: string;

  // frustration stored as JSON string (Feelings | undefined)
  frustration?: string;

  // selfReflection stored as JSON string (Feelings | undefined)
  selfReflection?: string;

  // lineage stored as JSON string (Lineage | undefined)
  lineage?: string;

  // engram origin ID (undefined for spawned nodes)
  engramId?: string;

  createdAt: number;
  lastActiveAt: number;
}

// ---- Metabolism schema (metabolism.json) ----

export interface MetabolismSchema {
  pressure: {
    hCooling: number;
    ttlStep: number;
    deathMinTtl: number;
    deathMinW: number;
  };

  relief: {
    surviveTtlRecovery: number;
    surviveDecayReduction: number;
    surviveHRecovery: number;
    surviveWRecovery: number;
    surviveWCost: number;
  };

  energy: {
    baseCost: Record<string, number>;
    reactionCost: Record<string, number>;
  };

  social: {
    neighborLimit: number;
    signalExtraReach: number;
    resonanceDecay: number;
    targetAffinity?: Record<string, number>;
  };

  birth: {
    initialH: number;
    initialW: number;
  };

  scoring: {
    halfLifeHours: number;
    dimensions: { wWeight: number; hWeight: number; ttlWeight: number };
    hungerThresholds: { low: number; mid: number };
    hungerFloor: number;
    hungerCeil: number;
    speciesProtection: number;
    blendRatio: { self: number; global: number };
    digestIntervalTicks: number;
  };

  decision: {
    temperature: number;
  };

  frustration: {
    enabled: boolean;
    decay: number;
    accum: number;
    blend: number;
  };

  selfReflection: {
    enabled: boolean;
    blend: number;
    decay: number;
  };

  learning: {
    rate: number;
    deltaClamp: number;
    blendAlpha: number;
    deltaDecay: number;
    resonanceLrScale: number;
  };

  spawn: {
    minContents: number;
    minFitness: number;
    minResonance: number;
    minPartnerSimilarity: number;
    childTtlRatio: number;
    blendMode: "same" | "cross";
    resonanceInheritRatio: number;
  };

  merge: {
    proximityThreshold: number;
    minSimilarity?: number;
  };

  observatory: {
    enabled: boolean;
    intervalTicks: number;
    bufferSize: number;
    minPopulation: number;
  };

  pushback: {
    earlyPct: number;
    minCosine: number;
    posResThreshold: number;
    redundantCosine: number;
    wThreshold: number;
    maxDepth1: number;
    clusterPct: number;
    clusterMinCos: number;
    clusterMaxCos: number;
  };

  receptor: {
    signalAcceptBoost: number;
    signalHeatBoost: number;
    signalAcceptWBoost: number;
    rejectHeatPenalty: number;
    rejectResonancePenalty: number;
    retaliateDecayIncrease: number;
    retaliateResonancePenalty: number;
    retaliateWeightPenalty: number;
    mergeWeightTransfer: number;
    mergeTtlTransfer: number;
    mergeResonanceBoost: number;
    mergeResonanceTransfer: number;
    bequeathTtlRatio: number;
    bequeathDecayReduction: number;
    bequeathResonanceBoost: number;
    ignoreResonanceFade: number;
    similarityResonanceBonus: number;
  };

  nutrition: {
    bias: number;
    weightSaturation: number;
    hitCountCap: number;
    fixedBonus: number;
  };
}

// ---- Config ----

export interface MyceliumConfig {
  qdrantUrl: string;
  collection: string;
  engramCollection: string;
  embeddingDimension: number;
  tickIntervalMs: number;
  /** Species memory mode: "latest" (newest snapshot), "none" (zero delta), or file path */
  speciesMemory: "latest" | "none" | string;
  /** Directory for snapshot files */
  snapshotDir: string;
}

export const DEFAULT_CONFIG: MyceliumConfig = {
  qdrantUrl: "http://localhost:6333",
  collection: "mycelium",
  engramCollection: "engram",
  embeddingDimension: 384,
  tickIntervalMs: 30_000,
  speciesMemory: "latest",
  snapshotDir: "./data/snapshots",
};
