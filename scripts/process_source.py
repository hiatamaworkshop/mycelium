"""
process_source.py — Local JSONL → chunk → embed → tag → Qdrant

Reads raw JSONL files (saved by prepare_source.py --save-raw) and processes them
through the full pipeline: preprocessing → chunking → embedding → tagging → Qdrant upload.

This file is the sole data processor.  Runs repeatedly without re-downloading.

Usage:
  python scripts/process_source.py data/raw/ccdv_arxiv-summarization__train20.jsonl \\
    --chunk-size 100 --collection source_arxiv

  # With doc-separator for multi_news (split on |||||)
  python scripts/process_source.py data/raw/alexfabbri_multi_news__train100.jsonl \\
    --doc-separator '\\|{3,}' --chunk-size 100 --collection source_news

  # Force-recreate collection
  python scripts/process_source.py data/raw/file.jsonl \\
    --chunk-size 100 --collection my_col --force
"""

import argparse
import json
import re
import time
import uuid
from pathlib import Path

from qdrant_client import QdrantClient
from qdrant_client.models import Distance, PointStruct, VectorParams

META_DIR = Path(__file__).resolve().parent.parent / "data" / "meta"
from sentence_transformers import SentenceTransformer


# ===========================================================================
# Raw data loading
# ===========================================================================

def load_raw(path: Path) -> tuple[list[str], list, dict, list[dict]]:
    """Load JSONL saved by prepare_source.py. Returns (texts, ids, meta, doc_extras).
    doc_extras: per-doc extra fields (everything except id and text).
    """
    texts: list[str] = []
    ids: list = []
    meta: dict = {}
    doc_extras: list[dict] = []
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            obj = json.loads(line)
            if obj.get("__meta__"):
                meta = {k: v for k, v in obj.items() if k != "__meta__"}
            else:
                texts.append(obj["text"])
                ids.append(obj["id"])
                extras = {k: v for k, v in obj.items() if k not in ("id", "text")}
                doc_extras.append(extras)
    print(f"  → Loaded {len(texts)} docs from {path}")
    if meta:
        print(f"  → Meta: {meta}")
    if doc_extras and any(doc_extras):
        sample_keys = set()
        for d in doc_extras:
            sample_keys.update(d.keys())
        print(f"  → Extra fields per doc: {sorted(sample_keys)}")
    return texts, ids, meta, doc_extras


# ===========================================================================
# Preprocessing — dataset-specific transforms (before chunking)
# ===========================================================================

def split_on_separator(raw_texts: list[str], raw_ids: list, pattern: str) -> tuple[list[str], list]:
    """Split each document on a regex separator into multiple sub-documents."""
    sep_re = re.compile(pattern)
    out_texts: list[str] = []
    out_ids: list = []
    split_count = 0
    for i, raw in enumerate(raw_texts):
        parts = sep_re.split(raw)
        parts = [p.strip() for p in parts if p.strip()]
        if len(parts) <= 1:
            out_texts.append(raw)
            out_ids.append(raw_ids[i])
        else:
            split_count += 1
            for j, part in enumerate(parts):
                out_texts.append(part)
                out_ids.append(f"{raw_ids[i]}:{j}")
    if split_count > 0:
        print(f"  → doc-separator: {len(raw_texts)} docs → {len(out_texts)} sub-docs ({split_count} split)")
    return out_texts, out_ids


# ===========================================================================
# Academic / structured-document header detection
# ===========================================================================

_HEADER_PREFIX_STRIP = re.compile(
    r"^(?:"
    r"\[\d+\]\s*"           # Patent paragraph numbering: [0001]
    r"|"
    r"\[sec:[^\]]*\]\s*"    # ArXiv section labels: [sec:intro]
    r")*"
)

_HEADER_PATTERNS: list[re.Pattern] = [
    re.compile(r"^#{1,4}\s+.+"),                          # Markdown: ## Title
    re.compile(r"^\d+\.(?:\d+\.)*\s+[A-Z]"),              # Numbered: 1. Introduction, 2.3 Methods
    re.compile(r"^[A-Z][A-Z\s]{3,}$"),                    # ALL CAPS line (≥4 chars)
    re.compile(r"^(?:Abstract|Introduction|Background|Methods?|Methodology|"
               r"Results?|Discussion|Conclusions?|References|Acknowledgment|"
               r"Appendix|Related\s+Work|Experiments?|Evaluation|"
               r"Implementation|Overview|Summary|Analysis|Limitations?)\s*$",
               re.IGNORECASE),
    re.compile(r"^(?:Field\s+of\s+the\s+Invention|"
               r"Background\s+of\s+the\s+Invention|"
               r"Summary\s+of\s+the\s+Invention|"
               r"Brief\s+Summary|"
               r"Detailed\s+Description(?:\s+of.*)?|"
               r"Brief\s+Description\s+of.*Drawings|"
               r"Claims?|Examples?)\s*$",
               re.IGNORECASE),
]

