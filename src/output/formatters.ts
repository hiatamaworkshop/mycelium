// ============================================================
// View Layer — formatters for external consumption
// ============================================================
//
// Transforms raw SurvivorReport[] into structured responses
// suitable for agents, LLMs, or downstream services.
//
// Five output modes:
//   compact    — minimal text digest (token-efficient for LLM context)
//   detailed   — full breakdown with per-source stats
//   structured — typed JSON for programmatic consumption
//   digest     — 3-tier per-source output (meta/pure/clusters) + DigestQuery for progressive disclosure
//   manifest   — lightweight source index (~50 tokens/source) for scan-then-drill pattern

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

/** Clean a short snippet — applies cleanText, strips trailing truncation artifacts, limits to 80 chars */
function cleanSnippet(raw: string): string {
  let t = cleanText(raw);
  // Remove trailing incomplete artifacts from truncation
  t = t.replace(/@xmath\d*$/, "");
  t = t.replace(/@$/, "");
  t = t.replace(/\[x\d*$/, "");
  // Flatten newlines for snippets
  t = t.replace(/[\n\r]+/g, " ").replace(/ {2,}/g, " ").trim();
  return t.slice(0, 80);
}

// ---- Context extraction (tag keyword windowing) ----

/** Tag → combined regex for locating keyword hits in chunk text */
const TAG_CONTEXT_PATTERNS: Record<string, RegExp> = {
  // sentinel
  definition: /\b(?:definition|defined (?:as|by)|denoted by|we define)\b/i,
  theorem: /\b(?:theorem|lemma|corollary|proof|proposition)\b/i,
  constraint: /\b(?:necessary condition|sufficient condition|if and only if|implies that|it follows that)\b/i,
  bound: /\b(?:upper bound|lower bound|bounded by|asymptotic(?:ally)?|convergence)\b/i,
  rule: /\b(?:rule|convention|policy)\b/i,
  error: /\b(?:error|bug|fix(?:ed)?)\b/i,
  // herald
  methodology: /\b(?:our method|our approach|technique|algorithm|procedure|framework)\b/i,
  comparison: /\b(?:compared (?:to|with)|outperforms?|baseline|state.of.the.art|prior work)\b/i,
  performance: /\b(?:performance|optimi[sz]|benchmark|latency|throughput)\b/i,
  results: /\b(?:therefore|thus|hence|consequently|as a result)\b/i,
  findings: /\b(?:we demonstrate|we show|we observe|our results|we find)\b/i,
  refactor: /\b(?:refactor(?:ing)?|restructur(?:e|ing))\b/i,
  release: /\b(?:release|deploy|ship)\b/i,
  commit: /\b(?:commit|changelog|migration)\b/i,
  gotcha: /\bgotcha\b/i,
  // summarizer
  caveat: /\b(?:however|in contrast|nevertheless|limitation|assumption)\b/i,
  summary: /\b(?:furthermore|moreover|in addition|overall)\b/i,
  debug: /\b(?:debug(?:ging)?|logging|trace)\b/i,
  monitoring: /\b(?:monitor(?:ing)?|metric|alert(?:ing)?)\b/i,
  dependency: /\b(?:dependenc(?:y|ies)|library|package)\b/i,
  config: /\b(?:config|env|infra|docker)\b/i,
  // spore
  experiment: /\b(?:experiment(?:al)?|measurement|dataset)\b/i,
  hypothesis: /\b(?:hypothesis|we propose|we introduce|we present)\b/i,
  idea: /\b(?:idea|concept)\b/i,
  temporary: /\b(?:temporary|workaround|hack)\b/i,
  obsolete: /\b(?:obsolete|deprecated)\b/i,
  // anchor
  abstract: /\babstract\b/i,
  conclusion: /\bconclusion\b/i,
  crash: /\b(?:crash|outage|fatal)\b/i,
};

const CONTEXT_RADIUS = 40;
const MAX_CONTEXT_WINDOWS = 3;
const FALLBACK_LENGTH = 80;

/**
 * Extract keyword-context windows from chunk text.
 *
 * For each tag keyword found, extracts ±40 chars around the match.
 * Merges overlapping windows. Falls back to first ~80 chars if no hits.
 *
 * @param rawText - Raw chunk text (will be cleaned + flattened)
 * @param hintTags - Source-level survivorTags keys to narrow keyword search
 */
function extractContext(rawText: string, hintTags?: string[]): string {
  const cleaned = cleanText(rawText);
  const flat = cleaned.replace(/[\n\r]+/g, " ").replace(/ {2,}/g, " ").trim();

  if (flat.length <= FALLBACK_LENGTH) return flat;

  // Collect keyword match positions
  const hits: Array<{ start: number; end: number }> = [];

  // Search all known patterns (or just hintTags if provided)
  const tagsToSearch = hintTags ?? Object.keys(TAG_CONTEXT_PATTERNS);
  for (const tag of tagsToSearch) {
    const re = TAG_CONTEXT_PATTERNS[tag];
    if (!re) continue;
    const m = re.exec(flat);
    if (m) {
      hits.push({ start: m.index, end: m.index + m[0].length });
    }
  }

  if (hits.length === 0) {
    return flat.slice(0, FALLBACK_LENGTH - 3) + "...";
  }

  // Sort by position, take top N, merge overlapping windows
  hits.sort((a, b) => a.start - b.start);

  const windows: Array<{ start: number; end: number }> = [];
  for (const h of hits.slice(0, MAX_CONTEXT_WINDOWS)) {
    const ws = Math.max(0, h.start - CONTEXT_RADIUS);
    const we = Math.min(flat.length, h.end + CONTEXT_RADIUS);

    if (windows.length > 0 && ws <= windows[windows.length - 1].end) {
      windows[windows.length - 1].end = we;
    } else {
      windows.push({ start: ws, end: we });
    }
  }

  const parts = windows.map(w => {
    let s = flat.slice(w.start, w.end).trim();
    if (w.start > 0) s = "…" + s;
    if (w.end < flat.length) s = s + "…";
    return s;
  });

  return parts.join(" ");
}

// ---- Output types ----

export type ViewFormat = "compact" | "detailed" | "structured" | "digest" | "manifest";

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

// ---- AI-native role mapping ----

/**
 * Internal species → AI-facing functional role.
 * Roles describe what the chunk DOES in the knowledge structure,
 * not the mycelium metaphor it came from.
 */
const SPECIES_TO_ROLE: Record<string, string> = {
  herald:     "claim",       // asserts findings, results, methodology
  sentinel:   "constraint",  // formal rules, definitions, bounds
  anchor:     "foundation",  // immutable structural elements (abstract, conclusion)
  summarizer: "synthesis",   // consolidation, overview, caveats
  spore:      "hypothesis",  // tentative, exploratory, experimental
};

/** Reverse mapping for query: role → species (for filtering internal data) */
const ROLE_TO_SPECIES: Record<string, string> = {};
for (const [sp, role] of Object.entries(SPECIES_TO_ROLE)) {
  ROLE_TO_SPECIES[role] = sp;
}

function toRole(species: string): string {
  return SPECIES_TO_ROLE[species] ?? species;
}

// ---- Digest types (3-tier: meta / pure / clusters) ----

/** Per-source digest for AI consumption — keyword-context windowed */
export interface SourceDigest {
  meta: {
    sourceId: string;
    collection: string;
    totalChunks: number;
    survivingChunks: number;
    survivalRate: number;
    classification: ClassificationBreakdown;
    consensusRate?: number;
    /** One-line summary derived from pure[0] or sourceMetadata.abstract */
    headline?: string;
    /** Dominant functional role among survivors */
    topRole?: string;
    /** Post-filter tag frequency from surviving chunks */
    survivorTags?: Record<string, number>;
    sourceMetadata?: Record<string, unknown>;
  };
  /** Pure survivors — keyword-context extracted text */
  pure: Array<{ seq: number; text: string; role: string }>;
  /** Merged survivors (clusters) — absorption info + keyword-context text */
  clusters: Array<{
    seq: number;
    size: number;
    depth1: number;
    deep: number;
    role: string;
    text: string;
    /** Species composition of absorbed members mapped to roles */
    composition?: Record<string, number>;
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

// ---- Manifest types (lightweight index) ----

/** Per-source manifest entry — ~50 tokens, for scanning before detail drill-down */
export interface ManifestEntry {
  sourceId: string;
  collection: string;
  totalChunks: number;
  survivingChunks: number;
  survivalRate: number;
  headline?: string;
  topRole?: string;
  survivorTags?: Record<string, number>;
  pureCount: number;
  mergedCount: number;
  consensusRate?: number;
}

export interface ManifestReport {
  format: "manifest";
  timestamp: string;
  summary: {
    totalSources: number;
    totalChunks: number;
    survivingChunks: number;
    survivalRate: number;
  };
  sources: ManifestEntry[];
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

// ---- Post-filter re-aggregation helpers ----

/** Collapse text to a single line, clean artifacts, and truncate to ~120 chars */
function toHeadline(raw: string): string {
  let t = cleanText(raw);
  // Flatten all newlines/tabs to single space
  t = t.replace(/[\n\r\t]+/g, " ");
  // Collapse multiple spaces
  t = t.replace(/ {2,}/g, " ").trim();
  return t.length > 120 ? t.slice(0, 117) + "..." : t;
}

/** Derive a one-line headline (~120 chars) from pure[0] text or sourceMetadata.abstract */
function deriveHeadline(
  r: SurvivorReport,
  pureEntries: Array<{ seq: number; text: string; species: string }>,
): string | undefined {
  // Prefer pure[0] text (already cleaned by buildDigest, but re-clean for headline)
  if (pureEntries.length > 0 && pureEntries[0].text.length > 0) {
    return toHeadline(pureEntries[0].text);
  }
  // Fallback: sourceMetadata.abstract
  const abstract = r.sourceMetadata?.abstract;
  if (typeof abstract === "string" && abstract.length > 0) {
    return toHeadline(abstract);
  }
  return undefined;
}

/** Find the dominant functional role among survivors */
function deriveTopRole(r: SurvivorReport): string | undefined {
  const sp = r.species;
  let best: string | undefined;
  let bestN = 0;
  for (const [k, v] of Object.entries(sp)) {
    if (v > bestN) { best = k; bestN = v; }
  }
  return best ? toRole(best) : undefined;
}

// ---- Digest builder (3-tier, query-driven) ----

function buildDigest(reports: SurvivorReport[], query?: DigestQuery): DigestReport {
  // Filter by sourceIds if specified
  let filtered = reports;
  if (query?.sourceIds && query.sourceIds.length > 0) {
    const ids = new Set(query.sourceIds);
    filtered = reports.filter(r => ids.has(r.sourceId));
  }

  const totalChunks = filtered.reduce((s, r) => s + r.totalChunks, 0);
  const survivingChunks = filtered.reduce((s, r) => s + r.survivingChunks, 0);

  // Determine which tiers to include (meta is always present)
  const tiers = new Set(query?.tiers ?? ["meta", "pure", "clusters"]);
  const includePure = tiers.has("pure");
  const includeClusters = tiers.has("clusters");

  // Context radius override
  const radius = query?.contextRadius ?? CONTEXT_RADIUS;

  const sources: SourceDigest[] = filtered.map(r => {
    // Hint tags for keyword search scope (from source-level survivorTags)
    const hintTags = r.survivorTags ? Object.keys(r.survivorTags) : undefined;

    // Context extractor with optional radius override
    const extract = (text: string) =>
      radius !== CONTEXT_RADIUS
        ? extractContextWithRadius(text, radius, hintTags)
        : extractContext(text, hintTags);

    // Resolve role filter → internal species names for matching
    const roleFilter = query?.roles && query.roles.length > 0
      ? new Set(query.roles.map(r => ROLE_TO_SPECIES[r] ?? r))
      : undefined;

    // Build pure tier
    let pure: SourceDigest["pure"] = [];
    if (includePure) {
      pure = (r.pureSurvivors ?? []).map(c => ({
        seq: c.chunkSeqNo,
        text: extract(c.text),
        role: toRole(c.species),
      }));
      // Role filter
      if (roleFilter) {
        pure = pure.filter(p => {
          const sp = ROLE_TO_SPECIES[p.role] ?? p.role;
          return roleFilter.has(sp);
        });
      }
      // Limit
      if (query?.maxPure != null) {
        pure = pure.slice(0, query.maxPure);
      }
    }

    // Build clusters tier
    let clusters: SourceDigest["clusters"] = [];
    if (includeClusters) {
      clusters = (r.mergerClusters ?? []).map(c => {
        // Map species composition to role names
        let roleComp: Record<string, number> | undefined;
        if (c.composition) {
          roleComp = {};
          for (const [sp, count] of Object.entries(c.composition)) {
            if (count != null && count > 0) {
              const role = toRole(sp);
              roleComp[role] = (roleComp[role] ?? 0) + count;
            }
          }
          if (Object.keys(roleComp).length === 0) roleComp = undefined;
        }
        return {
          seq: c.originChunkSeqNo,
          size: c.clusterSize,
          depth1: c.depth1Count,
          deep: c.deepChainCount,
          role: toRole(c.species),
          text: extract(c.sampleText),
          composition: roleComp,
        };
      });
      // Min cluster size filter
      if (query?.minClusterSize != null) {
        clusters = clusters.filter(c => c.size >= query.minClusterSize!);
      }
      // Role filter
      if (roleFilter) {
        clusters = clusters.filter(c => {
          const sp = ROLE_TO_SPECIES[c.role] ?? c.role;
          return roleFilter.has(sp);
        });
      }
      // Limit
      if (query?.maxClusters != null) {
        clusters = clusters.slice(0, query.maxClusters);
      }
    }

    // Post-filter re-aggregation: headline, topRole, survivorTags
    // (always derived from full data, not filtered subset)
    const fullPure = (r.pureSurvivors ?? []).map(c => ({
      seq: c.chunkSeqNo, text: c.text, species: c.species,
    }));
    const headline = deriveHeadline(r, fullPure);
    const topRole = deriveTopRole(r);

    return {
      meta: {
        sourceId: r.sourceId,
        collection: r.collection,
        totalChunks: r.totalChunks,
        survivingChunks: r.survivingChunks,
        survivalRate: Math.round(r.survivalRate * 1000) / 1000,
        classification: { ...r.classificationBreakdown },
        consensusRate: r.consensusRate != null ? Math.round(r.consensusRate * 1000) / 1000 : undefined,
        headline,
        topRole,
        survivorTags: r.survivorTags,
        sourceMetadata: r.sourceMetadata,
      },
      pure,
      clusters,
    };
  });

  return {
    format: "digest",
    timestamp: new Date().toISOString(),
    summary: {
      totalSources: filtered.length,
      totalChunks,
      survivingChunks,
      survivalRate: totalChunks > 0 ? Math.round((survivingChunks / totalChunks) * 1000) / 1000 : 0,
      classification: sumBreakdown(filtered),
    },
    sources,
  };
}

/** extractContext variant with custom radius (for query-driven override) */
function extractContextWithRadius(rawText: string, radius: number, hintTags?: string[]): string {
  const cleaned = cleanText(rawText);
  const flat = cleaned.replace(/[\n\r]+/g, " ").replace(/ {2,}/g, " ").trim();

  if (flat.length <= FALLBACK_LENGTH) return flat;

  const hits: Array<{ start: number; end: number }> = [];
  const tagsToSearch = hintTags ?? Object.keys(TAG_CONTEXT_PATTERNS);
  for (const tag of tagsToSearch) {
    const re = TAG_CONTEXT_PATTERNS[tag];
    if (!re) continue;
    const m = re.exec(flat);
    if (m) hits.push({ start: m.index, end: m.index + m[0].length });
  }

  if (hits.length === 0) return flat.slice(0, FALLBACK_LENGTH - 3) + "...";

  hits.sort((a, b) => a.start - b.start);
  const windows: Array<{ start: number; end: number }> = [];
  for (const h of hits.slice(0, MAX_CONTEXT_WINDOWS)) {
    const ws = Math.max(0, h.start - radius);
    const we = Math.min(flat.length, h.end + radius);
    if (windows.length > 0 && ws <= windows[windows.length - 1].end) {
      windows[windows.length - 1].end = we;
    } else {
      windows.push({ start: ws, end: we });
    }
  }

  return windows.map(w => {
    let s = flat.slice(w.start, w.end).trim();
    if (w.start > 0) s = "…" + s;
    if (w.end < flat.length) s = s + "…";
    return s;
  }).join(" ");
}

// ---- Manifest builder (lightweight index) ----

function buildManifest(reports: SurvivorReport[]): ManifestReport {
  const totalChunks = reports.reduce((s, r) => s + r.totalChunks, 0);
  const survivingChunks = reports.reduce((s, r) => s + r.survivingChunks, 0);

  const sources: ManifestEntry[] = reports.map(r => {
    // Reuse shared headline derivation
    const pureSurvivors = r.pureSurvivors ?? [];
    const pureForHeadline = pureSurvivors.map(c => ({
      seq: c.chunkSeqNo, text: c.text, species: c.species,
    }));
    const headline = deriveHeadline(r, pureForHeadline);
    const topRole = deriveTopRole(r);
    const bd = r.classificationBreakdown;

    return {
      sourceId: r.sourceId,
      collection: r.collection,
      totalChunks: r.totalChunks,
      survivingChunks: r.survivingChunks,
      survivalRate: Math.round(r.survivalRate * 1000) / 1000,
      headline,
      topRole,
      survivorTags: r.survivorTags,
      pureCount: bd.pure,
      mergedCount: bd.merged,
      consensusRate: r.consensusRate != null ? Math.round(r.consensusRate * 1000) / 1000 : undefined,
    };
  });

  return {
    format: "manifest",
    timestamp: new Date().toISOString(),
    summary: {
      totalSources: reports.length,
      totalChunks,
      survivingChunks,
      survivalRate: totalChunks > 0 ? Math.round((survivingChunks / totalChunks) * 1000) / 1000 : 0,
    },
    sources,
  };
}

// ---- Digest query (progressive disclosure) ----

/**
 * Query parameters for selective digest access.
 *
 * Progressive disclosure pattern:
 *   1. manifest (no query) → scan all sources
 *   2. digest + sourceIds only → meta for selected sources
 *   3. digest + tiers/roles/minClusterSize → filtered detail
 *
 * AI reads sequentially — meta arrives first for routing decisions,
 * detail tiers are included only when explicitly requested.
 *
 * Available roles: claim, constraint, foundation, synthesis, hypothesis
 */
export interface DigestQuery {
  /** Filter to specific sourceIds (default: all) */
  sourceIds?: string[];
  /** Which tiers to include (default: all). "meta" is always included. */
  tiers?: Array<"meta" | "pure" | "clusters">;
  /** Filter entries by functional role: claim|constraint|foundation|synthesis|hypothesis */
  roles?: string[];
  /** Only include clusters with size >= N (default: 0) */
  minClusterSize?: number;
  /** Override context extraction radius (default: 40) */
  contextRadius?: number;
  /** Max pure entries per source (default: unlimited) */
  maxPure?: number;
  /** Max cluster entries per source (default: unlimited) */
  maxClusters?: number;
}

// ---- Public API ----

export interface FormatOptions {
  /** Output format (default: structured) */
  format?: ViewFormat;
  /** Max sample texts per source (default: 3) */
  sampleLimit?: number;
  /** Progressive disclosure query for digest format */
  query?: DigestQuery;
}

/**
 * Format SurvivorReport[] for external consumption.
 *
 * - structured: returns FormattedReport as JSON string
 * - compact: short text digest for LLM context
 * - detailed: full human-readable breakdown
 * - digest: 3-tier per-source output (meta/pure/clusters), supports DigestQuery
 * - manifest: lightweight meta-only index (~50 tokens/source)
 *
 * Progressive disclosure (digest + query):
 *   formatReports(r, { format: "digest", query: { sourceIds: ["arxiv:17"], tiers: ["meta"] } })
 *   → meta only for routing decision
 *
 *   formatReports(r, { format: "digest", query: { sourceIds: ["arxiv:17"], tiers: ["clusters"], roles: ["claim"], minClusterSize: 3 } })
 *   → filtered clusters for deep dive
 */
export function formatReports(
  reports: SurvivorReport[],
  opts: FormatOptions = {},
): string {
  const format = opts.format ?? "structured";
  const sampleLimit = opts.sampleLimit ?? 3;

  switch (format) {
    case "digest":
      return JSON.stringify(buildDigest(reports, opts.query), null, 2);
    case "manifest":
      return JSON.stringify(buildManifest(reports), null, 2);
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
  query?: DigestQuery,
): DigestReport {
  return buildDigest(reports, query);
}

/**
 * Build typed ManifestReport (for programmatic use without serialization).
 */
export function buildManifestReport(
  reports: SurvivorReport[],
): ManifestReport {
  return buildManifest(reports);
}
