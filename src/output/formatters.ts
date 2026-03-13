// ============================================================
// View Layer — formatters for external consumption
// ============================================================
//
// Transforms raw SurvivorReport[] into structured responses
// suitable for agents, LLMs, or downstream services.
//
// Three output modes:
//   compact    — minimal text digest (token-efficient for LLM context)
//   detailed   — full breakdown with per-source stats
//   structured — typed JSON for programmatic consumption

import type { SurvivorReport, ClassificationBreakdown } from "../loader/feed-instance.js";

// ---- Output types ----

export type ViewFormat = "compact" | "detailed" | "structured";

/** Per-source summary in structured mode */
export interface SourceView {
  sourceId: string;
  collection: string;
  totalChunks: number;
  survivingChunks: number;
  survivalRate: number;
  classification: ClassificationBreakdown;
  consensusRate?: number;
  species: Record<string, number>;
  metadata?: Record<string, unknown>;
  /** Representative surviving texts (up to sampleLimit) */
  samples: string[];
}

/** Per-world aggregate */
export interface WorldView {
  world: string;
  totalChunks: number;
  survivingChunks: number;
  survivalRate: number;
  classification: ClassificationBreakdown;
  speciesDistribution: Record<string, number>;
  sources: SourceView[];
}

/** Top-level structured report */
export interface FormattedReport {
  format: ViewFormat;
  timestamp: string;
  worlds: WorldView[];
  summary: {
    totalWorlds: number;
    totalSources: number;
    totalChunks: number;
    survivingChunks: number;
    survivalRate: number;
  };
}

// ---- Aggregation helpers ----

function sumBreakdown(reports: SurvivorReport[]): ClassificationBreakdown {
  const bd: ClassificationBreakdown = { pure: 0, merged: 0, loner: 0, redundant: 0, dead: 0 };
  for (const r of reports) {
    for (const [k, v] of Object.entries(r.classificationBreakdown)) {
      bd[k as keyof ClassificationBreakdown] += v;
    }
  }
  return bd;
}

function sumSpecies(reports: SurvivorReport[]): Record<string, number> {
  const sp: Record<string, number> = {};
  for (const r of reports) {
    for (const [k, v] of Object.entries(r.species)) {
      sp[k] = (sp[k] ?? 0) + v;
    }
  }
  return sp;
}

function groupByWorld(reports: SurvivorReport[]): Map<string, SurvivorReport[]> {
  const map = new Map<string, SurvivorReport[]>();
  for (const r of reports) {
    const key = r.worldName ?? "shared";
    const arr = map.get(key);
    if (arr) arr.push(r);
    else map.set(key, [r]);
  }
  return map;
}

// ---- Structured builder ----

function buildStructured(reports: SurvivorReport[], sampleLimit: number): FormattedReport {
  const byWorld = groupByWorld(reports);
  const worlds: WorldView[] = [];

  for (const [worldName, worldReports] of byWorld) {
    const totalChunks = worldReports.reduce((s, r) => s + r.totalChunks, 0);
    const survivingChunks = worldReports.reduce((s, r) => s + r.survivingChunks, 0);

    const sources: SourceView[] = worldReports.map(r => ({
      sourceId: r.sourceId,
      collection: r.collection,
      totalChunks: r.totalChunks,
      survivingChunks: r.survivingChunks,
      survivalRate: r.survivalRate,
      classification: { ...r.classificationBreakdown },
      consensusRate: r.consensusRate,
      species: { ...r.species },
      metadata: r.sourceMetadata,
      samples: r.survivingTexts.slice(0, sampleLimit),
    }));

    worlds.push({
      world: worldName,
      totalChunks,
      survivingChunks,
      survivalRate: totalChunks > 0 ? survivingChunks / totalChunks : 0,
      classification: sumBreakdown(worldReports),
      speciesDistribution: sumSpecies(worldReports),
      sources,
    });
  }

  const totalChunks = reports.reduce((s, r) => s + r.totalChunks, 0);
  const survivingChunks = reports.reduce((s, r) => s + r.survivingChunks, 0);

  return {
    format: "structured",
    timestamp: new Date().toISOString(),
    worlds,
    summary: {
      totalWorlds: worlds.length,
      totalSources: reports.length,
      totalChunks,
      survivingChunks,
      survivalRate: totalChunks > 0 ? survivingChunks / totalChunks : 0,
    },
  };
}

// ---- Compact text ----