_HEADER_TAG_MAP: list[tuple[re.Pattern, str]] = [
    # Academic sections
    (re.compile(r"\babstract\b", re.I),                    "abstract"),
    (re.compile(r"\bintroduction\b", re.I),                "summary"),
    (re.compile(r"\bbackground\b", re.I),                  "summary"),
    (re.compile(r"\brelated\s+work\b", re.I),              "report"),
    (re.compile(r"\bmethodology\b|\bmethods?\b", re.I),    "methodology"),
    (re.compile(r"\bexperiment", re.I),                    "hypothesis"),
    (re.compile(r"\bevaluation\b", re.I),                  "results"),
    (re.compile(r"\bresults?\b|\bfindings?\b", re.I),      "results"),
    (re.compile(r"\bdiscussion\b", re.I),                  "report"),
    (re.compile(r"\bconclusion", re.I),                    "conclusion"),
    (re.compile(r"\blimitation", re.I),                    "report"),
    (re.compile(r"\bsummary\b|\boverview\b", re.I),        "summary"),
    (re.compile(r"\bappendix\b", re.I),                    "report"),
    (re.compile(r"\breferences\b", re.I),                  "report"),
    (re.compile(r"\bimplementation\b", re.I),              "methodology"),
    (re.compile(r"\banalysis\b", re.I),                    "results"),
    # Patent sections
    (re.compile(r"\bfield of the invention\b", re.I),      "methodology"),
    (re.compile(r"\bsummary of the invention\b", re.I),    "abstract"),
    (re.compile(r"\bbrief summary\b", re.I),               "abstract"),
    (re.compile(r"\bdetailed description\b", re.I),        "methodology"),
    (re.compile(r"\bdescription of.*drawings\b", re.I),    "report"),
    (re.compile(r"\bclaims?\b", re.I),                     "conclusion"),
    (re.compile(r"\bexamples?\b", re.I),                   "hypothesis"),
]


def _clean_header(line: str) -> str:
    s = line.strip()
    s = _HEADER_PREFIX_STRIP.sub("", s)
    s = s.lstrip("#").strip().rstrip(":").strip()
    s = re.sub(r"^\d+(?:\.\d+)*\s*", "", s)
    return s


def is_header_line(line: str) -> bool:
    stripped = line.strip()
    if not stripped or len(stripped) > 120:
        return False
    cleaned = _HEADER_PREFIX_STRIP.sub("", stripped)
    return any(p.match(cleaned) for p in _HEADER_PATTERNS)


def header_to_tag(header_text: str) -> str | None:
    cleaned = _clean_header(header_text)
    if not cleaned:
        return None
    for pat, tag in _HEADER_TAG_MAP:
        if pat.search(cleaned):
            return tag
    return None


# ===========================================================================
# General-purpose keyword rules (body-level)
# ===========================================================================

