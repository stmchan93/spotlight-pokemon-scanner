#!/usr/bin/env python3
"""Rewrite a synced catalog SQLite in place so its ids carry their game namespace.

Why this exists instead of a re-sync: the four POC catalogs
(backend/data/{onepiece,lorcana,riftbound,gundam}_poc.sqlite) already hold every
row Scrydex returned. Re-fetching them to pick up the new id shape would cost 81
API credits to learn nothing new. The ids are a pure function of (game,
provider_id), so they can be rewritten offline.

What it fixes: `cards.id` is a TEXT PRIMARY KEY with no game component, but
provider ids are only unique WITHIN a game. One Piece and Gundam both ship an
expansion called EB01 numbered from 001, so `EB01-001` names a different card in
each. Merging both catalogs into one database silently dropped 211 Gundam cards
(947 -> 736) and collapsed 11 expansions.

Pokémon databases are a no-op by construction: `namespaced_catalog_id` returns
Pokémon ids unchanged (see catalog_tools for why that is non-negotiable), so
pointing this at the live Pokémon catalog rewrites nothing. Running it twice on
the same database is also a no-op — the namespacing is idempotent.

Usage:
    python tools/namespace_catalog_ids.py backend/data/gundam_poc.sqlite
    python tools/namespace_catalog_ids.py backend/data/*.sqlite --dry-run
"""

from __future__ import annotations

import argparse
import sqlite3
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
BACKEND_ROOT = REPO_ROOT / "backend"
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from catalog_tools import (  # noqa: E402
    GAME_POKEMON,
    namespaced_catalog_id,
    normalize_game,
)

# Every column that holds one of OUR card ids, table by table. Written out rather
# than discovered by a `LIKE '%card_id'` scan because two columns end in
# `card_id` and must NOT be rewritten:
#
#   * labeling_sessions.provider_card_id — the PROVIDER's own id, kept bare on
#     purpose so it stays the thing you can hand back to Scrydex.
#   * card_language_links.counterpart_card_id IS ours and IS rewritten, which is
#     exactly the pair that shows a name-based rule cannot be trusted here.
CARD_ID_COLUMNS: dict[str, tuple[str, ...]] = {
    "cards": ("id",),
    "card_name_aliases": ("card_id",),
    "card_artist_aliases": ("card_id",),
    "card_price_snapshots": ("card_id",),
    "card_price_history_daily": ("card_id",),
    "ppt_graded_signals": ("card_id",),
    "scan_events": ("predicted_card_id", "selected_card_id", "confirmed_card_id"),
    "labeling_sessions": ("card_id",),
    "labeling_session_artifacts": ("card_id",),
    "scan_prediction_candidates": ("card_id",),
    "scan_price_observations": ("card_id",),
    "scan_confirmations": ("confirmed_card_id",),
    "card_favorites": ("card_id",),
    "card_likes": ("card_id",),
    "card_views": ("card_id",),
    "card_language_links": ("card_id", "counterpart_card_id"),
    "deck_entries": ("card_id",),
    "sale_events": ("card_id",),
    "card_transactions": ("card_id",),
    "deck_entry_events": ("card_id",),
    "slab_recent_sales_cache": ("card_id",),
    "card_ebay_listings_cache": ("card_id",),
    "slab_recent_sales": ("card_id",),
    "portfolio_import_rows": ("matched_card_id",),
    "card_external_refs": ("card_id",),
    "scan_labeling_reviews": ("labeled_card_id",),
}

# Expansion ids collide too (EB01, ST01..ST10), and `cards.set_id` is the join
# key into `expansions.id`. Both sides move together or set browsing breaks.
EXPANSION_ID_COLUMNS: dict[str, tuple[str, ...]] = {
    "expansions": ("id",),
    "cards": ("set_id",),
}


def _table_columns(connection: sqlite3.Connection, table: str) -> set[str]:
    try:
        return {row[1] for row in connection.execute(f'PRAGMA table_info("{table}")')}
    except sqlite3.Error:
        return set()


def _catalog_game(connection: sqlite3.Connection) -> str | None:
    """The single game this database holds, or None if it is empty/mixed.

    A mixed database is refused rather than guessed at: the whole point of the
    namespace is that you cannot tell which game a bare `EB01-001` belongs to,
    so a per-row rewrite would have nothing to read the answer off.
    """
    rows = connection.execute(
        "SELECT DISTINCT game FROM cards WHERE game IS NOT NULL AND TRIM(game) <> ''"
    ).fetchall()
    games = {normalize_game(row[0]) for row in rows}
    if len(games) != 1:
        return None
    return next(iter(games))


def namespace_database(path: Path, *, dry_run: bool = False) -> dict[str, object]:
    connection = sqlite3.connect(path)
    try:
        # Rewriting a primary key that children reference would trip FK
        # enforcement mid-update; the whole rewrite is one transaction and every
        # referencing column moves inside it, so the end state is consistent.
        connection.execute("PRAGMA foreign_keys=OFF")
        game = _catalog_game(connection)
        if game is None:
            return {"path": str(path), "skipped": "no single game in cards.game"}
        if game == GAME_POKEMON:
            return {"path": str(path), "game": game, "skipped": "pokemon ids are never namespaced"}

        updated: dict[str, int] = {}
        connection.execute("BEGIN")
        for columns_by_table in (CARD_ID_COLUMNS, EXPANSION_ID_COLUMNS):
            for table, columns in columns_by_table.items():
                present = _table_columns(connection, table)
                if not present:
                    continue
                for column in columns:
                    if column not in present:
                        continue
                    rows = connection.execute(
                        f'SELECT DISTINCT "{column}" FROM "{table}" '
                        f'WHERE "{column}" IS NOT NULL AND TRIM("{column}") <> \'\''
                    ).fetchall()
                    changes = [
                        (namespaced_catalog_id(game, row[0]), row[0])
                        for row in rows
                        if namespaced_catalog_id(game, row[0]) != row[0]
                    ]
                    if not changes:
                        continue
                    if not dry_run:
                        connection.executemany(
                            f'UPDATE "{table}" SET "{column}" = ? WHERE "{column}" = ?',
                            changes,
                        )
                    updated[f"{table}.{column}"] = len(changes)
        if dry_run:
            connection.execute("ROLLBACK")
        else:
            connection.execute("COMMIT")
        return {"path": str(path), "game": game, "updated": updated}
    finally:
        connection.close()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("databases", nargs="+", type=Path)
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Report what would change without writing.",
    )
    args = parser.parse_args()

    for database_path in args.databases:
        if not database_path.exists():
            print(f"missing: {database_path}")
            continue
        result = namespace_database(database_path, dry_run=args.dry_run)
        print(result)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
