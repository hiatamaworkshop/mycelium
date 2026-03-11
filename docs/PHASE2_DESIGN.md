# Mycelium Phase 2 — Design Report

## Overview

Phase 1 established: tick engine, decay/survive metabolism, engram feeder, config-driven tuning.
Phase 2 introduces three interconnected systems that make nodes dynamic social organisms.

---

## Node Model (revised)

Phase 1 review exposed dead fields and blurred ownership. This is the cleaned model.

### Design Principles
- **Node owns**: identity, body (h/w/d/ttl), personality, resonance, timestamps
- **Environment provides**: proximityHeat, kinCount, neighborSpecies (computed per tick, not stored)
- **Computed on demand**: fitness, entropy (functions, not fields)
- **Personality = DNA + learning**: immutable species base + mutable learnedDelta

### MyceliumNode (Phase 2)

```typescript
interface MyceliumNode {
  id: string;
  species: Species;
  contents: string[];             // immutable text array

  // body state (node owns, persisted)
  h: number;                      // heat — activity level, 0.0-1.0
  w: number;                      // weight — resource accumulation
  d: number;                      // decay rate
  ttl: number;                    // remaining lifespan in ticks

  // resonance — species-colored interaction receipt (tick末リセット)
  resonance: Record<Species, number>;
  // e.g. { summarizer: 0.3, sentinel: 0, herald: 0.5, anchor: 0 }

  // personality (DNA: immutable species base)
  personality: WeightMatrix;      // N rows × 4 feelings cols
                                  // rows = actions + reactions (unified matrix)

  // learned delta (experience: mutable, clamp ±0.3)
  learnedDelta: WeightMatrix;     // same shape as personality
                                  // effective = personality + learnedDelta

  // timestamps
  createdAt: number;
  lastActiveAt: number;
}
```

### Environment (tick-local, not stored on node)

Sphere の globalField と同構造。cosine neighbor scan のついでに全 metrics 平均を算出。
h だけ特別扱いしない — 近傍の w, d も場の性質として feelings に影響する。

```typescript
interface Environment {
  // 近傍 top-K の metrics 平均 (magnetic field)
  neighborField: {
    h: number;    // avg heat — 周囲が熱いと活気づく
    w: number;    // avg weight — 周囲が重い中で自分だけ軽いと飢える
    d: number;    // avg decay — 周囲の decay が高いと不穏
  };
  kinCount: number;                       // same-species neighbor count
  neighborSpecies: Record<Species, number>; // species distribution in neighborhood
}
```

### Removed from Phase 1

| Field | Reason |
|-------|--------|
| `pathCount` | No writer. Hunger simplifies to weightLack only |
| `entropy` | No reader. Population-level diversity is more meaningful than per-node content spread |
| `contentWeights` | Only meaningful with entropy. contents is flat array, no weighting needed |
| `Metrics` wrapper | Flattened into node body (h/w/d/ttl) + environment |
| `proximityHeat` on node | Replaced by neighborField.h — environment, not node state |
| `kinCount` on node | Environment provides this, node doesn't own it |

### Two-stage matrix pipeline: perception → decision

Phase 1 の computeFeelings は hardcoded 算術式。種族を増やすたびにコードを触る。
代わりに 2 段のマトリクス演算にする。チューニングはコンフィグのみ、コードは触らない。

```
raw metrics + env → [perception matrix] → feelings 4D → [personality matrix] → action
                     種族 DNA (不変)                     DNA + learnedDelta
                     "世界をどう感じるか"                  "感じた上でどう動くか"
```

#### Stage 1: perception (species.json)

```typescript
// raw input vector (assembled per tick):
rawVec = [node.h, node.w, node.d, node.ttl/initialTtl, env.field.h, env.field.w, env.field.d, kinCount, resonanceSum]
//         0       1       2       3                     4            5            6            7         8

// perception matrix: 4 feelings × N raw inputs (per species in species.json)
feelings = clamp01(perception × rawVec)
```

Each species perceives the world differently:
- sentinel: high weight on col 2 (selfD) → row 1 (dread) — decay-sensitive
- herald: high weight on col 4 (envH) → row 0 (vigor) — ambient-heat-sensitive
- anchor: all weights compressed → feelings move slowly — dull perception

#### Stage 2: decision (personality + learnedDelta)

```typescript
effectiveWeights = personality + learnedDelta  // element-wise, clamped ±deltaClamp
scores = effectiveWeights × feelings           // 9 actions/reactions × 4 feelings
probs = softmax(scores)
action = probabilisticSelect(probs)
```

