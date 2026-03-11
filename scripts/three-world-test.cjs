// Three-World Dialectical Simulation Test
// W1 (Thesis):     frustration=OFF, selfReflection=ON  — pure Markov + social feedback
// W2 (Antithesis): frustration=ON,  selfReflection=ON  — internal desire + social feedback
// W3 (Synthesis):  frustration=ON,  selfReflection=ON  — initial selfReflection = W2 - W1 delta
//
// Usage: node scripts/three-world-test.cjs [--snapshot [path|latest]]

const { ensureCollection, upsertPoints, scrollAll, deletePoints } = require("../dist/qdrant.js");
const { payloadToNode, nodeToPayload, computeFeelings, assessAction, assessActionWithProbs, updateFrustration, computeReflection, clamp01, zeroResonance, createNode, getSpeciesConfig } = require("../dist/core/node.js");
const { emitSignal, react, resolveInteraction } = require("../dist/core/receptor.js");
const { isSpawnEligible, isCompatiblePartner, executeSpawn } = require("../dist/core/spawn.js");
const { BEHAVIOR_KEYS, FEELINGS_DIM, FEELING_KEYS, ALL_SPECIES, ACTIONS, REACTIONS } = require("../dist/types.js");
const { computePushbackSnapshot, extractPureSurvivors, extractLonerIds, extractRedundantIds, extractMergerClusters } = require("../dist/core/pushback.js");
const { summarizeDeaths } = require("../dist/core/observatory.js");
const { computeFitness } = require("../dist/core/scoring.js");

const QDRANT_URL = process.env.QDRANT_URL || "http://localhost:6333";
const TICKS = parseInt(process.env.TICKS || "60", 10);
const DIGEST_INTERVAL = parseInt(process.env.DIGEST_INTERVAL || "20", 10);
const RUNS = parseInt(process.env.RUNS || "10", 10);
const W3_BLEND = parseFloat(process.env.W3_BLEND || "0.3");
const W3_DELTA_SCALE = parseFloat(process.env.W3_DELTA_SCALE || "1.0");
const COLLECTION = "mycelium_3world";

function deepCopy(obj) { return JSON.parse(JSON.stringify(obj)); }
function cosine(a, b) { let d = 0; for (let i = 0; i < a.length; i++) d += a[i] * b[i]; return d; }
function zeroMatrix(rows, cols) { return Array.from({ length: rows }, () => new Array(cols).fill(0)); }

function loadBase() {
  delete require.cache[require.resolve("../dist/config/metabolism.json")];
  return deepCopy(require("../dist/config/metabolism.json"));
}

function resolveSnapshotPath() {
  const idx = process.argv.indexOf("--snapshot");
  if (idx === -1) return null;
  const next = process.argv[idx + 1];
  const snapDir = require("path").resolve(__dirname, "../data/snapshots");
  if (!next || next.startsWith("--")) {
    return require("path").resolve(snapDir, "species-weights-baseline-20260307.json");
  }
  if (next === "latest") {
    const fs = require("fs");
    if (!fs.existsSync(snapDir)) return null;
    const files = fs.readdirSync(snapDir).filter(f => f.startsWith("species-weights-") && f.endsWith(".json") && !f.includes("baseline")).sort();
    return files.length > 0 ? require("path").resolve(snapDir, files[files.length - 1]) : null;
  }
  return require("path").resolve(next);
}

function loadSnapshot() {
  const file = resolveSnapshotPath();
  if (!file) return null;
  try {
    const raw = JSON.parse(require("fs").readFileSync(file, "utf-8"));
    if (raw.delta) {
      const hasRes = !!raw.resonanceDelta;
      console.error(`[3world] loaded delta${hasRes ? " + resonanceDelta" : ""} from ${require("path").basename(file)}`);
      return { delta: raw.delta, resonanceDelta: raw.resonanceDelta || null };
    }
  } catch (e) { console.error(`[3world] failed to load snapshot: ${e.message}`); }
  return null;
}

