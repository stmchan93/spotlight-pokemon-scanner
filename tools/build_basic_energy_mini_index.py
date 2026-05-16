#!/usr/bin/env python3
"""Build the basic-energy mini-index used by the backend's energy-card disambiguation path.

The main visual index contains tens of thousands of cards. When the runtime
matcher narrows a shortlist down to "basic energy"-class candidates we want
to do a focused cosine search against ONLY the basic-energy slice of the
catalog so the top-1 result isn't dominated by visually-similar
high-vocab non-energy cards.

This script slices the active runtime visual index into that focused
sub-index. Filter rule:

    supertype == "Energy"
    AND name startswith "Basic "
    AND name endswith " Energy"

So "Basic Metal Energy" is in, "Twin Energy" / "V Guard Energy" / "Capture
Energy" etc. are out.

Output schema (consumed by backend/raw_visual_matcher.py):

    embeddings : float32 (N, 512), L2-normalized
    card_ids   : object  (N,)  providerCardId
    names      : object  (N,)  e.g. "Basic Fire Energy"
    languages  : object  (N,)  "English" | "Japanese"
    set_names  : object  (N,)  human-readable set name
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

import numpy as np


REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_SOURCE_INDEX = REPO_ROOT / "backend" / "data" / "visual-index" / "visual_index_active_clip-vit-base-patch32.npz"
DEFAULT_SOURCE_MANIFEST = REPO_ROOT / "backend" / "data" / "visual-index" / "visual_index_active_manifest.json"
DEFAULT_OUTPUT = REPO_ROOT / "backend" / "data" / "visual-index" / "basic_energy_mini_index.npz"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--source-index", type=Path, default=DEFAULT_SOURCE_INDEX)
    parser.add_argument("--source-manifest", type=Path, default=DEFAULT_SOURCE_MANIFEST)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print the filtered entry list without writing the output npz.",
    )
    return parser.parse_args()


def is_basic_energy(entry: dict[str, Any]) -> bool:
    if str(entry.get("supertype") or "") != "Energy":
        return False
    name = str(entry.get("name") or "")
    return name.startswith("Basic ") and name.endswith(" Energy")


def main() -> None:
    args = parse_args()

    source_index = args.source_index.resolve()
    source_manifest = args.source_manifest.resolve()
    output_path = args.output.resolve()

    print(f"Loading manifest: {source_manifest}", flush=True)
    with source_manifest.open() as handle:
        manifest = json.load(handle)
    entries: list[dict[str, Any]] = manifest.get("entries") or []
    if not entries:
        raise SystemExit("Source manifest has no entries.")

    print(f"Loading embeddings: {source_index}", flush=True)
    with np.load(source_index) as data:
        if "embeddings" not in data:
            raise SystemExit(f"Source index missing 'embeddings' key. Found: {list(data.keys())}")
        embeddings = data["embeddings"].astype(np.float32, copy=True)

    if embeddings.shape[0] != len(entries):
        raise SystemExit(
            f"Manifest/embedding length mismatch: {len(entries)} entries vs {embeddings.shape[0]} rows."
        )

    filtered_indices: list[int] = []
    card_ids: list[str] = []
    names: list[str] = []
    languages: list[str] = []
    set_names: list[str] = []

    for entry in entries:
        if not is_basic_energy(entry):
            continue
        row_index = int(entry.get("rowIndex"))
        if row_index < 0 or row_index >= embeddings.shape[0]:
            raise SystemExit(f"Entry rowIndex {row_index} out of range.")
        filtered_indices.append(row_index)
        card_ids.append(str(entry.get("providerCardId") or ""))
        names.append(str(entry.get("name") or ""))
        languages.append(str(entry.get("language") or ""))
        set_names.append(str(entry.get("setName") or ""))

    total = len(filtered_indices)
    print(f"Filtered survivors: {total} entries", flush=True)
    if total == 0:
        raise SystemExit("No basic-energy entries found. Aborting.")

    # Language breakdown
    lang_counts: dict[str, int] = {}
    for lang in languages:
        lang_counts[lang] = lang_counts.get(lang, 0) + 1
    print("Language breakdown:")
    for lang in sorted(lang_counts):
        print(f"  {lang}: {lang_counts[lang]}")

    # Name breakdown
    name_counts: dict[str, int] = {}
    for name in names:
        name_counts[name] = name_counts.get(name, 0) + 1
    print("Name breakdown:")
    for name in sorted(name_counts):
        print(f"  {name}: {name_counts[name]}")

    if args.dry_run:
        print()
        print("Dry-run; not writing output. Entries:")
        for card_id, name, language, set_name in zip(card_ids, names, languages, set_names):
            print(f"  {card_id} | {name} | {language} | {set_name}")
        return

    embeddings_subset = embeddings[filtered_indices].astype(np.float32, copy=True)

    # Defensive re-normalize. The source index is L2-normalized but we re-normalize
    # in case future source variants ship un-normalized rows.
    norms = np.linalg.norm(embeddings_subset, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    embeddings_subset = (embeddings_subset / norms).astype(np.float32)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    np.savez(
        output_path,
        embeddings=embeddings_subset,
        card_ids=np.array(card_ids, dtype=object),
        names=np.array(names, dtype=object),
        languages=np.array(languages, dtype=object),
        set_names=np.array(set_names, dtype=object),
    )
    print(f"Wrote mini-index: {output_path}")
    print(f"  shape={embeddings_subset.shape} dtype={embeddings_subset.dtype}")


if __name__ == "__main__":
    main()
