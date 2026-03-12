// ============================================================
// World Configuration — isolation mode & world definitions
// ============================================================
//
// Three isolation modes:
//   shared  — all source collections in one mycelium world (legacy)
//   domain  — each source collection becomes its own world
//   custom  — user-specified groupings via WORLD_MAP
//
// Usage:
//   ISOLATION=domain SOURCE_COLLECTIONS=source_arxiv,source_patent
//   → worlds: mycelium_arxiv, mycelium_patent
//
//   ISOLATION=custom WORLD_MAP="science=source_arxiv,source_pubmed;news=source_news"
//   → worlds: mycelium_science, mycelium_news

import type { SourceCollectionConfig } from "./slot-allocator.js";

// ---- Types ----

export type IsolationMode = "shared" | "domain" | "custom";

export interface WorldDefinition {
  /** Human-readable world name (e.g. "arxiv", "science") */
  name: string;
  /** Mycelium Qdrant collection for this world */
  collection: string;
  /** Source collections to load into this world */
  sourceCollections: SourceCollectionConfig[];
}

// ---- Parsing ----

export function parseIsolationMode(env: string | undefined): IsolationMode {
  const mode = (env ?? "shared").toLowerCase().trim();
  if (mode === "domain" || mode === "custom") return mode;
  return "shared";
}

export function buildWorldDefinitions(
  mode: IsolationMode,
  sourceConfigs: SourceCollectionConfig[],
  worldMapRaw: string | undefined,
  defaultCollection: string,
): WorldDefinition[] {
  switch (mode) {
    case "shared":
      return [{
        name: "shared",
        collection: defaultCollection,
        sourceCollections: sourceConfigs,
      }];

    case "domain":
      return sourceConfigs.map(cfg => {
        const name = deriveWorldName(cfg.collection);
        return {
          name,
          collection: `mycelium_${name}`,
          sourceCollections: [cfg],
        };
      });

    case "custom":
      return parseWorldMap(worldMapRaw ?? "", sourceConfigs);
  }
}

// ---- Helpers ----

/** Strip common prefixes to derive a clean world name */
function deriveWorldName(collectionName: string): string {
  return collectionName
    .replace(/^source_/, "")
    .replace(/^src_/, "");
}

/**
 * Parse WORLD_MAP format: "name1=col1,col2;name2=col3"
 * Each semicolon-separated entry is a world.
 */
function parseWorldMap(
  raw: string,
  sourceConfigs: SourceCollectionConfig[],
): WorldDefinition[] {
  if (!raw.trim()) {
    throw new Error(
      "ISOLATION=custom requires WORLD_MAP env var. " +
      'Format: "name1=col1,col2;name2=col3"',
    );
  }

  const configByName = new Map(sourceConfigs.map(c => [c.collection, c]));
  const worlds: WorldDefinition[] = [];

  for (const entry of raw.split(";")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;

    const eqIdx = trimmed.indexOf("=");
    if (eqIdx < 0) {
      throw new Error(`Invalid WORLD_MAP entry (missing '='): "${trimmed}"`);
    }

    const name = trimmed.slice(0, eqIdx).trim();
    const colNames = trimmed.slice(eqIdx + 1).split(",").map(s => s.trim()).filter(Boolean);

    if (!name) throw new Error(`Empty world name in WORLD_MAP: "${trimmed}"`);
    if (colNames.length === 0) throw new Error(`No source collections for world "${name}"`);

    const sources: SourceCollectionConfig[] = [];
    for (const col of colNames) {
      const cfg = configByName.get(col);
      if (!cfg) {
        throw new Error(
          `WORLD_MAP references unknown source collection "${col}". ` +
          `Available: ${[...configByName.keys()].join(", ")}`,
        );
      }
      sources.push(cfg);
    }

    worlds.push({
      name,
      collection: `mycelium_${name}`,
      sourceCollections: sources,
    });
  }

  if (worlds.length === 0) {
    throw new Error("WORLD_MAP produced no worlds");
  }

  return worlds;
}
