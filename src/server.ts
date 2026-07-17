#!/usr/bin/env node
// ============================================================
// Mycelium MCP Server — Lightweight tool interface for receptor integration
// ============================================================
// Tools:
//   mycelium_filter  — Run filtering on a Qdrant collection, return results
//   mycelium_status  — Health check + last report summary
//
// Transport: stdio
// Usage: npx tsx src/server.ts

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execFile } from "node:child_process";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..");
const LOADER_ENTRY = join(PROJECT_ROOT, "src", "loader", "main.ts");
const REPORT_DIR = join(PROJECT_ROOT, "data", "reports");

const server = new McpServer({
  name: "mycelium",
  version: "1.0.0",
});

// ---- Tools ----

server.tool(
  "mycelium_filter",
  "Run mycelium ecosystem filtering on a Qdrant collection. Returns filtered results as JSON or text.",
  {
    sourceQdrantUrl: z.string().describe("Qdrant URL to read source data from (e.g. http://localhost:6333)"),
    collections: z.string().default("engram").describe("Comma-separated collection names"),
    viewFormat: z.enum(["digest", "manifest", "compact", "structured", ""]).default("compact")
      .describe("Output format: digest (structured JSON), manifest (lightweight index), compact (1-line summary), structured, or empty for raw JSON"),
    consensusRuns: z.number().min(1).max(30).default(10).describe("Number of consensus voting runs"),
    filterHardness: z.enum(["soft", "mid", "hard"]).default("mid").describe("Filter strictness"),
    filterSourceIds: z.string().default("").describe("Comma-separated source IDs to filter (empty = all)"),
    crossFile: z.boolean().default(false).describe("Enable cross-file affinity 2nd pass"),
    fuelOff: z.boolean().default(false).describe("Ignore fuel channels (payload.weight / myceliumMetrics) — flat audit run (F3)"),
    auditAB: z.boolean().default(false).describe("Run every slot twice (fueled + flat) and return a fuel drift audit JSON instead of reports (F3)"),
    excludeTags: z.string().default("").describe("Comma-separated tags to exclude from source scroll (e.g. previously-cached nodes, prevents recursive re-ingestion) (Phase 3)"),
  },
  async ({ sourceQdrantUrl, collections, viewFormat, consensusRuns, filterHardness, filterSourceIds, crossFile, fuelOff, auditAB, excludeTags }) => {
    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      SOURCE_QDRANT_URL: sourceQdrantUrl,
      SOURCE_COLLECTIONS: collections,
      CONSENSUS_RUNS: String(consensusRuns),
      FILTER_HARDNESS: filterHardness,
    };
    if (viewFormat) env.VIEW_FORMAT = viewFormat;
    if (filterSourceIds) env.FILTER_SOURCE_IDS = filterSourceIds;
    if (crossFile) env.CROSS_FILE = "true";
    if (fuelOff) env.FUEL_OFF = "true";
    if (auditAB) env.AUDIT_AB = "true";
    if (excludeTags) env.EXCLUDE_TAGS = excludeTags;

    // Don't save reports when called via MCP — caller (receptor sink) handles persistence
    delete env.REPORT_DIR;

    try {
      const { stdout, stderr } = await execFileAsync(
        "npx", ["tsx", LOADER_ENTRY],
        {
          env,
          cwd: PROJECT_ROOT,
          timeout: auditAB ? 240_000 : 120_000, // A/B runs every slot twice
          maxBuffer: 10 * 1024 * 1024,
          shell: true,
        },
      );

      // Extract summary line from stderr for quick consumption
      const stderrLines = stderr.split("\n");
      const summaryLine = stderrLines.find(l => l.includes("all") && l.includes("complete"))
        ?? stderrLines[stderrLines.length - 2]
        ?? "";

      return {
        content: [
          { type: "text" as const, text: stdout.trim() },
        ],
        _meta: { summary: summaryLine.trim() },
      };
    } catch (err: any) {
      const stderr = err.stderr ?? "";
      const message = err.message ?? "Unknown error";
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ error: true, message, stderr: stderr.slice(-500) }),
        }],
        isError: true,
      };
    }
  },
);

server.tool(
  "mycelium_status",
  "Health check — returns last report summary and available reports",
  {},
  async () => {
    const result: Record<string, any> = {
      ok: true,
      ts: Date.now(),
      reportDir: REPORT_DIR,
      latestReport: null,
      recentReports: [],
    };

    // Check latest report
    const latestPath = join(REPORT_DIR, "latest.json");
    if (existsSync(latestPath)) {
      try {
        const stat = statSync(latestPath);
        const raw = JSON.parse(readFileSync(latestPath, "utf-8"));
        const reports = Array.isArray(raw) ? raw : [raw];
        const totalChunks = reports.reduce((s: number, r: any) => s + (r.totalChunks ?? 0), 0);
        const survivingChunks = reports.reduce((s: number, r: any) => s + (r.survivingChunks ?? 0), 0);
        result.latestReport = {
          age: `${((Date.now() - stat.mtimeMs) / 1000 / 60).toFixed(0)}min ago`,
          sources: reports.length,
          survival: `${survivingChunks}/${totalChunks}`,
          rate: totalChunks > 0 ? `${(survivingChunks / totalChunks * 100).toFixed(1)}%` : "N/A",
        };
      } catch {}
    }

    // List recent reports
    if (existsSync(REPORT_DIR)) {
      result.recentReports = readdirSync(REPORT_DIR)
        .filter(f => !f.startsWith("latest.") && f.endsWith(".json"))
        .sort()
        .slice(-5);
    }

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify(result, null, 2),
      }],
    };
  },
);

// ---- Start ----

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[mycelium-mcp] server started (stdio)");
}

main().catch((err) => {
  console.error("[mycelium-mcp] fatal:", err);
  process.exit(1);
});