#### Design rationale
- **perception = DNA (immutable)**: how you see the world doesn't change with experience
- **personality = DNA (immutable)**: base behavioral tendencies
- **learnedDelta = experience (mutable)**: decisions shift with interaction history
- All tuning in species.json — no hardcoded formulas in code

### Resonance color in kinship

Species-colored resonance enables differential kinship perception:
- anchor receiving herald resonance → annoyance (negative weight in species.json)
- summarizer receiving summarizer resonance → comfort (positive weight)
- Configured per species as `resonanceSensitivity: Record<Species, number>` in species.json

### learnedDelta lifecycle

```
interaction outcome (receptor) → resonance update
  → at tick end: learnedDelta += lr × signal
  → lr = metabolism.json learning.rate × interactionStrength
  → clamp: each cell bounded to ±metabolism.json learning.deltaClamp
  → assess() uses personality + learnedDelta

spawn: child.personality = blend(parentA, parentB) personality + learnedDelta
       child.learnedDelta = zero matrix (fresh learner)
```

Digestor reference: `sphere-original/digestor/src/profiler.ts` (weight delta learning)

---

## 1. Scoring System (digestor-inspired)

### Intent
Neutral, species-agnostic evaluation of node fitness.
Enables selection pressure, spawn ranking, and trend solidification per species.

### Mechanism
Reference: `sphere-original/digestor/src/scoring.ts`

- **Score** = `balanced_qv * time_decay`
  - `balanced_qv`: equal-weight across dimensions (no species bias in evaluation)
  - `time_decay`: `exp(-ageHours / halfLifeHours)` — freshness bonus
- **Fitness dimensions** (mycelium-adapted):
  - `w` (weight) — resource accumulation
  - `h` (heat) — activity level
  - `ttl / initialTtl` — longevity ratio
- **Fitness is a function, not a stored field** — computed on demand
- **Hunger-based pruning**: dynamic threshold scales with population
  - Small colony (< 50): minimal pruning (hunger 0.2)
  - Medium (50-200): linear ramp
  - Large (> 200): aggressive (hunger 0.8+)
  - Species protection: minimum member count before pruning applies

### Per-Species Profile Accumulation
Each digest cycle (configurable interval, e.g. every N ticks):
1. Score all nodes neutrally
2. Aggregate per species: avgW, avgH, avgTtlRatio, consistency
3. Blend: `0.7 * species_own + 0.3 * global_average` (prevents local optima)
4. Archive generation snapshot
5. Optional: weight delta learning (consistency-gated, clamped)

### Config (metabolism.json `scoring` section — TBD)
```json
{
  "scoring": {
    "halfLifeHours": 72,
    "dimensions": { "wWeight": 0.33, "hWeight": 0.34, "ttlWeight": 0.33 },
    "hungerThresholds": { "low": 50, "mid": 200 },
    "speciesProtection": 10,
    "blendRatio": { "self": 0.7, "global": 0.3 },
    "digestIntervalTicks": 100
  }
}
```

### Files
- `src/core/scoring.ts` — score computation, hunger pruning
- `src/core/digest.ts` — digest cycle, profile accumulation, archiving

---

## 2. Receptor Model (active/passive interaction)

### Intent
Transform nodes from independent tick-processors into interactive organisms.
Each interaction is bidirectional: initiator emits a signal, receiver reacts based on own state.

### Active Receptor (emission)
When a node acts on another node, it emits an **ActionSignal**:
```typescript
interface ActionSignal {
  action: Action;                     // what I'm doing
  species: Species;                   // who I am
  feelings: Feelings;                 // my emotional state
  strength: number;                   // my fitness score (computed, not stored)
}
```
This is the "行動原理ベクトル" — the full state of "I am touching you in this way, with this intent."

### Passive Receptor (reception + reaction)
The receiving node processes the incoming signal against its own state.
Reaction selection uses the same unified personality matrix (extended rows):

```typescript
type ReactionType = "accept" | "reject" | "retaliate" | "ignore" | "flee";
```

Personality matrix rows = actions (signal/merge/bequeath/survive) + reactions (accept/reject/retaliate/ignore/flee) = **9 rows × 4 feelings columns**.

One matrix, one softmax pattern. Actions and reactions are just different contexts for the same personality.

