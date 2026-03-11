// Scenario tests v2: baseline + sensitivity analysis + stress patterns
// Nutrition (engram metrics → ±30% w/h/d bias) is ON by default. --no-nutrition to disable.
// Sensitivity: V- (BIAS×0.9) and V+ (BIAS×1.1) measure ecosystem response to initial condition perturbation.
//   Env: NUTRITION_V_LO=0.9 NUTRITION_V_HI=1.1 (defaults)
// --feedback: enable multi-round feedback loop (default 3 rounds, FEEDBACK_ROUNDS env to change)
//   After each round, survival rates feed back as ±30% w bias for the next round.
//   Diff report shows consensus convergence across rounds.
// 3 baseline + 2 sensitivity (V-/V+) + 5 stress:
//   E) Early Cull   — kill 40% early
//   F) Oscillation  — hCooling toggles 0.99↔0.95 every 10 ticks
//   G) Famine       — surviveHRecovery drops to near-zero at midpoint
//   H) Boom→Bust    — inject 40 at tick 20, then harsh env from tick 30
//   I) Gradient     — hCooling linearly decreases 0.99→0.90 over full run

const { ensureCollection, upsertPoints, scrollAll, deletePoints } = require("../dist/qdrant.js");
const { payloadToNode, nodeToPayload, computeFeelings, assessAction, assessActionWithProbs, updateFrustration, computeReflection, clamp01, zeroResonance, createNode, getSpeciesConfig } = require("../dist/core/node.js");
const { emitSignal, react, resolveInteraction } = require("../dist/core/receptor.js");
const { isSpawnEligible, isCompatiblePartner, executeSpawn } = require("../dist/core/spawn.js");
const { BEHAVIOR_KEYS, FEELINGS_DIM, FEELING_KEYS, ALL_SPECIES, ACTIONS, REACTIONS } = require("../dist/types.js");
const { computeResonanceSummary, computeDeathHistogram, summarizeDeaths, computePushbackSnapshot, crossVote } = require("../dist/core/observatory.js");

// ================================================================
// CONFIG — edit defaults here
// ================================================================
const QDRANT_URL       = process.env.QDRANT_URL        || "http://localhost:6333";
const ENGRAM_PROJECT   = process.env.ENGRAM_PROJECT     || "all";       // "all" = no filter
const TICKS            = parseInt(process.env.TICKS             || "60",  10);
const DIGEST_INTERVAL  = parseInt(process.env.DIGEST_INTERVAL   || "20",  10);
const BASELINE_RUNS    = parseInt(process.env.BASELINE_RUNS     || "5",   10);
const VOTE_PCT         = parseFloat(process.env.VOTE_PCT        || "0.4");
const FEEDBACK_ROUNDS  = parseInt(process.env.FEEDBACK_ROUNDS   || "3",   10);
const NUTRITION_V_LO   = parseFloat(process.env.NUTRITION_V_LO  || "0.9");
const NUTRITION_V_HI   = parseFloat(process.env.NUTRITION_V_HI  || "1.1");
const BIAS             = 0.3;            // nutrition ±30% bias
const FEEDBACK_ALPHA   = 0.3;            // max ±30% w bias from feedback
// ---- Flags ----
const NO_NUTRITION     = process.argv.includes("--no-nutrition");
const FEEDBACK_ON      = process.argv.includes("--feedback");
const REPORT           = process.argv.includes("--report");
const BASELINE_ONLY    = process.argv.includes("--baseline-only");
// ================================================================

function engramFilter() {
  if (ENGRAM_PROJECT === "all") return undefined;
  return { must: [{ key: "projectId", match: { value: ENGRAM_PROJECT } }] };
}

function deepCopy(obj) { return JSON.parse(JSON.stringify(obj)); }

function computeNutrition(engramPayload, species, M, nutritionScale) {
  const scale = nutritionScale ?? 1.0;
  const bias = BIAS * scale;  // 0.3 × scale (0.9=V-, 1.0=default, 1.1=V+)
  const baseW = M.birth.initialW;
  const baseH = M.birth.initialH;
  const baseD = getSpeciesConfig(species).initialDecay;

  const wBias = bias * Math.tanh((engramPayload.weight ?? 0) / 3);
  const hitRatio = Math.min((engramPayload.hitCount ?? 0) / 5, 1);
  const hBias = bias * hitRatio;
  const dBias = -bias * hitRatio;

  const fixed = engramPayload.status === "fixed";
  const fixedW = fixed ? 0.15 : 0;
  const fixedD = fixed ? -0.15 : 0;

  return {
    w: baseW * (1 + wBias + fixedW),
    h: baseH * (1 + hBias),
    d: baseD * (1 + dBias + fixedD),
  };
}

function loadBase() {
  delete require.cache[require.resolve("../dist/config/metabolism.json")];
  return deepCopy(require("../dist/config/metabolism.json"));
}

function applyOverrides(m, overrides) {
  for (const [path, val] of Object.entries(overrides)) {
    const keys = path.split(".");
    let obj = m;
    for (let i = 0; i < keys.length - 1; i++) obj = obj[keys[i]];
    obj[keys[keys.length - 1]] = val;
  }
  return m;
}

function cosine(a, b) { let d = 0; for (let i = 0; i < a.length; i++) d += a[i] * b[i]; return d; }
function zeroMatrix(rows, cols) { return Array.from({ length: rows }, () => new Array(cols).fill(0)); }

// Softmax top-K target selection (matches tick.ts selectTarget)
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
  const proxThreshold = M.merge?.proximityThreshold ?? 0.85;
  const targetMergeBias = getSpeciesConfig(selected.nv.node.species).mergeTargetBias ?? 1.0;
  const proximityMerge = action !== "merge" && selected.similarity >= proxThreshold && targetMergeBias > 0;
  return { target: selected.nv, similarity: selected.similarity, proximityMerge };
}

