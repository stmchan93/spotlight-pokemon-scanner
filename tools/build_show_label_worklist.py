#!/usr/bin/env python3
"""Turn a downloaded tree of scan artifacts into a labeling worklist.

Input: a directory of `<scan_id>/{normalized_target.jpg, artifacts.json}` pulled
from GCS (no scan DB needed — artifacts.json already carries the predicted card
and the top-10 candidate card_ids + scores).

Output (under --out):
  images/<scan_id>.jpg        normalized capture, ready to view
  scan_review.csv             export_scan_training_rows-compatible worksheet
                              (top10_json resolved to name/number/set, chosen
                              card_id blank) — consumed by both the AI labelers
                              and tools/scan_labeling_server.py
  worklist.jsonl              richer per-scan context for the AI labelers

Catalog resolution uses the LOCAL mirror (cards table) — no Scrydex, no spend.
"""
from __future__ import annotations

import argparse
import csv
import json
import shutil
import sqlite3
import sys
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT / "tools") not in sys.path:
    sys.path.insert(0, str(REPO_ROOT / "tools"))

from export_labeling_sessions_batch import default_database_path  # noqa: E402

CSV_FIELDS = [
    "scan_id", "created_at", "owner_user_id", "image_file", "normalized_object_path",
    "upload_status", "predicted_card_id", "predicted_card_name", "confirmed_card_id",
    "confirmed_card_name", "chosen_card_id", "top10_json", "notes",
]


class Catalog:
    def __init__(self, db_path: Path):
        self.con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        self.con.row_factory = sqlite3.Row
        self.cache: dict[str, dict[str, str] | None] = {}

    def resolve(self, card_id: str | None) -> dict[str, str] | None:
        if not card_id:
            return None
        if card_id in self.cache:
            return self.cache[card_id]
        row = self.con.execute(
            "SELECT id, name, number, set_name FROM cards WHERE id = ?", (card_id,)
        ).fetchone()
        result = (
            {
                "card_id": card_id,
                "name": str(row["name"] or ""),
                "number": str(row["number"] or ""),
                "set": str(row["set_name"] or ""),
            }
            if row
            else None
        )
        self.cache[card_id] = result
        return result

    def label(self, card_id: str | None) -> str:
        info = self.resolve(card_id)
        if not info:
            return ""
        meta = " · ".join(p for p in (info["number"], info["set"]) if p)
        return f"{info['name']} ({meta})" if meta else info["name"]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--raw", type=Path, required=True, help="Dir of <scan_id>/ artifact folders.")
    parser.add_argument("--out", type=Path, required=True, help="Output root for images/ + CSV + worklist.")
    parser.add_argument("--db", type=Path, default=default_database_path(), help="Local catalog DB (read-only).")
    args = parser.parse_args()

    if not args.db.exists():
        print(f"error: catalog DB not found at {args.db}", file=sys.stderr)
        return 2

    catalog = Catalog(args.db)
    images_dir = args.out / "images"
    images_dir.mkdir(parents=True, exist_ok=True)
    csv_path = args.out / "scan_review.csv"
    worklist_path = args.out / "worklist.jsonl"

    scan_dirs = sorted(p for p in args.raw.iterdir() if p.is_dir() and (p / "artifacts.json").exists())
    written = 0
    missing_image = 0
    candidates_in_catalog = 0
    candidates_total = 0

    with csv_path.open("w", newline="") as csv_handle, worklist_path.open("w") as wl_handle:
        writer = csv.DictWriter(csv_handle, fieldnames=CSV_FIELDS)
        writer.writeheader()

        for scan_dir in scan_dirs:
            scan_id = scan_dir.name
            try:
                artifacts = json.loads((scan_dir / "artifacts.json").read_text())
            except (ValueError, OSError):
                continue

            norm_src = scan_dir / "normalized_target.jpg"
            if not norm_src.exists():
                missing_image += 1
                continue
            shutil.copy2(norm_src, images_dir / f"{scan_id}.jpg")

            predicted_id = artifacts.get("predicted_card_id") or ""
            resolved_candidates: list[dict[str, Any]] = []
            for cand in artifacts.get("top_candidates", []) or []:
                candidates_total += 1
                info = catalog.resolve(cand.get("card_id"))
                if info:
                    candidates_in_catalog += 1
                resolved_candidates.append(
                    {
                        "rank": cand.get("rank"),
                        "score": cand.get("score"),
                        "card_id": cand.get("card_id"),
                        "name": (info or {}).get("name", ""),
                        "number": (info or {}).get("number", ""),
                        "set": (info or {}).get("set", ""),
                    }
                )

            top10_for_csv = [
                {"rank": c["rank"], "card_id": c["card_id"], "name": c["name"], "number": c["number"], "set": c["set"]}
                for c in resolved_candidates
            ]
            writer.writerow(
                {
                    "scan_id": scan_id,
                    "created_at": artifacts.get("created_at", ""),
                    "owner_user_id": "",
                    "image_file": f"images/{scan_id}.jpg",
                    "normalized_object_path": artifacts.get("normalized_target_uri", ""),
                    "upload_status": "uploaded",
                    "predicted_card_id": predicted_id,
                    "predicted_card_name": catalog.label(predicted_id),
                    "confirmed_card_id": "",
                    "confirmed_card_name": "",
                    "chosen_card_id": "",
                    "top10_json": json.dumps(top10_for_csv, separators=(",", ":")),
                    "notes": "",
                }
            )
            wl_handle.write(
                json.dumps(
                    {
                        "scan_id": scan_id,
                        "image_path": str((images_dir / f"{scan_id}.jpg").resolve()),
                        "mode": artifacts.get("mode"),
                        "predicted": catalog.resolve(predicted_id),
                        "candidates": resolved_candidates,
                    },
                    separators=(",", ":"),
                )
                + "\n"
            )
            written += 1

    print(
        json.dumps(
            {
                "out": str(args.out),
                "csv": str(csv_path),
                "worklist": str(worklist_path),
                "scansWritten": written,
                "missingImage": missing_image,
                "candidateResolveRate": f"{(100.0 * candidates_in_catalog / candidates_total):.1f}%" if candidates_total else "n/a",
            },
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
