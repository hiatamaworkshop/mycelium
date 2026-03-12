// semantic-filter-test.cjs — Pushback 3-axis filter consensus test
// PRIMARY production filter script. All config values come from metabolism.json (via M_REF).
// This script is the canonical reference for mycelium simulation behavior.
//
// Reads engram nodes, runs N simulations, majority votes for stable classification.
//
// 3-axis filter:
//   1. Pure survivors  — absorbedCount=0, not spawned → unique knowledge (promotion candidate)
//   2. Loner (孤立死)  — early death + near-zero positive resonance → irrelevant garbage (redundant flag)
//   3. Merger (cluster) — cos band [clusterMinCos, clusterMaxCos) → cluster candidate metadata
//
// Usage:
//   node scripts/semantic-filter-test.cjs                    # default: 10 runs, 50 ticks, dry run
//   RUNS=10 TICKS=50 MAJORITY=6 node scripts/semantic-filter-test.cjs
//   DRY_RUN=false node scripts/semantic-filter-test.cjs      # flag loners in engram

const { ensureCollection, upsertPoints, scrollAll, deletePoints } = require("../dist/qdrant.js");
const { payloadToNode, nodeToPayload, computeFeelings, assessAction, assessActionWithProbs, updateFrustration, computeReflection, clamp01, zeroResonance, createNode, getSpeciesConfig, resolveSpecies } = require("../dist/core/node.js");
const { emitSignal, react, resolveInteraction } = require("../dist/core/receptor.js");
const { isSpawnEligible, isCompatiblePartner, executeSpawn } = require("../dist/core/spawn.js");
const { computeFitness } = require("../dist/core/scoring.js");
const { BEHAVIOR_KEYS, FEELINGS_DIM, FEELING_KEYS, ALL_SPECIES, ACTIONS, REACTIONS } = require("../dist/types.js");
const { extractRedundantIds, extractLonerIds, extractPureSurvivors, extractMergerClusters } = require("../dist/core/pushback.js");
const { computeResonanceSummary, computeDeathHistogram, summarizeDeaths, crossVote } = require("../dist/core/observatory.js");
const M_REF = require("../dist/config/metabolism.json");

// ================================================================
// CONFIG
// ================================================================
const QDRANT_URL       = process.env.QDRANT_URL       || "http://localhost:6333";
const SOURCE_COLLECTION = process.env.SOURCE_COLLECTION || "engram";  // "engram" or source collection name
const ENGRAM_PROJECT   = process.env.ENGRAM_PROJECT    || "all";
const RUNS             = parseInt(process.env.RUNS             || "10",   10);
const TICKS            = parseInt(process.env.TICKS            || "50",   10);
const DIGEST_INTERVAL  = parseInt(process.env.DIGEST_INTERVAL  || "20",   10);
const DRY_RUN          = (process.env.DRY_RUN ?? "true") !== "false";
const MAJORITY         = parseInt(process.env.MAJORITY || String(Math.ceil(RUNS * 0.4)), 10);
const COLLECTION       = "mycelium_filter_test";
const LEARNING_RATE    = M_REF.learning.rate;
const DELTA_CLAMP      = M_REF.learning.deltaClamp;
const IS_ENGRAM_MODE   = SOURCE_COLLECTION === "engram";

// ================================================================
// Helpers
// ================================================================

function deepCopy(obj) { return JSON.parse(JSON.stringify(obj)); }
function cosine(a, b) { let d = 0; for (let i = 0; i < a.length; i++) d += a[i] * b[i]; return d; }
function zeroMatrix(rows, cols) { return Array.from({ length: rows }, () => new Array(cols).fill(0)); }

function loadBase() {
  delete require.cache[require.resolve("../dist/config/metabolism.json")];
  return deepCopy(require("../dist/config/metabolism.json"));
}

function computeNutrition(engramPayload, species, M) {
  const NUT = M.nutrition;
  const baseW = M.birth.initialW;
  const baseH = M.birth.initialH;
  const baseD = getSpeciesConfig(species).initialDecay;
  const wBias = NUT.bias * Math.tanh((engramPayload.weight ?? 0) / NUT.weightSaturation);
  const hitRatio = Math.min((engramPayload.hitCount ?? 0) / NUT.hitCountCap, 1);
  const hBias = NUT.bias * hitRatio;
  const dBias = -NUT.bias * hitRatio;
  const fixed = engramPayload.status === "fixed";
  const fixedW = fixed ? NUT.fixedBonus : 0;
  const fixedD = fixed ? -NUT.fixedBonus : 0;
  return {
    w: baseW * (1 + wBias + fixedW),
    h: baseH * (1 + hBias),
    d: baseD * (1 + dBias + fixedD),
  };
}

