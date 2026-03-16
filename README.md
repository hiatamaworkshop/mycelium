# Mycelium

Bio-inspired semantic filtering engine. Ecosystem simulation for knowledge quality assessment.

## What it does

Mycelium takes embedding vectors + text and runs them through a biological ecosystem simulation.
Nodes compete, cooperate, merge, and die over 60 ticks. What survives is classified:

| Classification | Meaning |
|----------------|---------|
| **pure** | Unique knowledge — survived without merging |
| **merged** | Cluster center — absorbed related content |
| **loner** | Isolated — no social interaction, died alone |
| **redundant** | Duplicate — too similar to another, absorbed early |
| **dead** | Outcompeted — lost in social dynamics |

## Quick start

```bash
npm install && npm run build

# Filter from any Qdrant collection
SOURCE_QDRANT_URL=http://localhost:6333 \
SOURCE_COLLECTIONS=my_collection \
VIEW_FORMAT=compact \
npx tsx src/loader/main.ts
```

No dedicated Qdrant instance needed. Filtering runs entirely in-memory.

## How it works

```
Source Qdrant → scroll → slot allocator → IsolatedRunner (in-memory)
                                            ├─ inject (species assign, external weight → w)
                                            ├─ 60 ticks (feelings → action → interaction → death)
                                            ├─ consensus (10 runs, majority vote)
                                            └─ harvest → pure / merged / loner / redundant / dead
                                                           ↓
                                                    digest / manifest / compact / JSON
```

Each node has:
- **Species** (anchor, sentinel, herald, summarizer, spore) — determines personality
- **Feelings** (vigor, dread, kinship, hunger) — computed from self state + environment
- **Actions** (signal, merge, bequeath, survive) — chosen by personality × feelings
- **Resonance** — memory of past interactions with each species

Merge direction: higher `w` always survives as cluster center.

## External service integration

Payload auto-normalization maps common schemas:

| External field | Maps to | Example |
|---------------|---------|---------|
| `summary` + `content` | `text` | engram |
| `projectId` | `sourceId` | engram |
| `weight` | initial `w` [0.3, 1.5] | engram |

```bash
# Read directly from engram's Qdrant
SOURCE_QDRANT_URL=http://localhost:6333 \
SOURCE_COLLECTIONS=engram \
VIEW_FORMAT=digest \
npx tsx src/loader/main.ts
```

## Cross-file affinity

Discover semantic relationships between sources:

```bash
CROSS_FILE=true \
SOURCE_QDRANT_URL=http://localhost:6333 \
SOURCE_COLLECTIONS=engram \
npx tsx src/loader/main.ts
```

Survivors from 1st pass are converted to herald (social species) and mixed.
Output: affinity matrix (merge count + cosine), per-source loner/resonance stats.

## Output formats

| Format | Use case |
|--------|----------|
| `compact` | One-line summary per source |
| `digest` | Structured JSON (meta + pure + clusters) for AI agents |
| `manifest` | ~50 tokens/source index for scan → drill-down |
| (default) | Raw SurvivorReport JSON |

## Key environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `SOURCE_QDRANT_URL` | `QDRANT_URL` | Source data Qdrant endpoint |
| `SOURCE_COLLECTIONS` | `source` | Comma-separated collection names |
| `FILTER_SOURCE_IDS` | (all) | Filter specific sourceIds |
| `CONSENSUS_RUNS` | `10` | Number of voting runs |
| `TARGET_TICKS` | `60` | Simulation length |
| `FILTER_HARDNESS` | `mid` | `soft` / `mid` / `hard` |
| `VIEW_FORMAT` | (raw) | Output format |
| `CROSS_FILE` | `false` | Enable cross-file affinity |

## Data preparation (for raw text)

```bash
# Embed + chunk + upload to Qdrant
python scripts/process_source.py data/raw/my_data.jsonl \
  --chunk-size 100 --collection source_mydata \
  --qdrant-url http://localhost:6333
```

## Documentation

- [USAGE.md](docs/USAGE.md) — Full usage guide
- [DIGEST_FORMAT.md](docs/DIGEST_FORMAT.md) — Digest output specification
- [CHANGELOG.md](docs/CHANGELOG.md) — Design decisions and test results
- [CONSENSUS_DESIGN.md](docs/CONSENSUS_DESIGN.md) — Consensus voting design