function createDigestor() {
  const snapshot = loadSnapshot();
  const mem = {}, sums = {}, counts = {}, resDelta = {};
  for (const sp of ALL_SPECIES) {
    const d = snapshot && snapshot.delta && snapshot.delta[sp];
    mem[sp] = d ? d.map(r => [...r]) : zeroMatrix(BEHAVIOR_KEYS.length, FEELINGS_DIM);
    sums[sp] = zeroMatrix(BEHAVIOR_KEYS.length, FEELINGS_DIM);
    counts[sp] = new Array(BEHAVIOR_KEYS.length).fill(0);
    const rd = snapshot && snapshot.resonanceDelta && snapshot.resonanceDelta[sp];
    resDelta[sp] = rd ? { summarizer: 0, sentinel: 0, herald: 0, anchor: 0, spore: 0, ...rd } : { summarizer: 0, sentinel: 0, herald: 0, anchor: 0, spore: 0 };
  }
  let gen = 0;
  return {
    getMemory(species) { return mem[species].map(r => [...r]); },
    getResonanceDelta(species) { return { ...resDelta[species] }; },
    record(species, behaviorIdx, feelings) {
      const fv = FEELING_KEYS.map(k => feelings[k]);
      for (let j = 0; j < FEELINGS_DIM; j++) sums[species][behaviorIdx][j] += fv[j];
      counts[species][behaviorIdx] += 1;
    },
    digest(survivors) {
      gen++;
      const buckets = {};
      for (const n of survivors) { if (!buckets[n.species]) buckets[n.species] = []; buckets[n.species].push(n); }
      for (const sp of ALL_SPECIES) {
        const members = buckets[sp] || [];
        if (members.length === 0) continue;
        const avgFitness = members.reduce((s, n) => {
          const cfg = getSpeciesConfig(n.species);
          return s + (n.h + Math.min(1, n.w) + n.ttl / cfg.initialTtl) / 3;
        }, 0) / members.length;
        const lr = 0.05 * avgFitness;
        const fMean = new Array(FEELINGS_DIM).fill(0);
        let totalAct = 0;
        for (let i = 0; i < BEHAVIOR_KEYS.length; i++) {
          if (counts[sp][i] === 0) continue;
          for (let j = 0; j < FEELINGS_DIM; j++) fMean[j] += sums[sp][i][j];
          totalAct += counts[sp][i];
        }
        if (totalAct > 0) for (let j = 0; j < FEELINGS_DIM; j++) fMean[j] /= totalAct;
        for (let i = 0; i < BEHAVIOR_KEYS.length; i++) {
          if (counts[sp][i] === 0) continue;
          for (let j = 0; j < FEELINGS_DIM; j++) {
            const avg = sums[sp][i][j] / counts[sp][i];
            const signal = avg - fMean[j];
            mem[sp][i][j] = Math.max(-0.5, Math.min(0.5, mem[sp][i][j] + lr * signal));
          }
        }
        // Reset accumulators
        sums[sp] = zeroMatrix(BEHAVIOR_KEYS.length, FEELINGS_DIM);
        counts[sp] = new Array(BEHAVIOR_KEYS.length).fill(0);
      }
      return gen;
    },
  };
}

function computeEnvironment(self, allNodes, M) {
  const env = { neighborField: { h: 0, w: 0, d: 0 }, kinCount: 0, neighborSpecies: { summarizer: 0, sentinel: 0, herald: 0, anchor: 0, spore: 0 } };
  if (!self.vector) return env;
  const neighbors = allNodes
    .filter(n => n.node.id !== self.node.id && n.vector)
    .map(n => ({ score: cosine(self.vector, n.vector), node: n.node }))
    .sort((a, b) => b.score - a.score)
    .slice(0, M.social.neighborLimit);
  if (neighbors.length === 0) return env;
  let hSum = 0, wSum = 0, dSum = 0;
  for (const n of neighbors) {
    hSum += n.node.h; wSum += n.node.w; dSum += n.node.d;
    if (n.node.species === self.node.species) env.kinCount++;
    env.neighborSpecies[n.node.species]++;
  }
  env.neighborField = { h: hSum / neighbors.length, w: wSum / neighbors.length, d: dSum / neighbors.length };
  return env;
}

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