// ---- Snapshot loader ----
function resolveSnapshotPath() {
  const idx = process.argv.indexOf("--snapshot");
  if (idx === -1) return null;
  const next = process.argv[idx + 1];
  const snapDir = require("path").resolve(__dirname, "../data/snapshots");
  if (!next || next.startsWith("--")) {
    // default: latest non-baseline
    const fs = require("fs");
    if (!fs.existsSync(snapDir)) return null;
    const files = fs.readdirSync(snapDir).filter(f => f.startsWith("species-weights-") && f.endsWith(".json") && !f.includes("baseline")).sort();
    return files.length > 0 ? require("path").resolve(snapDir, files[files.length - 1]) : null;
  }
  if (next === "latest") {
    const fs = require("fs");
    if (!fs.existsSync(snapDir)) return null;
    const files = fs.readdirSync(snapDir).filter(f => f.startsWith("species-weights-") && f.endsWith(".json") && !f.includes("baseline")).sort();
    return files.length > 0 ? require("path").resolve(snapDir, files[files.length - 1]) : null;
  }
  return require("path").resolve(next);
}

const SNAPSHOT_FILE = resolveSnapshotPath();

function loadSnapshot() {
  if (!SNAPSHOT_FILE) return null;
  try {
    const raw = JSON.parse(require("fs").readFileSync(SNAPSHOT_FILE, "utf-8"));
    if (raw.delta) {
      const hasRes = !!raw.resonanceDelta;
      console.error(`[filter] loaded delta${hasRes ? " + resonanceDelta" : ""} from ${require("path").basename(SNAPSHOT_FILE)}`);
      return { delta: raw.delta, resonanceDelta: raw.resonanceDelta || null };
    }
  } catch (e) {
    console.error(`[filter] failed to load ${SNAPSHOT_FILE}: ${e.message}`);
  }
  return null;
}

// ---- Digestor (per-run, in-memory) ----
function createDigestor() {
  const snapshot = loadSnapshot();
  if (!SNAPSHOT_FILE) console.error(`[filter] plain mode. Use --snapshot [path|latest] to load delta`);
  const mem = {};
  const sums = {};
  const counts = {};
  const resDelta = {};
  for (const sp of ALL_SPECIES) {
    const d = snapshot && snapshot.delta && snapshot.delta[sp];
    mem[sp] = d ? d.map(r => [...r]) : zeroMatrix(BEHAVIOR_KEYS.length, FEELINGS_DIM);
    sums[sp] = zeroMatrix(BEHAVIOR_KEYS.length, FEELINGS_DIM);
    counts[sp] = new Array(BEHAVIOR_KEYS.length).fill(0);
    const rd = snapshot && snapshot.resonanceDelta && snapshot.resonanceDelta[sp];
    const zeroRes = {}; for (const s of ALL_SPECIES) zeroRes[s] = 0;
    resDelta[sp] = rd ? { ...zeroRes, ...rd } : { ...zeroRes };
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
        const lr = LEARNING_RATE * avgFitness;
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
            const avgFeeling = sums[sp][i][j] / counts[sp][i];
            const signal = avgFeeling - fMean[j];
            mem[sp][i][j] += lr * signal;
            mem[sp][i][j] = Math.max(-DELTA_CLAMP, Math.min(DELTA_CLAMP, mem[sp][i][j]));
          }
        }
        // Resonance sensitivity learning
        const resScale = getSpeciesConfig(sp).resonanceReceiveScale ?? 1.0;
        const resLr = LEARNING_RATE * (M_REF.learning.resonanceLrScale ?? 0.5) * resScale;
        for (const tsp of ALL_SPECIES) {
          let sum = 0;
          for (const n of members) sum += n.resonance[tsp];
          const sig = Math.tanh(sum / members.length);
          resDelta[sp][tsp] += resLr * sig;
          resDelta[sp][tsp] = Math.max(-DELTA_CLAMP, Math.min(DELTA_CLAMP, resDelta[sp][tsp]));
        }
      }
      for (const sp of ALL_SPECIES) {
        sums[sp] = zeroMatrix(BEHAVIOR_KEYS.length, FEELINGS_DIM);
        counts[sp] = new Array(BEHAVIOR_KEYS.length).fill(0);
      }
      return gen;
    },
  };
}

