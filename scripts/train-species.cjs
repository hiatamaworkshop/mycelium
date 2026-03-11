// ============================================================
// Species Training Loop — phi-agent style batch δ accumulation
// ============================================================
//
// Tick logic: Phase 2.1 (resonance decay, proximity merge, mergeCtx, spawn)
//
// 1. Run N test batches (default 100)
// 2. Each batch: seed 5 species (equal), run TICKS ticks with digest
// 3. Accumulate action×feelings across ALL batches into global + per-species pools
// 4. Compute final δ: species_δ * α + global_δ * (1 - α)
// 5. Save to data/species-weights.json
//
// Usage: node scripts/train-species.cjs [BATCHES=100] [TICKS=80]

const fs = require("fs");
const path = require("path");
const { ensureCollection, upsertPoints, scrollAll, deletePoints } = require("../dist/qdrant.js");
const { payloadToNode, nodeToPayload, computeFeelings, assessAction, createNode, getSpeciesConfig } = require("../dist/core/node.js");
const { emitSignal, react, resolveInteraction } = require("../dist/core/receptor.js");
const { isSpawnEligible, isCompatiblePartner, executeSpawn } = require("../dist/core/spawn.js");
const { BEHAVIOR_KEYS, FEELINGS_DIM, FEELING_KEYS, ALL_SPECIES, ACTIONS, REACTIONS } = require("../dist/types.js");

const url = "http://localhost:6333";
const col = "mycelium_train";

// ENGRAM_PROJECT env: "all" or unset → no filter, otherwise filter by projectId
const ENGRAM_PROJECT = process.env.ENGRAM_PROJECT || "all";
function engramFilter() {
  if (ENGRAM_PROJECT === "all") return undefined;
  return { must: [{ key: "projectId", match: { value: ENGRAM_PROJECT } }] };
}

const _metaRaw = require("../dist/config/metabolism.json");
const BATCHES = parseInt(process.env.BATCHES || process.argv[2] || "100", 10);
const TICKS = parseInt(process.env.TICKS || process.argv[3] || "80", 10);
const DIGEST_INTERVAL = parseInt(process.env.DIGEST_INTERVAL || "20", 10);
const BLEND_ALPHA = parseFloat(process.env.BLEND_ALPHA || String(_metaRaw.learning.blendAlpha ?? 0.7)); // from metabolism.json
const LEARNING_RATE = _metaRaw.learning.rate;
const DELTA_CLAMP = _metaRaw.learning.deltaClamp;
const DELTA_DECAY = parseFloat(process.env.DELTA_DECAY || String(_metaRaw.learning.deltaDecay ?? 0));

function deepCopy(obj) { return JSON.parse(JSON.stringify(obj)); }
function loadBase() {
  delete require.cache[require.resolve("../dist/config/metabolism.json")];
  return deepCopy(require("../dist/config/metabolism.json"));
}
function cosine(a, b) { let d = 0; for (let i = 0; i < a.length; i++) d += a[i] * b[i]; return d; }
function zeroMatrix(rows, cols) { return Array.from({ length: rows }, () => new Array(cols).fill(0)); }

// ---- Global accumulators (persist across all batches) ----

const ROWS = BEHAVIOR_KEYS.length;
const COLS = FEELINGS_DIM;

// Per-species accumulators
const speciesSums = {};
const speciesCounts = {};
// Global (all-species) accumulators
const globalSums = zeroMatrix(ROWS, COLS);
const globalCounts = new Array(ROWS).fill(0);
// Survivor fitness tracking
const speciesSurvivals = {};
const speciesFitnessAccum = {};

for (const sp of ALL_SPECIES) {
  speciesSums[sp] = zeroMatrix(ROWS, COLS);
  speciesCounts[sp] = new Array(ROWS).fill(0);
  speciesSurvivals[sp] = 0;
  speciesFitnessAccum[sp] = 0;
}

// Running δ (accumulated across batches, used for seeding next batch)
const runningDelta = {};
const runningResonanceDelta = {};
function zeroResonance() { return { summarizer: 0, sentinel: 0, herald: 0, anchor: 0, spore: 0 }; }
for (const sp of ALL_SPECIES) {
  runningDelta[sp] = zeroMatrix(ROWS, COLS);
  runningResonanceDelta[sp] = zeroResonance();
}