### Resonance update on interaction
```
signal + accept → initiator.resonance[receiver.species] += signalStrength
                  receiver.resonance[initiator.species] += signalStrength
signal + reject → initiator.resonance[receiver.species] -= rejectPenalty
merge + accept  → merge proceeds, both nodes' resonance boosted
any + retaliate → initiator.resonance[receiver.species] -= retaliationCost
```

Species-colored resonance → feeds into kinship at next tick → affects learnedDelta over time.

### Interaction Effects
| Initiator Action | Receiver Reaction | Effect |
|-----------------|-------------------|--------|
| signal + accept | resonance++ on both, h boost |
| signal + reject | initiator h drops slightly |
| signal + retaliate | initiator takes d increase |
| merge + accept | merge proceeds (contents combine) |
| merge + reject | merge blocked, initiator h drops |
| merge + retaliate | merge blocked, initiator w penalty |
| bequeath + accept | receiver inherits w portion |
| bequeath + ignore | bequeath fails, w lost to void |
| any + flee | receiver moves (vector perturbation) |

### Tick Integration (Phase 2 flow)
1. Poll engram for new seeds
2. Scroll all nodes with vectors, decay resonance
3. Each node: computeFeelings → assessAction → select target → proximity merge check
4. Initiator emits ActionSignal (active receptor)
5. Target: computeFeelings → assessReaction (passive receptor, with mergeContext if merge)
6. Resolve interaction → update resonance on both nodes
7. **Spawn phase**: eligible nodes (contents≥3, fitness≥0.3) find partner → both consumed → 2 children upserted
8. Apply decay (w, h, ttl) for all surviving nodes
9. Batch update survivors, delete expired/consumed
10. Species digestor: aggregate learnedDelta at digest intervals

### Files
- `src/core/receptor.ts` — ActionSignal, react(), interaction resolution
- `src/types.ts` — ReactionType, ActionSignal types
- `src/config/species.json` — unified personality matrix (9×4), resonanceSensitivity

---

## 3. Similarity-Gated Merge (implemented 2026-03-07)

### Intent
Merge should work as data filtering: close neighbors merge easily (healthy merge), distant merges are discouraged. Crisis-driven merge (dread+hunger → merge action) still works, but proximity also triggers merge between healthy nodes.

### 3-Layer Similarity Gating

**Layer 1: Proximity trigger** (tick.ts)
Very close neighbors (cosine > `proximityThreshold`) may trigger merge regardless of chosen action.
```
if (similarity >= 0.85 && random() < 0.3) → override action to "merge"
```
This enables "healthy merge" — no crisis needed, just high content similarity.

**Layer 2: Acceptance gating** (node.ts `assessReaction`)
When a merge request arrives, similarity gates the reaction scores:
```
scores[accept] *= similarity     // close → likely accept
scores[reject] *= (1 - similarity) // close → unlikely reject
```
Distant merges face strong rejection bias.

**Layer 3: Transfer scaling** (receptor.ts `resolveMergeInteraction`)
Weight and TTL transfer efficiency scale by similarity:
```
target.w += initiator.w * mergeWeightTransfer * intensity * similarity
target.ttl += floor(initiator.ttl * mergeTtlTransfer * intensity * similarity)
```
Close merge = efficient transfer. Distant merge = lossy.

### Config (metabolism.json `merge` section)
```json
{
  "merge": {
    "proximityThreshold": 0.85,
    "proximityChance": 0.3
  }
}
```

### Files
- `src/core/tick.ts` — proximity trigger (phase 3, post-target-selection)
- `src/core/node.ts` — `assessReaction()` similarity gating
- `src/core/receptor.ts` — `resolveMergeInteraction()` transfer scaling

---

## 4. Spawn Mechanics (implemented 2026-03-07)

### Intent
Sexual reproduction: two content-rich, fit nodes produce offspring with blended personality.
Both parents consumed. Content splits cleanly; personality merges by fitness ratio.

### Trigger
Simple eligibility check per node per tick (post-action phase):
```
contents.length >= minContents AND fitness >= minFitness
```
- `minContents: 3` — node must have accumulated knowledge (typically via merge)
- `minFitness: 0.3` — above-average health required

Neuron Triangle (adaptive spawn thresholds) deferred as overkill for initial implementation.

### Mechanism

**Partner selection**: nearest cosine neighbor (not already consumed/deleted)

**Fitness ratio** (determines personality blend):
```
ratioA = fitness(A) / (fitness(A) + fitness(B))
ratioB = 1 - ratioA
```