// ---- Softmax target selection (matches tick.ts) ----
function selectTarget(self, allNodes, toDelete, M, reach, action) {
  if (!self.vector) return null;
  const limit = reach ?? M.social.neighborLimit;
  const bias = getSpeciesConfig(self.node.species).selectionBias;
  const affinity = action ? (M.social.targetAffinity?.[action] ?? 0) : 0;
  const candidates = [];
  for (const t of allNodes) {
    if (t.node.id === self.node.id || !t.vector || toDelete.has(t.node.id)) continue;
    const sim = cosine(self.vector, t.vector);
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
  const proxThreshold = M.merge?.proximityThreshold ?? M_REF.merge.proximityThreshold;
  const targetMergeBias = getSpeciesConfig(selected.nv.node.species).mergeTargetBias ?? 1.0;
  const proximityMerge = action !== "merge" && selected.similarity >= proxThreshold && targetMergeBias > 0;
  return { target: selected.nv, similarity: selected.similarity, proximityMerge };
}

// ---- computeEnvironment ----
function computeEnvironment(self, allNodes, M) {
  const neighborSpecies = {}; for (const sp of ALL_SPECIES) neighborSpecies[sp] = 0;
  const env = { neighborField: { h: 0, w: 0, d: 0 }, kinCount: 0, neighborSpecies };
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

// ---- runTickLocal (Phase 2.1 — full feature set) ----
function runTickLocal(allNodes, M, digestor) {
  const toDelete = new Set();
  const actionCounts = {};
  let interactionCount = 0;
  let spawnCount = 0;
  const mergeEvents = [];

  // Resonance decay
  const resonanceDecay = M.social.resonanceDecay ?? M_REF.social.resonanceDecay;
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
        vigor:   clamp01(feelings.vigor   + b * nv.node.frustration.vigor),
        dread:   clamp01(feelings.dread   + b * nv.node.frustration.dread),
        kinship: clamp01(feelings.kinship + b * nv.node.frustration.kinship),
        hunger:  clamp01(feelings.hunger  + b * nv.node.frustration.hunger),
      };
    }
    if (refl.enabled && nv.node.selfReflection) {
      const rb = refl.blend;
      feelings = {
        vigor:   clamp01(feelings.vigor   + rb * nv.node.selfReflection.vigor),
        dread:   clamp01(feelings.dread   + rb * nv.node.selfReflection.dread),
        kinship: clamp01(feelings.kinship + rb * nv.node.selfReflection.kinship),
        hunger:  clamp01(feelings.hunger  + rb * nv.node.selfReflection.hunger),
      };
    }

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
    digestor.record(nv.node.species, ACTIONS.indexOf(action), feelings);

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
      if (refl.enabled && nv.node.selfReflection) {
        nv.node.selfReflection = {
          vigor: refl.decay * nv.node.selfReflection.vigor,
          dread: refl.decay * nv.node.selfReflection.dread,
          kinship: refl.decay * nv.node.selfReflection.kinship,
          hunger: refl.decay * nv.node.selfReflection.hunger,
        };
      }
      continue;
    }

    const intensity = nv.node.h;
    const baseCost = (M.energy.baseCost[action]) ?? 0.1;
    nv.node.h = Math.max(0, nv.node.h - intensity * baseCost);

    const signalReach = action === "signal"
      ? M.social.neighborLimit + Math.floor(intensity * (M.social.signalExtraReach ?? 0))
      : undefined;
    const match = selectTarget(nv, allNodes, toDelete, M, signalReach, action);
    if (!match) {
      // No available target — fallback to survive (recover energy spent)
      nv.node.h = Math.min(1, nv.node.h + intensity * baseCost); // refund energy
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
      vigor:   signal.feelings.vigor * tone,
      hunger:  signal.feelings.hunger * tone,
      dread:   signal.feelings.dread * tone,
      kinship: signal.feelings.kinship * tone,
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
      nv.node.selfReflection = computeReflection(
        feelings, targetFeelings,
        initiatorConfig.receptivity ?? 0,
        nv.node.selfReflection, refl.decay,
      );
    }

    if (!result.initiatorAlive) {
      toDelete.add(nv.node.id);
      if (action === "merge") mergeEvents.push({ absorbed: nv.node.id, absorber: match.target.node.id, cosine: match.similarity });
    }
    if (!result.targetAlive) {
      toDelete.add(match.target.node.id);
      if (action === "merge") mergeEvents.push({ absorbed: match.target.node.id, absorber: nv.node.id, cosine: match.similarity });
    }
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
    if (!best || !isCompatiblePartner(bestScore)) continue;
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

  return { survivors, expired: toDelete.size, actionCounts, interactionCount, spawnCount, mergeEvents, spawnConsumed };
}