function recordToAccum(species, behaviorIdx, feelings) {
  const fv = FEELING_KEYS.map(k => feelings[k]);
  for (let j = 0; j < COLS; j++) {
    speciesSums[species][behaviorIdx][j] += fv[j];
    globalSums[behaviorIdx][j] += fv[j];
  }
  speciesCounts[species][behaviorIdx] += 1;
  globalCounts[behaviorIdx] += 1;
}

// ---- Tick engine (inline, no Qdrant) ----

function computeEnvironment(self, allNodes, M) {
  const env = { neighborField: { h: 0, w: 0, d: 0 }, kinCount: 0, neighborSpecies: { summarizer: 0, sentinel: 0, herald: 0, anchor: 0, spore: 0 } };
  if (!self.vector) return env;
  const neighbors = allNodes.filter(n => n.node.id !== self.node.id && n.vector)
    .map(n => ({ score: cosine(self.vector, n.vector), node: n.node }))
    .sort((a, b) => b.score - a.score).slice(0, M.social.neighborLimit);
  if (!neighbors.length) return env;
  let sH = 0, sW = 0, sD = 0;
  for (const n of neighbors) {
    sH += n.node.h; sW += n.node.w; sD += n.node.d;
    env.neighborSpecies[n.node.species]++;
    if (n.node.species === self.node.species) env.kinCount++;
  }
  env.neighborField = { h: sH / neighbors.length, w: sW / neighbors.length, d: sD / neighbors.length };
  return env;
}

function runTickLocal(allNodes, M) {
  const toDelete = new Set();
  const actionCounts = {};
  let spawnCount = 0;

  // Resonance decay (carry-over, not reset)
  const resonanceDecay = M.social.resonanceDecay || 0.8;
  for (const nv of allNodes) {
    for (const sp of ALL_SPECIES) nv.node.resonance[sp] *= resonanceDecay;
  }

  for (const nv of allNodes) {
    if (toDelete.has(nv.node.id)) continue;
    const env = computeEnvironment(nv, allNodes, M);
    const feelings = computeFeelings(nv.node, env);
    let action = assessAction(feelings, nv.node.personality, nv.node.learnedDelta);
    actionCounts[action] = (actionCounts[action] || 0) + 1;
    recordToAccum(nv.node.species, ACTIONS.indexOf(action), feelings);

    if (action === "survive") {
      nv.node.h = Math.min(1, nv.node.h + M.relief.surviveHRecovery);
      nv.node.w += (M.relief.surviveWRecovery || 0);
      nv.node.w -= (M.relief.surviveWCost || 0);
      nv.node.ttl += M.relief.surviveTtlRecovery;
      nv.node.d *= M.relief.surviveDecayReduction;
      continue;
    }

    const intensity = nv.node.h;
    const baseCost = (M.energy.baseCost[action]) ?? 0.1;
    nv.node.h = Math.max(0, nv.node.h - intensity * baseCost);

    // Greedy nearest-neighbor target selection (intentionally differs from tick.ts softmax)
    // Greedy training + softmax runtime = diversity-friendly mismatch (validated by T0759 results)
    let best = null, bestScore = -Infinity;
    if (nv.vector) {
      for (const t of allNodes) {
        if (t.node.id === nv.node.id || !t.vector || toDelete.has(t.node.id)) continue;
        const s = cosine(nv.vector, t.vector);
        if (s > bestScore) { bestScore = s; best = t; }
      }
    }
    if (!best) continue;

    // Proximity merge: unconditional when target is too close (mergeTargetBias=0 species immune)
    const targetMergeBias = getSpeciesConfig(best.node.species).mergeTargetBias ?? 1.0;
    if (action !== "merge" && targetMergeBias > 0 && bestScore >= (M.merge?.proximityThreshold ?? 0.85)) {
      actionCounts[action]--;
      action = "merge";
      actionCounts["merge"] = (actionCounts["merge"] || 0) + 1;
    }

    const signal = emitSignal(nv.node, action, feelings, intensity);
    const targetEnv = computeEnvironment(best, allNodes, M);
    const mergeCtx = action === "merge" ? { similarity: bestScore } : undefined;
    const reaction = react(best.node, targetEnv, signal.feelings, mergeCtx);
    const targetFeelings = computeFeelings(best.node, targetEnv);
    recordToAccum(best.node.species, ACTIONS.length + REACTIONS.indexOf(reaction), targetFeelings);
    const result = resolveInteraction(nv.node, best.node, signal, reaction, intensity, bestScore);
    if (!result.initiatorAlive) toDelete.add(nv.node.id);
    if (!result.targetAlive) toDelete.add(best.node.id);
  }

  // Spawn phase
  const spawnConsumed = new Set();
  const newChildren = [];
  for (const nv of allNodes) {
    if (toDelete.has(nv.node.id) || spawnConsumed.has(nv.node.id)) continue;
    if (!nv.vector || !isSpawnEligible(nv.node)) continue;
    let best = null, bestScore = -Infinity;
    for (const t of allNodes) {
      if (t.node.id === nv.node.id || !t.vector || toDelete.has(t.node.id) || spawnConsumed.has(t.node.id)) continue;
      const s = cosine(nv.vector, t.vector);
      if (s > bestScore) { bestScore = s; best = t; }
    }
    if (!best) continue;
    if (!isCompatiblePartner(bestScore)) continue;
    const sr = executeSpawn(nv.node, nv.vector, best.node, best.vector);
    spawnConsumed.add(sr.consumedIds[0]);
    spawnConsumed.add(sr.consumedIds[1]);
    toDelete.add(sr.consumedIds[0]);
    toDelete.add(sr.consumedIds[1]);
    for (const child of sr.children) {
      newChildren.push({ node: child.node, vector: child.vector });
    }
    spawnCount += 2;
  }

  // Decay
  for (const nv of allNodes) {
    if (toDelete.has(nv.node.id)) continue;
    nv.node.w *= (1 - nv.node.d);
    nv.node.h *= M.pressure.hCooling;
    nv.node.ttl -= M.pressure.ttlStep;
    if (nv.node.ttl <= M.pressure.deathMinTtl || nv.node.w <= M.pressure.deathMinW) toDelete.add(nv.node.id);
  }

  const survivors = allNodes.filter(nv => !toDelete.has(nv.node.id));
  for (const child of newChildren) survivors.push(child);

  return { survivors, actionCounts, spawnCount };
}

