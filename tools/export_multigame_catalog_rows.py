"""Export the non-Pokémon catalog rows into a small sqlite file for staging.

Staging is Scrydex-KEYLESS by design (the deploy guards reject a key), so the
new games' catalogs cannot be synced there — they are synced locally and their
rows shipped. This tool filters the five catalog tables to `<game>~`-prefixed
ids and writes them into a standalone sqlite file, plus an `apply.sql` that
ATTACHes it and INSERT OR REPLACEs with explicit column lists (so column order
never matters on the target).

Ship + apply:

    python3 tools/export_multigame_catalog_rows.py \
        --source /Users/stephenchan/Code/spotlight-onepiece/backend/data/spotlight_multigame_test.sqlite \
        --out /tmp/multigame_catalog_export.sqlite
    gcloud compute scp /tmp/multigame_catalog_export.sqlite /tmp/multigame_catalog_apply.sql \
        stephenchan@spotlight-backend-staging:/tmp/ --zone us-central1-a --tunnel-through-iap
    gcloud compute ssh stephenchan@spotlight-backend-staging --zone us-central1-a --tunnel-through-iap \
        --command "sqlite3 ~/spotlight/data/spotlight_scanner.sqlite '.read /tmp/multigame_catalog_apply.sql'"

Idempotent: INSERT OR REPLACE keyed on each table's primary key. The target
must already carry the multi-game schema (deploy the backend first — the new
code adds `expansions.game` on boot).
"""

from __future__ import annotations

import argparse
import sqlite3
from pathlib import Path

GAMES = ("onepiece", "lorcana", "riftbound", "gundam")

# table -> column carrying the namespaced id to filter on
TABLES = {
    "expansions": "id",
    "cards": "id",
    "card_name_aliases": "card_id",
    "card_artist_aliases": "card_id",
    "card_price_snapshots": "card_id",
}


def game_filter(column: str) -> str:
    return " OR ".join(f"{column} LIKE '{game}~%'" for game in GAMES)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()

    source = sqlite3.connect(f"file:{args.source.resolve()}?mode=ro", uri=True)
    args.out.unlink(missing_ok=True)
    export = sqlite3.connect(args.out)

    apply_lines = [
        f"ATTACH '/tmp/{args.out.name}' AS ex;",
        "PRAGMA busy_timeout = 30000;",
        "BEGIN;",
    ]

    for table, column in TABLES.items():
        create_sql = source.execute(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name=?", (table,)
        ).fetchone()[0]
        export.execute(create_sql)
        columns = [row[1] for row in source.execute(f"PRAGMA table_info({table})")]
        placeholders = ",".join("?" for _ in columns)
        rows = source.execute(
            f"SELECT * FROM {table} WHERE {game_filter(column)}"
        ).fetchall()
        export.executemany(
            f"INSERT INTO {table} VALUES ({placeholders})", rows
        )
        collist = ", ".join(columns)
        apply_lines.append(
            f"INSERT OR REPLACE INTO {table} ({collist}) SELECT {collist} FROM ex.{table};"
        )
        print(f"{table}: {len(rows)} rows")

    apply_lines += ["COMMIT;", "DETACH ex;"]
    export.commit()
    export.close()
    apply_path = args.out.with_name(args.out.stem.replace("_export", "_apply") + ".sql")
    apply_path.write_text("\n".join(apply_lines) + "\n")
    print(f"export: {args.out}")
    print(f"apply script: {apply_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
