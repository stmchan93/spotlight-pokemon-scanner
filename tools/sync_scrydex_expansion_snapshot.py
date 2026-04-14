#!/usr/bin/env python3
from __future__ import annotations

import argparse
from pathlib import Path

from raw_visual_dataset_paths import default_raw_visual_train_expansion_snapshot_path
from scrydex_expansion_resolver import fetch_all_expansions, write_expansion_snapshot


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Sync a local Scrydex expansions snapshot for offline raw-manifest resolution.")
    parser.add_argument(
        "--output",
        type=Path,
        default=default_raw_visual_train_expansion_snapshot_path(),
        help="Path to write the Scrydex expansions snapshot JSON.",
    )
    parser.add_argument(
        "--page-size",
        type=int,
        default=100,
        help="Requested Scrydex page size while fetching expansions.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    entries = fetch_all_expansions(page_size=args.page_size)
    output_path = args.output.resolve()
    write_expansion_snapshot(output_path, entries)
    print(f"Wrote Scrydex expansions snapshot to {output_path}")
    print(f"Expansion entries: {len(entries)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
