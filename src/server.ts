#!/usr/bin/env node
// ============================================================
// Mycelium — MCP Server (Phase 0)
// ============================================================
//
// Biological knowledge node observation system.
// Directly connects to Qdrant (no gateway layer).
//
// Tools:
//   mycelium_push    — seed a new node into the petri dish
//   mycelium_status  — view colony statistics
//   mycelium_observe — peek at nodes (cosine search)
//
// Transport: stdio
//
// Environment:
//   QDRANT_URL            — Qdrant endpoint (default: http://localhost:6333)
//   MYCELIUM_COLLECTION   — Collection name (default: mycelium)

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { DEFAULT_CONFIG } from "./types.js";
import type { MyceliumConfig } from "./types.js";
import { embedText } from "./embedding.js";
import {
  ensureCollection,
  checkQdrantHealth,
} from "./qdrant.js";
import { createNode, nodeToPayload, resolveSpecies } from "./core/node.js";
import { startTick, getTickStats, runTick } from "./core/tick.js";
import { getSpeciesMemory, getDigestorStats, loadSpeciesMemory } from "./core/digestor.js";
import * as store from "./core/colony-store.js";
import { getSnapshots, getLatestSnapshot, getSnapshotCount } from "./core/observatory.js";

// ---- Config ----

const config: MyceliumConfig = {
  ...DEFAULT_CONFIG,
  qdrantUrl: process.env.QDRANT_URL ?? DEFAULT_CONFIG.qdrantUrl,
  collection: process.env.MYCELIUM_COLLECTION ?? DEFAULT_CONFIG.collection,
};

let initialized = false;

async function ensureInit(): Promise<void> {
  if (initialized) return;

  const healthy = await checkQdrantHealth(config.qdrantUrl);
  if (!healthy) {
    throw new Error(`Qdrant unreachable at ${config.qdrantUrl}`);
  }

  await ensureCollection(config.qdrantUrl, config.collection, config.embeddingDimension);
  loadSpeciesMemory(config);

  // Bootstrap colony store from Qdrant (one-time load)
  if (!store.isLoaded()) {
    await store.loadFromQdrant(config.qdrantUrl, config.collection);
  }

  initialized = true;
}

// ---- MCP Server ----

const server = new McpServer({
  name: "mycelium",
  version: "0.1.0",
});

// ============================================================
// Tool: mycelium_push
// ============================================================

