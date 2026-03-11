const { scrollAll, ensureCollection, deletePoints, upsertPoints } = require("../dist/qdrant.js");
function cosine(a, b) { let d = 0; for (let i = 0; i < a.length; i++) d += a[i] * b[i]; return d; }
const { payloadToNode, nodeToPayload, computeFeelings, assessAction, clamp01, createNode, getSpeciesConfig, resolveSpecies } = require("../dist/core/node.js");
const { emitSignal, react, resolveInteraction } = require("../dist/core/receptor.js");
const { isSpawnEligible, isCompatiblePartner, executeSpawn } = require("../dist/core/spawn.js");
const M = require("../dist/config/metabolism.json");
const QDRANT_URL = "http://localhost:6333";
const COLLECTION = "mycelium_filter_test";
const ALL_SPECIES = ["summarizer","sentinel","herald","anchor","spore"];

function computeNutrition(p, sp) {
  const NUT = M.nutrition;
  return {
    w: M.birth.initialW * (1 + NUT.bias * Math.tanh((p.weight||0)/NUT.weightSaturation) + (p.status==="fixed"?NUT.fixedBonus:0)),
    h: M.birth.initialH * (1 + NUT.bias * Math.min((p.hitCount||0)/NUT.hitCountCap,1)),
    d: getSpeciesConfig(sp).initialDecay * (1 - NUT.bias * Math.min((p.hitCount||0)/NUT.hitCountCap,1) + (p.status==="fixed"?-NUT.fixedBonus:0))
  };
}

function selectTarget(self, allNodes, toDelete, reach, action) {
  if (!self.vector) return null;
  const limit = reach || M.social.neighborLimit;
  const bias = getSpeciesConfig(self.node.species).selectionBias;
  const affinity = action ? (M.social.targetAffinity?.[action] || 0) : 0;
  const candidates = [];
  for (const t of allNodes) {
    if (t.node.id === self.node.id || !t.vector || toDelete.has(t.node.id)) continue;
    const sim = cosine(self.vector, t.vector);
    const b = bias?.[t.node.species] || 1.0;
    const stateBonus = affinity !== 0 ? (1 + affinity * t.node.w) : 1;
    const mergeBias = action === "merge" ? (getSpeciesConfig(t.node.species).mergeTargetBias ?? 1.0) : 1;
    candidates.push({ nv: t, score: sim * b * stateBonus * mergeBias, similarity: sim });
  }
  candidates.sort((a, b) => b.score - a.score);
  const pool = candidates.slice(0, limit);
  if (pool.length === 0) return null;
  const temp = M.decision?.temperature || 1.0;
  const maxScore = pool[0].score;
  const exps = pool.map(c => Math.exp((c.score - maxScore) / temp));
  const sumExp = exps.reduce((a, b) => a + b, 0);
  let r = Math.random(), cum = 0, selected;
  for (let i = 0; i < pool.length; i++) { cum += exps[i]/sumExp; if (r < cum) { selected = pool[i]; break; } }
  if (!selected) selected = pool[pool.length - 1];
  const proxThreshold = M.merge?.proximityThreshold || 0.85;
  const targetMergeBias = getSpeciesConfig(selected.nv.node.species).mergeTargetBias ?? 1.0;
  const proximityMerge = action !== "merge" && selected.similarity >= proxThreshold && targetMergeBias > 0;
  return { target: selected.nv, similarity: selected.similarity, proximityMerge };
}

function computeEnvironment(self, allNodes) {
  const env = { neighborField: { h: 0, w: 0, d: 0 }, kinCount: 0, neighborSpecies: { summarizer: 0, sentinel: 0, herald: 0, anchor: 0, spore: 0 } };
  if (!self.vector) return env;
  const neighbors = allNodes.filter(n => n.node.id !== self.node.id && n.vector)
    .map(n => ({ score: cosine(self.vector, n.vector), node: n.node }))
    .sort((a, b) => b.score - a.score).slice(0, M.social.neighborLimit);
  if (!neighbors.length) return env;
  for (const nb of neighbors) {
    env.neighborField.h += nb.node.h; env.neighborField.w += nb.node.w; env.neighborField.d += nb.node.d;
    env.neighborSpecies[nb.node.species]++;
    if (nb.node.species === self.node.species) env.kinCount++;
  }
  env.neighborField.h /= neighbors.length; env.neighborField.w /= neighbors.length; env.neighborField.d /= neighbors.length;
  return env;
}