// ================================================================
// Seed from source
// ================================================================
let sourceCache = null;
async function getSourceVectors() {
  if (sourceCache) return sourceCache;
  const filter = IS_ENGRAM_MODE && ENGRAM_PROJECT !== "all"
    ? { must: [{ key: "projectId", match: { value: ENGRAM_PROJECT } }] }
    : undefined;
  sourceCache = await scrollAll(QDRANT_URL, SOURCE_COLLECTION, true, filter);
  console.log(`Source: ${SOURCE_COLLECTION} (${sourceCache.length} nodes)`);
  return sourceCache;
}

async function seedNodes(M, digestor) {
  await ensureCollection(QDRANT_URL, COLLECTION, 384);
  const existing = await scrollAll(QDRANT_URL, COLLECTION, false);
  if (existing.length > 0) await deletePoints(QDRANT_URL, COLLECTION, existing.map(p => p.id));

  const sourcePoints = await getSourceVectors();
  if (sourcePoints.length === 0) return { nodes: [], sourceIdMap: new Map(), nodeInfoMap: new Map() };

  const sourceIdMap = new Map();  // mycelium node ID → source point ID
  const nodeInfoMap = new Map();
  const speciesCounts = {};
  const nodesToUpsert = [];
  for (let i = 0; i < sourcePoints.length; i++) {
    const ep = sourcePoints[i];
    const p = ep.payload || {};
    const summary = (p.contents && p.contents[0]) || p.summary || "source node";
    const trigger = p.trigger || "manual";
    const tags = p.tags || [];
    const sp = IS_ENGRAM_MODE ? resolveSpecies(trigger, tags) : "spore";
    speciesCounts[sp] = (speciesCounts[sp] || 0) + 1;
    const inherited = digestor.getMemory(sp);
    const inheritedRes = digestor.getResonanceDelta(sp);
    const nutrition = IS_ENGRAM_MODE ? computeNutrition(p, sp, M) : undefined;

    const { node } = createNode(String(summary), undefined, trigger, inherited, inheritedRes, nutrition, tags);

    sourceIdMap.set(node.id, String(ep.id));
    nodeInfoMap.set(node.id, { species: sp, summary: String(summary).slice(0, 80), sourceId: String(ep.id) });
    nodesToUpsert.push({ id: node.id, vector: ep.vector, payload: nodeToPayload(node) });
  }
  await upsertPoints(QDRANT_URL, COLLECTION, nodesToUpsert);

  const pts = await scrollAll(QDRANT_URL, COLLECTION, true);
  return {
    nodes: pts.map(p => ({ node: payloadToNode(p.id, p.payload), vector: p.vector || null })),
    sourceIdMap,
    nodeInfoMap,
    speciesCounts,
  };
}

