"""Build ONE database holding Pokémon + the four spike games, so the app can be
driven end to end.

Each game was synced into its own POC database, which was right for building
indexes and wrong for testing: the backend serves a single database, so there was
no way to switch lanes in the app and have both catalogs answer.

Free — no Scrydex calls. Copies the local Pokémon catalog, lets the branch's
additive column migrations run on it, then copies each game's cards, expansions
and the card-adjacent rows a PDP actually reads.

    python tools/build_multigame_test_db.py [--rebuild]
"""

from __future__ import annotations

import argparse
import shutil
import sqlite3
import sys
import time
from pathlib import Path

WORKTREE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(WORKTREE / "backend"))

import catalog_tools  # noqa: E402

SOURCE = Path("/Users/stephenchan/Code/spotlight/backend/data/spotlight_scanner.sqlite")
TARGET = WORKTREE / "backend" / "data" / "spotlight_multigame_test.sqlite"
GAMES = ("onepiece", "lorcana", "riftbound", "gundam")

# A PDP reads more than `cards`: without the price tables the new games render
# with no pricing at all, which is a hollow test.
CARD_TABLES = (
    "card_price_snapshots",
    "card_price_history_daily",
    "card_name_aliases",
    "card_external_refs",
    "card_artist_aliases",
    "card_language_links",
)


def copy_table(connection: sqlite3.Connection, table: str) -> int:
    target_columns = [row["name"] for row in connection.execute(f"PRAGMA table_info({table})")]
    if not target_columns:
        return 0
    source_columns = {row[1] for row in connection.execute(f"PRAGMA poc.table_info({table})")}
    shared = [c for c in target_columns if c in source_columns]
    if not shared:
        return 0
    column_list = ", ".join(shared)
    before = connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
    connection.execute(f"INSERT OR IGNORE INTO {table} ({column_list}) SELECT {column_list} FROM poc.{table}")
    return connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] - before


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--rebuild", action="store_true", help="Delete and rebuild an existing target")
    args = parser.parse_args()

    if TARGET.exists() and args.rebuild:
        TARGET.unlink()
        for suffix in ("-wal", "-shm"):
            sidecar = TARGET.with_name(TARGET.name + suffix)
            if sidecar.exists():
                sidecar.unlink()

    if TARGET.exists():
        print(f"[skip] {TARGET.name} exists — pass --rebuild to replace it")
    else:
        print(f"[copy] {SOURCE.name} -> {TARGET.name} ({SOURCE.stat().st_size / 1e9:.1f} GB)")
        started = time.perf_counter()
        shutil.copy2(SOURCE, TARGET)
        print(f"[copy] done in {time.perf_counter() - started:.0f}s")

    connection = catalog_tools.connect(TARGET)
    catalog_tools.apply_schema(connection, WORKTREE / "backend" / "schema.sql")
    connection.commit()
    print("[migrate] schema applied (adds cards.game, expansions.game, tcgplayer_id)")

    for game in GAMES:
        path = WORKTREE / "backend" / "data" / f"{game}_poc.sqlite"
        if not path.exists():
            print(f"[skip] {game}: no POC database")
            continue
        connection.execute("ATTACH DATABASE ? AS poc", (str(path),))

        offered = connection.execute("SELECT COUNT(*) FROM poc.cards WHERE game = ?", (game,)).fetchone()[0]
        added_cards = copy_table(connection, "cards")
        added_expansions = copy_table(connection, "expansions")
        extras = {table: copy_table(connection, table) for table in CARD_TABLES}
        connection.commit()

        # Offered vs landed is the id-collision check: they diverged before
        # non-Pokémon ids were namespaced (Gundam lost 211 cards to One Piece).
        flag = "" if added_cards == offered else f"   !! {offered - added_cards} DROPPED"
        print(f"[merge] {game:<10} cards {added_cards}/{offered}{flag}  expansions {added_expansions}  "
              + " ".join(f"{k.replace('card_', '')}={v}" for k, v in extras.items() if v))
        connection.execute("DETACH DATABASE poc")

    print("\n[final] per game:")
    rows = connection.execute(
        """
        SELECT c.game,
               COUNT(*) AS cards,
               (SELECT COUNT(*) FROM expansions e WHERE e.game = c.game) AS expansions,
               (SELECT COUNT(*) FROM card_price_snapshots s JOIN cards c2 ON c2.id = s.card_id WHERE c2.game = c.game) AS priced
        FROM cards c GROUP BY c.game ORDER BY cards DESC
        """
    ).fetchall()
    print(f"  {'game':<12}{'cards':>8}{'expansions':>12}{'priced':>9}")
    for row in rows:
        print(f"  {row['game']:<12}{row['cards']:>8}{row['expansions']:>12}{row['priced']:>9}")
    print(f"\n[final] {TARGET}  ({TARGET.stat().st_size / 1e9:.1f} GB)")
    connection.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
