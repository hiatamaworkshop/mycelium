"""
prepare_source.py — HuggingFace dataset → Source Qdrant
Embeds text with all-MiniLM-L6-v2 (384d) and assigns tags via keyword matching.
Long texts are split into overlapping chunks (--chunk-size / --chunk-overlap).

Usage:
  python scripts/prepare_source.py [--dataset DATASET] [--split SPLIT] [--limit N]
                                   [--collection NAME] [--qdrant-url URL]
                                   [--text-field FIELD] [--id-field FIELD]
                                   [--chunk-size N] [--chunk-overlap N]

Example (short texts, no chunking):
  python scripts/prepare_source.py --dataset "ag_news" --split "train[:500]" --text-field "text"

Example (long texts, with chunking):
  python scripts/prepare_source.py --dataset "ccdv/arxiv-summarization" --split "train[:5]" \
    --text-field "article" --chunk-size 500 --chunk-overlap 50
"""

import argparse
import re
import time
import uuid

from datasets import load_dataset
from qdrant_client import QdrantClient
from qdrant_client.models import Distance, PointStruct, VectorParams
from sentence_transformers import SentenceTransformer

# ---------------------------------------------------------------------------
# Tag keyword rules — mirrors species-mapping.json
# Priority order: first match wins (same as resolveByTags in node.ts)
# ---------------------------------------------------------------------------

TAG_RULES: list[tuple[str, list[str]]] = [
    # anchor — paper backbone: abstract, conclusion, critical failures
    ("abstract",   [r"\babstract\b"]),
    ("conclusion", [r"\bconclusion(?:s)?\b", r"\bconcluding\b"]),
    ("error",      [r"\berror\b", r"\bexception\b", r"\bfail(?:ure|ed)?\b", r"\bcrash(?:ed|es)?\b"]),
    ("bug",        [r"\bbug\b", r"\bdefect\b", r"\bregress(?:ion)?\b"]),
    ("fix",        [r"\bfix(?:ed|es)?\b", r"\bpatch(?:ed)?\b", r"\bresolv(?:ed|es)?\b", r"\bhotfix\b"]),

    # sentinel — rules, policies, methodology
    ("methodology",[r"\bmethodology\b", r"\bmethod(?:s)?\b"]),
    ("config",     [r"\bconfig(?:uration)?\b", r"\bsetting\b", r"\bsetup\b", r"\binstall(?:ation)?\b"]),
    ("env",        [r"\benvironment\b", r"\benv\b", r"\binfra(?:structure)?\b", r"\bdocker\b",
                    r"\bkubernetes\b", r"\bk8s\b", r"\bport\b", r"\bpath\b"]),
    ("rule",       [r"\brule\b", r"\bconvention\b", r"\bstandard\b", r"\bguideline\b"]),
    ("policy",     [r"\bpolicy\b", r"\bcompliance\b", r"\bsecurity\b", r"\bvalidat(?:ion|e)\b",
                    r"\bconstraint\b", r"\brequire(?:ment|d)?\b", r"\blint\b", r"\baudit\b"]),

    # herald — results, findings, releases, changes
    ("results",    [r"\bresult(?:s)?\b", r"\bfinding(?:s)?\b", r"\boutcome(?:s)?\b"]),
    ("release",    [r"\brelease(?:d|s)?\b", r"\bdeploy(?:ed|ment)?\b", r"\bship(?:ped)?\b",
                    r"\blaunch(?:ed)?\b"]),
    ("commit",     [r"\bcommit\b", r"\bchangelog\b", r"\bmigrat(?:ion|e|ing)\b",
                    r"\bbreaking\b", r"\bdeprecate[ds]?\b", r"\bannounce(?:ment)?\b",
                    r"\bupdate[ds]?\b"]),

    # spore — ideas, drafts, hypotheses, experiments
    ("idea",       [r"\bidea\b", r"\bconcept\b", r"\bbrainstorm\b"]),
    ("draft",      [r"\bdraft\b", r"\bwip\b", r"\bwork[- ]in[- ]progress\b"]),
    ("hypothesis", [r"\bhypothesis\b", r"\bexperiment(?:al)?\b", r"\bprototyp(?:e|ing)\b",
                    r"\bpropos(?:al|ed|e)\b", r"\btodo\b", r"\bquestion\b",
                    r"\bexplor(?:e|ation|ing)\b", r"\bsuggest(?:ion|ed)?\b"]),

    # summarizer — summaries, reports, analysis (catch-all flavor)
    ("summary",    [r"\bsummar(?:y|ize|ies)\b", r"\bdigest\b", r"\boverview\b"]),
    ("report",     [r"\breport\b", r"\blog\b", r"\breview\b", r"\banalys[ie]s\b",
                    r"\bcompar(?:ison|e|ing)\b", r"\bbenchmark\b", r"\bsurvey\b"]),
]

