# Training & Tuning Log — 2026-03-07

## 1. Learning Parameter Widening

### Problem
With `learningRate=0.03` / `deltaClamp=0.3`, actual deltas after 5 training rounds only reached ~0.04 (14% of clamp ceiling). Personality divergence between species was too weak.

### Changes
| Parameter | Before | After | Files |
|-----------|--------|-------|-------|
| `learning.rate` | 0.03 | 0.05 | `metabolism.json`, `train-species.cjs`, `scenario-test.cjs`, `scenario-test-v2.cjs`, `parallel-test.cjs` |
| `learning.deltaClamp` | 0.3 | 0.5 | same |

### Effect
Effective personality range: `base × (1 + δ)` where `|δ| ≤ 0.5` → personality cells can range 0.5×–1.5× of species DNA.

### Training Results (5 rounds, rate=0.05, clamp=0.5)

| Species | Max |δ| | Avg Fitness | Survival Count |
|---------|---------|-------------|----------------|
| spore | 0.072 | 0.627 | 21 |
| herald | 0.062 | 0.565 | 29 |
| sentinel | 0.045 | 0.413 | 32 |
| summarizer | 0.034 | 0.368 | 13 |
| anchor | 0.008 | 0.152 | 27 |

Observations:
- spore shows highest delta amplitude — high resonanceSensitivity drives fast adaptation
- anchor remains conservative — low delta likely due to stable niche (convention anchoring)
- herald and sentinel show healthy mid-range divergence
- summarizer low survival count (13) but moderate delta — high mortality drives learning pressure

## 2. Energy Cost Cascade (Verification)

### Question
Does rejection/retaliation energy cost propagate to affect subsequent action costs within the same tick?

### Answer: Yes — already works
- `receptor.ts`: target pays `target.h × reactionCost[reaction]` before interaction resolves
- Tick loop is sequential with in-place node mutations
- After rejection: `h` drops → next `cost = h × baseCost` is lower → intensity (= h) is also lower
- No code change needed

### Deferred
Species-specific baseCost (personality-influenced energy costs) — conceptually valid but adds complexity. Revisit after more behavioral data.

## 3. Snapshot-Based Weight Protection

### Problem
Parameter tuning experiments modify `metabolism.json` and training scripts. If training runs during tuning, the resulting `species-weights.json` gets contaminated with experimental parameters.

### Solution
1. **Baseline snapshot**: `data/snapshots/species-weights-baseline-20260307.json`
   - Frozen copy of 5-round training output with production params
   - Never modified by training scripts

2. **Config path**: `MyceliumConfig.speciesWeightsPath` (optional)
   - Default: `./data/snapshots/species-weights-baseline-20260307.json`
   - Defined in `types.ts`

3. **File-based fallback in digestor.ts**:
   ```
   loadSpeciesMemory(config):
     1. Try Qdrant (existing __species_memory__ points)
     2. If empty → read config.speciesWeightsPath JSON → parse delta field
     3. Log which source was used
   ```

### File Layout
```
data/
  species-weights.json              ← training output (mutable, experiments OK)
  snapshots/
    species-weights-baseline-20260307.json  ← frozen baseline (production)
```

## 4. Metabolism Config Reference (current)

Key parameters after this session:

```json
{
  "learning": { "rate": 0.05, "deltaClamp": 0.5 },
  "pressure": { "hCooling": 0.97, "ttlStep": 1 },
  "relief": { "surviveTtlRecovery": 3, "surviveDecayReduction": 0.95, "surviveHRecovery": 0.1 },
  "energy": {
    "baseCost": { "signal": 0.08, "merge": 0.15, "bequeath": 0.12 },
    "reactionCost": { "accept": 0.05, "reject": 0.06, "retaliate": 0.10, "flee": 0.08, "ignore": 0 }
  },
  "decision": { "temperature": 0.5 },
  "receptor": { "signalAcceptBoost": 0.3, "signalHeatBoost": 0.05, "similarityResonanceBonus": 0.5 }
}
```

## 5. Baseline Scenario Test Results

Run: `scenario-test.cjs` (80 ticks, digest every 20, 4 scenarios, ~106 nodes each)

### Population Dynamics

| tick | A) Warm→Cold | B) Cold→Warm | C) Stable+Inject | D) Warm→Cold+Inject |
|------|-------------|-------------|------------------|---------------------|
| 1 | 101 | 100 | 98 | 100 |
| 10 | 57 | 57 | 55 | 57 |
| 20 | 27 | 25 | 25 | 31 |
| 40 | 8 | 6 | 11 (+inject) | 8 (+inject) |
| 60 | 1 | 2 | 2 | 2 |
| 80 | 1 | 2 | 1 | 2 |

### Weight Retention