**Personality blending**:
```
effective(X) = X.personality[i][j] × (1 + X.learnedDelta[i][j])
child.personality[i][j] = ratioA × effective(A) + ratioB × effective(B)
child.learnedDelta = zero matrix  // fresh learner
```
Stronger parent's learned experience contributes more to child's base personality.

**Offspring**:
- Child A: parent A's contents + vector, blended personality
- Child B: parent B's contents + vector, same blended personality
- Species: stronger parent's species
- Metrics: fresh (h=initialH, w=initialW, ttl=initialTtl × childTtlRatio)
- Lineage: `{ parentA: {id, species, fitness}, parentB: {id, species, fitness}, generation }`
- Generation = max(parentA.generation, parentB.generation) + 1 (seed nodes = gen 0)

**Closed w economy**: Spawn does not create energy. Children start with species default `initialW`. Parents are consumed — their w is destroyed, not transferred.

**Observation goal**: Do children with same personality but different content diverge in behavior?
Content → vector position → different neighbors → different environment → different feelings → different actions. Personality is nature, environment is nurture.

### Config (metabolism.json `spawn` section)
```json
{
  "spawn": {
    "minContents": 3,
    "minFitness": 0.3,
    "childTtlRatio": 0.5
  }
}
```

### Design decisions (resolved)
1. **learnedDelta = zero**: Children start fresh. Personality blend already incorporates parents' learning.
2. **Cross-species OK**: herald + summarizer → species of stronger parent. Personality blending crosses species boundaries.
3. **Lineage tracking**: Generation counter + parent info stored on node. Enables evolutionary observation.
4. **No re-embedding**: Children inherit parent's vector directly. Content determines position adequately.

### Files
- `src/core/spawn.ts` — `isSpawnEligible()`, `executeSpawn()`
- `src/core/tick.ts` — spawn phase (phase 4, post-action, pre-decay)
- `src/types.ts` — `Lineage`, `ParentInfo` interfaces

---

## Phase 2.1 — Observation Notes & Deferred Items

### Topological Movement (移動の本質)
Physical vector movement is unnecessary. Signal/resonance/accept/reject already change
effective connectivity each tick = topological movement. Nodes don't move; the network moves.
This mirrors neural systems: neurons are stationary, synapse strength changes.

### Action Energy + Intensity (行動エネルギーとグラデーション)

h = action energy。全行動を統一的に扱う。

**Intensity**: action の強さ = `node.h` (0.0〜1.0)
- signal(0.9) = 大声。h コスト高い、resonance 効果大
- signal(0.3) = 小声。h コスト低い、resonance 効果小
- feelings が「何をするか」を決め、h が「どれだけやるか」を決める

**Energy cycle**:
```
action (signal/merge/bequeath):
  intensity = node.h
  h -= intensity × baseCost[action]     // 行動するほど消耗
  effect *= intensity                    // 効果も intensity に比例

survive:
  h += surviveHRecovery                  // 唯一の h 回復手段
  ttl += surviveTtlRecovery
  d *= surviveDecayReduction
```

**Emergent behavior**:
- 近くに誰もいない (kinship低) → signal 選びやすい + h がまだある → intensity 高 = 大声
- h が下がる → intensity 低 = 行動が弱まる → survive を選ぶインセンティブ
- survive = 休息。行動不能ではなく回復の選択
- 活動 → 消耗 → survive → 回復 → 活動 のリズムが自然発生

**Config** (metabolism.json):
```json
{
  "energy": {
    "baseCost": { "signal": 0.08, "merge": 0.15, "bequeath": 0.12 },
    "surviveHRecovery": 0.1
  }
}
```

### Merge/Spawn Vector Rebirth (ベクトル再計算)
Problem: merged node keeps old vector but holds combined contents → semantic position is wrong.
Solution: **rebirth buffer**
1. merge/spawn result → buffer (not directly upserted)
2. next tick start: re-embed buffer contents → new node with fresh vector
3. delete old target, upsert new node
4. Same buffer serves both merge and future spawn
- Re-embedding cost: negligible at merge/spawn rates (few per tick)

### Digest Cycle (種族プロファイル蓄積)
scoring.ts functions exist but no periodic runner yet:
- `computeSpeciesProfiles()` — per-species avgW/avgH/avgTtlRatio/avgFitness
- `shouldPrune()` — hunger-based pruning
- Need: tick counter % `digestIntervalTicks` → run digest → log profiles
- Need: profile archive (in-memory array or SQLite)

### Observation Window
3 session cycles of observation before tuning. Let the ecosystem run with current
perception/personality matrices and collect behavioral data first.

---

## Implementation Order