// ---- Main ----

(async () => {
  console.log(`=== SPECIES TRAINING ===`);
  console.log(`Batches: ${BATCHES}  Ticks: ${TICKS}  Digest: ${DIGEST_INTERVAL}  Blend α: ${BLEND_ALPHA}`);
  console.log(`Species: ${ALL_SPECIES.join(", ")}\n`);

  // Load engram vectors once
  const engramPoints = await scrollAll(url, "engram", true, engramFilter());
  if (engramPoints.length === 0) {
    console.error("No engram vectors found. Seed engram first.");
    process.exit(1);
  }
  if (ENGRAM_PROJECT !== "all") console.log(`Engram filter: projectId="${ENGRAM_PROJECT}"`);
  console.log(`Engram vectors: ${engramPoints.length}\n`);

  const M = loadBase();
  const speciesConfig = require("../dist/config/species.json");

  // Batch survival stats
  const batchStats = [];

  const startTime = Date.now();

  for (let batch = 0; batch < BATCHES; batch++) {
    // Seed: anchor every other batch (δ already saturated), others always
    const pool = (batch % 2 === 0)
      ? ALL_SPECIES
      : ALL_SPECIES.filter(s => s !== "anchor");
    let allNodes = [];
    for (let i = 0; i < engramPoints.length; i++) {
      const ep = engramPoints[i];
      const sp = pool[i % pool.length];
      const summary = (ep.payload.contents && ep.payload.contents[0]) || "train node";
      const { node } = createNode(String(summary), undefined, "manual", runningDelta[sp].map(r => [...r]), { ...runningResonanceDelta[sp] });
      node.species = sp;
      node.personality = speciesConfig[sp].personality;
      node.d = speciesConfig[sp].initialDecay;
      node.ttl = speciesConfig[sp].initialTtl;
      node.h = M.birth.initialH;
      node.w = M.birth.initialW;
      allNodes.push({ node, vector: ep.vector });
    }

    // Run ticks
    for (let t = 1; t <= TICKS; t++) {
      const result = runTickLocal(allNodes, M);
      allNodes = result.survivors;
      if (allNodes.length === 0) break;
    }

    // Record survivor fitness
    const survPop = {};
    for (const nv of allNodes) {
      const sp = nv.node.species;
      survPop[sp] = (survPop[sp] || 0) + 1;
      speciesSurvivals[sp]++;
      const cfg = getSpeciesConfig(sp);
      speciesFitnessAccum[sp] += (nv.node.h + Math.min(1, nv.node.w) + nv.node.ttl / cfg.initialTtl) / 3;
    }

    batchStats.push({ batch: batch + 1, pop: allNodes.length, species: { ...survPop } });

    // Update running δ every 10 batches (intermediate learning with blend)
    if ((batch + 1) % 10 === 0) {
      // Pass 1: compute per-species signals and learning rates
      const batchSignals = {};
      const batchLrs = {};
      for (const sp of ALL_SPECIES) {
        const avgFitness = speciesSurvivals[sp] > 0 ? speciesFitnessAccum[sp] / speciesSurvivals[sp] : 0.1;
        batchLrs[sp] = LEARNING_RATE * Math.min(1, avgFitness);
        const fMean = new Array(COLS).fill(0);
        let totalAct = 0;
        for (let ii = 0; ii < ROWS; ii++) {
          if (speciesCounts[sp][ii] === 0) continue;
          for (let jj = 0; jj < COLS; jj++) fMean[jj] += speciesSums[sp][ii][jj];
          totalAct += speciesCounts[sp][ii];
        }
        if (totalAct > 0) for (let jj = 0; jj < COLS; jj++) fMean[jj] /= totalAct;
        batchSignals[sp] = zeroMatrix(ROWS, COLS);
        for (let i = 0; i < ROWS; i++) {
          if (speciesCounts[sp][i] === 0) continue;
          for (let j = 0; j < COLS; j++) {
            batchSignals[sp][i][j] = speciesSums[sp][i][j] / speciesCounts[sp][i] - fMean[j];
          }
        }
      }
      // Pass 2: compute all-species mean signal
      const batchMeanSig = zeroMatrix(ROWS, COLS);
      if (BLEND_ALPHA < 1.0) {
        for (const sp of ALL_SPECIES) {
          for (let i = 0; i < ROWS; i++) for (let j = 0; j < COLS; j++) batchMeanSig[i][j] += batchSignals[sp][i][j];
        }
        for (let i = 0; i < ROWS; i++) for (let j = 0; j < COLS; j++) batchMeanSig[i][j] /= ALL_SPECIES.length;
      }
      // Pass 2.5: exponential decay on existing δ (prevents linear overshoot)
      if (DELTA_DECAY > 0) {
        for (const sp of ALL_SPECIES) {
          for (let i = 0; i < ROWS; i++) {
            for (let j = 0; j < COLS; j++) {
              runningDelta[sp][i][j] *= (1 - DELTA_DECAY);
            }
          }
        }
      }
      // Pass 3: blend and apply
      for (const sp of ALL_SPECIES) {
        for (let i = 0; i < ROWS; i++) {
          for (let j = 0; j < COLS; j++) {
            const blended = BLEND_ALPHA * batchSignals[sp][i][j] + (1 - BLEND_ALPHA) * batchMeanSig[i][j];
            runningDelta[sp][i][j] += batchLrs[sp] * blended;
            runningDelta[sp][i][j] = Math.max(-DELTA_CLAMP, Math.min(DELTA_CLAMP, runningDelta[sp][i][j]));
          }
        }
      }

      // Pass 4: resonance sensitivity delta learning from survivors
      // Average resonance per species pair from recent batches
      // We use the last batch's survivors (allNodes) for resonance signals
      for (const sp of ALL_SPECIES) {
        const members = allNodes.filter(nv => nv.node.species === sp);
        if (members.length === 0) continue;
        const resScale = getSpeciesConfig(sp).resonanceReceiveScale ?? 1.0;
        const lr = batchLrs[sp] * resScale;
        for (const targetSp of ALL_SPECIES) {
          let sum = 0;
          for (const nv of members) sum += nv.node.resonance[targetSp];
          const avgRes = sum / members.length;
          const signal = Math.tanh(avgRes);
          runningResonanceDelta[sp][targetSp] += lr * signal;
          runningResonanceDelta[sp][targetSp] = Math.max(-DELTA_CLAMP, Math.min(DELTA_CLAMP, runningResonanceDelta[sp][targetSp]));
        }
      }
      // Decay existing resonance delta
      if (DELTA_DECAY > 0) {
        for (const sp of ALL_SPECIES) {
          for (const targetSp of ALL_SPECIES) {
            runningResonanceDelta[sp][targetSp] *= (1 - DELTA_DECAY);
          }
        }
      }

      // Progress
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const survTotal = batchStats.slice(-10).reduce((s, b) => s + b.pop, 0);
      const maxDrift = {};
      for (const sp of ALL_SPECIES) {
        let mx = 0;
        for (const row of runningDelta[sp]) for (const v of row) mx = Math.max(mx, Math.abs(v));
        maxDrift[sp] = mx.toFixed(4);
      }
      process.stdout.write(`  batch ${String(batch + 1).padStart(4)}/${BATCHES} (${elapsed}s) ` +
        `surv/10=${survTotal} δ=[${ALL_SPECIES.map(sp => sp.slice(0, 4) + ":" + maxDrift[sp]).join(" ")}]\n`);
    }
  }

  const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  // ---- Compute final δ: species blend ----
  console.log(`\n=== FINAL COMPUTATION (${totalElapsed}s) ===\n`);

  // Global δ (all-species average) — use per-feeling mean as baseline
  const globalDelta = zeroMatrix(ROWS, COLS);
  const globalFMean = new Array(COLS).fill(0);
  let globalTotalAct = 0;
  for (let i = 0; i < ROWS; i++) {
    if (globalCounts[i] === 0) continue;
    for (let j = 0; j < COLS; j++) globalFMean[j] += globalSums[i][j];
    globalTotalAct += globalCounts[i];
  }
  if (globalTotalAct > 0) for (let j = 0; j < COLS; j++) globalFMean[j] /= globalTotalAct;
  for (let i = 0; i < ROWS; i++) {
    if (globalCounts[i] === 0) continue;
    for (let j = 0; j < COLS; j++) {
      globalDelta[i][j] = globalSums[i][j] / globalCounts[i] - globalFMean[j];
    }
  }

  // Per-species raw δ — use per-feeling mean as baseline
  const speciesRawDelta = {};
  for (const sp of ALL_SPECIES) {
    speciesRawDelta[sp] = zeroMatrix(ROWS, COLS);
    const fMean = new Array(COLS).fill(0);
    let totalAct = 0;
    for (let i = 0; i < ROWS; i++) {
      if (speciesCounts[sp][i] === 0) continue;
      for (let j = 0; j < COLS; j++) fMean[j] += speciesSums[sp][i][j];
      totalAct += speciesCounts[sp][i];
    }
    if (totalAct > 0) for (let j = 0; j < COLS; j++) fMean[j] /= totalAct;
    for (let i = 0; i < ROWS; i++) {
      if (speciesCounts[sp][i] === 0) continue;
      for (let j = 0; j < COLS; j++) {
        speciesRawDelta[sp][i][j] = speciesSums[sp][i][j] / speciesCounts[sp][i] - fMean[j];
      }
    }
  }

  // Blended δ: α × species_raw + (1-α) × global_raw, then scale by fitness and clamp
  const finalDelta = {};
  for (const sp of ALL_SPECIES) {
    finalDelta[sp] = zeroMatrix(ROWS, COLS);
    const avgFitness = speciesSurvivals[sp] > 0 ? speciesFitnessAccum[sp] / speciesSurvivals[sp] : 0;
    const fitnessScale = Math.min(1, avgFitness);

    for (let i = 0; i < ROWS; i++) {
      for (let j = 0; j < COLS; j++) {
        const blended = BLEND_ALPHA * speciesRawDelta[sp][i][j] + (1 - BLEND_ALPHA) * globalDelta[i][j];
        finalDelta[sp][i][j] = Math.max(-DELTA_CLAMP, Math.min(DELTA_CLAMP, blended * fitnessScale));
      }
    }
  }

  // ---- Stats ----
  console.log("Survival stats:");
  console.log("  species      | survivals | avgFitness | maxAbsDelta");
  console.log("  -------------|-----------|------------|------------");
  for (const sp of ALL_SPECIES) {
    const avgF = speciesSurvivals[sp] > 0 ? (speciesFitnessAccum[sp] / speciesSurvivals[sp]).toFixed(3) : "  N/A";
    let maxAbs = 0;
    for (const row of finalDelta[sp]) for (const v of row) maxAbs = Math.max(maxAbs, Math.abs(v));
    console.log("  " + sp.padEnd(13) + "| " +
      String(speciesSurvivals[sp]).padStart(9) + " | " +
      String(avgF).padStart(10) + " | " +
      maxAbs.toFixed(4).padStart(11));
  }

  // Data volume
  console.log("\nData volume (action×feelings observations):");
  let totalObs = 0;
  for (const sp of ALL_SPECIES) {
    const spTotal = speciesCounts[sp].reduce((a, b) => a + b, 0);
    totalObs += spTotal;
    console.log(`  ${sp}: ${spTotal.toLocaleString()}`);
  }
  console.log(`  TOTAL: ${totalObs.toLocaleString()}`);

  // δ matrix preview (top 3 absolute values per species)
  console.log("\nTop-3 δ cells per species:");
  for (const sp of ALL_SPECIES) {
    const cells = [];
    for (let i = 0; i < ROWS; i++) {
      for (let j = 0; j < COLS; j++) {
        cells.push({ behavior: BEHAVIOR_KEYS[i], feeling: FEELING_KEYS[j], val: finalDelta[sp][i][j] });
      }
    }
    cells.sort((a, b) => Math.abs(b.val) - Math.abs(a.val));
    const top3 = cells.slice(0, 3).map(c => `${c.behavior}×${c.feeling}=${c.val > 0 ? "+" : ""}${c.val.toFixed(4)}`);
    console.log(`  ${sp}: ${top3.join("  ")}`);
  }

  // ---- Save ----
  const outDir = path.join(__dirname, "..", "data");
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const output = {
    meta: {
      batches: BATCHES,
      ticksPerBatch: TICKS,
      digestInterval: DIGEST_INTERVAL,
      blendAlpha: BLEND_ALPHA,
      learningRate: LEARNING_RATE,
      deltaClamp: DELTA_CLAMP,
      deltaDecay: DELTA_DECAY,
      engramVectors: engramPoints.length,
      totalObservations: totalObs,
      trainingTime: totalElapsed + "s",
      timestamp: new Date().toISOString(),
    },
    survivals: {},
    delta: {},
    runningDelta: {},
    resonanceDelta: {},
  };

  for (const sp of ALL_SPECIES) {
    output.survivals[sp] = {
      count: speciesSurvivals[sp],
      avgFitness: speciesSurvivals[sp] > 0 ? speciesFitnessAccum[sp] / speciesSurvivals[sp] : 0,
    };
    output.delta[sp] = finalDelta[sp];
    output.runningDelta[sp] = runningDelta[sp];
    output.resonanceDelta[sp] = { ...runningResonanceDelta[sp] };
  }

  const outPath = path.join(outDir, "species-weights.json");
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`\nSaved to ${outPath}`);

  // Auto-snapshot with timestamp
  const snapDir = path.join(outDir, "snapshots");
  if (!fs.existsSync(snapDir)) fs.mkdirSync(snapDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "").slice(0, 15); // 20260307T153247
  const snapPath = path.join(snapDir, `species-weights-${ts}.json`);
  fs.writeFileSync(snapPath, JSON.stringify(output, null, 2));
  console.log(`Snapshot saved to ${snapPath}`);
})().catch(e => console.error(e));
