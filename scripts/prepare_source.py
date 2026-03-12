"""
prepare_source.py — HuggingFace dataset → Source Qdrant
Embeds text with all-MiniLM-L6-v2 (384d) and assigns tags via header detection + keyword matching.
Long texts are split into section/paragraph-aware chunks (--chunk-size / --chunk-overlap).

Usage:
  python scripts/prepare_source.py [--dataset DATASET] [--split SPLIT] [--limit N]
                                   [--collection NAME] [--qdrant-url URL]
                                   [--text-field FIELD] [--id-field FIELD]
                                   [--chunk-size N] [--chunk-overlap N]
                                   [--doc-separator REGEX] [--section-field FIELD]

Example (short texts, no chunking):
  python scripts/prepare_source.py --dataset "ag_news" --split "train[:500]" --text-field "text"

Example (long texts, with chunking — arxiv):
  python scripts/prepare_source.py --dataset "ccdv/arxiv-summarization" --split "train[:5]" \\
    --text-field "article" --chunk-size 500 --chunk-overlap 50

Example (scientific_papers — inject section headers):
  python scripts/prepare_source.py --dataset "armanc/scientific_papers" --split "pubmed[:10]" \\
    --text-field "article" --section-field "section_names" --chunk-size 500

Example (big_patent — patent headers auto-detected):
  python scripts/prepare_source.py --dataset "NortheasternUniversity/big_patent" --split "train[:10]" \\
    --text-field "description" --chunk-size 500

Example (multi_news — split on ||||| separator):
  python scripts/prepare_source.py --dataset "alexfabbri/multi_news" --split "train[:100]" \\
    --text-field "document" --doc-separator '\\|{3,}'
"""

import argparse
import re
import time
import uuid

from datasets import load_dataset
from qdrant_client import QdrantClient
from qdrant_client.models import Distance, PointStruct, VectorParams
from sentence_transformers import SentenceTransformer

# ===========================================================================
# Academic / structured-document header detection
# ===========================================================================
# For chunked long-form documents (papers, reports, manuals) where section
# headers carry structural meaning.  Used by assign_tags() Phase 1.

# Regex to strip leading noise before header matching
_HEADER_PREFIX_STRIP = re.compile(
    r"^(?:"
    r"\[\d+\]\s*"           # Patent paragraph numbering: [0001]
    r"|"
    r"\[sec:[^\]]*\]\s*"    # ArXiv section labels: [sec:intro]
    r")*"
)

# Patterns that indicate a section header line (applied AFTER prefix stripping)
_HEADER_PATTERNS: list[re.Pattern] = [
    re.compile(r"^#{1,4}\s+.+"),                          # Markdown: ## Title
    re.compile(r"^\d+\.(?:\d+\.)*\s+[A-Z]"),              # Numbered: 1. Introduction, 2.3 Methods
    re.compile(r"^[A-Z][A-Z\s]{3,}$"),                    # ALL CAPS line (≥4 chars): ABSTRACT, METHODS
    re.compile(r"^(?:Abstract|Introduction|Background|Methods?|Methodology|"
               r"Results?|Discussion|Conclusions?|References|Acknowledgment|"
               r"Appendix|Related\s+Work|Experiments?|Evaluation|"
               r"Implementation|Overview|Summary|Analysis|Limitations?)\s*$",
               re.IGNORECASE),                             # Known academic section names
    re.compile(r"^(?:Field\s+of\s+the\s+Invention|"
               r"Background\s+of\s+the\s+Invention|"
               r"Summary\s+of\s+the\s+Invention|"
               r"Brief\s+Summary|"
               r"Detailed\s+Description(?:\s+of.*)?|"
               r"Brief\s+Description\s+of.*Drawings|"
               r"Claims?|Examples?)\s*$",
               re.IGNORECASE),                             # Patent section names
]

# Header text → tag mapping (species-mapping.json tags)
#   anchor:     abstract, conclusion
#   sentinel:   methodology
#   herald:     results
#   spore:      hypothesis
#   summarizer: summary, report
_HEADER_TAG_MAP: list[tuple[re.Pattern, str]] = [
    # ---- Academic sections ----
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
    # ---- Patent sections ----
    (re.compile(r"\bfield of the invention\b", re.I),      "methodology"),
    (re.compile(r"\bsummary of the invention\b", re.I),    "abstract"),
    (re.compile(r"\bbrief summary\b", re.I),               "abstract"),
    (re.compile(r"\bdetailed description\b", re.I),        "methodology"),
    (re.compile(r"\bdescription of.*drawings\b", re.I),    "report"),
    (re.compile(r"\bclaims?\b", re.I),                     "conclusion"),
    (re.compile(r"\bexamples?\b", re.I),                   "hypothesis"),
]


def _clean_header(line: str) -> str:
    """Strip noise prefixes from a potential header line."""
    s = line.strip()
    s = _HEADER_PREFIX_STRIP.sub("", s)          # [0001], [sec:xxx]
    s = s.lstrip("#").strip().rstrip(":").strip()  # Markdown #, trailing :
    s = re.sub(r"^\d+(?:\.\d+)*\s*", "", s)       # Leading numbers: 1.2 Methods → Methods
    return s