Phase 2 core: **DONE** (5b94452)
1. ~~Node model cleanup~~ — types.ts revised
2. ~~Scoring~~ — scoring.ts created (fitness, hunger pruning, species profiles)
3. ~~Receptor model~~ — receptor.ts created (ActionSignal, react, interaction resolution)
4. ~~Similarity-gated merge~~ — 3-layer gating (proximity trigger, acceptance, transfer scaling)
5. ~~Spawn~~ — spawn.ts created (eligibility, blend, lineage tracking)

Phase 2.1 (next):
1. **Spawn observation** — run scenarios, observe generational behavior
2. **Neuron Triangle** — adaptive spawn thresholds (A: population floor, B: density-based, C: meta-observer)
3. **Rebirth buffer** — merge/spawn results re-embedded as new nodes (deferred — vector inheritance works for now)
4. **Path memory** — resonance accumulation → SQLite (道)

---

## Future Research — AI Infrastructure Applications (2026-03-10)

### Architecture: 2-Layer Separation

Mycelium's core strength is a clean separation between two layers:

- **Math layer** (core/): cosine geometry, decay, softmax, fitness — input-agnostic, tunable via metabolism.json
- **Semantic mapping layer** (feeder.ts, pushback.ts): data source connection, species assignment, output routing

The math layer never reads contents. Any data with an embedding vector can be placed on the Petri dish.
This means Mycelium can serve as infrastructure beyond engram — RAG chunks, vector DB entries, agent memories, log streams.

### Experiment: Wave Injection (temporal cohort analysis)

**Status**: Not yet implemented. Prerequisite for most applications below.

**Motivation**: Current model is synchronous birth — all nodes enter at tick 0. Real systems have continuous data arrival. A mature ecosystem presents a qualitatively different environment to newcomers:
- `computeEnvironment()` returns different neighborField values (mature w/h distributions)
- `assessReaction()` produces different reactions (frustration accumulated, resonance polarized)
- cosine neighborhood "population density" shifts post-merge

**Experiment design**:
```
Wave 0 (tick 0):  60% of nodes
Wave 1 (tick 20): 20%
Wave 2 (tick 40): 20%
```

Track `birthTick` per node. Compare cohort-level metrics:
- Survival rate by wave
- Merge absorption rate (are late arrivals consumed faster, or do they find open niches?)
- Species × wave interaction (does anchor late-arrival differ from spore late-arrival?)

**Core question**: Does the mature ecosystem exclude or facilitate newcomers? (competitive exclusion vs niche facilitation)

**Implementation**: Test script level only — no core changes needed. Split engram node pool into waves, inject at specified ticks.

### Application 1: Vector DB Hygiene (pushback generalization)

Generalize the existing engram pushback pipeline to arbitrary vector stores:
- Abstract feeder.ts payload structure (remove engram-specific fields)
- Adapter layer for Pinecone / Weaviate / Chroma / generic Qdrant
- Standardized output: JSON quality report (pure/loner/redundant/merger per entry)
- Docker image: `mycelium-filter` — input vectors, output quality signals

**Competitive advantage**: No LLM calls, no threshold tuning, privacy-safe (contents not read).

### Application 2: Semantic Immune System

Use ecosystem dynamics to distinguish "self" (data consistent with existing knowledge) from "non-self" (anomalous input):
- Data that merges or receives signal+accept = consistent with existing corpus
- Data that dies as loner = semantically isolated, potentially anomalous
- Application: LLM hallucination detection — embed generated text, inject into ecosystem, observe loner pattern

### Application 3: Embedding Space Cartography

Ecosystem dynamics as a map of embedding space structure:
- Merge-dense regions = semantic redundancy (topic over-represented)
- Loner-death regions = semantic desert (topic gaps)
- Anchor-survival regions = stable foundational concepts
- Spore-survival regions = unique frontier data

Unlike t-SNE/UMAP (static projection), Mycelium produces a **dynamic, time-evolving** structural map.

### Experiment: Dialectical Simulation — Three-World Counterfactual (2026-03-10)

**Status**: Implemented (simplified variant). First results obtained 2026-03-10.

**Terminology**: The core technique is **Dialectical Residual Injection (DRI)** —
compute the selfReflection delta between two worlds (W2 − W1) and inject it as
initial state into a third world. Related concepts:
- **Difference-in-Differences (DiD)** — econometrics: measures treatment effect via delta. DRI goes further: it *uses* the measured delta as intervention.
- **Residual injection** — ResNet: learns residual and adds to baseline. Same structural idea, different domain.
- **Aufheben (止揚)** — Hegelian dialectic: thesis + antithesis → synthesis. The philosophical framing.