const LEARNING_RATE = 0.05;
const DELTA_CLAMP = 0.5;

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

const SNAPSHOT_FILE = resolveSnapshotPath();

function loadSnapshot() {
  if (!SNAPSHOT_FILE) return null;
  try {
    const raw = JSON.parse(require("fs").readFileSync(SNAPSHOT_FILE, "utf-8"));
    if (raw.delta) {
      const hasRes = !!raw.resonanceDelta;
      console.error(`[test] loaded delta${hasRes ? " + resonanceDelta" : ""} from ${require("path").basename(SNAPSHOT_FILE)}`);
      return { delta: raw.delta, resonanceDelta: raw.resonanceDelta || null };
    }
  } catch (e) {
    console.error(`[test] failed to load ${SNAPSHOT_FILE}: ${e.message}`);
  }
  return null;
}

function createDigestor() {
  const snapshot = loadSnapshot();
  if (!SNAPSHOT_FILE) console.error(`[test] plain mode. Use --snapshot [path|latest] to load delta`);
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
    digest(survivors, tickNumber) {
      gen++;
      const buckets = {};
      for (const n of survivors) { if (!buckets[n.species]) buckets[n.species] = []; buckets[n.species].push(n); }
      const stats = {};
      for (const sp of ALL_SPECIES) {
        const members = buckets[sp] || [];
        if (members.length === 0) { stats[sp] = { count: 0, drift: 0 }; continue; }
        const { getSpeciesConfig } = require("../dist/core/node.js");
        const avgFitness = members.reduce((s, n) => {
          const cfg = getSpeciesConfig(n.species);
          return s + (n.h + Math.min(1, n.w) + n.ttl / cfg.initialTtl) / 3;
        }, 0) / members.length;
        const lr = LEARNING_RATE * avgFitness;
        // Compute per-feeling mean across all actions (baseline for this species)
        const fMean = new Array(FEELINGS_DIM).fill(0);
        let totalAct = 0;
        for (let i = 0; i < BEHAVIOR_KEYS.length; i++) {
          if (counts[sp][i] === 0) continue;
          for (let j = 0; j < FEELINGS_DIM; j++) fMean[j] += sums[sp][i][j];
          totalAct += counts[sp][i];
        }
        if (totalAct > 0) for (let j = 0; j < FEELINGS_DIM; j++) fMean[j] /= totalAct;
        let maxAbs = 0;
        for (let i = 0; i < BEHAVIOR_KEYS.length; i++) {
          if (counts[sp][i] === 0) continue;
          for (let j = 0; j < FEELINGS_DIM; j++) {
            const avgFeeling = sums[sp][i][j] / counts[sp][i];
            const signal = avgFeeling - fMean[j];
            mem[sp][i][j] += lr * signal;
            mem[sp][i][j] = Math.max(-DELTA_CLAMP, Math.min(DELTA_CLAMP, mem[sp][i][j]));
            maxAbs = Math.max(maxAbs, Math.abs(mem[sp][i][j]));
          }
        }
        stats[sp] = { count: members.length, drift: maxAbs };
      }
      // Resonance sensitivity learning
      for (const sp of ALL_SPECIES) {
        const members = buckets[sp] || [];
        if (members.length === 0) continue;
        const { getSpeciesConfig: _gsc } = require("../dist/core/node.js");
        const resScale = _gsc(sp).resonanceReceiveScale ?? 1.0;
        const lr = LEARNING_RATE * (stats[sp].count > 0 ? 0.5 : 0) * resScale;
        for (const tsp of ALL_SPECIES) {
          let sum = 0;
          for (const n of members) sum += n.resonance[tsp];
          const signal = Math.tanh(sum / members.length);
          resDelta[sp][tsp] += lr * signal;
          resDelta[sp][tsp] = Math.max(-DELTA_CLAMP, Math.min(DELTA_CLAMP, resDelta[sp][tsp]));
        }
      }
      for (const sp of ALL_SPECIES) {
        sums[sp] = zeroMatrix(BEHAVIOR_KEYS.length, FEELINGS_DIM);
        counts[sp] = new Array(BEHAVIOR_KEYS.length).fill(0);
      }
      return { generation: gen, stats };
    },
    getSummary() {
      const out = {};
      for (const sp of ALL_SPECIES) {
        let maxAbs = 0;
        for (const row of mem[sp]) for (const v of row) maxAbs = Math.max(maxAbs, Math.abs(v));
        out[sp] = maxAbs;
      }
      return { generation: gen, drift: out };
    },
  };
}

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

