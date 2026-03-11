// ============================================================
// Species Training Loop v2 — Phase 2.2 (frustration + selfReflection + social tone)
// ============================================================
//
// Tick logic matches scenario-test-v2.cjs / tick.ts:
//   frustration blend + selfReflection blend + social tone + proximity fitness gate + merge immunity
//
// 1. Run N test batches (default 100)
// 2. Each batch: seed 5 species (equal), run TICKS ticks with digest
// 3. Accumulate action×feelings across ALL batches into global + per-species pools
// 4. Compute final δ: species_δ * α + global_δ * (1 - α)
// 5. Save to data/species-weights.json
//
// Usage: node scripts/train-species-v2.cjs [BATCHES=100] [TICKS=80]
//   --snapshot [path|latest]  Load initial delta from snapshot

const fs = require("fs");
const path = require("path");
const { ensureCollection, upsertPoints, scrollAll, deletePoints } = require("../dist/qdrant.js");
const { payloadToNode, nodeToPayload, computeFeelings, assessAction, assessActionWithProbs,
        updateFrustration, computeReflection, clamp01, zeroResonance, createNode, getSpeciesConfig,
} = require("../dist/core/node.js");
const { emitSignal, react, resolveInteraction } = require("../dist/core/receptor.js");
const { isSpawnEligible, isCompatiblePartner, executeSpawn } = require("../dist/core/spawn.js");
const { computeFitness } = require("../dist/core/scoring.js");
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
// Positional args: skip flags like --snapshot
const positionalArgs = process.argv.slice(2).filter(a => !a.startsWith("--") && !process.argv[process.argv.indexOf(a) - 1]?.startsWith("--"));
const BATCHES = parseInt(process.env.BATCHES || positionalArgs[0] || "100", 10);
const TICKS = parseInt(process.env.TICKS || positionalArgs[1] || "80", 10);
const DIGEST_INTERVAL = parseInt(process.env.DIGEST_INTERVAL || "20", 10);
const BLEND_ALPHA = parseFloat(process.env.BLEND_ALPHA || String(_metaRaw.learning.blendAlpha ?? 0.7));
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
function zeroRes() { return { summarizer: 0, sentinel: 0, herald: 0, anchor: 0, spore: 0 }; }

// ---- Snapshot loading ----

function resolveSnapshotPath() {
  const idx = process.argv.indexOf("--snapshot");
  if (idx === -1) return null;
  const next = process.argv[idx + 1];
  const snapDir = path.resolve(__dirname, "../data/snapshots");
  if (!next || next.startsWith("--")) {
    return path.resolve(snapDir, "species-weights-baseline-20260307.json");
  }
  if (next === "latest") {
    if (!fs.existsSync(snapDir)) return null;
    const files = fs.readdirSync(snapDir)
      .filter(f => f.startsWith("species-weights-") && f.endsWith(".json") && !f.includes("baseline")).sort();
    return files.length > 0 ? path.resolve(snapDir, files[files.length - 1]) : null;
  }
  return path.resolve(next);
}

const SNAPSHOT_FILE = resolveSnapshotPath();
function loadSnapshot() {
  if (!SNAPSHOT_FILE) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, "utf-8"));
    if (raw.delta) {
      console.log(`[train] loaded delta from ${path.basename(SNAPSHOT_FILE)}`);
      return raw;
    }
  } catch (e) { console.error(`[train] failed to load ${SNAPSHOT_FILE}: ${e.message}`); }
  return null;
}

// ---- Global accumulators ----

const ROWS = BEHAVIOR_KEYS.length;
const COLS = FEELINGS_DIM;

const speciesSums = {};
const speciesCounts = {};
const globalSums = zeroMatrix(ROWS, COLS);
const globalCounts = new Array(ROWS).fill(0);
const speciesSurvivals = {};
const speciesFitnessAccum = {};

for (const sp of ALL_SPECIES) {
  speciesSums[sp] = zeroMatrix(ROWS, COLS);
  speciesCounts[sp] = new Array(ROWS).fill(0);
  speciesSurvivals[sp] = 0;
  speciesFitnessAccum[sp] = 0;
}