**Simplified variant (implemented)**:
- W1 (Thesis): frustration=OFF, selfReflection=ON
- W2 (Antithesis): frustration=ON, selfReflection=ON
- W3 (Synthesis): frustration=ON, selfReflection=ON, initial selfReflection = delta(W2 − W1)
- No action history recording needed — uses existing selfReflection state as transfer medium.

**Experimental results (10 runs × 60 ticks)**:

| Metric | W1 (thesis) | W2 (antithesis) | W3 (synthesis) |
|--------|-------------|-----------------|----------------|
| Population | 19.6±1.6 | 19.5±2.9 | 19.3±2.4 |
| Pure survivors | 12.6±1.7 | 11.7±2.0 | 11.7±2.4 |
| Loner deaths | 19.1±4.7 | 18.6±3.4 | **16.7±4.1** |
| Merge deaths | 59.4±2.3 | 58.2±2.2 | **55.6±4.4** |
| Only W3 survivors | — | — | **3.0±1.6** |

Key findings:
- **Synthesis-unique survivors stable at ~3/run** — nodes that survive only in W3, not in W1 or W2. Emergent "third way".
- **Loner death reduction** — W3 (blend=0.3) shows 16.7 vs W1=19.1, W2=18.6. Delta injection promotes social engagement.
- **Blend sensitivity non-linear**: 0.1 (balanced), 0.2 (worst — middle ground trap), 0.3 (best loner reduction, but +decay deaths). Production setting: **blend=0.3**.
- **Reflection delta profile**: vigor=+0.024, kinship=+0.033, dread≈0, hunger≈0. Frustration's social effect captured as positive vigor/kinship residual.
- **Population-level convergence**: all three worlds converge to ~19-20 nodes. The ecosystem's attractor is robust; DRI changes *who* survives, not *how many*.

**v2 trained δ results (10 runs × 60 ticks, train-species-v2.cjs 300b)**:
- Synthesis-unique improved to 3.4±1.5 (from 3.0±1.6 with baseline δ)
- Anchor dominance reduced: 10.5→7.1, herald stabilized: 2.8→3.6 (σ halved)
- Reflection delta kinship flipped positive→negative (v2 δ learned "social cost")
- Overall σ reduced — v2 δ produces more deterministic ecosystems
- Conclusion: DRI effect is robust across different δ training regimes

**Full variant (future)**:

**Concept**: Run three sequential worlds as thesis → antithesis → synthesis.

**World 1 (Thesis)** — Normal run.
- Record per node per tick: `{ action, feelings, reaction received }`.
- Record digestor learnedDelta at end.
- Standard frustration dynamics (internal only).

**World 2 (Antithesis)** — Same initial conditions, counterfactual exploration.
- Load W1 history. Force nodes to explore "the road not taken".
- Two competing approaches for cross-world transfer (see below).
- Record history and learnedDelta separately.

**World 3 (Synthesis)** — Integration of both experiences.
- Four candidate designs, ordered by separation cleanliness (implement in this order):

  **A: Delta Integration (cleanest separation)**
  - W3 initial delta = blend(W1.delta, W2.delta) via existing blendAlpha mechanism.
  - Population = same initial set. No injection. Fully autonomous.
  - Measures: does blended experience produce qualitatively different behavior from either world alone?

  **C: Population Selection (medium separation)**
  - W3 population composed from W1+W2 survival results:
    - Nodes that survived both worlds (robust)
    - Nodes that survived only W1 or only W2 (world-dependent)
    - Combine with A's delta integration for full effect.
  - Measures: does dual-world selection produce a more resilient population?

  **B: Frustration History Integration (deepest, least separable — try last)**
  - W3 carries frustration accumulation from BOTH W1 and W2.
  - "The weight of what you did" + "the weight of what you couldn't do".
  - Most human-like: experience as emotional residue, not just learned weights.
  - Risk: frustration may saturate and flatten all action probabilities.
  - Requires careful tuning of blend ratio between W1/W2 frustration.

  **D: Divergence Perception (experimental, after A/C/B)**
  - W3 feelings augmented by W1/W2 divergence signal:
    `feelings' = baseFeelings + γ × |W1.action[t] ≠ W2.action[t]| × (W1.frustration[t] - W2.frustration[t])`
  - Nodes "sense" where the two worlds disagreed. No goal given — just added perception.
  - Risk: defining γ is arbitrary. Better attempted after A/C/B provide baseline data.

