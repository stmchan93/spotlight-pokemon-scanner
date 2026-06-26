#!/usr/bin/env python3
"""One-off OFFLINE builder for the price-trend covering index.

Creates ``idx_cell_trend_market`` on an EXISTING, populated
``card_price_history_cell`` table so the single-card price-trend read
(``price_history_cell_trend_rows_by_date``) is served INDEX-ONLY instead of via
scattered cold table-row fetches (~1.3s cold -> ~1ms). This is the deferred half
of the fix: the fresh-DB bootstrap in server.py creates the same index, but the
crash-loop guard skips it on an existing table, so this must be run by hand,
off-peak, during low traffic. Building a 12-column index on a ~27.5M-row table
takes minutes and adds ~2-3 GB of disk; run with the backend able to tolerate a
brief write lock.

Usage (on the VM):
    python3 tools/build_cell_trend_index.py \
        --database-path /home/stephenchan/spotlight/data/spotlight_scanner.sqlite
"""
from __future__ import annotations

import argparse
import sqlite3
import time

INDEX_NAME = "idx_cell_trend_market"
CREATE_SQL = f"""
CREATE INDEX IF NOT EXISTS {INDEX_NAME}
ON card_price_history_cell (
    card_id, provider, price_date, lane, grader, grade, variant_key,
    condition, is_perfect, is_signed, is_error, market
)
"""
# Mirrors price_history_cell_trend_rows_by_date so EXPLAIN proves index-only use.
EXPLAIN_SQL = """
EXPLAIN QUERY PLAN
SELECT price_date, lane, grader, grade, variant_key, condition,
       is_perfect, is_signed, is_error, market
FROM card_price_history_cell
WHERE card_id = ? AND provider = ? AND price_date IN (?, ?)
"""


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database-path", required=True)
    args = parser.parse_args()

    connection = sqlite3.connect(args.database_path)
    try:
        # Long timeout so a transient writer (daily dual-write) doesn't abort us.
        connection.execute("PRAGMA busy_timeout = 600000")
        existing = connection.execute(
            "SELECT 1 FROM sqlite_master WHERE type='index' AND name=?",
            (INDEX_NAME,),
        ).fetchone()
        if existing:
            print(f"{INDEX_NAME} already exists; nothing to build.")
        else:
            print(f"Building {INDEX_NAME} (this can take several minutes)...")
            start = time.perf_counter()
            connection.execute(CREATE_SQL)
            connection.commit()
            print(f"Built {INDEX_NAME} in {time.perf_counter() - start:.1f}s")
            print("Checkpointing WAL...")
            connection.execute("PRAGMA wal_checkpoint(TRUNCATE)")

        plan = connection.execute(EXPLAIN_SQL, ("x", "scrydex", "a", "b")).fetchall()
        print("EXPLAIN QUERY PLAN:")
        for row in plan:
            print("  ", tuple(row))
        if any(INDEX_NAME in str(tuple(row)) for row in plan):
            print(f"OK: query is served by {INDEX_NAME}.")
        else:
            print(f"WARNING: query plan did not reference {INDEX_NAME}.")
    finally:
        connection.close()


if __name__ == "__main__":
    main()