// Running δ
const runningDelta = {};
const runningResonanceDelta = {};
for (const sp of ALL_SPECIES) {
  runningDelta[sp] = zeroMatrix(ROWS, COLS);
  runningResonanceDelta[sp] = zeroRes();
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

// ---- Target selection (softmax, matches tick.ts) ----

function selectTarget(self, allNodes, toDelete, M, reach, action) {
  if (!self.vector) return null;
  const limit = reach ?? M.social.neighborLimit;
  const bias = getSpeciesConfig(self.node.species).selectionBias;
  const affinity = action ? (M.social?.targetAffinity?.[action] ?? 0) : 0;
  const mergeMinSim = action === "merge" ? (M.merge?.minSimilarity ?? 0.5) : 0;
  const candidates = [];
  for (const t of allNodes) {
    if (t.node.id === self.node.id || !t.vector || toDelete.has(t.node.id)) continue;
    const sim = cosine(self.vector, t.vector);
    if (sim < mergeMinSim) continue;
    const b = bias?.[t.node.species] ?? 1.0;
    const stateBonus = affinity !== 0 ? (1 + affinity * t.node.w) : 1;
    const mergeBias = action === "merge" ? (getSpeciesConfig(t.node.species).mergeTargetBias ?? 1.0) : 1;
    candidates.push({ nv: t, score: sim * b * stateBonus * mergeBias, similarity: sim });
  }
  candidates.sort((a, b) => b.score - a.score);
  const pool = candidates.slice(0, limit);
  if (pool.length === 0) return null;
  const temp = M.decision?.temperature ?? 1.0;
  const maxScore = pool[0].score;
  const exps = pool.map(c => Math.exp((c.score - maxScore) / temp));
  const sumExp = exps.reduce((a, b) => a + b, 0);
  const rand = Math.random();
  let cumulative = 0;
  let selected;
  for (let i = 0; i < pool.length; i++) {
    cumulative += exps[i] / sumExp;
    if (rand < cumulative) { selected = pool[i]; break; }
  }
  if (!selected) selected = pool[pool.length - 1];
  const proxThreshold = M.merge?.proximityThreshold ?? 0.85;
  const targetMergeBias = getSpeciesConfig(selected.nv.node.species).mergeTargetBias ?? 1.0;
  const proximityMerge = action !== "merge" && selected.similarity >= proxThreshold && targetMergeBias > 0;
  return { target: selected.nv, similarity: selected.similarity, proximityMerge };
}

// ---- Environment ----

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

// ---- Tick engine (Phase 2.2: frustration + selfReflection + social tone) ----

function runTickLocal(allNodes, M) {
  const toDelete = new Set();
  const actionCounts = {};
  let spawnCount = 0;

  // Resonance decay
  const resonanceDecay = M.social.resonanceDecay || 0.8;
  for (const nv of allNodes) {
    for (const sp of ALL_SPECIES) nv.node.resonance[sp] *= resonanceDecay;
  }

  // Configs
  const frust = M.frustration ?? { enabled: false, decay: 0.7, accum: 0.1, blend: 0.15 };
  const refl = M.selfReflection ?? { enabled: false, blend: 0.3, decay: 0.8 };

  for (const nv of allNodes) {
    if (toDelete.has(nv.node.id)) continue;
    const env = computeEnvironment(nv, allNodes, M);
    const baseFeelings = computeFeelings(nv.node, env);

    // Frustration blend
    let feelings = baseFeelings;
    if (frust.enabled && nv.node.frustration) {
      const b = frust.blend;
      feelings = {
        vigor:   clamp01(feelings.vigor   + b * nv.node.frustration.vigor),
        dread:   clamp01(feelings.dread   + b * nv.node.frustration.dread),
        kinship: clamp01(feelings.kinship + b * nv.node.frustration.kinship),
        hunger:  clamp01(feelings.hunger  + b * nv.node.frustration.hunger),
      };
    }

    // Self-reflection blend
    if (refl.enabled && nv.node.selfReflection) {
      const rb = refl.blend;
      feelings = {
        vigor:   clamp01(feelings.vigor   + rb * nv.node.selfReflection.vigor),
        dread:   clamp01(feelings.dread   + rb * nv.node.selfReflection.dread),
        kinship: clamp01(feelings.kinship + rb * nv.node.selfReflection.kinship),
        hunger:  clamp01(feelings.hunger  + rb * nv.node.selfReflection.hunger),
      };
    }

    // Action selection
    let action;
    let actionProbs = null;
    if (frust.enabled) {
      const res = assessActionWithProbs(feelings, nv.node.personality, nv.node.learnedDelta);
      action = res.action;
      actionProbs = res.probs;
    } else {
      action = assessAction(feelings, nv.node.personality, nv.node.learnedDelta);
    }
    actionCounts[action] = (actionCounts[action] || 0) + 1;
    recordToAccum(nv.node.species, ACTIONS.indexOf(action), feelings);

    // Update frustration
    if (frust.enabled && actionProbs) {
      const chosenIdx = ACTIONS.indexOf(action);
      nv.node.frustration = updateFrustration(
        nv.node.personality, actionProbs, chosenIdx,
        nv.node.frustration, frust.decay, frust.accum,
      );
    }

    if (action === "survive") {
      nv.node.h = Math.min(1, nv.node.h + M.relief.surviveHRecovery);
      nv.node.w += (M.relief.surviveWRecovery || 0);
      nv.node.w -= (M.relief.surviveWCost || 0);
      nv.node.ttl += M.relief.surviveTtlRecovery;
      nv.node.d *= M.relief.surviveDecayReduction;
      // selfReflection decay on survive (no social interaction)
      if (refl.enabled && nv.node.selfReflection) {
        nv.node.selfReflection = {
          vigor:   refl.decay * nv.node.selfReflection.vigor,
          dread:   refl.decay * nv.node.selfReflection.dread,
          kinship: refl.decay * nv.node.selfReflection.kinship,
          hunger:  refl.decay * nv.node.selfReflection.hunger,
        };
      }
      continue;
    }

    const intensity = nv.node.h;
    const baseCost = (M.energy.baseCost[action]) ?? 0.1;
    nv.node.h = Math.max(0, nv.node.h - intensity * baseCost);

    // Signal reach scales with intensity
    const signalReach = action === "signal"
      ? M.social.neighborLimit + Math.floor(intensity * (M.social.signalExtraReach ?? 0))
      : undefined;
    const match = selectTarget(nv, allNodes, toDelete, M, signalReach, action);
    if (!match) {
      // Survive fallback: refund energy, apply survive recovery (matches tick.ts)
      nv.node.h = Math.min(1, intensity);
      nv.node.h = Math.min(1, nv.node.h + M.relief.surviveHRecovery);
      nv.node.w += (M.relief.surviveWRecovery || 0);
      nv.node.w -= (M.relief.surviveWCost || 0);
      nv.node.ttl += M.relief.surviveTtlRecovery;
      nv.node.d *= M.relief.surviveDecayReduction;
      continue;
    }

    // Proximity merge: selectTarget flags when target is too close to remain separate
    if (match.proximityMerge) {
      actionCounts[action]--;
      action = "merge";
      actionCounts["merge"] = (actionCounts["merge"] || 0) + 1;
    }

    const signal = emitSignal(nv.node, action, feelings, intensity);
    // Social Tone: sender.w modulates signal feelings
    const tone = nv.node.w;
    const tonedFeelings = {
      vigor:   signal.feelings.vigor * tone,
      hunger:  signal.feelings.hunger * tone,
      dread:   signal.feelings.dread * tone,
      kinship: signal.feelings.kinship * tone,
    };
    const targetEnv = computeEnvironment(match.target, allNodes, M);
    const mergeCtx = action === "merge" ? { similarity: match.similarity } : undefined;
    const reaction = react(match.target.node, targetEnv, tonedFeelings, mergeCtx);
    const targetFeelings = computeFeelings(match.target.node, targetEnv);
    recordToAccum(match.target.node.species, ACTIONS.length + REACTIONS.indexOf(reaction), targetFeelings);
    const result = resolveInteraction(nv.node, match.target.node, signal, reaction, intensity, match.similarity);

    // Self-reflection: initiator processes the reaction
    if (refl.enabled && result.initiatorAlive) {
      const initiatorConfig = getSpeciesConfig(nv.node.species);
      nv.node.selfReflection = computeReflection(
        feelings, targetFeelings,
        initiatorConfig.receptivity ?? 0,
        nv.node.selfReflection, refl.decay,
      );
    }

    if (!result.initiatorAlive) toDelete.add(nv.node.id);
    if (!result.targetAlive) toDelete.add(match.target.node.id);
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
    for (const child of sr.children) newChildren.push({ node: child.node, vector: child.vector });
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
  console.log("=== SPECIES TRAINING v2 (frustration + selfReflection + social tone) ===");
  console.log(`Batches: ${BATCHES}  Ticks: ${TICKS}  Digest: ${DIGEST_INTERVAL}  Blend α: ${BLEND_ALPHA}`);
  console.log(`Features: frustration=${_metaRaw.frustration?.enabled ?? false}  selfReflection=${_metaRaw.selfReflection?.enabled ?? false}  blend=${_metaRaw.selfReflection?.blend ?? 0}`);
  console.log(`Species: ${ALL_SPECIES.join(", ")}\n`);

  // Load engram vectors
  const engramPoints = await scrollAll(url, "engram", true, engramFilter());
  if (engramPoints.length === 0) { console.error("No engram vectors found."); process.exit(1); }
  if (ENGRAM_PROJECT !== "all") console.log(`Engram filter: projectId="${ENGRAM_PROJECT}"`);
  console.log(`Engram vectors: ${engramPoints.length}\n`);

  // Load initial delta from snapshot
  const snapshotData = loadSnapshot();
  if (snapshotData) {
    for (const sp of ALL_SPECIES) {
      if (snapshotData.delta && snapshotData.delta[sp]) {
        runningDelta[sp] = snapshotData.delta[sp].map(r => [...r]);
      }
      if (snapshotData.resonanceDelta && snapshotData.resonanceDelta[sp]) {
        runningResonanceDelta[sp] = { ...snapshotData.resonanceDelta[sp] };
      }
    }
  } else if (!SNAPSHOT_FILE) {
    console.log("[train] plain mode. Use --snapshot [path|latest] to load delta\n");
  }

  const M = loadBase();
  const speciesConfig = require("../dist/config/species.json");
  const batchStats = [];
  const startTime = Date.now();

  for (let batch = 0; batch < BATCHES; batch++) {
    // Seed: anchor every other batch
    const pool = (batch % 2 === 0) ? ALL_SPECIES : ALL_SPECIES.filter(s => s !== "anchor");
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

    // Update running δ every 10 batches
    if ((batch + 1) % 10 === 0) {
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
      const batchMeanSig = zeroMatrix(ROWS, COLS);
      if (BLEND_ALPHA < 1.0) {
        for (const sp of ALL_SPECIES) {
          for (let i = 0; i < ROWS; i++) for (let j = 0; j < COLS; j++) batchMeanSig[i][j] += batchSignals[sp][i][j];
        }
        for (let i = 0; i < ROWS; i++) for (let j = 0; j < COLS; j++) batchMeanSig[i][j] /= ALL_SPECIES.length;
      }
      if (DELTA_DECAY > 0) {
        for (const sp of ALL_SPECIES) {
          for (let i = 0; i < ROWS; i++) for (let j = 0; j < COLS; j++) runningDelta[sp][i][j] *= (1 - DELTA_DECAY);
        }
      }
      for (const sp of ALL_SPECIES) {
        for (let i = 0; i < ROWS; i++) {
          for (let j = 0; j < COLS; j++) {
            const blended = BLEND_ALPHA * batchSignals[sp][i][j] + (1 - BLEND_ALPHA) * batchMeanSig[i][j];
            runningDelta[sp][i][j] += batchLrs[sp] * blended;
            runningDelta[sp][i][j] = Math.max(-DELTA_CLAMP, Math.min(DELTA_CLAMP, runningDelta[sp][i][j]));
          }
        }
      }

      // Resonance sensitivity delta learning
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
      if (DELTA_DECAY > 0) {
        for (const sp of ALL_SPECIES) {
          for (const targetSp of ALL_SPECIES) runningResonanceDelta[sp][targetSp] *= (1 - DELTA_DECAY);
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

  // ---- Compute final δ ----
  console.log(`\n=== FINAL COMPUTATION (${totalElapsed}s) ===\n`);

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
    for (let j = 0; j < COLS; j++) globalDelta[i][j] = globalSums[i][j] / globalCounts[i] - globalFMean[j];
  }

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
      for (let j = 0; j < COLS; j++) speciesRawDelta[sp][i][j] = speciesSums[sp][i][j] / speciesCounts[sp][i] - fMean[j];
    }
  }

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
    console.log("  " + sp.padEnd(13) + "| " + String(speciesSurvivals[sp]).padStart(9) + " | " +
      String(avgF).padStart(10) + " | " + maxAbs.toFixed(4).padStart(11));
  }

  console.log("\nData volume (action×feelings observations):");
  let totalObs = 0;
  for (const sp of ALL_SPECIES) {
    const spTotal = speciesCounts[sp].reduce((a, b) => a + b, 0);
    totalObs += spTotal;
    console.log(`  ${sp}: ${spTotal.toLocaleString()}`);
  }
  console.log(`  TOTAL: ${totalObs.toLocaleString()}`);

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
      version: "v2",
      batches: BATCHES, ticksPerBatch: TICKS, digestInterval: DIGEST_INTERVAL,
      blendAlpha: BLEND_ALPHA, learningRate: LEARNING_RATE, deltaClamp: DELTA_CLAMP, deltaDecay: DELTA_DECAY,
      features: {
        frustration: _metaRaw.frustration?.enabled ?? false,
        selfReflection: _metaRaw.selfReflection?.enabled ?? false,
        selfReflectionBlend: _metaRaw.selfReflection?.blend ?? 0,
        socialTone: true,
        mergeImmunity: true,
        proximityMergeUnconditional: true,
      },
      engramVectors: engramPoints.length, totalObservations: totalObs,
      trainingTime: totalElapsed + "s", timestamp: new Date().toISOString(),
    },
    survivals: {}, delta: {}, runningDelta: {}, resonanceDelta: {},
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

  const snapDir = path.join(outDir, "snapshots");
  if (!fs.existsSync(snapDir)) fs.mkdirSync(snapDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "").slice(0, 15);
  const snapPath = path.join(snapDir, `species-weights-${ts}.json`);
  fs.writeFileSync(snapPath, JSON.stringify(output, null, 2));
  console.log(`Snapshot saved to ${snapPath}`);
})().catch(e => console.error(e));