server.tool(
  "mycelium_push",
  `Seed a new node into the Mycelium petri dish.
Each seed becomes a biological node with species assignment priority:
  1. species (direct override)
  2. tags (matched against species-mapping.json rules)
  3. trigger (fallback mapping)
  4. default: summarizer

Trigger mapping:
  session-end → Summarizer, error-resolved → Anchor,
  milestone / git-commit → Herald, convention → Sentinel,
  manual → Spore, environment → Anchor

Tag mapping (species-mapping.json):
  error/bug/fix → Anchor, rule/convention → Sentinel,
  release/deploy → Herald, summary/digest → Summarizer,
  idea/draft → Spore`,
  {
    summary: z.string().min(5).max(300).describe("Node content headline"),
    content: z.string().optional().describe("Detailed content (becomes second content element)"),
    trigger: z.enum(["session-end", "milestone", "git-commit", "error-resolved", "manual", "convention", "environment"])
      .default("manual").describe("Ingestion trigger — determines species (lowest priority)"),
    tags: z.array(z.string()).max(10).default([]).describe("Tags for species mapping and observation"),
    species: z.enum(["summarizer", "sentinel", "herald", "anchor", "spore"])
      .optional().describe("Direct species override (highest priority)"),
  },
  async ({ summary, content, trigger, tags, species: speciesOverride }) => {
    try {
      await ensureInit();

      const species = resolveSpecies(trigger, tags, speciesOverride);
      const inherited = getSpeciesMemory(species);
      const { node, textForEmbedding } = createNode(summary, content, trigger, inherited, undefined, undefined, tags, speciesOverride);
      const vector = await embedText(textForEmbedding);

      // Write-through: colony store + Qdrant
      await store.ingestAndPersist(config.qdrantUrl, config.collection, node.id, vector, node);

      const lines = [
        `Node born: ${node.species} [${node.id.slice(0, 8)}]`,
        `  summary: ${summary}`,
        `  ttl: ${node.ttl}  decay: ${node.d}`,
        `  contents: ${node.contents.length} elements`,
      ];

      return {
        content: [{ type: "text", text: lines.join("\n") }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Push failed: ${(err as Error).message}` }],
        isError: true,
      };
    }
  },
);

// ============================================================
// Tool: mycelium_status
// ============================================================

server.tool(
  "mycelium_status",
  "View Mycelium colony statistics: node counts by species, collection health.",
  {},
  async () => {
    try {
      const healthy = await checkQdrantHealth(config.qdrantUrl);
      if (!healthy) {
        return {
          content: [{ type: "text", text: `Qdrant unreachable at ${config.qdrantUrl}` }],
          isError: true,
        };
      }

      await ensureInit();

      const total = store.size();
      const speciesMap = store.countBySpecies();
      const speciesCounts = ["summarizer", "sentinel", "herald", "anchor", "spore"]
        .map(s => ({ species: s, count: speciesMap[s] ?? 0 }));

      const tick = getTickStats();

      const digestor = getDigestorStats();

      const lines = [
        `Mycelium Colony Status`,
        `  collection: ${config.collection}`,
        `  qdrant: ${config.qdrantUrl}`,
        `  total nodes: ${total}`,
        ``,
        `Species:`,
        ...speciesCounts.map(({ species, count }) => `  ${species}: ${count}`),
        ``,
        `Tick:`,
        `  running: ${tick.running}`,
        `  count: ${tick.tickCount}`,
        ...(tick.lastResult ? [
          `  last: processed=${tick.lastResult.processed} expired=${tick.lastResult.expired}`,
          `  actions: ${JSON.stringify(tick.lastResult.actions)}`,
        ] : []),
        ``,
        `Digestor:`,
        `  generation: ${digestor.generation}`,
        `  last digest tick: ${digestor.lastDigestTick}`,
        `  species memory drift:`,
        ...Object.entries(digestor.speciesMemorySummary).map(
          ([sp, s]) => `    ${sp}: maxAbsDelta=${s.maxAbsDelta.toFixed(4)}`,
        ),
      ];

      return {
        content: [{ type: "text", text: lines.join("\n") }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Status failed: ${(err as Error).message}` }],
        isError: true,
      };
    }
  },
);

// ============================================================
// Tool: mycelium_observe
// ============================================================