def is_header_line(line: str) -> bool:
    """Check if a line looks like a section header."""
    stripped = line.strip()
    if not stripped or len(stripped) > 120:
        return False
    cleaned = _HEADER_PREFIX_STRIP.sub("", stripped)
    return any(p.match(cleaned) for p in _HEADER_PATTERNS)


def header_to_tag(header_text: str) -> str | None:
    """Map a header line to a tag. Returns None if no match."""
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
# For ANY text type (short articles, notes, logs, etc.).
# Matches keywords anywhere in the chunk body.
# Grouped by target species (mirrors species-mapping.json).

TAG_RULES: list[tuple[str, list[str]]] = [
    # ---- anchor: critical failures, incidents ----
    ("error",      [r"\berror\b", r"\bexception\b", r"\bfail(?:ure|ed)?\b", r"\bcrash(?:ed|es)?\b"]),
    ("bug",        [r"\bbug\b", r"\bdefect\b", r"\bregress(?:ion)?\b"]),
    ("fix",        [r"\bfix(?:ed|es)?\b", r"\bpatch(?:ed)?\b", r"\bresolv(?:ed|es)?\b", r"\bhotfix\b"]),

    # ---- sentinel: rules, policies, configuration ----
    ("config",     [r"\bconfig(?:uration)?\b", r"\bsetting\b", r"\bsetup\b", r"\binstall(?:ation)?\b"]),
    ("env",        [r"\benvironment\b", r"\binfra(?:structure)?\b", r"\bdocker\b",
                    r"\bkubernetes\b", r"\bk8s\b"]),
    ("rule",       [r"\brule\b", r"\bconvention\b", r"\bguideline\b"]),
    ("policy",     [r"\bpolicy\b", r"\bcompliance\b", r"\bsecurity\b", r"\bvalidat(?:ion|e)\b",
                    r"\bconstraint\b", r"\blint\b", r"\baudit\b"]),

    # ---- herald: releases, changes, announcements ----
    ("release",    [r"\brelease(?:d|s)?\b", r"\bdeploy(?:ed|ment)?\b", r"\bship(?:ped)?\b",
                    r"\blaunch(?:ed)?\b"]),
    ("commit",     [r"\bcommit\b", r"\bchangelog\b", r"\bmigrat(?:ion|e|ing)\b",
                    r"\bbreaking\b", r"\bdeprecate[ds]?\b"]),

    # ---- spore: ideas, drafts, hypotheses ----
    ("idea",       [r"\bidea\b", r"\bconcept\b", r"\bbrainstorm\b"]),
    ("draft",      [r"\bdraft\b", r"\bwip\b", r"\bwork[- ]in[- ]progress\b"]),
    ("hypothesis", [r"\bhypothesis\b", r"\bprototyp(?:e|ing)\b",
                    r"\bpropos(?:al|ed|e)\b", r"\btodo\b"]),
]

# Precompile
_COMPILED_RULES: list[tuple[str, list[re.Pattern]]] = [
    (tag, [re.compile(p, re.IGNORECASE) for p in patterns])
    for tag, patterns in TAG_RULES
]


# ===========================================================================
# Preprocessing — dataset-specific transforms (before chunking)
# ===========================================================================

def split_on_separator(raw_texts: list[str], raw_ids: list, pattern: str) -> tuple[list[str], list]:
    """Split each document on a regex separator into multiple sub-documents.

    For multi_news ("|||||"), use pattern r'\\|{3,}' to match 3+ pipes flexibly.
    Returns expanded (texts, ids) where ids get `:N` suffix.
    """
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


