#!/usr/bin/env python3
"""Backfill cards.national_pokedex_numbers_json and cards.regulation_mark from
the already-stored Scrydex source_payload_json.

The catalog sync (map_scrydex_catalog_card) currently drops these two fields, so
the columns are empty even though the raw payload carries them. They are needed
to prune EN↔JP counterpart candidates (see tools/build_card_language_links.py)
and are generally useful catalog metadata.

Idempotent: re-running only rewrites rows whose extracted value differs.

Usage:
    python3 tools/backfill_card_pokedex_regmark.py --db backend/data/spotlight_scanner.sqlite
    python3 tools/backfill_card_pokedex_regmark.py --db ... --dry-run
"""
from __future__ import annotations

import argparse
import json
import sqlite3
from pathlib import Path


def _extract(payload_json: str) -> tuple[str, str | None]:
    """Return (national_pokedex_numbers_json, regulation_mark) from a raw payload."""
    try:
        data = json.loads(payload_json) if payload_json else {}
    except (json.JSONDecodeError, TypeError):
        data = {}
    # The stored payload is the Scrydex card "data" object (see map_scrydex_catalog_card).
    if isinstance(data, dict) and isinstance(data.get("data"), dict):
        data = data["data"]
    dex = data.get("national_pokedex_numbers") if isinstance(data, dict) else None
    dex_list = [int(n) for n in dex if isinstance(n, (int, float))] if isinstance(dex, list) else []
    reg = data.get("regulation_mark") if isinstance(data, dict) else None
    reg_value = str(reg).strip() if reg not in (None, "") else None
    return json.dumps(dex_list), reg_value


def run(db_path: Path, *, dry_run: bool) -> None:
    con = sqlite3.connect(str(db_path))
    con.row_factory = sqlite3.Row
    rows = con.execute(
        "SELECT id, national_pokedex_numbers_json, regulation_mark, source_payload_json FROM cards"
    ).fetchall()

    updated = 0
    with_dex = 0
    with_reg = 0
    for row in rows:
        dex_json, reg = _extract(row["source_payload_json"])
        if dex_json == (row["national_pokedex_numbers_json"] or "[]") and reg == row["regulation_mark"]:
            # Count existing coverage for the summary.
            if dex_json not in ("[]", ""):
                with_dex += 1
            if reg:
                with_reg += 1
            continue
        if dex_json not in ("[]", ""):
            with_dex += 1
        if reg:
            with_reg += 1
        updated += 1
        if not dry_run:
            con.execute(
                "UPDATE cards SET national_pokedex_numbers_json = ?, regulation_mark = ? WHERE id = ?",
                (dex_json, reg, row["id"]),
            )
    if not dry_run:
        con.commit()
    con.close()

    print(f"cards scanned: {len(rows)}")
    print(f"rows {'would update' if dry_run else 'updated'}: {updated}")
    print(f"cards with pokedex after run: {with_dex}")
    print(f"cards with regulation_mark after run: {with_reg}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", required=True, help="Path to the catalog sqlite DB")
    parser.add_argument("--dry-run", action="store_true", help="Report without writing")
    args = parser.parse_args()
    run(Path(args.db), dry_run=args.dry_run)


if __name__ == "__main__":
    main()
