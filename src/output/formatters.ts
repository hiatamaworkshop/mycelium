// ============================================================
// View Layer — formatters for external consumption
// ============================================================
//
// Transforms raw SurvivorReport[] into structured responses
// suitable for agents, LLMs, or downstream services.
//
// Four output modes:
//   compact    — minimal text digest (token-efficient for LLM context)
//   detailed   — full breakdown with per-source stats
//   structured — typed JSON for programmatic consumption
//   digest     — 4-tier per-source output (meta/pure/clusters/survivors/dead)

import type {
  SurvivorReport, ClassificationBreakdown,
  ChunkDetail, ClusterDetail, DeadBrief,
} from "../loader/feed-instance.js";

// ---- Text cleaning ----

/**
 * Clean LaTeX artifacts and noise from academic text.
 * Preserves variable identity (@xmath42 → [x42]) for cross-reference.
 */
export function cleanText(raw: string): string {
  let t = raw;
  // @xmath{N} → [x{N}]
  t = t.replace(/@xmath(\d+)/g, "[x$1]");
  // @xcite → [ref]
  t = t.replace(/@xcite/g, "[ref]");
  // LaTeX commands: \command{...} → content, bare \command → remove
  t = t.replace(/\\[a-z]+\{([^}]*)\}/g, "$1");
  t = t.replace(/\\[a-z]+/g, "");
  // Strip table fragments (lines with ≥5 & characters)
  t = t.replace(/^.*(?:&.*){4,}&.*$/gm, "[table]");
  // Collapse excessive whitespace
  t = t.replace(/\n{3,}/g, "\n\n");
  t = t.replace(/[ \t]{3,}/g, "  ");
  return t.trim();
}

// ---- Output types ----

export type ViewFormat = "compact" | "detailed" | "structured" | "digest";

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

// ---- Digest types (4-tier) ----

/** Per-source 4-tier digest for AI consumption */
export interface SourceDigest {
  meta: {
    sourceId: string;
    collection: string;
    totalChunks: number;
    survivingChunks: number;
    survivalRate: number;
    classification: ClassificationBreakdown;
    consensusRate?: number;
    sourceMetadata?: Record<string, unknown>;
  };
  pure: Array<{ seq: number; text: string; species: string }>;
  clusters: Array<{
    seq: number;
    clusterSize: number;
    depth1: number;
    deep: number;
    species: string;
    sample: string;
  }>;
  survivors: Array<{ seq: number; text: string; species: string; cls: string }>;
  dead: Array<{
    seq: number;
    cls: string;
    snippet: string;
    cause?: string;
    cosine?: number;
    posRes?: number;
  }>;
}

export interface DigestReport {
  format: "digest";
  timestamp: string;
  summary: {
    totalSources: number;
    totalChunks: number;
    survivingChunks: number;
    survivalRate: number;
    classification: ClassificationBreakdown;
  };
  sources: SourceDigest[];
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

// ---- Digest builder (4-tier) ----

function buildDigest(reports: SurvivorReport[], deadLimit: number): DigestReport {
  const totalChunks = reports.reduce((s, r) => s + r.totalChunks, 0);
  const survivingChunks = reports.reduce((s, r) => s + r.survivingChunks, 0);

  const sources: SourceDigest[] = reports.map(r => {
    const pure = (r.pureSurvivors ?? []).map(c => ({
      seq: c.chunkSeqNo,
      text: cleanText(c.text),
      species: c.species,
    }));

    const clusters = (r.mergerClusters ?? []).map(c => ({
      seq: c.originChunkSeqNo,
      clusterSize: c.clusterSize,
      depth1: c.depth1Count,
      deep: c.deepChainCount,
      species: c.species,
      sample: cleanText(c.sampleText),
    }));

    const survivors = (r.chunkDetails ?? []).map(c => ({
      seq: c.chunkSeqNo,
      text: cleanText(c.text),
      species: c.species,
      cls: c.classification,
    }));

    const dead = (r.deadBriefs ?? []).slice(0, deadLimit).map(d => ({
      seq: d.chunkSeqNo,
      cls: d.classification,
      snippet: d.snippet.slice(0, 80),
      cause: d.cause,
      cosine: d.cosine != null ? Math.round(d.cosine * 1000) / 1000 : undefined,
      posRes: d.posRes != null ? Math.round(d.posRes * 1000) / 1000 : undefined,
    }));

    return {
      meta: {
        sourceId: r.sourceId,
        collection: r.collection,
        totalChunks: r.totalChunks,
        survivingChunks: r.survivingChunks,
        survivalRate: r.survivalRate,
        classification: { ...r.classificationBreakdown },
        consensusRate: r.consensusRate,
        sourceMetadata: r.sourceMetadata,
      },
      pure,
      clusters,
      survivors,
      dead,
    };
  });

  return {
    format: "digest",
    timestamp: new Date().toISOString(),
    summary: {
      totalSources: reports.length,
      totalChunks,
      survivingChunks,
      survivalRate: totalChunks > 0 ? survivingChunks / totalChunks : 0,
      classification: sumBreakdown(reports),
    },
    sources,
  };
}

// ---- Public API ----

export interface FormatOptions {
  /** Output format (default: structured) */
  format?: ViewFormat;
  /** Max sample texts per source (default: 3) */
  sampleLimit?: number;
  /** Max dead briefs per source in digest mode (default: 50) */
  deadLimit?: number;
}

/**
 * Format SurvivorReport[] for external consumption.
 *
 * - structured: returns FormattedReport as JSON string
 * - compact: short text digest for LLM context
 * - detailed: full human-readable breakdown
 * - digest: 4-tier per-source output (meta/pure/clusters/survivors/dead)
 */
export function formatReports(
  reports: SurvivorReport[],
  opts: FormatOptions = {},
): string {
  const format = opts.format ?? "structured";
  const sampleLimit = opts.sampleLimit ?? 3;
  const deadLimit = opts.deadLimit ?? 50;

  switch (format) {
    case "digest":
      return JSON.stringify(buildDigest(reports, deadLimit), null, 2);
    case "compact": {
      const structured = buildStructured(reports, sampleLimit);
      return renderCompact(structured);
    }
    case "detailed": {
      const structured = buildStructured(reports, sampleLimit);
      return renderDetailed(structured);
    }
    case "structured": {
      const structured = buildStructured(reports, sampleLimit);
      return JSON.stringify(structured, null, 2);
    }
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

/**
 * Build typed DigestReport (for programmatic use without serialization).
 */
export function buildDigestReport(
  reports: SurvivorReport[],
  deadLimit = 50,
): DigestReport {
  return buildDigest(reports, deadLimit);
}