def inject_section_names(raw_texts: list[str], section_names_col: list[str]) -> list[str]:
    """Inject section names from a separate field into article text as header lines.

    For scientific_papers: section_names are \\n-separated, article paragraphs are \\n-separated.
    Strategy: distribute N section headers proportionally across M paragraphs.
    """
    result: list[str] = []
    injected_count = 0
    for text, sections_raw in zip(raw_texts, section_names_col):
        if not sections_raw or not sections_raw.strip():
            result.append(text)
            continue

        # Parse and clean section names
        names = [s.strip() for s in sections_raw.split("\n") if s.strip()]
        names = [_HEADER_PREFIX_STRIP.sub("", n).strip() for n in names]
        names = [n for n in names if n]

        if not names:
            result.append(text)
            continue

        # Split article into paragraphs (single \n separated in scientific_papers)
        paragraphs = [p.strip() for p in text.split("\n") if p.strip()]
        if not paragraphs:
            result.append(text)
            continue

        # Distribute section headers proportionally across paragraphs
        step = max(1, len(paragraphs) // len(names))
        new_parts: list[str] = []
        name_idx = 0
        for pi, para in enumerate(paragraphs):
            if name_idx < len(names) and pi == name_idx * step:
                new_parts.append(names[name_idx])
                name_idx += 1
            new_parts.append(para)

        # Join with double newlines so _split_paragraphs and chunk_text work correctly
        result.append("\n\n".join(new_parts))
        injected_count += 1

    if injected_count > 0:
        print(f"  → section-field: injected headers into {injected_count}/{len(raw_texts)} docs")
    return result


# ---------------------------------------------------------------------------
# Section-aware chunking
# ---------------------------------------------------------------------------

def _split_paragraphs(text: str) -> list[str]:
    """Split text into paragraphs on blank lines. Preserves non-empty paragraphs."""
    paragraphs = re.split(r"\n\s*\n", text)
    return [p.strip() for p in paragraphs if p.strip()]


def chunk_text(text: str, chunk_size: int, overlap: int) -> list[str]:
    """Split text into section/paragraph-aware chunks.

    Strategy:
    1. Split on paragraph boundaries (\\n\\n)
    2. If a paragraph starts with a section header, force a chunk break
    3. Accumulate paragraphs up to chunk_size words
    4. Overlap is applied at the paragraph level (carry last N words from previous chunk)
    """
    paragraphs = _split_paragraphs(text)
    if not paragraphs:
        return [text] if text.strip() else []

    # Check total word count — skip chunking for short texts
    total_words = sum(len(p.split()) for p in paragraphs)
    if total_words <= chunk_size:
        return [text.strip()]

    chunks: list[str] = []
    current_paras: list[str] = []
    current_words = 0
    overlap_text = ""

    for para in paragraphs:
        para_words = len(para.split())

        # Force chunk break on section header (if we have accumulated content)
        if current_paras and is_header_line(para.split("\n")[0]):
            chunk = "\n\n".join(current_paras)
            if chunk.strip():
                chunks.append(chunk.strip())
            # Carry overlap from end of previous chunk
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

        # Start new chunk with overlap prefix if available
        if not current_paras and overlap_text:
            current_paras.append(overlap_text)
            current_words += len(overlap_text.split())
            overlap_text = ""

        current_paras.append(para)
        current_words += para_words

    # Flush remaining
    if current_paras:
        chunk = "\n\n".join(current_paras)
        if chunk.strip():
            chunks.append(chunk.strip())

    return chunks if chunks else [text.strip()]


# ---------------------------------------------------------------------------
# Tag assignment — header-first, keyword-fallback
# ---------------------------------------------------------------------------

def assign_tags(text: str, max_tags: int = 3) -> list[str]:
    """Assign tags via two independent layers.

    Layer 1 — Academic header detection (chunked docs only in practice):
      Checks first 3 lines for section headers (## Abstract, 1. Introduction, etc.)
      and maps them to structural tags (abstract, methodology, results, ...).

    Layer 2 — General keyword matching (all text types):
      Scans body text for domain keywords (error, config, release, idea, ...).
      These are NOT academic-specific and apply to short articles, notes, logs, etc.

    Position-based fallback (applied externally for chunked docs):
      First chunk → "abstract", last 2 chunks → "conclusion" (if no existing tag).
    """
    matched: list[str] = []
    seen: set[str] = set()

    # --- Phase 1: Header detection (first 3 lines) ---
    lines = text.split("\n")
    header_lines = lines[:3]
    for line in header_lines:
        if is_header_line(line):
            tag = header_to_tag(line)
            if tag and tag not in seen:
                matched.append(tag)
                seen.add(tag)
                break  # one header tag per chunk

    # --- Phase 2: Keyword matching on body (skip if already at max) ---
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
    parser.add_argument("--doc-separator", default="",
                        help="Regex to split each row into sub-documents before chunking. "
                             r"For multi_news: '\\|{3,}' (3+ pipes)")
    parser.add_argument("--section-field", default="",
                        help="Field containing \\n-separated section names to inject as headers. "
                             "For scientific_papers: 'section_names'")
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

    raw_texts = list(ds[args.text_field])
    has_id = args.id_field and args.id_field in ds.column_names
    raw_ids = ds[args.id_field] if has_id else list(range(len(ds)))

    # ---- Preprocessing: doc separator (multi_news etc.) ----
    if args.doc_separator:
        raw_texts, raw_ids = split_on_separator(raw_texts, raw_ids, args.doc_separator)

    # ---- Preprocessing: section name injection (scientific_papers etc.) ----
    if args.section_field:
        if args.section_field in ds.column_names:
            raw_texts = inject_section_names(raw_texts, list(ds[args.section_field]))
        else:
            print(f"  ⚠ --section-field '{args.section_field}' not found in dataset columns: {ds.column_names}")

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
        # Position-based fallback for chunked documents (last resort)
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

    # Batch upsert
    UPSERT_BATCH = 100
    for i in range(0, len(points), UPSERT_BATCH):
        batch = points[i : i + UPSERT_BATCH]
        client.upsert(collection_name=args.collection, points=batch)
    print(f"  → Upserted {len(points)} points")

    print("\nDone. Source Qdrant is ready for mycelium loader.")


if __name__ == "__main__":
    main()
