#!/usr/bin/env python3
"""Phase 5 migration: drop the 3 large JSON blob columns from
``card_price_history_daily`` via a staged slim-table swap.

The blob columns (``raw_contexts_json``, ``graded_contexts_json``,
``source_payload_json``) are ~11 GB and are no longer read (Phase-4 cutover to the
normalized ``card_price_history_cell`` table is live) nor written-as-required (the
Phase-5 writer omits them when absent). ``source_url`` is KEPT — the portfolio
covering index projects it. An in-place ``ALTER TABLE ... DROP COLUMN`` rewrites the
whole table while holding a write lock and is outage-prone on a multi-GB table, so
instead this does a controlled rebuild:

  1. CREATE a ``card_price_history_daily_slim`` table with every column EXCEPT the
     3 blob ones (same PK, same column types).
  2. Copy rows in rowid-ordered chunks with batched commits, periodic
     ``wal_checkpoint(PASSIVE)``, and flushed progress logging. Resumable via
     ``--start-rowid``.
  3. Recreate on ``_slim`` exactly the indexes that exist on the live table and
     reference only kept (non-JSON) columns. (All current indexes qualify.)
  4. Atomic swap inside a single ``BEGIN IMMEDIATE`` transaction: rename the live
     table to ``card_price_history_daily__old_json`` and ``_slim`` into its place.

The script intentionally does NOT drop ``..._old_json`` (dropping a ~15 GB table
is the slow, outage-prone step the operator should run detached) and does NOT
VACUUM. It prints clear next steps for both.

Safety:
  - WITHOUT ``--execute`` it is a DRY RUN: prints the full plan (row count, kept
    columns, indexes to recreate, swap SQL) and exits without writing anything.
  - It is import-safe (no side effects at import time).
  - It refuses to run if the JSON columns are already gone, or if a stale
    ``_slim``/``__old_json`` table is present (operator must clean up first).

Usage:
    python tools/migrate_drop_history_json.py --db <path>            # dry run
    python tools/migrate_drop_history_json.py --db <path> --execute  # rebuild+swap
    python tools/migrate_drop_history_json.py --db <path> --execute --batch 200000 --start-rowid 5000000
"""
from __future__ import annotations

import argparse
import sqlite3
import sys
import time
from pathlib import Path

LIVE_TABLE = "card_price_history_daily"
SLIM_TABLE = "card_price_history_daily_slim"
OLD_TABLE = "card_price_history_daily__old_json"

# The 3 large JSON BLOB columns to drop (~11GB bulk). source_url is intentionally
# KEPT: the portfolio covering index (idx_card_price_history_daily_portfolio_cover)
# projects it, so dropping it would lose that index and regress PDP cold reads.
# This tuple drives BOTH the slim-table column set AND the "skip any index that
# references a dropped column" guard in _index_defs — so keeping source_url here
# means the covering index qualifies and IS recreated on the slim table.
JSON_COLUMNS = (
    "raw_contexts_json",
    "graded_contexts_json",
    "source_payload_json",
)


def _log(message: str) -> None:
    print(message, flush=True)


def _table_exists(connection: sqlite3.Connection, name: str) -> bool:
    row = connection.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=? LIMIT 1",
        (name,),
    ).fetchone()
    return row is not None


def _table_create_sql(connection: sqlite3.Connection, name: str) -> str | None:
    row = connection.execute(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name=? LIMIT 1",
        (name,),
    ).fetchone()
    return None if row is None else str(row[0])


def _columns(connection: sqlite3.Connection, name: str) -> list[sqlite3.Row]:
    """Ordered ``PRAGMA table_info`` rows (cid, name, type, notnull, dflt_value, pk)."""
    return connection.execute(f"PRAGMA table_info({name})").fetchall()


def _kept_columns(connection: sqlite3.Connection) -> list[sqlite3.Row]:
    return [c for c in _columns(connection, LIVE_TABLE) if str(c["name"]) not in JSON_COLUMNS]


