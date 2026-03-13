"""
prepare_source.py — HuggingFace dataset downloader (raw data only)

Downloads datasets from HuggingFace and saves as JSONL to data/raw/.
No chunking, embedding, or Qdrant upload — that's process_source.py.

Usage:
  python scripts/prepare_source.py --dataset "ccdv/arxiv-summarization" \\
    --split "train[:20]" --text-field "article"

  python scripts/prepare_source.py --dataset "armanc/scientific_papers" \\
    --config "pubmed" --split "train[:20]" --text-field "article"

  python scripts/prepare_source.py --dataset "NortheasternUniversity/big_patent" \\
    --config "d" --split "train[:10]" --text-field "description" \\
    --meta-fields "abstract"

  python scripts/prepare_source.py --dataset "alexfabbri/multi_news" \\
    --split "train[:100]" --text-field "document"
"""

import argparse
import json
import re
from pathlib import Path

from datasets import load_dataset

RAW_DIR = Path(__file__).resolve().parent.parent / "data" / "raw"


def _derive_filename(dataset: str, split: str, limit: int, config: str) -> str:
    """Derive a human-readable filename from dataset/split/limit/config."""
    name = dataset.replace("/", "_")
    split_clean = re.sub(r"[\[\]:']", "", split).replace(" ", "")
    config_suffix = f"_{config}" if config else ""
    return f"{name}__{split_clean}{config_suffix}" + (f"__L{limit}" if limit > 0 else "")


def save_raw(texts: list[str], ids: list, meta: dict, filename: str,
             extra_fields: dict[str, list] | None = None) -> Path:
    """Save raw texts + metadata as JSONL to data/raw/.
    extra_fields: column_name → list of values (one per doc), saved per-doc as metadata.
    """
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    path = RAW_DIR / f"{filename}.jsonl"
    with open(path, "w", encoding="utf-8") as f:
        f.write(json.dumps({"__meta__": True, **meta}, ensure_ascii=False) + "\n")
        for i, (text, doc_id) in enumerate(zip(texts, ids)):
            row: dict = {"id": doc_id, "text": text}
            if extra_fields:
                for col, vals in extra_fields.items():
                    row[col] = vals[i]
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
    print(f"  → Saved {len(texts)} docs to {path} ({path.stat().st_size / 1024:.0f} KB)")
    return path


def main():
    parser = argparse.ArgumentParser(description="Download HuggingFace dataset → local JSONL")
    parser.add_argument("--dataset", required=True, help="HuggingFace dataset name")
    parser.add_argument("--split", default="train[:500]", help="Dataset split (e.g. train[:500])")
    parser.add_argument("--limit", type=int, default=0, help="Additional row limit (0=no limit)")
    parser.add_argument("--config", default="", help="Dataset config/subset name (e.g. 'd' for big_patent)")
    parser.add_argument("--text-field", default="text", help="Text column name in dataset")
    parser.add_argument("--id-field", default="", help="ID column name (empty=auto-generate)")
    parser.add_argument("--meta-fields", default="", help="Comma-separated extra columns to save per doc (e.g. 'abstract,title')")
    args = parser.parse_args()

    config_label = f" (config={args.config})" if args.config else ""
    print(f"Loading dataset: {args.dataset} [{args.split}]{config_label}")
    ds = load_dataset(args.dataset, name=args.config or None, split=args.split, trust_remote_code=True)
    if args.limit > 0:
        ds = ds.select(range(min(args.limit, len(ds))))
    print(f"  → {len(ds)} rows loaded")

    raw_texts = list(ds[args.text_field])
    has_id = args.id_field and args.id_field in ds.column_names
    raw_ids = ds[args.id_field] if has_id else list(range(len(ds)))

    # Collect extra metadata fields
    meta_field_names = [f.strip() for f in args.meta_fields.split(",") if f.strip()] if args.meta_fields else []
    extra_fields: dict[str, list] = {}
    for col in meta_field_names:
        if col in ds.column_names:
            extra_fields[col] = list(ds[col])
            print(f"  → meta-field '{col}': {len(ds)} values captured")
        else:
            print(f"  ⚠ meta-field '{col}' not found in dataset columns: {ds.column_names}")

    filename = _derive_filename(args.dataset, args.split, args.limit, args.config)
    meta = {
        "dataset": args.dataset,
        "config": args.config,
        "split": args.split,
        "limit": args.limit,
        "text_field": args.text_field,
        "id_field": args.id_field,
        "meta_fields": meta_field_names,
        "doc_count": len(raw_texts),
    }
    save_raw(raw_texts, raw_ids, meta, filename, extra_fields if extra_fields else None)

    print(f"\nDone. To process:\n  python scripts/process_source.py data/raw/{filename}.jsonl "
          f"--chunk-size 100 --collection <name>")


if __name__ == "__main__":
    main()
