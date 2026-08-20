#!/usr/bin/env python3
"""Stamp `expansions.game` on a catalog database WITHOUT calling Scrydex.

`sync_scrydex_expansions` stamps the game on every row it writes, so any table
synced from now on is already correct. This script exists for the databases that
were synced BEFORE the column existed: their rows are complete, they just carry
the `'pokemon'` default the migration backfilled them with. Re-syncing them to
fix one column would spend Scrydex credits for data we already have.

Two modes, chosen automatically:

  * single-game database (the per-game POC files) — every expansion belongs to
    the one game in `cards.game`, so stamp them all with it.
  * merged database — derive each expansion's game by joining `cards.set_id`,
    which the sync already stamped correctly. Rows no card points at are left
    alone: 'pokemon' is the right answer for an orphan in a table that was
    Pokémon-only until multi-game.

`--game` forces the single-game answer for a database whose `cards` table is
empty or disagrees.

Idempotent: re-running rewrites nothing once the games match.

Usage:
    python3 tools/backfill_expansion_game.py backend/data/onepiece_poc.sqlite
    python3 tools/backfill_expansion_game.py backend/data/*.sqlite --dry-run
    python3 tools/backfill_expansion_game.py path/to.sqlite --game gundam
"""
from __future__ import annotations

import argparse
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from catalog_tools import GAMES  # noqa: E402

# The Scrydex path segment each game's images/URLs are served under -> game id.
GAME_BY_SCRYDEX_SEGMENT = {game.scrydex_segment: game.id for game in GAMES.values()}


def _has_table(connection: sqlite3.Connection, name: str) -> bool:
    row = connection.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1", (name,)
    ).fetchone()
    return row is not None


def _columns(connection: sqlite3.Connection, table: str) -> set[str]:
    return {str(row[1]) for row in connection.execute(f"PRAGMA table_info({table})")}


def _ensure_game_column(connection: sqlite3.Connection) -> None:
    """Same additive migration the runtime applies, so this works on a database
    the server has never opened."""
    if "game" not in _columns(connection, "expansions"):
        connection.execute(
            "ALTER TABLE expansions ADD COLUMN game TEXT NOT NULL DEFAULT 'pokemon'"
        )


def _game_from_payload(connection: sqlite3.Connection, expansion_id: str) -> str | None:
    """The game named by the Scrydex path segment in the row's stored payload."""
    row = connection.execute(
        "SELECT source_payload_json FROM expansions WHERE id = ?", (expansion_id,)
    ).fetchone()
    blob = str(row[0] or "") if row else ""
    for segment, game_id in GAME_BY_SCRYDEX_SEGMENT.items():
        if f"/{segment}/" in blob:
            return game_id
    return None


def backfill(db_path: Path, *, forced_game: str | None, dry_run: bool) -> dict[str, int]:
    connection = sqlite3.connect(str(db_path))
    connection.row_factory = sqlite3.Row
    try:
        if not _has_table(connection, "expansions"):
            return {}
        _ensure_game_column(connection)

        card_games: list[str] = []
        if _has_table(connection, "cards") and "game" in _columns(connection, "cards"):
            card_games = [
                str(row[0])
                for row in connection.execute(
                    "SELECT DISTINCT game FROM cards WHERE game IS NOT NULL AND game != ''"
                )
            ]

        target_by_id: dict[str, str] = {}
        if forced_game or len(card_games) == 1:
            game = forced_game or card_games[0]
            target_by_id = {
                str(row[0]): game for row in connection.execute("SELECT id FROM expansions")
            }
        else:
            # HAVING COUNT(DISTINCT c.game) = 1 rather than picking a bare
            # column: an un-namespaced merged catalog really does have one
            # `set_id` claimed by two games (One Piece and Gundam both ship an
            # EB01). Guessing there would mis-file a whole set, so an ambiguous
            # id is left alone and reported instead.
            target_by_id = {
                str(row["id"]): str(row["game"])
                for row in connection.execute(
                    """
                    SELECT e.id AS id, MIN(c.game) AS game
                    FROM expansions e
                    JOIN cards c ON c.set_id = e.id
                    GROUP BY e.id
                    HAVING COUNT(DISTINCT c.game) = 1
                    """
                )
            }
            ambiguous_ids = [
                str(row[0])
                for row in connection.execute(
                    """
                    SELECT e.id FROM expansions e
                    JOIN cards c ON c.set_id = e.id
                    GROUP BY e.id
                    HAVING COUNT(DISTINCT c.game) > 1
                    """
                )
            ]
            unresolved = 0
            for expansion_id in ambiguous_ids:
                # Last resort, and only for a colliding id: the row's OWN stored
                # Scrydex payload names the game in its image path
                # (".../onepiece/EB01-logo/..."). That is provenance, not a
                # guess — the losing side of the collision was overwritten, so
                # the surviving row belongs to whichever sync wrote it.
                resolved = _game_from_payload(connection, expansion_id)
                if resolved:
                    target_by_id[expansion_id] = resolved
                else:
                    unresolved += 1
            if ambiguous_ids:
                print(
                    f"{db_path}: {len(ambiguous_ids)} expansion id(s) claimed by >1 game "
                    f"({unresolved} unresolved) — namespaced ids remove this case"
                )

        current = {
            str(row["id"]): str(row["game"]) for row in connection.execute("SELECT id, game FROM expansions")
        }
        changed = [
            (game, expansion_id)
            for expansion_id, game in target_by_id.items()
            if current.get(expansion_id) != game
        ]
        if changed and not dry_run:
            connection.executemany("UPDATE expansions SET game = ? WHERE id = ?", changed)
            connection.commit()

        counts: dict[str, int] = {}
        for expansion_id, game in current.items():
            resolved = target_by_id.get(expansion_id, game)
            counts[resolved] = counts.get(resolved, 0) + 1
        counts["_updated"] = len(changed)
        return counts
    finally:
        connection.close()


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("databases", nargs="+", type=Path)
    parser.add_argument("--game", default=None, help="force every row to this game")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)

    for db_path in args.databases:
        if not db_path.exists():
            print(f"{db_path}: missing, skipped")
            continue
        counts = backfill(db_path, forced_game=args.game, dry_run=args.dry_run)
        if not counts:
            print(f"{db_path}: no expansions table, skipped")
            continue
        updated = counts.pop("_updated", 0)
        spread = ", ".join(f"{game}={count}" for game, count in sorted(counts.items()))
        prefix = "would update" if args.dry_run else "updated"
        print(f"{db_path}: {prefix} {updated} row(s) -> {spread}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