// Run one tick with full selfReflection + frustration support
function runTickLocal(allNodes, M, digestor) {
  const toDelete = new Set();
  const actionCounts = {};
  let interactionCount = 0, spawnCount = 0;
  const mergeEvents = [];

  const resonanceDecay = M.social.resonanceDecay || 0.8;
  for (const nv of allNodes) {
    for (const sp of ALL_SPECIES) nv.node.resonance[sp] *= resonanceDecay;
  }

  const frust = M.frustration ?? { enabled: false, decay: 0.7, accum: 0.1, blend: 0.15 };
  const refl = M.selfReflection ?? { enabled: false, blend: 0.1, decay: 0.8 };

  for (const nv of allNodes) {
    if (toDelete.has(nv.node.id)) continue;
    const env = computeEnvironment(nv, allNodes, M);
    const baseFeelings = computeFeelings(nv.node, env);

    let feelings = baseFeelings;
    if (frust.enabled && nv.node.frustration) {
      const b = frust.blend;
      feelings = {
        vigor: clamp01(feelings.vigor + b * nv.node.frustration.vigor),
        dread: clamp01(feelings.dread + b * nv.node.frustration.dread),
        kinship: clamp01(feelings.kinship + b * nv.node.frustration.kinship),
        hunger: clamp01(feelings.hunger + b * nv.node.frustration.hunger),
      };
    }
    if (refl.enabled && nv.node.selfReflection) {
      const rb = refl.blend;
      feelings = {
        vigor: clamp01(feelings.vigor + rb * nv.node.selfReflection.vigor),
        dread: clamp01(feelings.dread + rb * nv.node.selfReflection.dread),
        kinship: clamp01(feelings.kinship + rb * nv.node.selfReflection.kinship),
        hunger: clamp01(feelings.hunger + rb * nv.node.selfReflection.hunger),
      };
    }

    let action, actionProbs = null;
    if (frust.enabled) {
      const res = assessActionWithProbs(feelings, nv.node.personality, nv.node.learnedDelta);
      action = res.action; actionProbs = res.probs;
    } else {
      action = assessAction(feelings, nv.node.personality, nv.node.learnedDelta);
    }
    actionCounts[action] = (actionCounts[action] || 0) + 1;
    digestor.record(nv.node.species, ACTIONS.indexOf(action), feelings);

    if (frust.enabled && actionProbs) {
      const chosenIdx = ACTIONS.indexOf(action);
      nv.node.frustration = updateFrustration(nv.node.personality, actionProbs, chosenIdx, nv.node.frustration, frust.decay, frust.accum);
    }

    if (action === "survive") {
      nv.node.h = Math.min(1, nv.node.h + M.relief.surviveHRecovery);
      nv.node.w += (M.relief.surviveWRecovery || 0);
      nv.node.w -= (M.relief.surviveWCost || 0);
      nv.node.ttl += M.relief.surviveTtlRecovery;
      nv.node.d *= M.relief.surviveDecayReduction;
      if (refl.enabled && nv.node.selfReflection) {
        nv.node.selfReflection = {
          vigor: refl.decay * nv.node.selfReflection.vigor, dread: refl.decay * nv.node.selfReflection.dread,
          kinship: refl.decay * nv.node.selfReflection.kinship, hunger: refl.decay * nv.node.selfReflection.hunger,
        };
      }
      continue;
    }

    const intensity = nv.node.h;
    const baseCost = (M.energy.baseCost[action]) ?? 0.1;
    nv.node.h = Math.max(0, nv.node.h - intensity * baseCost);

    const signalReach = action === "signal" ? M.social.neighborLimit + Math.floor(intensity * (M.social.signalExtraReach ?? 0)) : undefined;
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
    const tone = nv.node.w;
    const tonedFeelings = {
      vigor: signal.feelings.vigor * tone, hunger: signal.feelings.hunger * tone,
      dread: signal.feelings.dread * tone, kinship: signal.feelings.kinship * tone,
    };
    const targetEnv = computeEnvironment(match.target, allNodes, M);
    const mergeCtx = action === "merge" ? { similarity: match.similarity } : undefined;
    const reaction = react(match.target.node, targetEnv, tonedFeelings, mergeCtx);
    const targetFeelings = computeFeelings(match.target.node, targetEnv);
    digestor.record(match.target.node.species, ACTIONS.length + REACTIONS.indexOf(reaction), targetFeelings);
    const result = resolveInteraction(nv.node, match.target.node, signal, reaction, intensity, match.similarity);
    interactionCount++;

    if (refl.enabled && result.initiatorAlive) {
      const initiatorConfig = getSpeciesConfig(nv.node.species);
      nv.node.selfReflection = computeReflection(feelings, targetFeelings, initiatorConfig.receptivity ?? 0, nv.node.selfReflection, refl.decay);
    }

    if (!result.initiatorAlive) { toDelete.add(nv.node.id); if (action === "merge") mergeEvents.push({ absorbed: nv.node.id, absorber: match.target.node.id, cosine: match.similarity }); }
    if (!result.targetAlive) { toDelete.add(match.target.node.id); if (action === "merge") mergeEvents.push({ absorbed: match.target.node.id, absorber: nv.node.id, cosine: match.similarity }); }
  }

  // Spawn
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
    if (!best || !isCompatiblePartner(bestScore)) continue;
    const sr = executeSpawn(nv.node, nv.vector, best.node, best.vector);
    spawnConsumed.add(sr.consumedIds[0]); spawnConsumed.add(sr.consumedIds[1]);
    toDelete.add(sr.consumedIds[0]); toDelete.add(sr.consumedIds[1]);
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
  return { survivors, expired: toDelete.size, actionCounts, interactionCount, spawnCount, mergeEvents, spawnConsumed };
}