server.tool(
  "mycelium_observe",
  "Observe nodes in the petri dish via cosine similarity search. Read-only — does not affect node state.",
  {
    query: z.string().describe("Natural language query to find nearby nodes"),
    limit: z.number().min(1).max(20).default(5).describe("Max nodes to return"),
  },
  async ({ query, limit }) => {
    try {
      await ensureInit();

      const vector = await embedText(query);
      const results = store.search(vector, limit);

      if (results.length === 0) {
        return {
          content: [{ type: "text", text: "No nodes found. The petri dish may be empty." }],
        };
      }

      const formatted = results.map((r, i) => {
        const p = r.payload;
        const dominant = p.contents[0]?.slice(0, 80) ?? "(empty)";
        return [
          `[${i + 1}] ${p.species} [${r.id.slice(0, 8)}] (score: ${r.score.toFixed(3)})`,
          `    "${dominant}"`,
          `    h=${p.h.toFixed(2)} w=${p.w.toFixed(2)} d=${p.d} ttl=${p.ttl}`,
          `    contents: ${p.contents.length} elements`,
        ].join("\n");
      });

      return {
        content: [{ type: "text", text: `Observed ${results.length} nodes:\n\n${formatted.join("\n\n")}` }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Observe failed: ${(err as Error).message}` }],
        isError: true,
      };
    }
  },
);

// ============================================================
// Tool: mycelium_tick
// ============================================================

server.tool(
  "mycelium_tick",
  "Manually trigger a single metabolism tick. Useful for testing and observation. Each tick applies decay, computes feelings, runs assess(), and expires dead nodes.",
  {},
  async () => {
    try {
      await ensureInit();

      const stats = getTickStats();
      const tickNumber = stats.tickCount + 1;
      const result = await runTick(config, tickNumber);

      const lines = [
        `Tick #${result.tick} complete`,
        `  processed: ${result.processed}`,
        `  expired: ${result.expired}`,
        `  actions: ${JSON.stringify(result.actions)}`,
      ];

      return {
        content: [{ type: "text", text: lines.join("\n") }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Tick failed: ${(err as Error).message}` }],
        isError: true,
      };
    }
  },
);

// ============================================================
// Tool: mycelium_snapshots
// ============================================================

server.tool(
  "mycelium_snapshots",
  "Retrieve ecosystem snapshots collected by the observatory. Returns population, species distribution, action summary, resonance data at configured intervals. Use 'latest' for most recent, 'all' for full buffer, or a number for last N snapshots.",
  {
    mode: z.enum(["latest", "all"]).default("latest").describe("'latest' = most recent snapshot, 'all' = full ring buffer"),
    last: z.number().optional().describe("Return only the last N snapshots (only with mode='all')"),
  },
  async ({ mode, last }) => {
    try {
      if (mode === "latest") {
        const snap = getLatestSnapshot();
        if (!snap) {
          return {
            content: [{ type: "text", text: `No snapshots yet (collected every N ticks when population >= minPopulation). Buffer: ${getSnapshotCount()}` }],
          };
        }
        // Summarize without full node list for readability
        const summary = {
          tick: snap.tick,
          population: snap.population,
          speciesCounts: snap.speciesCounts,
          actionSummary: snap.actionSummary,
          mergeCount: snap.mergeCount,
          spawnCount: snap.spawnCount,
          // Resonance summary: average per species across all nodes
          avgResonance: summarizeResonance(snap),
        };
        return {
          content: [{ type: "text", text: JSON.stringify(summary, null, 2) }],
        };
      }

      // mode === "all"
      let snaps = getSnapshots();
      if (last && last > 0) snaps = snaps.slice(-last);

      const summaries = snaps.map(snap => ({
        tick: snap.tick,
        population: snap.population,
        speciesCounts: snap.speciesCounts,
        actionSummary: snap.actionSummary,
        mergeCount: snap.mergeCount,
        spawnCount: snap.spawnCount,
      }));

      return {
        content: [{ type: "text", text: `${summaries.length} snapshots (buffer capacity: ${getSnapshotCount()}):\n${JSON.stringify(summaries, null, 2)}` }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Snapshot retrieval failed: ${(err as Error).message}` }],
        isError: true,
      };
    }
  },
);

function summarizeResonance(snap: ReturnType<typeof getLatestSnapshot>): Record<string, number> {
  if (!snap || snap.nodes.length === 0) return {};
  const totals: Record<string, number> = {};
  for (const n of snap.nodes) {
    for (const [sp, val] of Object.entries(n.resonance)) {
      totals[sp] = (totals[sp] ?? 0) + val;
    }
  }
  for (const sp of Object.keys(totals)) {
    totals[sp] = Math.round((totals[sp] / snap.nodes.length) * 1000) / 1000;
  }
  return totals;
}

// ============================================================
// Start
// ============================================================

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[mycelium] MCP server running (qdrant=${config.qdrantUrl}, collection=${config.collection})`);

  // Start metabolism tick loop
  try {
    await ensureInit();
    startTick(config);
  } catch (err) {
    console.error(`[mycelium] tick loop deferred (Qdrant not ready):`, (err as Error).message);
  }
}

main().catch((err) => {
  console.error("[mycelium] Fatal:", err);
  process.exit(1);
});