function renderCompact(report: FormattedReport): string {
  const lines: string[] = [];
  const s = report.summary;
  lines.push(
    `Mycelium Filter: ${s.survivingChunks}/${s.totalChunks} survived ` +
    `(${(s.survivalRate * 100).toFixed(1)}%) across ${s.totalWorlds} world(s)`,
  );

  for (const w of report.worlds) {
    if (report.worlds.length > 1) lines.push(`\n[${w.world}]`);

    const bd = w.classification;
    lines.push(
      `  pure:${bd.pure} merged:${bd.merged} loner:${bd.loner} redundant:${bd.redundant} dead:${bd.dead}`,
    );

    // Top sources by surviving chunks (limit 5)
    const top = [...w.sources]
      .filter(src => src.survivingChunks > 0)
      .sort((a, b) => b.survivingChunks - a.survivingChunks)
      .slice(0, 5);

    for (const src of top) {
      const rate = (src.survivalRate * 100).toFixed(0);
      const consensus = src.consensusRate != null
        ? ` consensus:${(src.consensusRate * 100).toFixed(0)}%`
        : "";
      lines.push(`  ${src.sourceId}: ${src.survivingChunks}/${src.totalChunks} (${rate}%)${consensus}`);
    }
  }

  return lines.join("\n");
}

// ---- Detailed text ----

function renderDetailed(report: FormattedReport): string {
  const lines: string[] = [];
  const s = report.summary;
  lines.push("=== Mycelium Filter Report ===");
  lines.push(`Timestamp: ${report.timestamp}`);
  lines.push(
    `Total: ${s.survivingChunks}/${s.totalChunks} survived ` +
    `(${(s.survivalRate * 100).toFixed(1)}%), ${s.totalSources} source(s), ${s.totalWorlds} world(s)`,
  );

  for (const w of report.worlds) {
    lines.push(`\n--- World: ${w.world} ---`);
    const bd = w.classification;
    lines.push(
      `  Survival: ${w.survivingChunks}/${w.totalChunks} (${(w.survivalRate * 100).toFixed(1)}%)`,
    );
    lines.push(
      `  3-axis: pure:${bd.pure} merged:${bd.merged} loner:${bd.loner} redundant:${bd.redundant} dead:${bd.dead}`,
    );

    const spLine = Object.entries(w.speciesDistribution)
      .filter(([, n]) => n > 0)
      .map(([k, v]) => `${k}:${v}`)
      .join(", ");
    if (spLine) lines.push(`  Species: ${spLine}`);

    for (const src of w.sources) {
      const rate = (src.survivalRate * 100).toFixed(1);
      const srcBd = src.classification;
      const bdStr = Object.entries(srcBd)
        .filter(([, n]) => n > 0)
        .map(([k, v]) => `${k}:${v}`)
        .join(" ");
      const consensus = src.consensusRate != null
        ? ` passing:${(src.consensusRate * 100).toFixed(0)}%`
        : "";

      lines.push(`\n  [${src.sourceId}] ${src.survivingChunks}/${src.totalChunks} (${rate}%)${consensus}`);
      lines.push(`    ${bdStr}`);

      const srcSp = Object.entries(src.species)
        .filter(([, n]) => n > 0)
        .map(([k, v]) => `${k}:${v}`)
        .join(", ");
      if (srcSp) lines.push(`    species: ${srcSp}`);

      if (src.metadata) {
        const metaKeys = Object.keys(src.metadata).slice(0, 5);
        if (metaKeys.length > 0) {
          const metaStr = metaKeys
            .map(k => `${k}=${JSON.stringify(src.metadata![k])}`)
            .join(", ");
          lines.push(`    meta: ${metaStr}`);
        }
      }

      if (src.samples.length > 0) {
        lines.push(`    samples:`);
        for (const t of src.samples) {
          const truncated = t.length > 120 ? t.slice(0, 120) + "…" : t;
          lines.push(`      - ${truncated}`);
        }
      }
    }
  }

  return lines.join("\n");
}

// ---- Public API ----

export interface FormatOptions {
  /** Output format (default: structured) */
  format?: ViewFormat;
  /** Max sample texts per source (default: 3) */
  sampleLimit?: number;
}

/**
 * Format SurvivorReport[] for external consumption.
 *
 * - structured: returns FormattedReport as JSON string
 * - compact: short text digest for LLM context
 * - detailed: full human-readable breakdown
 */
export function formatReports(
  reports: SurvivorReport[],
  opts: FormatOptions = {},
): string {
  const format = opts.format ?? "structured";
  const sampleLimit = opts.sampleLimit ?? 3;

  const structured = buildStructured(reports, sampleLimit);

  switch (format) {
    case "compact":
      return renderCompact(structured);
    case "detailed":
      return renderDetailed(structured);
    case "structured":
      structured.format = "structured";
      return JSON.stringify(structured, null, 2);
  }
}

/**
 * Build typed FormattedReport (for programmatic use without serialization).
 */
export function buildReport(
  reports: SurvivorReport[],
  sampleLimit = 3,
): FormattedReport {
  return buildStructured(reports, sampleLimit);
}