TAG_RULES: list[tuple[str, list[str]]] = [
    ("error",      [r"\berror\b", r"\bexception\b", r"\bfail(?:ure|ed)?\b", r"\bcrash(?:ed|es)?\b"]),
    ("bug",        [r"\bbug\b", r"\bdefect\b", r"\bregress(?:ion)?\b"]),
    ("fix",        [r"\bfix(?:ed|es)?\b", r"\bpatch(?:ed)?\b", r"\bresolv(?:ed|es)?\b", r"\bhotfix\b"]),
    ("config",     [r"\bconfig(?:uration)?\b", r"\bsetting\b", r"\bsetup\b", r"\binstall(?:ation)?\b"]),
    ("env",        [r"\benvironment\b", r"\binfra(?:structure)?\b", r"\bdocker\b",
                    r"\bkubernetes\b", r"\bk8s\b"]),
    ("rule",       [r"\brule\b", r"\bconvention\b", r"\bguideline\b"]),
    ("policy",     [r"\bpolicy\b", r"\bcompliance\b", r"\bsecurity\b", r"\bvalidat(?:ion|e)\b",
                    r"\bconstraint\b", r"\blint\b", r"\baudit\b"]),
    ("release",    [r"\brelease(?:d|s)?\b", r"\bdeploy(?:ed|ment)?\b", r"\bship(?:ped)?\b",
                    r"\blaunch(?:ed)?\b"]),
    ("commit",     [r"\bcommit\b", r"\bchangelog\b", r"\bmigrat(?:ion|e|ing)\b",
                    r"\bbreaking\b", r"\bdeprecate[ds]?\b"]),
    ("idea",       [r"\bidea\b", r"\bconcept\b", r"\bbrainstorm\b"]),
    ("draft",      [r"\bdraft\b", r"\bwip\b", r"\bwork[- ]in[- ]progress\b"]),
    ("hypothesis", [r"\bhypothesis\b", r"\bprototyp(?:e|ing)\b",
                    r"\bpropos(?:al|ed|e)\b", r"\btodo\b"]),
]

_COMPILED_RULES: list[tuple[str, list[re.Pattern]]] = [
    (tag, [re.compile(p, re.IGNORECASE) for p in patterns])
    for tag, patterns in TAG_RULES
]


# ===========================================================================
# Section-aware chunking
# ===========================================================================

def _split_paragraphs(text: str, chunk_size: int = 100) -> list[str]:
    """Split text into paragraphs on blank lines, sub-splitting oversized blocks on single newlines."""
    paragraphs = re.split(r"\n\s*\n", text)
    paragraphs = [p.strip() for p in paragraphs if p.strip()]
    # Sub-split any paragraph that is much larger than chunk_size
    threshold = chunk_size * 3
    result: list[str] = []
    for para in paragraphs:
        if len(para.split()) > threshold:
            sub = [s.strip() for s in para.split("\n") if s.strip()]
            result.extend(sub)
        else:
            result.append(para)
    # Final fallback: if still a single huge block, split on single \n
    if len(result) <= 1 and len(text.split()) > chunk_size * 2:
        result = [p.strip() for p in text.split("\n") if p.strip()]
    return result


def chunk_text(text: str, chunk_size: int, overlap: int) -> list[str]:
    """Split text into section/paragraph-aware chunks."""
    paragraphs = _split_paragraphs(text, chunk_size)
    if not paragraphs:
        return [text] if text.strip() else []

    total_words = sum(len(p.split()) for p in paragraphs)
    if total_words <= chunk_size:
        return [text.strip()]

    chunks: list[str] = []
    current_paras: list[str] = []
    current_words = 0
    overlap_text = ""

    for para in paragraphs:
        para_words = len(para.split())

        # Force chunk break on section header
        if current_paras and is_header_line(para.split("\n")[0]):
            chunk = "\n\n".join(current_paras)
            if chunk.strip():
                chunks.append(chunk.strip())
            all_words = chunk.split()
            overlap_text = " ".join(all_words[-overlap:]) if overlap > 0 and len(all_words) > overlap else ""
            current_paras = []
            current_words = 0

        # Would adding this paragraph exceed chunk_size?
        if current_words + para_words > chunk_size and current_paras:
            chunk = "\n\n".join(current_paras)
            if chunk.strip():
                chunks.append(chunk.strip())
            all_words = chunk.split()
            overlap_text = " ".join(all_words[-overlap:]) if overlap > 0 and len(all_words) > overlap else ""
            current_paras = []
            current_words = 0

        # Start new chunk with overlap prefix
        if not current_paras and overlap_text:
            current_paras.append(overlap_text)
            current_words += len(overlap_text.split())
            overlap_text = ""

        current_paras.append(para)
        current_words += para_words

    if current_paras:
        chunk = "\n\n".join(current_paras)
        if chunk.strip():
            chunks.append(chunk.strip())

    return chunks if chunks else [text.strip()]


# ===========================================================================
# Tag assignment — header-first, keyword-fallback
# ===========================================================================

def assign_tags(text: str, max_tags: int = 3) -> list[str]:
    """Assign tags via header detection + keyword matching."""
    matched: list[str] = []
    seen: set[str] = set()

    # Phase 1: Header detection (first 3 lines)
    lines = text.split("\n")
    for line in lines[:3]:
        if is_header_line(line):
            tag = header_to_tag(line)
            if tag and tag not in seen:
                matched.append(tag)
                seen.add(tag)
                break

    # Phase 2: Keyword matching on body
    if len(matched) < max_tags:
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