// Seed nodes from engram (same initial conditions for all worlds)
async function seedFromEngram(M, digestor) {
  const engramPoints = await scrollAll(QDRANT_URL, "engram", true);
  if (engramPoints.length === 0) { console.error("No engram data!"); process.exit(1); }
  const speciesConfig = require("../dist/config/species.json");

  const nodes = [];
  const engramIdMap = new Map();
  for (let i = 0; i < engramPoints.length; i++) {
    const ep = engramPoints[i];
    const summary = (ep.payload.contents && ep.payload.contents[0]) || ep.payload.summary || "engram node";
    const sp = ALL_SPECIES[i % ALL_SPECIES.length];
    const inherited = digestor.getMemory(sp);
    const inheritedRes = digestor.getResonanceDelta(sp);
    const { node } = createNode(String(summary), undefined, "manual", inherited, inheritedRes);
    node.species = sp;
    node.personality = speciesConfig[sp].personality;
    node.d = speciesConfig[sp].initialDecay;
    node.ttl = speciesConfig[sp].initialTtl;
    node.h = M.birth.initialH;
    node.w = M.birth.initialW;
    node.engramId = String(ep.id);
    engramIdMap.set(node.id, String(ep.id));
    nodes.push({ node, vector: ep.vector });
  }
  return { nodes, engramIdMap };
}

