"""
prepare_source.py — HuggingFace dataset → Source Qdrant
Embeds text with all-MiniLM-L6-v2 (384d) and assigns tags via keyword matching.

Usage:
  python scripts/prepare_source.py [--dataset DATASET] [--split SPLIT] [--limit N]
                                   [--collection NAME] [--qdrant-url URL]
                                   [--text-field FIELD] [--id-field FIELD]

Example:
  python scripts/prepare_source.py --dataset "ag_news" --split "train[:500]" --text-field "text"
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
    # anchor — immovable foundation: errors, infra, env, hard facts
    ("error",      [r"\berror\b", r"\bexception\b", r"\bfail(?:ure|ed)?\b", r"\bcrash(?:ed|es)?\b"]),
    ("bug",        [r"\bbug\b", r"\bdefect\b", r"\bregress(?:ion)?\b"]),
    ("fix",        [r"\bfix(?:ed|es)?\b", r"\bpatch(?:ed)?\b", r"\bresolv(?:ed|es)?\b", r"\bhotfix\b"]),
    ("config",     [r"\bconfig(?:uration)?\b", r"\bsetting\b", r"\bsetup\b", r"\binstall(?:ation)?\b"]),
    ("env",        [r"\benvironment\b", r"\benv\b", r"\binfra(?:structure)?\b", r"\bdocker\b",
                    r"\bkubernetes\b", r"\bk8s\b", r"\bport\b", r"\bpath\b"]),

    # sentinel — rules, policies, standards, constraints
    ("rule",       [r"\brule\b", r"\bconvention\b", r"\bstandard\b", r"\bguideline\b"]),
    ("policy",     [r"\bpolicy\b", r"\bcompliance\b", r"\bsecurity\b", r"\bvalidat(?:ion|e)\b",
                    r"\bconstraint\b", r"\brequire(?:ment|d)?\b", r"\blint\b", r"\baudit\b"]),

    # herald — announcements, releases, changes, migrations
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
    ("summary",    [r"\bsummar(?:y|ize|ies)\b", r"\bdigest\b", r"\boverview\b", r"\babstract\b"]),
    ("report",     [r"\breport\b", r"\blog\b", r"\breview\b", r"\banalys[ie]s\b",
                    r"\bcompar(?:ison|e|ing)\b", r"\bbenchmark\b", r"\bsurvey\b"]),
]

# Precompile
_COMPILED_RULES: list[tuple[str, list[re.Pattern]]] = [
    (tag, [re.compile(p, re.IGNORECASE) for p in patterns])
    for tag, patterns in TAG_RULES
]


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
    args = parser.parse_args()

    # ---- Load dataset ----
    print(f"Loading dataset: {args.dataset} [{args.split}]")
    ds = load_dataset(args.dataset, split=args.split)
    if args.limit > 0:
        ds = ds.select(range(min(args.limit, len(ds))))
    print(f"  → {len(ds)} rows loaded")

    texts = ds[args.text_field]
    has_id = args.id_field and args.id_field in ds.column_names
    ids = ds[args.id_field] if has_id else list(range(len(ds)))

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
    for text in texts:
        tags = assign_tags(text)
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
                "sourceId": str(ids[i]),
                "chunkSeqNo": 0,
                "tags": all_tags[i],
                "timestamp": now_ms,
            },
        )
        for i, vec in enumerate(vectors)
    ]

    # ---- Upsert to Qdrant ----
    client = QdrantClient(url=args.qdrant_url)

    # Recreate collection
    collections = [c.name for c in client.get_collections().collections]
    if args.collection in collections:
        client.delete_collection(args.collection)
        print(f"  → Deleted existing collection '{args.collection}'")

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