# Precompile
_COMPILED_RULES: list[tuple[str, list[re.Pattern]]] = [
    (tag, [re.compile(p, re.IGNORECASE) for p in patterns])
    for tag, patterns in TAG_RULES
]


def chunk_text(text: str, chunk_size: int, overlap: int) -> list[str]:
    """Split text into word-boundary chunks with overlap."""
    words = text.split()
    if len(words) <= chunk_size:
        return [text]
    chunks: list[str] = []
    start = 0
    while start < len(words):
        end = start + chunk_size
        chunks.append(" ".join(words[start:end]))
        start += chunk_size - overlap
    return chunks


def assign_tags(text: str, max_tags: int = 3) -> list[str]:
    """Assign tags by keyword matching. Returns up to max_tags unique tags."""
    matched: list[str] = []
    seen: set[str] = set()
    for tag, patterns in _COMPILED_RULES:
        if tag in seen:
            continue
        for pat in patterns:
            if pat.search(text):
                matched.append(tag)
                seen.add(tag)
                break
        if len(matched) >= max_tags:
            break
    return matched


def main():
    parser = argparse.ArgumentParser(description="Embed HuggingFace dataset → Source Qdrant")
    parser.add_argument("--dataset", default="ag_news", help="HuggingFace dataset name")
    parser.add_argument("--split", default="train[:500]", help="Dataset split (e.g. train[:500])")
    parser.add_argument("--limit", type=int, default=0, help="Additional row limit (0=no limit)")
    parser.add_argument("--collection", default="source", help="Qdrant collection name")
    parser.add_argument("--qdrant-url", default="http://localhost:6333", help="Qdrant URL")
    parser.add_argument("--text-field", default="text", help="Text column name in dataset")
    parser.add_argument("--id-field", default="", help="ID column name (empty=auto-generate)")
    parser.add_argument("--batch-size", type=int, default=64, help="Embedding batch size")
    parser.add_argument("--chunk-size", type=int, default=0,
                        help="Chunk size in words (0=no chunking). Recommended: 80-120 for MiniLM")
    parser.add_argument("--chunk-overlap", type=int, default=15,
                        help="Overlap words between chunks (default: 15)")
    parser.add_argument("--force", action="store_true",
                        help="Delete existing collection before creating. Without this flag, "
                             "existing collections are protected (upsert/append only)")
    args = parser.parse_args()

    # ---- Load dataset ----
    print(f"Loading dataset: {args.dataset} [{args.split}]")
    ds = load_dataset(args.dataset, split=args.split)
    if args.limit > 0:
        ds = ds.select(range(min(args.limit, len(ds))))
    print(f"  → {len(ds)} rows loaded")

    raw_texts = ds[args.text_field]
    has_id = args.id_field and args.id_field in ds.column_names
    raw_ids = ds[args.id_field] if has_id else list(range(len(ds)))

    # ---- Chunk (if needed) ----
    texts: list[str] = []
    source_ids: list[str] = []
    chunk_seq_nos: list[int] = []
    chunk_total_counts: list[int] = []  # total chunks per source doc

    if args.chunk_size > 0:
        print(f"Chunking {len(raw_texts)} documents (chunk_size={args.chunk_size}, overlap={args.chunk_overlap}) ...")
        for i, raw in enumerate(raw_texts):
            chunks = chunk_text(raw, args.chunk_size, args.chunk_overlap)
            for seq, chunk in enumerate(chunks):
                texts.append(chunk)
                source_ids.append(str(raw_ids[i]))
                chunk_seq_nos.append(seq)
                chunk_total_counts.append(len(chunks))
        print(f"  → {len(raw_texts)} docs → {len(texts)} chunks (avg {len(texts)/len(raw_texts):.1f} chunks/doc)")
    else:
        texts = list(raw_texts)
        source_ids = [str(rid) for rid in raw_ids]
        chunk_seq_nos = [0] * len(texts)
        chunk_total_counts = [1] * len(texts)

    # ---- Embed ----
    print("Loading model: all-MiniLM-L6-v2")
    model = SentenceTransformer("all-MiniLM-L6-v2")
    print(f"Encoding {len(texts)} texts (batch_size={args.batch_size}) ...")
    t0 = time.time()
    vectors = model.encode(texts, batch_size=args.batch_size, show_progress_bar=True)
    elapsed = time.time() - t0
    print(f"  → Encoded in {elapsed:.1f}s ({len(texts)/elapsed:.0f} texts/s)")

    # ---- Assign tags ----
    print("Assigning tags ...")
    tag_stats: dict[str, int] = {}
    all_tags: list[list[str]] = []
    for idx, text in enumerate(texts):
        tags = assign_tags(text)
        # Position-based tags for chunked documents (structural backbone)
        total = chunk_total_counts[idx]
        if total > 1:
            seq = chunk_seq_nos[idx]
            if seq == 0 and "abstract" not in tags:
                tags.insert(0, "abstract")
            if seq >= total - 2 and "conclusion" not in tags:
                tags.insert(0, "conclusion")
        all_tags.append(tags)
        for t in tags:
            tag_stats[t] = tag_stats.get(t, 0) + 1

    no_tag_count = sum(1 for t in all_tags if len(t) == 0)
    print(f"  → Tag distribution: {dict(sorted(tag_stats.items(), key=lambda x: -x[1]))}")
    print(f"  → No tags (→ default summarizer): {no_tag_count}/{len(texts)}")

    # ---- Build points ----
    now_ms = int(time.time() * 1000)
    points = [
        PointStruct(
            id=str(uuid.uuid4()),
            vector=vec.tolist(),
            payload={
                "text": texts[i],
                "sourceId": source_ids[i],
                "chunkSeqNo": chunk_seq_nos[i],
                "tags": all_tags[i],
                "timestamp": now_ms,
            },
        )
        for i, vec in enumerate(vectors)
    ]

    # ---- Upsert to Qdrant ----
    client = QdrantClient(url=args.qdrant_url)

    collections = [c.name for c in client.get_collections().collections]
    if args.collection in collections:
        if args.force:
            client.delete_collection(args.collection)
            print(f"  → Deleted existing collection '{args.collection}' (--force)")
        else:
            existing = client.count(args.collection).count
            print(f"  → Collection '{args.collection}' exists ({existing} points). Appending. Use --force to recreate.")

    if args.collection not in [c.name for c in client.get_collections().collections]:
        client.create_collection(
            collection_name=args.collection,
            vectors_config=VectorParams(size=384, distance=Distance.COSINE),
        )
        print(f"  → Created collection '{args.collection}' (384d, cosine)")

    # Batch upsert
    UPSERT_BATCH = 100
    for i in range(0, len(points), UPSERT_BATCH):
        batch = points[i : i + UPSERT_BATCH]
        client.upsert(collection_name=args.collection, points=batch)
    print(f"  → Upserted {len(points)} points")

    print("\nDone. Source Qdrant is ready for mycelium loader.")


if __name__ == "__main__":
    main()
