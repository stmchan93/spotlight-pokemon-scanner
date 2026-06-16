#!/usr/bin/env python3
"""Add the covering index that makes the PDP price-trend read INDEX-ONLY.

The price-trend list (`card_price_trend_list`) reads per-day cells via
`price_history_cell_trend_rows_by_date`, which selects only
`price_date, lane, grader, grade, variant_key, condition, is_perfect, is_signed,
is_error, market` filtered by `(card_id, provider, price_date IN (...))`. Today
that does an index seek then a SCATTERED TABLE-ROW FETCH per cell (the value
column `market` is in no index), which on a never-viewed card is a cold-cache
disk read of ~750-1300ms on the 27.5M-row `card_price_history_cell` table — the
dominant "PDP is slow on a new card" cost. Profiled on staging: the SAME read
served index-only is ~0.8ms (proven via the existing `idx_cellbuild_raw`).

This index covers exactly that query, so the read never touches the scattered
table:

    CREATE INDEX idx_cell_trend_market ON card_price_history_cell
      (card_id, provider, price_date, lane, grader, grade, variant_key,
       condition, is_perfect, is_signed, is_error, market)

Building it scans the 27.5M-row table once and holds a WRITE lock for the build
(~1-2 min); readers are unaffected under WAL. Run it deliberately:
  - LOW-TRAFFIC LIVE BUILD (simplest): run with --execute on the VM when the
    nightly Scrydex sync is NOT running. Reversible: `DROP INDEX idx_cell_trend_market`.
  - ZERO-LOCK (offline swap): copy the DB, run this --execute on the copy, then
    swap the file in during a brief backend restart.

Safety:
  - WITHOUT --execute it is a DRY RUN (prints plan + EXPLAIN check, no writes).
  - Idempotent: no-ops if the index already exists.
  - Import-safe (no work at import time).

Usage:
    python tools/add_cell_trend_covering_index.py --db <path>            # dry run
    python tools/add_cell_trend_covering_index.py --db <path> --execute  # build it
"""
from __future__ import annotations

import argparse
import sqlite3
import sys
import time
from pathlib import Path

INDEX_NAME = "idx_cell_trend_market"
TABLE = "card_price_history_cell"
INDEX_COLUMNS = (
    "card_id, provider, price_date, lane, grader, grade, variant_key, "
    "condition, is_perfect, is_signed, is_error, market"
)
CREATE_SQL = f"CREATE INDEX IF NOT EXISTS {INDEX_NAME} ON {TABLE} ({INDEX_COLUMNS})"

# The exact projected query the index must serve index-only (mirrors
# catalog_tools.price_history_cell_trend_rows_by_date).
_PROBE_SQL = (
    "SELECT price_date, lane, grader, grade, variant_key, condition, "
    "is_perfect, is_signed, is_error, market "
    f"FROM {TABLE} WHERE card_id = ? AND provider = 'scrydex' "
    "AND price_date IN ('2025-07-01','2025-08-01','2025-09-01')"
)


def _table_exists(con: sqlite3.Connection, name: str) -> bool:
    return con.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)
    ).fetchone() is not None


def _index_exists(con: sqlite3.Connection, name: str) -> bool:
    return con.execute(
        "SELECT 1 FROM sqlite_master WHERE type='index' AND name=?", (name,)
    ).fetchone() is not None


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--db", required=True, type=Path)
    ap.add_argument("--execute", action="store_true", help="Build the index (else dry run).")
    args = ap.parse_args(argv)

    if not args.db.exists():
        print(f"DB not found: {args.db}", file=sys.stderr)
        return 2

    con = sqlite3.connect(str(args.db))
    try:
        if not _table_exists(con, TABLE):
            print(f"Table {TABLE} not present — nothing to do (cells not migrated here).")
            return 0
        if _index_exists(con, INDEX_NAME):
            print(f"Index {INDEX_NAME} already exists — nothing to do.")
            return 0

        rows = con.execute(f"SELECT COUNT(*) FROM {TABLE}").fetchone()[0]
        print(f"Table {TABLE}: {rows:,} rows")
        print(f"Index DDL:\n  {CREATE_SQL}")

        sample = con.execute(f"SELECT card_id FROM {TABLE} LIMIT 1").fetchone()
        if sample:
            plan = [r[3] for r in con.execute("EXPLAIN QUERY PLAN " + _PROBE_SQL, (sample[0],))]
            print("Current probe plan:", plan)

        if not args.execute:
            print("\nDRY RUN — pass --execute to build. (Holds a write lock for the "
                  "build; run in low traffic or build offline + swap.)")
            return 0

        con.execute("PRAGMA journal_mode=WAL")
        print(f"\nBuilding {INDEX_NAME} (write-locks {TABLE} during build)...")
        t = time.time()
        con.execute(CREATE_SQL)
        con.commit()
        print(f"Built in {time.time() - t:.1f}s. Running ANALYZE...")
        con.execute(f"ANALYZE {TABLE}")
        con.commit()

        if sample:
            plan = [r[3] for r in con.execute("EXPLAIN QUERY PLAN " + _PROBE_SQL, (sample[0],))]
            covering = any("USING COVERING INDEX " + INDEX_NAME in p for p in plan)
            print("New probe plan:", plan)
            print("INDEX-ONLY (covering):", covering)
        print("Done. Reversible via: DROP INDEX " + INDEX_NAME)
        return 0
    finally:
        con.close()


if __name__ == "__main__":
    raise SystemExit(main())
