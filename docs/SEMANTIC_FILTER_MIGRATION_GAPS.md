# Semantic Filter — Migration Gaps (mycelium → mycelium_universal)

> Created: 2026-03-12
> Purpose: Document behavioral differences between original mycelium's semantic-filter-test.cjs
> and the mycelium_universal loader pipeline, to guide convergence work.

## Baseline: Original Mycelium (engram data, 78 nodes)

Tested on `mycelium/` repo with `semantic-filter-test.cjs` against engram Qdrant (port 6333).

### Results Summary (10 runs, snapshot latest, TICKS=50)

| Metric | Range | Avg |
|--------|-------|-----|
| Alive / Total | 18-25 / 78 | ~22 (28%) |
| Pure survivors | 3-11 | ~8 |
| Merger clusters | 11-18 | ~14 |
| Loners | 10-16 | ~13 |
| Redundant | 3-6 | ~5 |
| Merge deaths | 47-58 | ~51 |
| Decay deaths | 2-10 | ~5 |
| Spawn deaths | 0-8 | ~4 |

### Key Characteristics
- **Survival rate ~28%** — strong selective pressure
- **Merge-dominant deaths** (65-75% of all deaths)
- **Species diversity**: herald=12-17, summarizer=1-5, sentinel=2-6, anchor=0-1
- **Redundant detection stable** (selectionBias triplicates: 7-8/10 vote agreement)
- **Snapshot (trained delta) slightly increases survival** (28% vs 23% plain)

### Plain Mode vs Snapshot
| Condition | Alive avg | Pure | Merger | Loner | Redundant |
|-----------|-----------|------|--------|-------|-----------|
| plain     | 18 (23%)  | 5-7  | 10-11  | 6-17  | 5-6       |
| snapshot  | 22 (28%)  | 3-11 | 11-18  | 10-16 | 3-6       |

Snapshot increases survival slightly and broadens merger/loner detection ranges.

---

## Gap Analysis: Loader vs semantic-filter-test.cjs

### GAP-1: Nutrition — Initial State Bias (CRITICAL)

**filter-test**: Each node gets individual `w`, `h`, `d` from engram metadata:
```js
computeNutrition(engramPayload, species, M)
// w biased by engram weight (tanh saturation)
// h biased by hitCount ratio
// d biased by hitCount + fixed status
```

**loader**: All nodes start with identical `birth.initialW`, `birth.initialH`, species `initialDecay`.
No external quality signal.

**Impact**: Loader nodes are homogeneous at birth → less competitive pressure → survival rate too high → pure over-represented. In original, engram weight/hitCount create a spectrum of node health that drives meaningful selection.

**Resolution options**:
1. Source-data scoring: use embedding density, text length, or topic diversity as proxy
2. Random jitter around base values
3. Accept flat start, rely on ecosystem dynamics for differentiation (current)

### GAP-2: Snapshot / Trained Delta Loading

**filter-test**: `createDigestor()` loads `delta` + `resonanceDelta` from snapshot file.
Each species starts with learned behavioral biases from 300-batch training.

**loader**: Uses `getSpeciesMemory()` / `getSpeciesResonanceDelta()` from `digestor.ts`.
These are initialized to zero matrices unless a snapshot has been loaded into the
running digestor process.

**Impact**: Without snapshot, all species behave identically (no trained preferences).
With snapshot, species differentiation drives richer ecosystem dynamics (e.g., anchor
avoidance, herald signaling patterns).

**Resolution**: Loader must load snapshot at startup. Add `--snapshot` CLI param or
`SNAPSHOT_PATH` env var → call `digestor.loadSnapshot()` before first tick.

### GAP-3: Death Record — Target-side Cosine Missing

**filter-test** (runTickLocal):
```js
// Both absorbed and absorber get merge event with cosine
if (!result.initiatorAlive) mergeEvents.push({ absorbed: nv.node.id, cosine: match.similarity });
if (!result.targetAlive)    mergeEvents.push({ absorbed: match.target.node.id, cosine: match.similarity });
```

**tick.ts** (production):
```ts
if (!result.initiatorAlive) recordDeath(nv.node, tickNumber, result.merged ? "merge" : "interaction", match.similarity);
if (!result.targetAlive)    recordDeath(match.target.node, tickNumber, "interaction");
// ↑ BUG: target death from merge is recorded as "interaction" with no cosine
```

**Impact**: `extractRedundantIds()` requires `cause === "merge" && cosine >= threshold`.
Target-side merge deaths are invisible to redundant detection → ~50% of true redundants missed.

**Resolution**: Fix tick.ts to record target merge deaths with cause="merge" and cosine.

### GAP-4: Cluster Snapshot Timing

**filter-test**: Captures node state at `clusterPct` (60% of total ticks) for
`extractMergerClusters()`. This catches clusters mid-lifecycle when they still have
meaningful w values and absorbed content.

**loader**: Runs `extractMergerClusters()` at harvest (100% ticks). By then,
late-game decay/merge has dissolved clusters.

**Impact**: Merger cluster detection degraded in loader.

**Resolution**: FeedInstance should capture a snapshot at ~60% of targetTicks
and use that for cluster analysis.

### GAP-5: Death posRes Measurement Point

**filter-test**: Records `posRes` BEFORE tick execution (`preTickRes` map).
This captures the node's social standing before the fatal interaction.

**tick.ts**: Records `posRes` at death time (after resonance has been modified
by the fatal interaction itself).

**Impact**: Loner detection threshold may be skewed. Nodes that received a final
resonance bump before dying might escape loner classification.

**Resolution**: Capture pre-tick resonance in tick.ts before the main loop.

### GAP-6: Species Distribution

**filter-test** (engram data): Rich species mix from trigger+tag mapping:
```
summarizer=29, herald=33, sentinel=11, spore=4, anchor=1
```

**loader** (external data): Default `forceSpore=true` → all nodes are spore.
Even with `LOADER_SPECIES_FROM_TAGS=true`, TAG_RULES in prepare_source.py
produce wrong species (e.g., "port"→anchor for news about shipping ports).

**Impact**: Monoculture (all spore) eliminates species-based ecosystem dynamics.
selectionBias, resonance sensitivity, mergeTargetBias — all require species diversity.

**Resolution**: Either improve TAG_RULES for general text, or implement a
content-based species classifier separate from engram's trigger system.

---

## Priority Order

| Priority | Gap | Effort | Impact |
|----------|-----|--------|--------|
| P0 | GAP-3: death cosine bug | Small (tick.ts fix) | Redundant detection broken |
| P0 | GAP-2: snapshot loading | Small (env var + load) | Species behavior missing |
| P1 | GAP-4: cluster snapshot | Medium (FeedInstance timer) | Merger detection degraded |
| P1 | GAP-6: species diversity | Medium (classifier design) | Ecosystem dynamics flat |
| P2 | GAP-1: nutrition | Design decision needed | Survival rate too uniform |
| P2 | GAP-5: posRes timing | Small (pre-tick capture) | Loner detection skew |

## Test Reproduction

### Original mycelium baseline
```bash
cd mycelium/
RUNS=10 TICKS=50 MAJORITY=4 node scripts/semantic-filter-test.cjs --snapshot latest
```

### mycelium_universal loader (current)
```bash
cd mycelium_universal/
SOURCE_COLLECTIONS=source,source_ag_news \
QDRANT_URL=http://localhost:6334 \
SLOT_CAPACITY=100 TARGET_TICKS=60 TICK_INTERVAL_MS=500 \
npx tsx src/loader/main.ts
```