def _column_ddl(col: sqlite3.Row) -> str:
    """Reconstruct a single column definition for the slim CREATE TABLE.

    Preserves type, NOT NULL, and column-level DEFAULT. The PRIMARY KEY is emitted
    as a table-level constraint instead (handles the composite PK correctly).
    """
    parts = [str(col["name"])]
    col_type = str(col["type"] or "").strip()
    if col_type:
        parts.append(col_type)
    if int(col["notnull"] or 0) == 1:
        parts.append("NOT NULL")
    default = col["dflt_value"]
    if default is not None:
        parts.append(f"DEFAULT {default}")
    return " ".join(parts)


def _foreign_key_clauses(connection: sqlite3.Connection, kept_names: set[str]) -> list[str]:
    """Reconstruct table-level FOREIGN KEY clauses from PRAGMA foreign_key_list,
    so the slim table keeps the same referential integrity (e.g. card_id ->
    cards(id) ON DELETE CASCADE). Only FKs whose local columns are all kept are
    reproduced (the JSON columns aren't FK sources, so all current FKs qualify)."""
    rows = connection.execute(f"PRAGMA foreign_key_list({LIVE_TABLE})").fetchall()
    # Group multi-column FKs by their id.
    by_id: dict[int, list[sqlite3.Row]] = {}
    for row in rows:
        by_id.setdefault(int(row["id"]), []).append(row)
    clauses: list[str] = []
    for _id, parts in sorted(by_id.items()):
        parts = sorted(parts, key=lambda r: int(r["seq"]))
        local_cols = [str(p["from"]) for p in parts]
        if any(col not in kept_names for col in local_cols):
            continue
        ref_table = str(parts[0]["table"])
        ref_cols = [str(p["to"]) for p in parts]
        on_update = str(parts[0]["on_update"] or "NO ACTION")
        on_delete = str(parts[0]["on_delete"] or "NO ACTION")
        clause = (
            f"FOREIGN KEY ({', '.join(local_cols)}) "
            f"REFERENCES {ref_table}({', '.join(ref_cols)})"
        )
        if on_update and on_update != "NO ACTION":
            clause += f" ON UPDATE {on_update}"
        if on_delete and on_delete != "NO ACTION":
            clause += f" ON DELETE {on_delete}"
        clauses.append(clause)
    return clauses


def _build_slim_create_sql(connection: sqlite3.Connection) -> tuple[str, list[str]]:
    """Return (CREATE TABLE SQL for the slim table, kept column names in order)."""
    kept = _kept_columns(connection)
    kept_names = [str(c["name"]) for c in kept]
    column_defs = [f"    {_column_ddl(c)}" for c in kept]
    pk_cols = [str(c["name"]) for c in sorted(kept, key=lambda c: int(c["pk"])) if int(c["pk"] or 0) > 0]
    body = ",\n".join(column_defs)
    if pk_cols:
        body += f",\n    PRIMARY KEY ({', '.join(pk_cols)})"
    for clause in _foreign_key_clauses(connection, set(kept_names)):
        body += f",\n    {clause}"
    create_sql = f"CREATE TABLE {SLIM_TABLE} (\n{body}\n)"
    return create_sql, kept_names


def _index_defs(connection: sqlite3.Connection) -> list[tuple[str, str]]:
    """Indexes on the live table that should be recreated on the slim table.

    Returns (index_name, create_sql_for_slim). Skips:
      - auto-indexes (PK / UNIQUE are recreated by the table definition itself),
      - any index referencing a dropped JSON column (none currently do, but this
        keeps the rebuild correct if that ever changes).
    """
    rows = connection.execute(
        "SELECT name, sql FROM sqlite_master "
        "WHERE type='index' AND tbl_name=? AND sql IS NOT NULL",
        (LIVE_TABLE,),
    ).fetchall()
    defs: list[tuple[str, str]] = []
    for row in rows:
        name = str(row["name"])
        sql = str(row["sql"])
        if name.startswith("sqlite_autoindex_"):
            continue
        if any(json_col in sql for json_col in JSON_COLUMNS):
            _log(f"  WARNING skipping index {name}: references a dropped JSON column")
            continue
        # Point the same index at the slim table (it will be renamed to the live
        # name post-swap, so the index name can stay identical — but it must be
        # created against SLIM_TABLE first). Replace only the table reference.
        slim_sql = sql.replace(f" ON {LIVE_TABLE}", f" ON {SLIM_TABLE}", 1)
        slim_sql = slim_sql.replace(f" ON {LIVE_TABLE}(", f" ON {SLIM_TABLE}(", 1)
        defs.append((name, slim_sql))
    return defs