| tick | A) | B) | C) | D) |
|------|------|------|------|------|
| 1 | 0.972 | 0.976 | 0.982 | 0.977 |
| 20 | 0.542 | 0.544 | 0.597 | 0.576 |
| 40 | 0.258 | 0.286 | 0.537 | 0.579 |
| 60 | 0.068 | 0.118 | 0.203 | 0.559 |
| 80 | 0.032 | 0.054 | 0.156 | 0.399 |

### Survivors

| Scenario | summarizer | sentinel | herald | spore | Total |
|----------|-----------|----------|--------|-------|-------|
| A) Warm→Cold | 0 | 0 | 0 | 1 | 1 |
| B) Cold→Warm | 0 | 0 | 2 | 0 | 2 |
| C) Stable+Inject | 0 | 0 | 0 | 1 | 1 |
| D) Warm→Cold+Inject | 1 | 0 | 1 | 0 | 2 |

### Digestor Drift (max |δ| after 4 generations)

| Scenario | summarizer | sentinel | herald | spore |
|----------|-----------|----------|--------|-------|
| A) Warm→Cold | 0.0021 | 0.0091 | 0.0036 | 0.0096 |
| B) Cold→Warm | 0.0057 | 0.0057 | 0.0064 | 0.0069 |
| C) Stable+Inject | 0.0053 | 0.0057 | 0.0049 | 0.0135 |
| D) Warm→Cold+Inject | 0.0146 | 0.0049 | 0.0126 | 0.0074 |

### Observations

1. **Injection effect on weight**: D) maintains w=0.399 at tick 80 vs A) w=0.032 — injection at midpoint dramatically improves resource retention
2. **Herald dominance in warm environments**: B) Cold→Warm ends with 2 heralds; warm phase favors social signaling species
3. **Spore resilience in harsh conditions**: A) and C) both end with lone spore survivors — highest fitness species adapts to isolation
4. **No sentinel/anchor survivors**: sentinel and anchor go extinct in all scenarios — may need tuning (anchor fitness was already lowest at 0.152 in training)
5. **Digest drift**: D) shows highest summarizer drift (0.0146) — injection creates selection pressure that drives faster adaptation
6. **Population collapse**: All scenarios drop below 10 by tick 40 — hCooling=0.97 baseline may be too aggressive for long-lived ecosystems

## 6. Snapshot vs Plain Comparison

Test scripts now support `--snapshot` flag to preload learned delta from baseline.

**Usage**: `node scripts/scenario-test.cjs --snapshot`

### Plain (zero δ) — Final Species

| Scenario | summarizer | sentinel | herald | spore | Total |
|----------|-----------|----------|--------|-------|-------|
| A) Warm→Cold | 0 | 0 | 0 | 1 | 1 |
| B) Cold→Warm | 0 | 0 | 2 | 0 | 2 |
| C) Stable+Inject | 0 | 0 | 0 | 1 | 1 |
| D) Warm→Cold+Inject | 1 | 0 | 1 | 0 | 2 |

### Snapshot (trained δ) — Final Species

| Scenario | summarizer | sentinel | herald | spore | Total |
|----------|-----------|----------|--------|-------|-------|
| A) Warm→Cold | 1 | 0 | 0 | 0 | 1 |
| B) Cold→Warm | 0 | 0 | 0 | 1 | 1 |
| C) Stable+Inject | 0 | 1 | 0 | 0 | 1 |
| D) Warm→Cold+Inject | 1 | 0 | 0 | 0 | 1 |

### Digestor Drift Comparison (max |δ| after 4 gens)

| Scenario | Plain avg | Snapshot avg | Ratio |
|----------|-----------|-------------|-------|
| A) Warm→Cold | 0.0049 | 0.0560 | 11.4× |
| B) Cold→Warm | 0.0062 | 0.0526 | 8.5× |
| C) Stable+Inject | 0.0074 | 0.0584 | 7.9× |
| D) Warm→Cold+Inject | 0.0099 | 0.0579 | 5.9× |

### Population at tick 20 (early survival)

| Scenario | Plain | Snapshot |
|----------|-------|---------|
| A) Warm→Cold | 27 | 35 |
| B) Cold→Warm | 25 | 30 |
| C) Stable+Inject | 25 | 28 |
| D) Warm→Cold+Inject | 31 | 33 |

### Key Differences

1. **Species diversity**: Snapshot produces summarizer and sentinel survivors (absent in plain). Learned δ gives underperforming species enough behavioral edge to survive.
2. **Drift amplification**: Snapshot drift is 6-11× higher — starting from nonzero δ means digest cycles compound on existing signal instead of building from scratch.
3. **Population retention**: Snapshot runs retain ~15-30% more nodes at tick 20. Learned behaviors reduce wasteful actions early.
4. **Herald no longer dominates**: Plain runs favor herald/spore; snapshot distributes survival across summarizer, sentinel, spore — healthier ecosystem.
5. **Sentinel first survival**: Sentinel survives in C) Stable+Inject with snapshot — never observed in plain runs. Trained perception weights help sentinel respond to injection events.
