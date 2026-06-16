#!/usr/bin/env python3
"""Audit the raw-visual index for card-BACK placeholder "attractor" entries.

Some catalog cards have no real front art; Scrydex's canonical front URL for
them serves a generic Pokémon card BACK. The full build embedded those cards
from that card back, so dozens of unrelated cards share one near-identical
embedding -> a cluster that wins for any ambiguous / non-card scan (e.g. random
objects resolve to "Growlithe / McDonald's Collection 2018", shown as a card
back). See docs + the plan for the full trace.

Real card art is unique, so a reference image whose bytes are shared by MANY
cards is necessarily a placeholder. This script hashes every cached reference
image, flags any sha256 shared by >= --min-shared cards as a placeholder, and
writes the list of affected providerCardIds (the denylist the matcher filters
on, and the builder skips). Read-only except for the JSON it writes.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from collections import defaultdict
from pathlib import Path

DEFAULT_VISUAL_INDEX_DIR = Path(__file__).resolve().parents[1] / "backend" / "data" / "visual-index"


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--visual-index-dir", type=Path, default=DEFAULT_VISUAL_INDEX_DIR)
    parser.add_argument(
        "--min-shared",
        type=int,
        default=6,
        help="A reference image shared by >= this many cards is a placeholder "
        "(real art is unique; legit reprints share at most a handful).",
    )
    parser.add_argument(
        "--out",
        type=Path,
        default=None,
        help="Denylist JSON path (default: <visual-index-dir>/placeholder_card_ids.json).",
    )
    args = parser.parse_args()

    cache_dir = args.visual_index_dir / ".cache" / "reference_images"
    manifest_path = args.visual_index_dir / "visual_index_active_manifest.json"
    out_path = args.out or (args.visual_index_dir / "placeholder_card_ids.json")

    if not cache_dir.is_dir():
        raise SystemExit(f"reference image cache not found: {cache_dir}")

    # Only consider cards actually present in the active index.
    indexed_ids: set[str] = set()
    if manifest_path.exists():
        manifest = json.loads(manifest_path.read_text())
        for entry in manifest.get("entries", []):
            cid = entry.get("providerCardId")
            if cid:
                indexed_ids.add(str(cid))

    images = sorted(cache_dir.glob("*.png"))
    print(f"[audit] hashing {len(images)} cached reference images ...")
    by_hash: dict[str, list[str]] = defaultdict(list)
    for path in images:
        by_hash[_sha256(path)].append(path.stem)

    placeholders = {h: ids for h, ids in by_hash.items() if len(ids) >= args.min_shared}
    placeholder_card_ids = sorted(
        cid
        for ids in placeholders.values()
        for cid in ids
        if (not indexed_ids) or cid in indexed_ids
    )

    print(f"[audit] placeholder images (shared by >= {args.min_shared} cards): {len(placeholders)}")
    for h, ids in sorted(placeholders.items(), key=lambda kv: -len(kv[1])):
        sample = ", ".join(sorted(ids)[:6])
        print(f"  {h[:16]}…  {len(ids):>4} cards  e.g. {sample}")
    print(f"[audit] total denylisted providerCardIds (in active index): {len(placeholder_card_ids)}")

    payload = {
        "generatedBy": "tools/audit_placeholder_index_entries.py",
        "minShared": args.min_shared,
        "placeholderImageSha256": sorted(placeholders.keys()),
        "cardIds": placeholder_card_ids,
    }
    out_path.write_text(json.dumps(payload, indent=2) + "\n")
    print(f"[audit] wrote denylist -> {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