// Run one world (full simulation)
async function runWorld(label, M, digestor, initialReflections) {
  const { nodes: seedNodes, engramIdMap } = await seedFromEngram(M, digestor);
  let allNodes = deepCopy(seedNodes);
  // Restore vectors (lost in deepCopy)
  for (let i = 0; i < allNodes.length; i++) allNodes[i].vector = seedNodes[i].vector;

  // Inject initial selfReflection if provided (W3)
  if (initialReflections) {
    for (const nv of allNodes) {
      const eid = nv.node.engramId;
      if (eid && initialReflections.has(eid)) {
        nv.node.selfReflection = deepCopy(initialReflections.get(eid));
      }
    }
  }

  const deathLog = new Map();
  if (RUNS <= 1) console.log(`\n=== ${label} ===`);
  if (RUNS <= 1) {
    console.log(`  frust=${M.frustration.enabled} refl=${M.selfReflection.enabled} ticks=${TICKS}`);
    console.log("  tick | pop | avgH  | avgW  | surv | social");
    console.log("  -----|-----|-------|-------|------|-------");
  }

  for (let t = 1; t <= TICKS; t++) {
    const prevIds = new Set(allNodes.map(nv => nv.node.id));
    const preTickRes = new Map();
    for (const nv of allNodes) {
      const posRes = ALL_SPECIES.reduce((s, sp) => s + Math.max(0, nv.node.resonance[sp]), 0);
      preTickRes.set(nv.node.id, posRes);
    }

    const result = runTickLocal(allNodes, M, digestor);
    allNodes = result.survivors;

    const nowIds = new Set(allNodes.map(nv => nv.node.id));
    for (const id of prevIds) {
      if (!nowIds.has(id) && !deathLog.has(id)) {
        const mergeEvt = result.mergeEvents.find(e => e.absorbed === id);
        const isSpawn = result.spawnConsumed.has(id);
        deathLog.set(id, { tick: t, cause: mergeEvt ? "merge" : isSpawn ? "spawn" : "decay", cosine: mergeEvt?.cosine, posRes: preTickRes.get(id) ?? 0 });
      }
    }

    if (t % DIGEST_INTERVAL === 0 && allNodes.length > 0) digestor.digest(allNodes.map(nv => nv.node));

    const shouldPrint = RUNS <= 1 && (t <= 3 || t % 10 === 0 || t === TICKS || allNodes.length <= 3);
    if (shouldPrint) {
      const avgH = allNodes.length > 0 ? allNodes.reduce((s, nv) => s + nv.node.h, 0) / allNodes.length : 0;
      const avgW = allNodes.length > 0 ? allNodes.reduce((s, nv) => s + nv.node.w, 0) / allNodes.length : 0;
      const surv = result.actionCounts.survive || 0;
      const social = (result.actionCounts.signal || 0) + (result.actionCounts.merge || 0) + (result.actionCounts.bequeath || 0);
      console.log("  " + String(t).padStart(4) + " | " + String(allNodes.length).padStart(3) + " | " + avgH.toFixed(3) + " | " + avgW.toFixed(3) + " | " + String(surv).padStart(4) + " | " + String(social).padStart(6));
    }
    if (allNodes.length === 0) { console.log("  EXTINCT at tick " + t); break; }
  }

  // Collect selfReflection per engramId for surviving nodes
  const reflectionMap = new Map();
  for (const nv of allNodes) {
    if (nv.node.engramId && nv.node.selfReflection) {
      reflectionMap.set(nv.node.engramId, deepCopy(nv.node.selfReflection));
    }
  }

  // Summary
  const spPop = {};
  for (const nv of allNodes) spPop[nv.node.species] = (spPop[nv.node.species] || 0) + 1;
  const pureSurvivors = allNodes.length > 0 ? extractPureSurvivors(allNodes.map(nv => nv.node)) : [];
  const deaths = summarizeDeaths(deathLog);
  const lonerIds = extractLonerIds(engramIdMap, deathLog, TICKS);

  if (RUNS <= 1) {
    console.log("  Final: " + allNodes.length + " alive " + JSON.stringify(spPop));
    console.log("  Pure: " + pureSurvivors.length + " | Loner: " + lonerIds.length + " | Deaths: " + deaths.total + " (merge=" + deaths.merge + " decay=" + deaths.decay + " spawn=" + deaths.spawn + ")");
  }

  return {
    label, population: allNodes.length, speciesPop: spPop,
    pure: pureSurvivors.length, loner: lonerIds.length, deaths,
    pureIds: pureSurvivors.map(p => p.engramId),
    lonerEids: lonerIds,
    reflectionMap,
  };
}