#### Cross-World Transfer: Two Approaches

**Approach α: Frustration Injection (direct)**
- W2: inject strong negative frustration for W1's chosen action → softmax shifts to unchosen actions.
- Mechanism: new injection point in frustration pipeline.
- Properties: uniform pressure, no species differentiation, action-level forcing.

**Approach β: Receptor Reuse (preferred — try first)**
- W2: feed W1's `(action, feelings)` record as a "signal from past self" through the node's own passive receptor.
- Mechanism: existing `assessReaction()` pipeline — no new code.
- Flow:
  ```
  W1 record: tick 15, action=signal, feelings={vigor:0.7, hunger:0.1, ...}
    ↓
  W2 tick 15: route this as incoming signal to own receptor
    → receptivity × W1.feelings blended into current feelings
    → personality rows 4-8 produce reaction (accept/reject/retaliate/...)
  ```
- Properties:
  - Species personality determines interpretation (sentinel may reject own past signal; spore may accept)
  - Affects feelings first, action indirectly — softer, more organic
  - Zero new parameters, zero new mechanisms
  - Each species "remembers" differently because their reaction rows differ

| | Approach α (Frustration) | Approach β (Receptor) |
|---|---|---|
| Mechanism | New injection point | Existing receptor pipeline |
| Interpretation | Uniform negative pressure | Species personality decides |
| Output | Direct action probability distortion | Feelings shift → indirect action change |
| Species differentiation | None | Full (reaction rows 4-8) |
| New parameters | Injection strength | None |
| Implementation | Modify frustration pipeline | Route data to assessReaction() |

**Recommendation**: Start with Approach β. If receptor reuse produces insufficient behavioral divergence between W1 and W2 (i.e., past experience signal is too weak), fall back to Approach α as amplification.

**Implementation scope**:
- Core changes: add action/feelings history recording to tick.ts (minimal).
- Approach β: no core changes beyond history recording — receptor reuse is routing only.
- Approach α: add external frustration injection point (small).
- Test script: 3-pass loop in scenario-test-v2.cjs, passing history/delta between passes.
- Math layer untouched.

**Open design question**: What does a node "want"?
Current nodes have no objective function — personality × feelings → softmax, no maximization target.
Three-world integration requires deciding what W1/W2 experience *means* to W3.
The receptor reuse approach (β) sidesteps this: it doesn't define purpose, it provides
**experiential trace** and lets personality interpret it. This preserves the observation principle.

**Key question**: Does a node (or ecosystem) that has "experienced" both reality and counterfactual behave in a qualitatively distinct way in the third world? If yes — this is emergent integration, not optimization.

### Design Principle: Observation Over Optimization

External signals (recall counts, user feedback) must enter through the **feeder** (what goes on the dish), never through direct metric manipulation of living nodes. The ecosystem processes input through internal dynamics — this is what makes it an observation system rather than a weighted cache.

- OK: recall event → spawn new node near recalled topic (environmental stimulus)
- NOT OK: recall event → boost w/ttl of existing node (external selection)

## Phase 3 — Generic Data Loader & Semantic Mapper (設計メモ 2026-03-10)

### Motivation: Pre-LLM Knowledge Compressor

Mycelium の本質的な価値は **pre-LLM filtering** にある：

```
raw data (大量の断片メモ・ドキュメント・ログ)
  ↓ Data Loader (バッチ読み出し)
  ↓ Semantic Mapper (種族割り当て)
  ↓ Mycelium ecosystem (merge/decay/淘汰)
  ↓ filtered knowledge (~20% 生存)
  ↓ LLM prompt (圧縮済み入力)
```

現状の RAG (top-K cosine) は「検索に引っかかるもの」しか渡せない。
Mycelium は生態系ダイナミクスで **情報ネットワークのハブ** を選別する。

### Performance Budget

| 規模 | scroll 全取得 | Mycelium 処理 | 合計 |
|------|-------------|-------------|------|
| 500 nodes × 60 tick | ~50ms | ~2-3s | ~3s |
| 5,000 nodes (10 batch) | ~500ms | ~30s | ~30s |
| 50,000 nodes (100 batch) | ~5s | ~5min | ~5min |

ボトルネックは Qdrant I/O 側。Mycelium は CPU バウンドで軽い。
バッチ読み出しと Mycelium 処理をパイプライン化すれば自然に並列化される。

### Component 1: Generic Data Loader