// ================================================================
// Single run
// ================================================================
async function runOnce(runIdx) {
  const M = loadBase();
  const digestor = createDigestor();
  const seedResult = await seedNodes(M, digestor);
  let allNodes = seedResult.nodes;
  const sourceIdMap = seedResult.sourceIdMap;
  const nodeInfoMap = seedResult.nodeInfoMap;
  const initialPop = allNodes.length;
  if (runIdx === 0) {
    console.log(`  Species distribution (trigger+tags): ${JSON.stringify(seedResult.speciesCounts)}`);
  }

  const deathLog = new Map();
  const clusterTick = Math.floor(TICKS * (M.pushback?.clusterPct ?? 0.6));
  let clusterSnapshot = null; // captured at ~60% ticks for merger cluster detection

  for (let t = 1; t <= TICKS; t++) {
    const preTickRes = new Map();
    for (const nv of allNodes) {
      const posRes = ALL_SPECIES.reduce((s, sp) => s + Math.max(0, nv.node.resonance[sp]), 0);
      preTickRes.set(nv.node.id, posRes);
    }
    const prevIds = new Set(allNodes.map(nv => nv.node.id));

    const result = runTickLocal(allNodes, M, digestor);
    allNodes = result.survivors;

    // Record deaths
    const nowIds = new Set(allNodes.map(nv => nv.node.id));
    for (const id of prevIds) {
      if (!nowIds.has(id) && !deathLog.has(id)) {
        const mergeEvt = result.mergeEvents.find(e => e.absorbed === id);
        const isSpawn = result.spawnConsumed.has(id);
        const cause = mergeEvt ? "merge" : isSpawn ? "spawn" : "decay";
        deathLog.set(id, {
          tick: t, cause,
          cosine: mergeEvt ? mergeEvt.cosine : undefined,
          posRes: preTickRes.get(id) ?? 0,
        });
      }
    }

    // Capture snapshot at 60% ticks for merger cluster detection
    if (t === clusterTick && allNodes.length > 0) {
      clusterSnapshot = allNodes.map(nv => ({
        ...nv.node,
        contents: [...nv.node.contents],
        resonance: { ...nv.node.resonance },
      }));
    }

    // Digestor
    if (t % DIGEST_INTERVAL === 0 && allNodes.length > 0) {
      digestor.digest(allNodes.map(nv => nv.node));
    }

    if (allNodes.length === 0) break;
  }

  // Debug: merge death cosine distribution
  const mergeCosines = [];
  const earlyMergeCosines = [];
  const tickCutoff = Math.floor(TICKS * (M_REF.pushback.earlyPct ?? 0.4));
  for (const [, d] of deathLog) {
    if (d.cause === "merge" && d.cosine != null) {
      mergeCosines.push({ tick: d.tick, cos: d.cosine });
      if (d.tick <= tickCutoff) earlyMergeCosines.push(d.cosine);
    }
  }
  if (runIdx === 0) {
    const proxCos = M_REF.merge.proximityThreshold;
    const clusterMaxCos = M_REF.pushback.clusterMaxCos ?? proxCos;
    const aboveProx = mergeCosines.filter(m => m.cos >= proxCos);
    const aboveCluster = mergeCosines.filter(m => m.cos >= clusterMaxCos);
    const earlyAboveCluster = earlyMergeCosines.filter(c => c >= clusterMaxCos);
    console.log(`  [debug] merge deaths: ${mergeCosines.length}, cos>=${proxCos}: ${aboveProx.length}, cos>=${clusterMaxCos}: ${aboveCluster.length}, early(<=t${tickCutoff}) cos>=${clusterMaxCos}: ${earlyAboveCluster.length}`);
    if (aboveProx.length > 0) console.log(`  [debug] cos>=${proxCos} ticks: ${aboveProx.map(m => 't'+m.tick+'='+m.cos.toFixed(3)).join(', ')}`);
    if (aboveCluster.length > 0 && aboveCluster.length <= 20) console.log(`  [debug] cos>=${clusterMaxCos} ticks: ${aboveCluster.map(m => 't'+m.tick+'='+m.cos.toFixed(3)).join(', ')}`);
  }

  // Pushback analysis (universal: no engramIdMap, returns node IDs directly)
  const redundantNodeIds = extractRedundantIds(deathLog, TICKS);
  const lonerNodeIds = extractLonerIds(deathLog, TICKS);
  // Map back to source IDs for consensus voting
  const redundantIds = redundantNodeIds.map(id => sourceIdMap.get(id) || id).filter(Boolean);
  const lonerIds = lonerNodeIds.map(id => sourceIdMap.get(id) || id).filter(Boolean);
  const pureSurvivors = allNodes.length > 0 ? extractPureSurvivors(allNodes.map(nv => nv.node)) : [];
  // Merger clusters from 60% tick snapshot (nodes still have meaningful w at this point)
  const mergerClusters = clusterSnapshot ? extractMergerClusters(clusterSnapshot) : [];

  // Species breakdown
  const spPop = {};
  for (const nv of allNodes) spPop[nv.node.species] = (spPop[nv.node.species] || 0) + 1;
  const deaths = summarizeDeaths(deathLog);

  // Social hits per surviving node (for display)
  const avgHits = allNodes.length > 0
    ? allNodes.reduce((s, nv) => s + ALL_SPECIES.reduce((r, sp) => r + Math.max(0, nv.node.resonance[sp]), 0), 0) / allNodes.length
    : 0;

  console.log(`  Run ${runIdx + 1}/${RUNS}: alive=${allNodes.length}/${initialPop} pure=${pureSurvivors.length} merger=${mergerClusters.length} loner=${lonerIds.length} redundant=${redundantIds.length} deaths=${deaths.total}(m${deaths.merge}/d${deaths.decay}/s${deaths.spawn}) species=${JSON.stringify(spPop)} avgPosRes=${avgHits.toFixed(2)}`);

  // Cleanup
  const pts = await scrollAll(QDRANT_URL, COLLECTION, false);
  if (pts.length > 0) await deletePoints(QDRANT_URL, COLLECTION, pts.map(p => p.id));

  // Map pure/merger to source IDs for consensus
  const pureSourceIds = pureSurvivors.map(p => sourceIdMap.get(p.nodeId) || p.nodeId);
  const mergerSourceIds = mergerClusters.map(c => sourceIdMap.get(c.originId) || c.originId);

  return {
    alive: allNodes.length,
    initialPop,
    pureSurvivors,
    mergerClusters,
    redundantIds,
    lonerIds,
    pureSourceIds,
    mergerSourceIds,
    deaths,
    spPop,
    nodeInfoMap,
    sourceIdMap,
  };
}

