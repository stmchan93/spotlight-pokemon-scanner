"""Case fixtures + DB copy for eval runs.

Fixtures write to the database, so the runner only applies them to a COPY
(`--db-copy`): never to a live DB. A case may declare

  fixtures:
    delete: [{table: deck_entries, where: {owner_user_id: $USER, card_id: sv3pt5-199}}]
    insert: [{table: slab_recent_sales, rows: [{id: ..., card_id: ..., created_at: $NOW}]}]
  writes: true            # the assistant may write (direct add): owner's deck_entries restored after
  state_checks:
    holding_delta: [{card_id: sv3pt5-199, delta: 2}]   # SUM(quantity) after - before, whole case

Deleted rows are put back and inserted rows removed after the case, so cases in
one run don't leak into each other. `$USER` = --user-id, `$NOW` = UTC ISO time, `$TODAY` = YYYY/MM/DD.
"""

from __future__ import annotations

import re
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

FIXTURE_KEYS = frozenset({"delete", "insert"})
STATE_CHECK_KEYS = frozenset({"holding_delta"})
_IDENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def case_needs_db_copy(case: dict[str, Any]) -> bool:
    return bool(case.get("fixtures") or case.get("writes"))


def validate_fixtures(where: str, fixtures: Any, errors: list[str]) -> None:
    if not isinstance(fixtures, dict) or not fixtures:
        errors.append(f"{where}.fixtures: must be a mapping with delete and/or insert")
        return
    for key in sorted(set(fixtures) - FIXTURE_KEYS):
        errors.append(f"{where}.fixtures: unknown key {key!r}")
    for kind, column_key in (("delete", "where"), ("insert", "rows")):
        for i, spec in enumerate(fixtures.get(kind) or []):
            spot = f"{where}.fixtures.{kind}[{i}]"
            if not isinstance(spec, dict) or not _IDENT.match(str(spec.get("table") or "")):
                errors.append(f"{spot}: needs table = a plain table name")
                continue
            payload = spec.get(column_key)
            rows = payload if kind == "insert" else [payload]
            if not isinstance(rows, list) or not rows or not all(isinstance(r, dict) and r for r in rows):
                errors.append(f"{spot}: {column_key} must be {'a non-empty list of rows' if kind == 'insert' else 'a non-empty mapping'}")
                continue
            bad = sorted({c for row in rows for c in row if not _IDENT.match(str(c))})
            if bad:
                errors.append(f"{spot}: bad column names {bad}")


def validate_state_checks(where: str, checks: Any, errors: list[str]) -> None:
    if not isinstance(checks, dict) or not checks:
        errors.append(f"{where}.state_checks: must be a non-empty mapping")
        return
    for key in sorted(set(checks) - STATE_CHECK_KEYS):
        errors.append(f"{where}.state_checks: unknown key {key!r}")
    for i, spec in enumerate(checks.get("holding_delta") or []):
        if not isinstance(spec, dict) or not spec.get("card_id") or not isinstance(spec.get("delta"), int):
            errors.append(f"{where}.state_checks.holding_delta[{i}]: needs card_id and an integer delta")


def copy_database(source: str | Path, destination: str | Path) -> Path:
    """Consistent copy via SQLite's backup API (WAL-safe, source opened read-only)."""
    source, destination = Path(source), Path(destination)
    if not source.exists():
        raise FileNotFoundError(source)
    src = sqlite3.connect(f"file:{source}?mode=ro", uri=True)
    dst = sqlite3.connect(str(destination))
    try:
        src.backup(dst)
    finally:
        dst.close()
        src.close()
    return destination


def _fill(value: Any, user_id: str, now: str) -> Any:
    if isinstance(value, str):
        # $TODAY = sold_at format (YYYY/MM/DD): comps must stay inside the recent-sales window.
        return value.replace("$USER", user_id).replace("$NOW", now).replace("$TODAY", now[:10].replace("-", "/"))
    return value


class CaseFixtures:
    """Applies one case's fixtures on its own connection and undoes them."""

    def __init__(self, database_path: str | Path, user_id: str) -> None:
        self.conn = sqlite3.connect(str(database_path), timeout=30)
        self.user_id = user_id
        self.now = datetime.now(timezone.utc).isoformat()
        self._deleted: list[tuple[str, list[str], list[tuple[Any, ...]]]] = []
        self._inserted: list[tuple[str, int]] = []
        self._owner_rows: tuple[list[str], list[tuple[Any, ...]]] | None = None

    def close(self) -> None:
        self.conn.close()

    def apply(self, fixtures: dict[str, Any] | None) -> None:
        for spec in (fixtures or {}).get("delete") or []:
            table = spec["table"]
            if not self._has_table(table):  # e.g. a slimmed DB without the daily history table
                continue
            where = {k: _fill(v, self.user_id, self.now) for k, v in spec["where"].items()}
            clause = " AND ".join(f'"{column}" = ?' for column in where)
            cursor = self.conn.execute(f'SELECT rowid, * FROM "{table}" WHERE {clause}', tuple(where.values()))
            columns = ["rowid"] + [d[0] for d in cursor.description[1:]]
            rows = cursor.fetchall()
            self.conn.execute(f'DELETE FROM "{table}" WHERE {clause}', tuple(where.values()))
            self._deleted.append((table, columns, rows))
        for spec in (fixtures or {}).get("insert") or []:
            table = spec["table"]
            for row in spec["rows"]:
                values = {k: _fill(v, self.user_id, self.now) for k, v in row.items()}
                cursor = self.conn.execute(
                    f'INSERT INTO "{table}" ({", ".join(chr(34) + c + chr(34) for c in values)}) '
                    f'VALUES ({", ".join("?" for _ in values)})',
                    tuple(values.values()),
                )
                self._inserted.append((table, int(cursor.lastrowid)))
        self.conn.commit()

    def _has_table(self, table: str) -> bool:
        row = self.conn.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", (table,)).fetchone()
        return row is not None

    def snapshot_owner_holdings(self) -> None:
        cursor = self.conn.execute('SELECT rowid, * FROM deck_entries WHERE owner_user_id = ?', (self.user_id,))
        self._owner_rows = (["rowid"] + [d[0] for d in cursor.description[1:]], cursor.fetchall())

    def holding_quantity(self, card_id: str) -> int:
        row = self.conn.execute(
            "SELECT COALESCE(SUM(quantity), 0) FROM deck_entries WHERE owner_user_id = ? AND card_id = ?",
            (self.user_id, card_id),
        ).fetchone()
        return int(row[0] or 0)

    def _reinsert(self, table: str, columns: list[str], rows: list[tuple[Any, ...]]) -> None:
        names = ", ".join(f'"{c}"' if c != "rowid" else "rowid" for c in columns)
        marks = ", ".join("?" for _ in columns)
        for row in rows:
            self.conn.execute(f'INSERT OR REPLACE INTO "{table}" ({names}) VALUES ({marks})', tuple(row))

    def cleanup(self) -> None:
        """Undo in reverse: owner holdings (snapshotted after fixtures) first, then
        inserted rows out and deleted rows back."""
        if self._owner_rows is not None:
            self.conn.execute("DELETE FROM deck_entries WHERE owner_user_id = ?", (self.user_id,))
            self._reinsert("deck_entries", *self._owner_rows)
        for table, rowid in reversed(self._inserted):
            self.conn.execute(f'DELETE FROM "{table}" WHERE rowid = ?', (rowid,))
        for table, columns, rows in reversed(self._deleted):
            self._reinsert(table, columns, rows)
        self.conn.commit()
        self._inserted, self._deleted, self._owner_rows = [], [], None