**責務**: 任意の DB からバッチ読み出し → Mycelium ingestion フォーマットに変換

```
Data Loader
├── DB Adapter (Qdrant / Postgres / file system / API)
├── Batch Controller (500件単位、パイプライン制御)
└── Output: { summary, content?, vector, tags[] }
```

- バッチサイズ推奨: **200〜500件**
  - 100件未満: merge 機会が少なく圧縮率が低い
  - 1000件超: tick の O(n²) target selection が効いてくる
- 並列エコシステム: トピック別に複数 Mycelium インスタンスを同時実行 → 最終統合

### Component 2: Semantic Mapper (外部ルールファイル)

**現状の問題**: `TRIGGER_TO_SPECIES` が Engram のドメイン知識をハードコードしている。
汎用データには Engram の trigger 体系が存在しない。

**解決**: 外部 JSON ファイルでタグマッチングルールを定義。データ管理者がコードを触らずに制御。

```jsonc
// src/config/species-mapping.json
{
  "rules": [
    { "match": { "tags": ["error", "bug", "fix", "crash"] },        "species": "anchor" },
    { "match": { "tags": ["config", "env", "infra", "docker"] },    "species": "anchor" },
    { "match": { "tags": ["rule", "convention", "lint", "policy"] }, "species": "sentinel" },
    { "match": { "tags": ["release", "deploy", "commit", "ship"] }, "species": "herald" },
    { "match": { "tags": ["summary", "digest", "report", "log"] },  "species": "summarizer" },
    { "match": { "tags": ["idea", "draft", "hypothesis", "wip"] },  "species": "spore" }
  ],
  "default": "summarizer"
}
```

**マッチングロジック**:
- 入力データの tags に1つでも match.tags のいずれかが含まれれば → その species
- 複数ルールにヒット → 先頭優先（rules 配列の priority order）
- どのルールにもヒットしない → `default` species
- データ管理者はルール追加・並べ替えだけで種族戦略を変更可能

**優先順位** (species 解決の fallback chain):
```
1. species 直接指定 (API パラメータ)     ← 最優先
2. tags マッチ (species-mapping.json)    ← 汎用データ
3. trigger マッチ (TRIGGER_TO_SPECIES)   ← Engram 後方互換
4. default ("summarizer")                ← fallback
```

### Mycelium 側の変更 (最小)

1. **`resolveSpecies(trigger, tags?, species?)` 拡張**
   - species 引数があればそのまま返す
   - tags 引数があれば species-mapping.json でマッチ
   - どちらもなければ従来の trigger マッピング

2. **`mycelium_push` スキーマ拡張**
   - `tags?: string[]` 追加
   - `species?: Species` 追加 (直接指定)

3. **species-mapping.json** 新規作成 (src/config/)

4. **Digestor**: 変更不要。正しい species が来れば現状のまま動作

### Pipeline Architecture

```
┌──────────────────────────────────────────────┐
│  Data Loader                                  │
│  ├── DB Adapter (batch read 500件)            │
│  ├── Semantic Mapper                          │
│  │   └── species-mapping.json (tag → species) │
│  └── Output: { summary, content, vector,      │
│               tags[], species? }              │
└──────────┬───────────────────────────────────┘
           │ mycelium_push (or direct ingest API)
           ↓
┌──────────────────────────────────────────────┐
│  Mycelium                                     │
│  ├── resolveSpecies (species > tags > trigger)│
│  ├── Ecosystem (tick loop)                    │
│  ├── Digestor (species 別学習)                │
│  └── Output: surviving nodes                  │
└──────────┬───────────────────────────────────┘
           ↓
┌──────────────────────────────────────────────┐
│  Consumer (LLM / Dashboard / Export)          │
│  └── mycelium_observe / scroll API            │
└──────────────────────────────────────────────┘
```

### Open Questions

- **並列エコシステムの統合方法**: 各バッチの生存ノードを再度 Mycelium に通す (cross-batch merge) vs 単純 concat
- **Data Loader のデプロイ形態**: sidecar container vs CLI tool vs library
- **species-mapping.json のホットリロード**: 実行中にルール変更を反映するか、再起動必須か

## Dependencies

```
types.ts (node model) ← everything
scoring.ts ← digestor.ts (uses scores for profiles)
scoring.ts ← receptor.ts (ActionSignal.strength)
scoring.ts ← spawn.ts (fitness ratio for blend)
receptor.ts ← tick.ts (interaction loop)
spawn.ts ← tick.ts (post-action spawn phase)
```