function runTickLocal(allNodes, M, digestor) {
  const { getSpeciesConfig: _getSpeciesConfig } = require("../dist/core/node.js");
  const toDelete = new Set();
  const actionCounts = {};
  let interactionCount = 0;
  let spawnCount = 0;
  const mergeEvents = [];

  // Resonance decay (carry-over, not reset)
  const resonanceDecay = M.social.resonanceDecay || 0.8;
  for (const nv of allNodes) {
    for (const sp of ALL_SPECIES) nv.node.resonance[sp] *= resonanceDecay;
  }

  // Frustration config
  const frust = M.frustration ?? { enabled: false, decay: 0.7, accum: 0.1, blend: 0.15 };
  // Self-reflection config
  const refl = M.selfReflection ?? { enabled: false, blend: 0.1, decay: 0.8 };

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

    // Action selection (with probs for frustration update)
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

    // Signal reach scales with intensity (matches tick.ts)
    const signalReach = action === "signal"
      ? M.social.neighborLimit + Math.floor(intensity * (M.social.signalExtraReach ?? 0))
      : undefined;
    const match = selectTarget(nv, allNodes, toDelete, M, signalReach, action);
    if (!match) continue;

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
    digestor.record(match.target.node.species, ACTIONS.length + REACTIONS.indexOf(reaction), targetFeelings);
    const result = resolveInteraction(nv.node, match.target.node, signal, reaction, intensity, match.similarity);
    interactionCount++;

    // Self-reflection: initiator processes the reaction through its own receptor
    if (refl.enabled && result.initiatorAlive) {
      const initiatorConfig = _getSpeciesConfig(nv.node.species);
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

  return { survivors, expired: toDelete.size, actionCounts, interactionCount, spawnCount, mergeEvents, spawnConsumed };
}

// Cache engram vectors
let engramCache = null;
async function getEngramVectors() {
  if (engramCache) return engramCache;
  engramCache = await scrollAll(QDRANT_URL, "engram", true, engramFilter());
  if (ENGRAM_PROJECT !== "all") console.log(`Engram filter: projectId="${ENGRAM_PROJECT}" (${engramCache.length} nodes)`);
  return engramCache;
}

async function seedNodes(collection, M, digestor, feedbackMap, nutritionScale) {
  await ensureCollection(QDRANT_URL, collection, 384);
  const existing = await scrollAll(QDRANT_URL, collection, false);
  if (existing.length > 0) await deletePoints(QDRANT_URL, collection, existing.map(p => p.id));

  const engramPoints = await getEngramVectors();
  if (engramPoints.length === 0) return [];

  const species = ALL_SPECIES;
  const speciesConfig = require("../dist/config/species.json");

  const engramIdMap = new Map();
  const nodeInfoMap = new Map();
  const nodesToUpsert = [];
  for (let i = 0; i < engramPoints.length; i++) {
    const ep = engramPoints[i];
    const summary = (ep.payload.contents && ep.payload.contents[0]) || ep.payload.summary || "engram node";
    const sp = species[i % species.length];
    const inherited = digestor.getMemory(sp);
    const inheritedRes = digestor.getResonanceDelta(sp);

    // Nutrition: engram metrics → ±30% bias (default ON, --no-nutrition to disable)
    // nutritionScale scales BIAS (0.9=V-, 1.0=default, 1.1=V+)
    const nutrition = NO_NUTRITION ? undefined : computeNutrition(ep.payload, sp, M, nutritionScale);

    const { node } = createNode(String(summary), undefined, "manual", inherited, inheritedRes, nutrition);
    node.species = sp;
    node.personality = speciesConfig[sp].personality;
    if (!nutrition || nutrition.d == null) node.d = speciesConfig[sp].initialDecay;
    node.ttl = speciesConfig[sp].initialTtl;
    if (!nutrition || nutrition.h == null) node.h = M.birth.initialH;
    if (!nutrition || nutrition.w == null) node.w = M.birth.initialW;

    // Feedback: previous round survival rate → ±30% w bias (capped via tanh)
    if (feedbackMap) {
      const eid = String(ep.id);
      const survivalRate = feedbackMap.get(eid); // 0..1 or undefined
      if (survivalRate !== undefined) {
        // survivalRate 0.5 = neutral, >0.5 = survived often → boost, <0.5 = died often → penalize
        // Map [0,1] → [-1,1], then tanh-scale to ±FEEDBACK_ALPHA
        const signal = (survivalRate - 0.5) * 2; // [-1, 1]
        const wBias = FEEDBACK_ALPHA * Math.tanh(signal);
        node.w *= (1 + wBias);
      }
    }
    node.engramId = String(ep.id);
    engramIdMap.set(node.id, String(ep.id));
    nodeInfoMap.set(node.id, { species: sp, summary: String(summary).slice(0, 80), engramId: String(ep.id) });
    nodesToUpsert.push({ id: node.id, vector: ep.vector, payload: nodeToPayload(node) });
  }
  await upsertPoints(QDRANT_URL, collection, nodesToUpsert);

  const pts = await scrollAll(QDRANT_URL, collection, true);
  return { nodes: pts.map(p => ({ node: payloadToNode(p.id, p.payload), vector: p.vector || null })), engramIdMap, nodeInfoMap };
}

function injectNodes(allNodes, count, M, digestor) {
  const engramPoints = engramCache || [];
  if (engramPoints.length === 0) return allNodes;

  const species = ALL_SPECIES;
  const speciesConfig = require("../dist/config/species.json");
  const injected = [];

  for (let i = 0; i < count; i++) {
    const ep = engramPoints[Math.floor(Math.random() * engramPoints.length)];
    const summary = (ep.payload.contents && ep.payload.contents[0]) || ep.payload.summary || "injected";
    const sp = species[i % species.length];
    const inherited = digestor.getMemory(sp);
    const inheritedRes = digestor.getResonanceDelta(sp);
    const { node } = createNode(String(summary), undefined, "manual", inherited, inheritedRes);
    node.species = sp;
    node.personality = speciesConfig[sp].personality;
    node.d = speciesConfig[sp].initialDecay;
    node.ttl = speciesConfig[sp].initialTtl;
    node.h = M.birth.initialH;
    node.w = M.birth.initialW;
    injected.push({ node, vector: ep.vector });
  }
  return [...allNodes, ...injected];
}

// Cull: randomly kill a percentage of the population
function cullNodes(allNodes, killRatio) {
  const shuffled = [...allNodes].sort(() => Math.random() - 0.5);
  const killCount = Math.floor(shuffled.length * killRatio);
  return shuffled.slice(killCount);
}

async function runScenario(label, collection, scenario, totalTicks, digestInterval, feedbackMap, nutritionScale) {
  const { phases, injectAt, cullAt, cullRatio, gradientFn } = scenario;

  const digestor = createDigestor();
  let phaseIdx = 0;
  let M = applyOverrides(loadBase(), phases[0].overrides);

  console.log("[" + label + "]");
  for (let pi = 0; pi < phases.length; pi++) {
    const p = phases[pi];
    const desc = Object.entries(p.overrides).map(([k, v]) => k.split(".").pop() + "=" + v).join(" ") || "baseline";
    console.log("  phase " + (pi + 1) + " (tick 1-" + p.until + "): " + desc);
  }
  if (injectAt) console.log("  inject at tick " + injectAt);
  if (cullAt) console.log("  cull " + Math.round((cullRatio || 0.7) * 100) + "% at tick " + cullAt);
  if (gradientFn) console.log("  gradient: continuous env change each tick");

  const seedResult = await seedNodes(collection, M, digestor, feedbackMap, nutritionScale);
  let allNodes = seedResult.nodes;
  const engramIdMap = seedResult.engramIdMap;
  const nodeInfoMap = seedResult.nodeInfoMap;
  const initialPop = allNodes.length;
  console.log("  seeded: " + initialPop + " nodes\n");

  const { extractRedundantIds, extractLonerIds, extractPureSurvivors, extractMergerClusters } = require("../dist/core/pushback.js");
  const timeline = [];
  const deathLog = new Map();

  console.log("  tick | pop | spn | avgH  | avgW  | surv | social | event");
  console.log("  -----|-----|-----|-------|-------|------|--------|------");

  for (let t = 1; t <= totalTicks; t++) {
    let event = "";

    // Phase transition
    if (phaseIdx < phases.length - 1 && t > phases[phaseIdx].until) {
      phaseIdx++;
      M = applyOverrides(loadBase(), phases[phaseIdx].overrides);
      const desc = Object.entries(phases[phaseIdx].overrides).map(([k, v]) => k.split(".").pop() + "=" + v).join(" ");
      event = ">>> SHIFT: " + desc;
    }

    // Gradient: apply continuous override per tick
    if (gradientFn) {
      const overrides = gradientFn(t, totalTicks);
      M = applyOverrides(loadBase(), overrides);
    }

    // Cull
    if (cullAt && t === cullAt && allNodes.length > 1) {
      const before = allNodes.length;
      allNodes = cullNodes(allNodes, cullRatio || 0.7);
      event += (event ? " + " : "") + ">>> CULL " + Math.round((cullRatio || 0.7) * 100) + "% (" + before + "->" + allNodes.length + ")";
    }

    // Node injection
    if (injectAt && t === injectAt && allNodes.length > 0) {
      const injectCount = typeof scenario.injectCount === "number" ? scenario.injectCount : Math.max(1, Math.floor(allNodes.length * 0.5));
      const before = allNodes.length;
      allNodes = injectNodes(allNodes, injectCount, M, digestor);
      event += (event ? " + " : "") + ">>> INJECT +" + injectCount + " (" + before + "->" + allNodes.length + ")";
    }

    // Snapshot posRes before tick
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

    // Digestor
    if (t % digestInterval === 0 && allNodes.length > 0) {
      const dr = digestor.digest(allNodes.map(nv => nv.node));
      const parts = Object.entries(dr.stats).filter(([, s]) => s.count > 0).map(([sp, s]) => sp[0] + ":" + s.count);
      event += (event ? " | " : "") + "gen#" + dr.generation + " [" + parts.join(",") + "]";
    }

    const avgH = allNodes.length > 0 ? allNodes.reduce((s, nv) => s + nv.node.h, 0) / allNodes.length : 0;
    const avgW = allNodes.length > 0 ? allNodes.reduce((s, nv) => s + nv.node.w, 0) / allNodes.length : 0;
    const surv = result.actionCounts.survive || 0;
    const social = (result.actionCounts.signal || 0) + (result.actionCounts.merge || 0) + (result.actionCounts.bequeath || 0);
    const spPop = {};
    for (const nv of allNodes) spPop[nv.node.species] = (spPop[nv.node.species] || 0) + 1;

    timeline.push({ tick: t, pop: allNodes.length, avgH, avgW, surv, social, spPop, spawnCount: result.spawnCount, event });

    const shouldPrint = t <= 5 || t % 10 === 0 || t % digestInterval === 0 || event || allNodes.length <= 3 || t === totalTicks || result.spawnCount > 0;
    if (shouldPrint) {
      console.log("  " +
        String(t).padStart(4) + " | " +
        String(allNodes.length).padStart(3) + " | " +
        String(result.spawnCount).padStart(3) + " | " +
        avgH.toFixed(3) + " | " +
        avgW.toFixed(3) + " | " +
        String(surv).padStart(4) + " | " +
        String(social).padStart(6) + " | " +
        event
      );
    }
    // Periodic pushback snapshot every 20 ticks
    if (t % 20 === 0 && allNodes.length > 0) {
      const snap = computePushbackSnapshot(engramIdMap, deathLog, totalTicks, allNodes.map(nv => nv.node));
      const avgW = allNodes.reduce((s, nv) => s + nv.node.w, 0) / allNodes.length;
      const avgPosRes = allNodes.reduce((s, nv) => s + ALL_SPECIES.reduce((r, sp) => r + Math.max(0, nv.node.resonance[sp]), 0), 0) / allNodes.length;
      console.log("    [snap@" + t + "] pop=" + allNodes.length + " avgW=" + avgW.toFixed(3) + " avgPosRes=" + avgPosRes.toFixed(3) +
        " | red=" + snap.redundant + " lon=" + snap.loner + " pure=" + snap.pure + " mrg=" + snap.merger +
        " | deaths=" + snap.deaths.total + "(" + snap.deaths.merge + "/" + snap.deaths.decay + "/" + snap.deaths.spawn + ")");
    }

    if (allNodes.length === 0) { console.log("  EXTINCT at tick " + t); break; }
  }

  if (allNodes.length > 0) {
    const sp = {};
    for (const nv of allNodes) sp[nv.node.species] = (sp[nv.node.species] || 0) + 1;
    console.log("  Final: " + allNodes.length + " alive " + JSON.stringify(sp));

    // Resonance summary per species
    const resSummary = computeResonanceSummary(allNodes);
    console.log("  Resonance:");
    console.log("    " + "species".padEnd(12) + "n".padStart(3) + "  avgPosRes".padStart(10) + "  avgCentr".padStart(10));
    for (const d of resSummary) {
      console.log("    " + d.species.padEnd(12) + String(d.count).padStart(3) + "  " + d.avgPosRes.toFixed(3).padStart(9) + "  " + d.avgCentrality.toFixed(4).padStart(9));
    }
    const allNodeRes = resSummary.flatMap(d => d.nodes);
    if (allNodeRes.length > 3) {
      console.log("    Top posRes: " + allNodeRes.slice(0, 5).map(n =>
        n.id + "(" + n.posRes.toFixed(2) + ",c=" + n.centrality.toFixed(3) + ")"
      ).join("  "));
    }
  }

  const ds = digestor.getSummary();

  // Pushback analysis (final)
  const pushbackDeathLog = new Map();
  for (const [mid, d] of deathLog.entries()) {
    pushbackDeathLog.set(mid, { tick: d.tick, cause: d.cause, cosine: d.cosine, posRes: d.posRes });
  }
  const redundantIds = extractRedundantIds(engramIdMap, pushbackDeathLog, totalTicks);
  const lonerIds = extractLonerIds(engramIdMap, pushbackDeathLog, totalTicks);
  const pureSurvivors = allNodes.length > 0 ? extractPureSurvivors(allNodes.map(nv => nv.node)) : [];
  const mergerClusters = allNodes.length > 0 ? extractMergerClusters(allNodes.map(nv => nv.node)) : [];

  const deaths = summarizeDeaths(deathLog);

  console.log("  Pushback: redundant=" + redundantIds.length + " loner=" + lonerIds.length +
    " pure=" + pureSurvivors.length + " merger=" + mergerClusters.length);
  console.log("  Deaths: total=" + deaths.total + " (merge=" + deaths.merge + " decay=" + deaths.decay + " spawn=" + deaths.spawn + ")");

  // Death timing distribution
  const histo = computeDeathHistogram(deathLog, totalTicks);
  const bar = (n, max) => { const len = max > 0 ? Math.round(n / max * 20) : 0; return "█".repeat(len) + "░".repeat(20 - len); };
  console.log("  Death timing (per " + histo.bucketSize + " ticks):");
  console.log("    tick  | merge                | spawn                | decay");
  for (const b of histo.buckets) {
    const label = String(b.tickStart).padStart(3) + "-" + String(b.tickEnd).padStart(3);
    console.log("    " + label + " | " + bar(b.merge, histo.maxPerBucket) + " " + String(b.merge).padStart(2) +
      " | " + bar(b.spawn, histo.maxPerBucket) + " " + String(b.spawn).padStart(2) +
      " | " + bar(b.decay, histo.maxPerBucket) + " " + String(b.decay).padStart(2));
  }

  // Return actual engramId lists for cross-scenario voting
  const pureEngramIds = pureSurvivors.map(p => p.engramId);
  const mergerEngramIds = mergerClusters.map(c => c.originEngramId);

  const pushback = {
    redundant: redundantIds.length, loner: lonerIds.length, pure: pureSurvivors.length, merger: mergerClusters.length,
    totalDeaths: deaths.total, decayDeaths: deaths.decay, mergeDeaths: deaths.merge, spawnDeaths: deaths.spawn,
    redundantIds, lonerIds, pureEngramIds, mergerEngramIds,
  };

  const pts = await scrollAll(QDRANT_URL, collection, false);
  if (pts.length > 0) await deletePoints(QDRANT_URL, collection, pts.map(p => p.id));

  return { label, timeline, digestSummary: ds, pushback };
}

(async () => {
  const DIGEST = DIGEST_INTERVAL;
  const MID = Math.floor(TICKS / 2);

  // Baseline x 3 + sensitivity V-/V+ (nutrition scale 0.9/1.1)
  const scenarios = [];
  const BASELINE_ACTUAL = Math.max(1, BASELINE_RUNS - 2); // reserve 2 slots for V-/V+
  for (let i = 0; i < BASELINE_ACTUAL; i++) {
    scenarios.push({
      label: "B" + (i + 1) + ") Baseline",
      col: "mycelium_v2_b" + (i + 1),
      scenario: {
        phases: [{ until: TICKS, overrides: {} }],
        injectAt: null,
      },
    });
  }
  // Sensitivity analysis: same config, different nutrition scale
  scenarios.push({
    label: "V-) Nutr " + NUTRITION_V_LO,
    col: "mycelium_v2_vlo",
    scenario: {
      phases: [{ until: TICKS, overrides: {} }],
      injectAt: null,
    },
    nutritionScale: NUTRITION_V_LO,
  });
  scenarios.push({
    label: "V+) Nutr " + NUTRITION_V_HI,
    col: "mycelium_v2_vhi",
    scenario: {
      phases: [{ until: TICKS, overrides: {} }],
      injectAt: null,
    },
    nutritionScale: NUTRITION_V_HI,
  });

  // Stress scenarios — designed to test filtering robustness without destroying ecosystem
  const EARLY = Math.floor(TICKS * 0.2);   // 20% into sim (tick 10 for 50-tick, 20 for 100-tick)
  const MID30 = Math.floor(TICKS * 0.3);   // 30% point
  scenarios.push(
    {
      label: "E) Early Cull",
      col: "mycelium_v2_e",
      scenario: {
        phases: [{ until: TICKS, overrides: {} }],
        injectAt: null,
        cullAt: EARLY,
        cullRatio: 0.4,
      },
    },
    {
      label: "F) Oscillation",
      col: "mycelium_v2_f",
      scenario: {
        phases: [{ until: TICKS, overrides: {} }],
        injectAt: null,
        gradientFn: (t) => {
          const cycle = Math.floor((t - 1) / 10) % 2;
          return { "pressure.hCooling": cycle === 0 ? 0.99 : 0.95 };
        },
      },
    },
    {
      label: "G) Famine",
      col: "mycelium_v2_g",
      scenario: {
        phases: [
          { until: MID30, overrides: {} },
          { until: TICKS, overrides: { "relief.surviveHRecovery": 0.025, "relief.surviveWRecovery": 0, "relief.surviveTtlRecovery": 1 } },
        ],
        injectAt: null,
      },
    },
    {
      label: "H) Boom->Bust",
      col: "mycelium_v2_h",
      scenario: {
        phases: [
          { until: MID30, overrides: { "pressure.hCooling": 0.99 } },
          { until: TICKS, overrides: { "pressure.hCooling": 0.93 } },
        ],
        injectAt: EARLY,
        injectCount: 40,
      },
    },
    {
      label: "I) Gradient",
      col: "mycelium_v2_i",
      scenario: {
        phases: [{ until: TICKS, overrides: {} }],
        injectAt: null,
        gradientFn: (t, total) => {
          const ratio = t / total;
          return { "pressure.hCooling": 0.99 - 0.09 * ratio };
        },
      },
    },
  );

  const SENSITIVITY_COUNT = 2; // V- and V+
  if (BASELINE_ONLY) {
    scenarios.length = BASELINE_ACTUAL + SENSITIVITY_COUNT; // keep baseline + V-/V+, trim stress
  }

  const stressCount = scenarios.length - BASELINE_ACTUAL - SENSITIVITY_COUNT;
  console.log("=== SCENARIO TEST v2 ===");
  console.log("Baseline runs: " + BASELINE_ACTUAL + "  Sensitivity: V-=" + NUTRITION_V_LO + " V+=" + NUTRITION_V_HI + "  Stress scenarios: " + stressCount);
  console.log("Total ticks: " + TICKS + "  Digest interval: " + DIGEST);
  console.log("Nutrition: " + (NO_NUTRITION ? "OFF (--no-nutrition)" : "ON (engram metrics → BIAS=" + BIAS + ")"));
  console.log("Feedback: " + (FEEDBACK_ON ? "ON (" + FEEDBACK_ROUNDS + " rounds, α=" + FEEDBACK_ALPHA + ")" : "OFF (--feedback to enable)"));
  console.log("Report: " + (REPORT ? "ON (save results to reports/)" : "OFF (--report to enable)"));
  if (stressCount > 0) {
    console.log("E) Early Cull: kill 40% at tick " + EARLY);
    console.log("F) Oscillation: hCooling 0.99<->0.95 every 10 ticks");
    console.log("G) Famine: survive halved from tick " + MID30);
    console.log("H) Boom->Bust: inject 40 at tick " + EARLY + ", cool from tick " + MID30);
    console.log("I) Gradient: hCooling 0.99->0.90 linear");
  }
  console.log();

  // ---- Run one round of all scenarios, return results + voting ----
  async function runRound(roundNum, feedbackMap) {
    const roundLabel = FEEDBACK_ON ? ` [round ${roundNum}/${FEEDBACK_ROUNDS}]` : "";
    if (roundLabel) console.log("\n" + "=".repeat(60) + "\n=== ROUND " + roundNum + "/" + FEEDBACK_ROUNDS +
      (feedbackMap ? " (feedback: " + feedbackMap.size + " nodes biased)" : " (no feedback)") + " ===\n" + "=".repeat(60));

    const results = [];
    for (const s of scenarios) {
      results.push(await runScenario(s.label + roundLabel, s.col, s.scenario, TICKS, DIGEST, feedbackMap, s.nutritionScale));
    }
    return results;
  }

  // ---- Build feedback map from results: engramId → survival rate [0,1] ----
  function buildFeedbackMap(results) {
    // For each engramId, count: how many scenarios it appeared as pure survivor vs total scenarios
    // pure = survived and thrived, loner = survived but isolated (penalize mildly)
    // redundant = absorbed (neutral-to-negative), not in any list = died early (strong negative)
    const engramPoints = engramCache || [];
    const allEngramIds = engramPoints.map(ep => String(ep.id));
    const totalScenarios = results.length;

    const survivalCounts = new Map(); // engramId → number of scenarios where it appeared as pure or merger
    for (const eid of allEngramIds) survivalCounts.set(eid, 0);

    for (const r of results) {
      const survived = new Set([...r.pushback.pureEngramIds, ...r.pushback.mergerEngramIds]);
      for (const eid of survived) {
        survivalCounts.set(eid, (survivalCounts.get(eid) || 0) + 1);
      }
    }

    const feedbackMap = new Map();
    for (const [eid, count] of survivalCounts) {
      feedbackMap.set(eid, count / totalScenarios); // 0..1 survival rate
    }
    return feedbackMap;
  }

  // ---- Print round comparison (cross-scenario report) ----
  function printReport(results) {
    const pad = (s, n) => String(s).padStart(n);
    const labels = scenarios.map(s => s.label.split(")")[0] + ")").map(l => pad(l, 7));
    const speciesList = ALL_SPECIES;

    // Population
    const maxT = Math.max(...results.map(r => r.timeline.length));
    console.log("\n=== POPULATION COMPARISON ===");
    console.log("  tick | " + labels.join(" | "));
    console.log("  -----|" + labels.map(() => "--------").join("|"));
    for (let i = 0; i < maxT; i++) {
      const t = i + 1;
      if (t <= 5 || t === 20 || t === 21 || t === MID - 1 || t === MID || t === MID + 1 || t % 10 === 0 || t === maxT) {
        const vals = results.map(r => r.timeline[i] ? pad(r.timeline[i].pop, 7) : pad(0, 7));
        console.log("  " + pad(t, 4) + " | " + vals.join(" | "));
      }
    }

    // avgW
    console.log("\n=== AVG WEIGHT COMPARISON ===");
    console.log("  tick | " + labels.join(" | "));
    console.log("  -----|" + labels.map(() => "--------").join("|"));
    for (let i = 0; i < maxT; i++) {
      const t = i + 1;
      if (t <= 3 || t === 20 || t === MID || t % 10 === 0 || t === maxT) {
        const vals = results.map(r => r.timeline[i] ? pad(r.timeline[i].avgW.toFixed(3), 7) : pad("0.000", 7));
        console.log("  " + pad(t, 4) + " | " + vals.join(" | "));
      }
    }

    // Final species
    console.log("\n=== FINAL SPECIES ===");
    console.log("  scenario          | summ | sent | hera | spor | total");
    console.log("  ------------------|------|------|------|------|------");
    for (let i = 0; i < results.length; i++) {
      const tl = results[i].timeline;
      const last = tl[tl.length - 1];
      const sp = last ? last.spPop || {} : {};
      console.log("  " + scenarios[i].label.padEnd(18) + "| " +
        speciesList.map(s => pad(sp[s] || 0, 4)).join(" | ") + " | " + pad(last ? last.pop : 0, 5));
    }

    // Pushback comparison
    console.log("\n=== PUSHBACK FILTER COMPARISON ===");
    console.log("  scenario          | redund | loner | pure | merger | deaths(mrg/dec/spn)");
    console.log("  ------------------|--------|-------|------|--------|--------------------");
    for (let i = 0; i < results.length; i++) {
      const pb = results[i].pushback;
      console.log("  " + scenarios[i].label.padEnd(18) + "| " +
        pad(pb.redundant, 6) + " | " + pad(pb.loner, 5) + " | " + pad(pb.pure, 4) + " | " + pad(pb.merger, 6) + " | " +
        pb.totalDeaths + "(" + pb.mergeDeaths + "/" + pb.decayDeaths + "/" + pb.spawnDeaths + ")");
    }

    // === Cross-scenario voting ===
    const totalScenarios = results.length;
    const voteThreshold = Math.ceil(totalScenarios * VOTE_PCT);

    const voteRedundant = crossVote(results.map(r => r.pushback.redundantIds), voteThreshold);
    const voteLoner = crossVote(results.map(r => r.pushback.lonerIds), voteThreshold);
    const votePure = crossVote(results.map(r => r.pushback.pureEngramIds), voteThreshold);
    const voteMerger = crossVote(results.map(r => r.pushback.mergerEngramIds), voteThreshold);

    console.log("\n=== CROSS-RUN VOTING (baseline=" + BASELINE_RUNS + " + stress=" + stressCount + ", threshold: " + voteThreshold + "/" + totalScenarios + " = " + Math.round(voteThreshold / totalScenarios * 100) + "%) ===");
    for (const [name, vote] of [["redundant", voteRedundant], ["loner", voteLoner], ["pure", votePure], ["merger", voteMerger]]) {
      console.log("  " + name.padEnd(12) + "| confirmed=" + vote.confirmed.length + " borderline=" + vote.borderline.length + " unique=" + vote.total);
      if (vote.confirmed.length > 0) {
        for (const c of vote.confirmed.slice(0, 10)) {
          console.log("    CONFIRMED " + c.id.substring(0, 12) + "... (" + c.count + "/" + totalScenarios + ")");
        }
        if (vote.confirmed.length > 10) console.log("    ... +" + (vote.confirmed.length - 10) + " more");
      }
      if (vote.borderline.length > 0 && vote.borderline.length <= 5) {
        for (const b of vote.borderline) {
          console.log("    rejected  " + b.id.substring(0, 12) + "... (" + b.count + "/" + totalScenarios + ")");
        }
      } else if (vote.borderline.length > 5) {
        console.log("    rejected: " + vote.borderline.length + " ids (max " + vote.borderline[0].count + "/" + totalScenarios + ")");
      }
    }

    // Per-scenario vote detail matrix
    console.log("\n=== VOTE DETAIL (per engram across scenarios) ===");
    const scenarioLabels = scenarios.map(s => s.label.split(")")[0].trim() + ")");
    console.log("  filter      | engramId     | " + scenarioLabels.map(l => pad(l, 4)).join(" ") + " | total");
    console.log("  ------------|--------------|" + scenarioLabels.map(() => "-----").join("") + "|------");
    const voteEntries = [
      ["redundant", voteRedundant, r => r.pushback.redundantIds],
      ["loner", voteLoner, r => r.pushback.lonerIds],
      ["pure", votePure, r => r.pushback.pureEngramIds],
      ["merger", voteMerger, r => r.pushback.mergerEngramIds],
    ];
    for (const [name, vote, getIds] of voteEntries) {
      const allIds = [...vote.confirmed, ...vote.borderline].sort((a, b) => b.count - a.count);
      for (const item of allIds.slice(0, 15)) {
        const marks = results.map(r => getIds(r).includes(item.id) ? " +" : " .");
        const status = item.count >= voteThreshold ? "*" : " ";
        console.log("  " + status + name.padEnd(11) + "| " + item.id.substring(0, 12) + " | " + marks.join("") + " | " + item.count + "/" + totalScenarios);
      }
    }

    // Summary
    console.log("\n=== VOTING SUMMARY ===");
    console.log("  Filter     | Flaggable | Rejected | Total unique");
    console.log("  -----------|-----------|----------|-------------");
    for (const [name, vote] of [["redundant", voteRedundant], ["loner", voteLoner], ["pure", votePure], ["merger", voteMerger]]) {
      console.log("  " + name.padEnd(11) + "| " + pad(vote.confirmed.length, 9) + " | " + pad(vote.borderline.length, 8) + " | " + pad(vote.total, 12));
    }

    // Digestor drift
    console.log("\n=== DIGESTOR DRIFT ===");
    console.log("  scenario          | gens | " + speciesList.map(s => pad(s.slice(0, 4), 8)).join(" | "));
    console.log("  ------------------|------|" + speciesList.map(() => "---------").join("|"));
    for (let i = 0; i < results.length; i++) {
      const ds = results[i].digestSummary;
      console.log("  " + scenarios[i].label.padEnd(18) + "| " + pad(ds.generation, 4) + " | " +
        speciesList.map(s => pad(ds.drift[s].toFixed(4), 8)).join(" | "));
    }

    return { voteRedundant, voteLoner, votePure, voteMerger };
  }

  // ---- Feedback diff report between rounds ----
  function printFeedbackDiff(allRoundVotes) {
    const pad = (s, n) => String(s).padStart(n);
    console.log("\n" + "=".repeat(60));
    console.log("=== FEEDBACK CONVERGENCE (across " + allRoundVotes.length + " rounds) ===");
    console.log("=".repeat(60));

    console.log("\n  Round | redundant | loner | pure | merger");
    console.log("  ------|-----------|-------|------|-------");
    for (let r = 0; r < allRoundVotes.length; r++) {
      const v = allRoundVotes[r];
      console.log("  " + pad(r + 1, 5) + " | " +
        pad(v.voteRedundant.confirmed.length, 9) + " | " +
        pad(v.voteLoner.confirmed.length, 5) + " | " +
        pad(v.votePure.confirmed.length, 4) + " | " +
        pad(v.voteMerger.confirmed.length, 6));
    }

    // Stability check: compare last two rounds
    if (allRoundVotes.length >= 2) {
      const prev = allRoundVotes[allRoundVotes.length - 2];
      const curr = allRoundVotes[allRoundVotes.length - 1];

      console.log("\n  === ROUND " + (allRoundVotes.length - 1) + " → " + allRoundVotes.length + " DIFF ===");
      for (const [name, key] of [["redundant", "voteRedundant"], ["loner", "voteLoner"], ["pure", "votePure"], ["merger", "voteMerger"]]) {
        const prevIds = new Set(prev[key].confirmed.map(c => c.id));
        const currIds = new Set(curr[key].confirmed.map(c => c.id));
        const added = [...currIds].filter(id => !prevIds.has(id));
        const removed = [...prevIds].filter(id => !currIds.has(id));
        const stable = [...currIds].filter(id => prevIds.has(id));
        console.log("  " + name.padEnd(12) + "| stable=" + stable.length + " added=" + added.length + " removed=" + removed.length);
        if (added.length > 0 && added.length <= 5) {
          for (const id of added) console.log("    + " + id.substring(0, 16) + "...");
        }
        if (removed.length > 0 && removed.length <= 5) {
          for (const id of removed) console.log("    - " + id.substring(0, 16) + "...");
        }
      }
    }
  }

  // ---- Main execution: single round or feedback loop ----
  const rounds = FEEDBACK_ON ? FEEDBACK_ROUNDS : 1;
  const allRoundVotes = [];
  let feedbackMap = null;

  for (let round = 1; round <= rounds; round++) {
    const results = await runRound(round, feedbackMap);
    const votes = printReport(results);
    allRoundVotes.push(votes);

    // Build feedback for next round (skip on last round)
    if (FEEDBACK_ON && round < rounds) {
      feedbackMap = buildFeedbackMap(results);
      const rates = [...feedbackMap.values()];
      const avgRate = rates.reduce((a, b) => a + b, 0) / rates.length;
      const zeroRate = rates.filter(r => r === 0).length;
      const fullRate = rates.filter(r => r === 1).length;
      console.log("\n  [feedback] round " + round + " → " + (round + 1) + ": " + feedbackMap.size + " nodes, avg survival=" + avgRate.toFixed(3) +
        " (never=" + zeroRate + " always=" + fullRate + ")");
    }
  }

  if (FEEDBACK_ON) {
    printFeedbackDiff(allRoundVotes);
  }

  // ---- Report: write mycelium results to JSON (no engram modification) ----
  if (REPORT) {
    const lastVotes = allRoundVotes[allRoundVotes.length - 1];
    // Build ID → engram metadata lookup for enrichment
    const engramLookup = new Map();
    for (const ep of (engramCache || [])) {
      const p = ep.payload || {};
      engramLookup.set(String(ep.id), { summary: p.summary || "", tags: p.tags || [] });
    }
    function enrichEntry(c) {
      const meta = engramLookup.get(c.id) || {};
      return { engramId: c.id, summary: meta.summary || "", tags: meta.tags || [], votes: c.count, total: scenarios.length };
    }
    const report = {
      timestamp: new Date().toISOString(),
      config: { ticks: TICKS, digest: DIGEST, baselineRuns: BASELINE_ACTUAL, votePct: VOTE_PCT, nutritionBias: BIAS },
      scenarios: scenarios.map(s => s.label),
      confirmed: {
        redundant: lastVotes.voteRedundant.confirmed.map(enrichEntry),
        loner: lastVotes.voteLoner.confirmed.map(enrichEntry),
        pure: lastVotes.votePure.confirmed.map(enrichEntry),
        merger: lastVotes.voteMerger.confirmed.map(enrichEntry),
      },
    };
    const fs = require("fs");
    const path = require("path");
    const outDir = path.join(__dirname, "..", "reports");
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    const outFile = path.join(outDir, "mycelium-report.json");
    fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
    console.log("\n=== REPORT SAVED ===");
    console.log("  " + outFile);
    console.log("  redundant: " + report.confirmed.redundant.length + " | loner: " + report.confirmed.loner.length +
      " | pure: " + report.confirmed.pure.length + " | merger: " + report.confirmed.merger.length);
  }
})().catch(e => console.error(e));