(async () => {
  await ensureCollection(QDRANT_URL, COLLECTION, 384);
  const existing = await scrollAll(QDRANT_URL, COLLECTION, false);
  if (existing.length > 0) await deletePoints(QDRANT_URL, COLLECTION, existing.map(p => p.id));

  const engramPoints = await scrollAll(QDRANT_URL, "engram", true);
  const nodesToUpsert = [];
  for (const ep of engramPoints) {
    const p = ep.payload || {};
    const summary = (p.contents && p.contents[0]) || p.summary || "";
    const trigger = p.trigger || "manual";
    const tags = p.tags || [];
    const sp = resolveSpecies(trigger, tags);
    const nutrition = computeNutrition(p, sp);
    const { node } = createNode(String(summary), undefined, trigger, undefined, undefined, nutrition, tags);
    node.engramId = String(ep.id);
    nodesToUpsert.push({ id: node.id, vector: ep.vector, payload: nodeToPayload(node) });
  }
  await upsertPoints(QDRANT_URL, COLLECTION, nodesToUpsert);
  const pts = await scrollAll(QDRANT_URL, COLLECTION, true);
  let allNodes = pts.map(p => ({ node: payloadToNode(p.id, p.payload), vector: p.vector || null }));

  const anchorDeaths = [];
  const anchorActions = {};

  for (let t = 1; t <= 50; t++) {
    const toDelete = new Set();

    for (const nv of allNodes) {
      if (toDelete.has(nv.node.id)) continue;
      const env = computeEnvironment(nv, allNodes);
      const feelings = computeFeelings(nv.node, env);
      const action = assessAction(feelings, nv.node.personality, nv.node.learnedDelta);

      // Track anchor actions
      if (nv.node.species === "anchor") {
        anchorActions[action] = (anchorActions[action] || 0) + 1;
      }

      if (action === "survive") {
        nv.node.h = Math.min(1, nv.node.h + M.relief.surviveHRecovery);
        nv.node.w += (M.relief.surviveWRecovery || 0);
        nv.node.w -= (M.relief.surviveWCost || 0);
        nv.node.ttl += M.relief.surviveTtlRecovery;
        nv.node.d *= M.relief.surviveDecayReduction;
        continue;
      }

      let act = action;
      const intensity = nv.node.h;
      nv.node.h = Math.max(0, nv.node.h - intensity * ((M.energy.baseCost[act]) || 0.1));

      const signalReach = act === "signal" ? M.social.neighborLimit + Math.floor(intensity * (M.social.signalExtraReach || 0)) : undefined;
      const match = selectTarget(nv, allNodes, toDelete, signalReach, act);
      if (!match) {
        nv.node.h = Math.min(1, nv.node.h + intensity * ((M.energy.baseCost[act]) || 0.1));
        nv.node.h = Math.min(1, nv.node.h + M.relief.surviveHRecovery);
        nv.node.w += (M.relief.surviveWRecovery || 0);
        nv.node.w -= (M.relief.surviveWCost || 0);
        nv.node.ttl += M.relief.surviveTtlRecovery;
        nv.node.d *= M.relief.surviveDecayReduction;
        continue;
      }

      if (match.proximityMerge) { act = "merge"; }

      const signal = emitSignal(nv.node, act, feelings, intensity);
      const tone = nv.node.w;
      const tonedFeelings = { vigor: signal.feelings.vigor*tone, hunger: signal.feelings.hunger*tone, dread: signal.feelings.dread*tone, kinship: signal.feelings.kinship*tone };
      const targetEnv = computeEnvironment(match.target, allNodes);
      const mergeCtx = act === "merge" ? { similarity: match.similarity } : undefined;
      const reaction = react(match.target.node, targetEnv, tonedFeelings, mergeCtx);
      const result = resolveInteraction(nv.node, match.target.node, signal, reaction, intensity, match.similarity);

      if (!result.initiatorAlive) {
        toDelete.add(nv.node.id);
        if (nv.node.species === "anchor") {
          anchorDeaths.push({ tick: t, cause: "merge-as-initiator", origAction: action, proxMerge: match.proximityMerge, cos: match.similarity.toFixed(3), targetSp: match.target.node.species, reaction });
        }
      }
      if (!result.targetAlive) {
        toDelete.add(match.target.node.id);
        if (match.target.node.species === "anchor") {
          anchorDeaths.push({ tick: t, cause: "merge-as-target", initiatorSp: nv.node.species, cos: match.similarity.toFixed(3), reaction });
        }
      }
    }

    // Spawn
    const spawnConsumed = new Set();
    for (const nv of allNodes) {
      if (toDelete.has(nv.node.id) || spawnConsumed.has(nv.node.id)) continue;
      if (!nv.vector || !isSpawnEligible(nv.node)) continue;
      let best = null, bestScore = -Infinity;
      for (const t2 of allNodes) {
        if (t2.node.id === nv.node.id || !t2.vector || toDelete.has(t2.node.id) || spawnConsumed.has(t2.node.id)) continue;
        const s = cosine(nv.vector, t2.vector);
        if (s > bestScore) { bestScore = s; best = t2; }
      }
      if (!best || !isCompatiblePartner(bestScore)) continue;
      const sr = executeSpawn(nv.node, nv.vector, best.node, best.vector);
      spawnConsumed.add(sr.consumedIds[0]); spawnConsumed.add(sr.consumedIds[1]);
      toDelete.add(sr.consumedIds[0]); toDelete.add(sr.consumedIds[1]);
      if (nv.node.species === "anchor") anchorDeaths.push({ tick: t, cause: "spawn" });
      if (best.node.species === "anchor") anchorDeaths.push({ tick: t, cause: "spawn-partner" });
    }

    // Decay
    for (const nv of allNodes) {
      if (toDelete.has(nv.node.id)) continue;
      nv.node.w *= (1 - nv.node.d);
      nv.node.h *= M.pressure.hCooling;
      nv.node.ttl -= M.pressure.ttlStep;
      if (nv.node.ttl <= M.pressure.deathMinTtl || nv.node.w <= M.pressure.deathMinW) {
        toDelete.add(nv.node.id);
        if (nv.node.species === "anchor") anchorDeaths.push({ tick: t, cause: "decay", w: nv.node.w.toFixed(4), ttl: nv.node.ttl });
      }
    }

    allNodes = allNodes.filter(nv => !toDelete.has(nv.node.id));
  }

  console.log("=== Anchor action distribution (50 ticks) ===");
  console.log(JSON.stringify(anchorActions));
  console.log("\n=== Anchor deaths:", anchorDeaths.length, "===");
  for (const d of anchorDeaths) console.log("  " + JSON.stringify(d));
  console.log("\nAnchor alive:", allNodes.filter(nv => nv.node.species === "anchor").length, "/ 18");

  // Cleanup
  const leftover = await scrollAll(QDRANT_URL, COLLECTION, false);
  if (leftover.length > 0) await deletePoints(QDRANT_URL, COLLECTION, leftover.map(p => p.id));
})();