def _row_count(connection: sqlite3.Connection) -> int:
    return int(connection.execute(f"SELECT COUNT(*) FROM {LIVE_TABLE}").fetchone()[0])


def _max_rowid(connection: sqlite3.Connection) -> int:
    row = connection.execute(f"SELECT MAX(rowid) FROM {LIVE_TABLE}").fetchone()
    return int(row[0]) if row and row[0] is not None else 0


def run(db_path: Path, *, batch: int, start_rowid: int, execute: bool) -> int:
    if not db_path.exists():
        _log(f"ERROR: database not found: {db_path}")
        return 2

    connection = sqlite3.connect(str(db_path))
    connection.row_factory = sqlite3.Row
    try:
        if not _table_exists(connection, LIVE_TABLE):
            _log(f"ERROR: table {LIVE_TABLE} not found")
            return 2

        live_columns = [str(c["name"]) for c in _columns(connection, LIVE_TABLE)]
        present_json = [c for c in JSON_COLUMNS if c in live_columns]
        if not present_json:
            _log(f"Nothing to do: {LIVE_TABLE} has no JSON columns to drop.")
            return 0

        create_sql, kept_names = _build_slim_create_sql(connection)
        index_defs = _index_defs(connection)
        total_rows = _row_count(connection)
        max_rowid = _max_rowid(connection)

        _log("=" * 72)
        _log("Phase 5 migration: drop history JSON columns via slim-table swap")
        _log("=" * 72)
        _log(f"DB:                {db_path}")
        _log(f"Live table:        {LIVE_TABLE}")
        _log(f"Rows to copy:      {total_rows:,}  (max rowid {max_rowid:,})")
        _log(f"Batch size:        {batch:,}")
        _log(f"Start rowid:       {start_rowid:,}")
        _log(f"JSON cols dropped: {', '.join(present_json)}")
        _log(f"Kept columns ({len(kept_names)}): {', '.join(kept_names)}")
        _log("")
        _log("Slim CREATE TABLE:")
        _log(create_sql)
        _log("")
        _log(f"Indexes to recreate on slim ({len(index_defs)}):")
        for name, sql in index_defs:
            _log(f"  - {name}")
            _log(f"      {sql}")
        _log("")
        _log("Atomic swap SQL (single BEGIN IMMEDIATE transaction):")
        _log(f"  ALTER TABLE {LIVE_TABLE} RENAME TO {OLD_TABLE};")
        _log(f"  ALTER TABLE {SLIM_TABLE} RENAME TO {LIVE_TABLE};")
        _log("")

        if not execute:
            _log("DRY RUN (no --execute): no changes written. Re-run with --execute to perform the rebuild + swap.")
            return 0

        # --- Guards before any write -----------------------------------------
        if _table_exists(connection, OLD_TABLE):
            _log(f"ERROR: {OLD_TABLE} already exists. A prior run left it behind. "
                 f"Drop it (or finish that migration) before re-running.")
            return 2
        # A leftover slim table from a crashed run: only safe to resume into it if
        # the caller passes --start-rowid; otherwise refuse so we don't double-copy.
        slim_present = _table_exists(connection, SLIM_TABLE)
        if slim_present and start_rowid <= 0:
            _log(f"ERROR: {SLIM_TABLE} already exists but --start-rowid was not given. "
                 f"If resuming, pass --start-rowid; if this is stale, DROP TABLE {SLIM_TABLE} first.")
            return 2

        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA synchronous=NORMAL")

        if not slim_present:
            _log(f"Creating {SLIM_TABLE} ...")
            connection.execute(create_sql)
            connection.commit()
        else:
            _log(f"Resuming into existing {SLIM_TABLE} from rowid > {start_rowid:,} ...")

        # --- Chunked copy -----------------------------------------------------
        col_list = ", ".join(kept_names)
        insert_sql = (
            f"INSERT OR IGNORE INTO {SLIM_TABLE} ({col_list}) "
            f"SELECT {col_list} FROM {LIVE_TABLE} "
            f"WHERE rowid > ? AND rowid <= ? ORDER BY rowid"
        )
        copied = 0
        lo = start_rowid
        started = time.time()
        checkpoint_every = max(1, 20)  # checkpoint roughly every 20 batches
        batch_index = 0
        while lo < max_rowid:
            hi = min(lo + batch, max_rowid)
            cur = connection.execute(insert_sql, (lo, hi))
            copied += cur.rowcount if cur.rowcount is not None and cur.rowcount > 0 else 0
            connection.commit()
            batch_index += 1
            if batch_index % checkpoint_every == 0:
                connection.execute("PRAGMA wal_checkpoint(PASSIVE)")
            elapsed = time.time() - started
            pct = (hi / max_rowid * 100.0) if max_rowid else 100.0
            _log(f"  copied up to rowid {hi:,}/{max_rowid:,} ({pct:5.1f}%)  "
                 f"rows~{copied:,}  elapsed {elapsed:6.1f}s")
            lo = hi

        connection.execute("PRAGMA wal_checkpoint(PASSIVE)")
        connection.commit()
        slim_count = int(connection.execute(f"SELECT COUNT(*) FROM {SLIM_TABLE}").fetchone()[0])
        _log(f"Copy complete: {slim_count:,} rows in {SLIM_TABLE} (live had {total_rows:,}).")

        # --- Recreate indexes -------------------------------------------------
        # SQLite index names are global, so the canonical names are still occupied
        # by the live table's indexes. Drop those first (metadata-only / instant),
        # then build the canonical-named indexes directly on the slim table so the
        # post-swap live table carries the EXACT same index names the schema
        # expects. The live table is only briefly unindexed during this build
        # window (acceptable for an offline maintenance migration); reads still
        # work, just without index acceleration, until the swap lands.
        _log("Dropping live-table indexes to free their names, then rebuilding on slim ...")
        for name, _sql in index_defs:
            connection.execute(f"DROP INDEX IF EXISTS {name}")
        connection.commit()
        for name, sql in index_defs:
            _log(f"  CREATE {name}")
            connection.execute(sql)
        connection.commit()
        connection.execute("PRAGMA wal_checkpoint(PASSIVE)")

        # --- Atomic swap ------------------------------------------------------
        _log("Performing atomic swap ...")
        connection.execute("BEGIN IMMEDIATE")
        try:
            connection.execute(f"ALTER TABLE {LIVE_TABLE} RENAME TO {OLD_TABLE}")
            connection.execute(f"ALTER TABLE {SLIM_TABLE} RENAME TO {LIVE_TABLE}")
            connection.execute("COMMIT")
        except Exception:
            connection.execute("ROLLBACK")
            raise

        _log("")
        _log("SWAP COMPLETE. The live table is now the slim (JSON-free) table.")
        _log("")
        _log("NEXT STEPS (run by the operator, ideally detached):")
        _log(f"  1. Verify the new {LIVE_TABLE} reads/writes correctly in staging.")
        _log(f"  2. Drop the old table to reclaim ~15 GB (slow; run detached):")
        _log(f"         DROP TABLE {OLD_TABLE};")
        _log(f"  3. Optionally reclaim file space afterwards (also slow, needs ~2x disk):")
        _log(f"         VACUUM;")
        _log("")
        _log("This script intentionally did NOT drop the old table or VACUUM.")
        return 0
    finally:
        connection.close()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", required=True, help="Path to the SQLite database")
    parser.add_argument("--batch", type=int, default=100_000,
                        help="Rowid window size per copy batch (default 100000)")
    parser.add_argument("--start-rowid", type=int, default=0,
                        help="Resume copying from rowid greater than this value (default 0)")
    parser.add_argument("--execute", action="store_true",
                        help="Actually perform the rebuild + swap. Without this it is a dry run.")
    args = parser.parse_args(argv)
    return run(
        Path(args.db),
        batch=max(1, int(args.batch)),
        start_rowid=max(0, int(args.start_rowid)),
        execute=bool(args.execute),
    )


if __name__ == "__main__":
    sys.exit(main())