# ===========================================================================
# Pipeline: chunk → embed → tag → Qdrant
# ===========================================================================

def process(raw_texts: list[str], raw_ids: list, args,
            dataset_meta: dict | None = None, doc_extras: list[dict] | None = None):
    """Full processing pipeline: chunk → embed → tag → Qdrant upload + metadata sidecar."""
    # ---- Chunk ----
    texts: list[str] = []
    source_ids: list[str] = []
    chunk_seq_nos: list[int] = []
    chunk_total_counts: list[int] = []

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
        total = chunk_total_counts[idx]
        if total > 1:
            seq = chunk_seq_nos[idx]
            if seq == 0 and "abstract" not in tags and "summary" not in tags:
                tags.insert(0, "abstract")
            if seq >= total - 2 and "conclusion" not in tags and "results" not in tags:
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

    UPSERT_BATCH = 100
    for i in range(0, len(points), UPSERT_BATCH):
        batch = points[i : i + UPSERT_BATCH]
        client.upsert(collection_name=args.collection, points=batch)
    print(f"  → Upserted {len(points)} points")

    # ---- Write metadata sidecar (sourceId → doc-level metadata) ----
    # Compute per-doc chunk counts from the per-chunk list
    doc_chunk_counts: dict[str, int] = {}
    for sid in source_ids:
        doc_chunk_counts[sid] = doc_chunk_counts.get(sid, 0) + 1

    META_DIR.mkdir(parents=True, exist_ok=True)
    meta_index: dict = {}
    for i, raw_id in enumerate(raw_ids):
        sid = str(raw_id)
        entry: dict = {}
        if dataset_meta:
            entry["dataset"] = dataset_meta.get("dataset", "")
            entry["config"] = dataset_meta.get("config", "")
        entry["chunkTotal"] = doc_chunk_counts.get(sid, 1)
        if doc_extras and i < len(doc_extras):
            for k, v in doc_extras[i].items():
                # Truncate long values (e.g. abstract) to keep sidecar compact
                if isinstance(v, str) and len(v) > 500:
                    entry[k] = v[:500] + "..."
                else:
                    entry[k] = v
        meta_index[sid] = entry

    meta_path = META_DIR / f"{args.collection}.json"
    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump(meta_index, f, ensure_ascii=False, indent=2)
    print(f"  → Metadata sidecar: {meta_path} ({len(meta_index)} sourceIds)")

    print("\nDone. Source Qdrant is ready for mycelium loader.")


def main():
    parser = argparse.ArgumentParser(
        description="Process local JSONL → chunk → embed → tag → Qdrant")
    parser.add_argument("input", help="Path to .jsonl file (saved by prepare_source.py --save-raw)")
    # Preprocessing
    parser.add_argument("--doc-separator", default="",
                        help="Regex to split each row into sub-documents before chunking. "
                             r"For multi_news: '\\|{3,}'")
    # Processing
    parser.add_argument("--collection", default="source", help="Qdrant collection name")
    parser.add_argument("--qdrant-url", default="http://localhost:6333", help="Qdrant URL")
    parser.add_argument("--batch-size", type=int, default=64, help="Embedding batch size")
    parser.add_argument("--chunk-size", type=int, default=100,
                        help="Chunk size in words (0=no chunking). Default: 100 for MiniLM")
    parser.add_argument("--chunk-overlap", type=int, default=15,
                        help="Overlap words between chunks (default: 15)")
    parser.add_argument("--force", action="store_true",
                        help="Delete existing collection before creating")
    args = parser.parse_args()

    path = Path(args.input)
    if not path.is_absolute():
        path = Path.cwd() / path
    if not path.exists():
        print(f"ERROR: file not found: {path}")
        return

    raw_texts, raw_ids, meta, doc_extras = load_raw(path)

    # Apply preprocessing only if explicitly requested via CLI
    if args.doc_separator:
        print(f"  Applying doc_separator: {args.doc_separator!r}")
        raw_texts, raw_ids = split_on_separator(raw_texts, raw_ids, args.doc_separator)

    process(raw_texts, raw_ids, args, dataset_meta=meta, doc_extras=doc_extras)


if __name__ == "__main__":
    main()
