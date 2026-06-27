#!/usr/bin/env python3
"""Import a card_language_links CSV (built offline by build_card_language_links.py)
into a target catalog DB — used to ship locally-computed EN↔JP links to the
staging VM without running the heavy embed on the serving box.

Rows whose card_id or counterpart_card_id is absent from the target's `cards`
table are skipped (guards against catalog id drift / FK violations). Replaces the
whole table by default.

CSV columns: card_id,counterpart_card_id,counterpart_language,match_score,match_method,created_at

Usage:
    python3 tools/import_card_language_links.py --db data/spotlight_scanner.sqlite --csv links.csv
"""
from __future__ import annotations

import argparse
import csv
import sqlite3
from pathlib import Path


def run(db_path: Path, csv_path: Path, *, replace: bool = True) -> None:
    con = sqlite3.connect(str(db_path))
    existing = {r[0] for r in con.execute("SELECT id FROM cards")}

    rows: list[tuple] = []
    skipped = 0
    with csv_path.open(newline="") as fh:
        for row in csv.DictReader(fh):
            cid = row["card_id"]
            cp = row["counterpart_card_id"]
            if cid not in existing or cp not in existing:
                skipped += 1
                continue
            score = row.get("match_score")
            rows.append((
                cid, cp, row["counterpart_language"],
                float(score) if score not in (None, "") else None,
                row["match_method"], row["created_at"],
            ))

    if replace:
        con.execute("DELETE FROM card_language_links")
    con.executemany(
        """
        INSERT OR REPLACE INTO card_language_links
            (card_id, counterpart_card_id, counterpart_language, match_score, match_method, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        rows,
    )
    con.commit()
    total = con.execute("SELECT COUNT(*) FROM card_language_links").fetchone()[0]
    con.close()
    print(f"imported: {len(rows)}  skipped (id not in catalog): {skipped}  table total: {total}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", required=True)
    parser.add_argument("--csv", required=True)
    parser.add_argument("--append", action="store_true", help="Keep existing rows (default replaces)")
    args = parser.parse_args()
    run(Path(args.db), Path(args.csv), replace=not args.append)


if __name__ == "__main__":
    main()