// --- Aggregation helpers ---
function emptyAcc() {
  return { population: [], pure: [], loner: [], totalDeaths: [], mergeDeaths: [], decayDeaths: [], spawnDeaths: [],
           speciesPop: {}, onlyW3: [], in123: [] };
}
function pushAcc(acc, result, speciesList) {
  acc.population.push(result.population);
  acc.pure.push(result.pure);
  acc.loner.push(result.loner);
  acc.totalDeaths.push(result.deaths.total);
  acc.mergeDeaths.push(result.deaths.merge);
  acc.decayDeaths.push(result.deaths.decay);
  acc.spawnDeaths.push(result.deaths.spawn);
  for (const sp of speciesList) {
    if (!acc.speciesPop[sp]) acc.speciesPop[sp] = [];
    acc.speciesPop[sp].push(result.speciesPop[sp] || 0);
  }
}
function mean(arr) { return arr.reduce((a, b) => a + b, 0) / arr.length; }
function std(arr) { const m = mean(arr); return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length); }
function fmt(arr) { return mean(arr).toFixed(1) + "±" + std(arr).toFixed(1); }

(async () => {
  console.log("╔══════════════════════════════════════════════╗");
  console.log("║  THREE-WORLD DIALECTICAL SIMULATION TEST     ║");
  console.log("║  W1: frust=OFF (thesis)                     ║");
  console.log("║  W2: frust=ON  (antithesis)                 ║");
  console.log("║  W3: frust=ON + reflection delta (synthesis) ║");
  console.log("║  Runs: " + String(RUNS).padEnd(37) + "║");
  console.log("║  W3 blend: " + String(W3_BLEND).padEnd(33) + "║");
  console.log("║  W3 delta scale: " + String(W3_DELTA_SCALE).padEnd(26) + "║");
  console.log("╚══════════════════════════════════════════════╝");

  const accW1 = emptyAcc(), accW2 = emptyAcc(), accW3 = emptyAcc();
  const deltaAvgs = { vigor: [], dread: [], kinship: [], hunger: [] };

  for (let run = 1; run <= RUNS; run++) {
    console.log(`\n${"=".repeat(50)}`);
    console.log(`  RUN ${run}/${RUNS}`);
    console.log("=".repeat(50));

    // W1: frustration=OFF, selfReflection=ON
    const M1 = loadBase();
    M1.frustration.enabled = false;
    M1.selfReflection.enabled = true;
    const d1 = createDigestor();
    const w1 = await runWorld("W1 (Thesis: frust=OFF)", M1, d1, null);

    // W2: frustration=ON, selfReflection=ON
    const M2 = loadBase();
    M2.frustration.enabled = true;
    M2.selfReflection.enabled = true;
    const d2 = createDigestor();
    const w2 = await runWorld("W2 (Antithesis: frust=ON)", M2, d2, null);

    // Compute reflection delta: W2 - W1
    const reflDelta = new Map();
    const allEids = new Set([...w1.reflectionMap.keys(), ...w2.reflectionMap.keys()]);
    for (const eid of allEids) {
      const r1 = w1.reflectionMap.get(eid) || { vigor: 0, dread: 0, kinship: 0, hunger: 0 };
      const r2 = w2.reflectionMap.get(eid) || { vigor: 0, dread: 0, kinship: 0, hunger: 0 };
      const s = W3_DELTA_SCALE;
      reflDelta.set(eid, {
        vigor: (r2.vigor - r1.vigor) * s, dread: (r2.dread - r1.dread) * s,
        kinship: (r2.kinship - r1.kinship) * s, hunger: (r2.hunger - r1.hunger) * s,
      });
    }
    const deltas = [...reflDelta.values()];
    if (deltas.length > 0) {
      const davg = (key) => deltas.reduce((s, d) => s + d[key], 0) / deltas.length;
      for (const k of ["vigor", "dread", "kinship", "hunger"]) deltaAvgs[k].push(davg(k));
    }

    // W3: frustration=ON, selfReflection=ON, inject delta (boosted blend)
    const M3 = loadBase();
    M3.frustration.enabled = true;
    M3.selfReflection.enabled = true;
    M3.selfReflection.blend = W3_BLEND;
    const d3 = createDigestor();
    const w3 = await runWorld("W3 (Synthesis: frust=ON + delta)", M3, d3, reflDelta);

    pushAcc(accW1, w1, ALL_SPECIES);
    pushAcc(accW2, w2, ALL_SPECIES);
    pushAcc(accW3, w3, ALL_SPECIES);

    // Per-run overlap
    const w1pure = new Set(w1.pureIds);
    const w2pure = new Set(w2.pureIds);
    const w3pure = new Set(w3.pureIds);
    const allPure = new Set([...w1pure, ...w2pure, ...w3pure]);
    accW3.onlyW3.push([...w3pure].filter(id => !w1pure.has(id) && !w2pure.has(id)).length);
    accW3.in123.push([...allPure].filter(id => w1pure.has(id) && w2pure.has(id) && w3pure.has(id)).length);

    console.log(`  [Run ${run}] W1=${w1.population} W2=${w2.population} W3=${w3.population} | pure: ${w1.pure}/${w2.pure}/${w3.pure} | onlyW3: ${accW3.onlyW3[accW3.onlyW3.length - 1]}`);
  }

  // --- Aggregate report ---
  console.log("\n" + "═".repeat(70));
  console.log("  AGGREGATE RESULTS (" + RUNS + " runs × " + TICKS + " ticks)");
  console.log("═".repeat(70));
  console.log("  Metric         |   W1 (thesis)  |  W2 (antithesis) |  W3 (synthesis)");
  console.log("  ---------------|----------------|------------------|------------------");
  const row = (label, k) => {
    console.log("  " + label.padEnd(15) + " | " + fmt(accW1[k]).padStart(14) + " | " + fmt(accW2[k]).padStart(16) + " | " + fmt(accW3[k]).padStart(16));
  };
  row("Population", "population");
  row("Pure surviv.", "pure");
  row("Loner deaths", "loner");
  row("Total deaths", "totalDeaths");
  row("Merge deaths", "mergeDeaths");
  row("Decay deaths", "decayDeaths");
  row("Spawn deaths", "spawnDeaths");

  console.log("\n  Species (mean) |   W1           |  W2              |  W3");
  console.log("  ---------------|----------------|------------------|------------------");
  for (const sp of ALL_SPECIES) {
    const a1 = accW1.speciesPop[sp] || [0], a2 = accW2.speciesPop[sp] || [0], a3 = accW3.speciesPop[sp] || [0];
    console.log("  " + sp.padEnd(15) + " | " + fmt(a1).padStart(14) + " | " + fmt(a2).padStart(16) + " | " + fmt(a3).padStart(16));
  }

  console.log("\n  Reflection delta (mean across runs):");
  for (const k of ["vigor", "dread", "kinship", "hunger"]) {
    console.log("    " + k.padEnd(8) + ": " + mean(deltaAvgs[k]).toFixed(4) + " ± " + std(deltaAvgs[k]).toFixed(4));
  }

  console.log("\n  Pure overlap (mean):");
  console.log("    All 3 worlds: " + fmt(accW3.in123));
  console.log("    Only W3:      " + fmt(accW3.onlyW3) + " ← synthesis-unique survivors");

  console.log("\nDone.");
})();