// ================================================================
// Main
// ================================================================
(async () => {
  console.log("╔══════════════════════════════════════════════╗");
  console.log("║  SEMANTIC FILTER TEST (Pushback 3-axis)     ║");
  console.log(`║  Runs: ${RUNS}  Ticks: ${TICKS}  Majority: ${MAJORITY}/${RUNS}`.padEnd(46) + " ║");
  console.log(`║  Source: ${SOURCE_COLLECTION} @ ${QDRANT_URL}`.padEnd(46) + " ║");
  console.log(`║  proxCos: ${M_REF.merge.proximityThreshold}  clusterCos: [${M_REF.pushback.clusterMinCos},${M_REF.pushback.clusterMaxCos})`.padEnd(46) + " ║");
  console.log(`║  DRY_RUN: ${DRY_RUN}  Mode: ${IS_ENGRAM_MODE ? "engram" : "source"}`.padEnd(46) + " ║");
  console.log(`║  Snapshot: ${SNAPSHOT_FILE ? require("path").basename(SNAPSHOT_FILE) : "none (plain)"}`.padEnd(46) + " ║");
  console.log("╚══════════════════════════════════════════════╝");
  console.log();

  const sourcePoints = await getSourceVectors();
  console.log(`Source vectors: ${sourcePoints.length}`);
  if (sourcePoints.length === 0) {
    console.log("No source nodes found. Exiting.");
    return;
  }
  console.log();

  // Run N simulations
  const results = [];
  for (let i = 0; i < RUNS; i++) {
    results.push(await runOnce(i));
  }

  // ---- Cross-run consensus voting ----
  const voteRedundant = crossVote(results.map(r => r.redundantIds), MAJORITY);
  const voteLoner = crossVote(results.map(r => r.lonerIds), MAJORITY);
  const votePure = crossVote(results.map(r => r.pureSourceIds), MAJORITY);
  const voteMerger = crossVote(results.map(r => r.mergerSourceIds), MAJORITY);

  const pad = (s, n) => String(s).padStart(n);

  console.log("\n" + "=".repeat(60));
  console.log(`=== CONSENSUS (majority >= ${MAJORITY}/${RUNS} = ${Math.round(MAJORITY / RUNS * 100)}%) ===`);
  console.log("=".repeat(60));

  // Build source lookup for enrichment
  const sourceLookup = new Map();
  for (const ep of sourcePoints) {
    const p = ep.payload || {};
    sourceLookup.set(String(ep.id), {
      summary: p.summary || (p.contents && p.contents[0]) || "",
      tags: p.tags || [],
      status: p.status || "",
    });
  }

  // Summary table
  console.log("\n  Filter     | Confirmed | Borderline | Total unique");
  console.log("  -----------|-----------|------------|-------------");
  for (const [name, vote] of [["redundant", voteRedundant], ["loner", voteLoner], ["pure", votePure], ["merger", voteMerger]]) {
    console.log("  " + name.padEnd(11) + "| " + pad(vote.confirmed.length, 9) + " | " + pad(vote.borderline.length, 10) + " | " + pad(vote.total, 12));
  }

  // Pure survivors detail
  if (votePure.confirmed.length > 0) {
    console.log("\n  === PURE SURVIVORS (unique knowledge, promotion candidates) ===");
    for (const c of votePure.confirmed) {
      const meta = sourceLookup.get(c.id) || {};
      console.log(`    ${c.count}/${RUNS} | ${c.id.substring(0, 12)}... | ${(meta.summary || "").slice(0, 60)} [${(meta.tags || []).join(",")}]`);
    }
  }

  // Loner detail
  if (voteLoner.confirmed.length > 0) {
    console.log("\n  === LONERS (isolated garbage, redundant flag candidates) ===");
    for (const c of voteLoner.confirmed) {
      const meta = sourceLookup.get(c.id) || {};
      console.log(`    ${c.count}/${RUNS} | ${c.id.substring(0, 12)}... | ${(meta.summary || "").slice(0, 60)} [${(meta.tags || []).join(",")}]`);
    }
  }

  // Merger clusters detail
  if (voteMerger.confirmed.length > 0) {
    console.log("\n  === MERGER CLUSTERS (knowledge consolidation candidates) ===");
    for (const c of voteMerger.confirmed) {
      const meta = sourceLookup.get(c.id) || {};
      console.log(`    ${c.count}/${RUNS} | ${c.id.substring(0, 12)}... | ${(meta.summary || "").slice(0, 60)} [${(meta.tags || []).join(",")}]`);
    }
  }

  // Redundant detail
  if (voteRedundant.confirmed.length > 0) {
    console.log("\n  === REDUNDANT (early high-cosine merge, near-duplicates) ===");
    for (const c of voteRedundant.confirmed.slice(0, 20)) {
      const meta = sourceLookup.get(c.id) || {};
      console.log(`    ${c.count}/${RUNS} | ${c.id.substring(0, 12)}... | ${(meta.summary || "").slice(0, 60)} [${(meta.tags || []).join(",")}]`);
    }
    if (voteRedundant.confirmed.length > 20) console.log(`    ... +${voteRedundant.confirmed.length - 20} more`);
  }

  // Per-run vote detail matrix
  console.log("\n  === VOTE DETAIL (per engram across runs) ===");
  const runLabels = Array.from({ length: RUNS }, (_, i) => "R" + (i + 1));
  console.log("  filter      | engramId     | " + runLabels.map(l => pad(l, 3)).join(" ") + " | total");
  console.log("  ------------|--------------|" + runLabels.map(() => "----").join("") + "|------");
  const voteEntries = [
    ["pure", votePure, r => r.pureSourceIds],
    ["loner", voteLoner, r => r.lonerIds],
    ["merger", voteMerger, r => r.mergerSourceIds],
    ["redundant", voteRedundant, r => r.redundantIds],
  ];
  for (const [name, vote, getIds] of voteEntries) {
    const allIds = [...vote.confirmed, ...vote.borderline].sort((a, b) => b.count - a.count);
    for (const item of allIds.slice(0, 10)) {
      const marks = results.map(r => getIds(r).includes(item.id) ? " +" : " .");
      const status = item.count >= MAJORITY ? "*" : " ";
      console.log("  " + status + name.padEnd(11) + "| " + item.id.substring(0, 12) + " | " + marks.join("") + " | " + item.count + "/" + RUNS);
    }
  }

  // ---- Flagging (only in engram mode) ----
  if (IS_ENGRAM_MODE && !DRY_RUN && voteLoner.confirmed.length > 0) {
    console.log("\n  === FLAGGING LONERS IN ENGRAM ===");
    const { flagInEngram } = require("../dist/core/pushback.js");
    const lonerSourceIds = voteLoner.confirmed.map(c => c.id);
    const result = await flagInEngram(lonerSourceIds, "loner", "mycelium: consensus loner (" + MAJORITY + "/" + RUNS + " runs)");
    console.log(`  Flagged: ${result.flagged}/${lonerSourceIds.length}  Errors: ${result.errors}`);
  } else if (!IS_ENGRAM_MODE) {
    console.log("\n  Non-engram mode — no flagging.");
  } else if (!DRY_RUN) {
    console.log("\n  No loners to flag.");
  } else {
    console.log("\n  DRY_RUN=true — no modification. Set DRY_RUN=false to flag loners.");
  }

  console.log("\nDone.");
})().catch(e => console.error(e));
