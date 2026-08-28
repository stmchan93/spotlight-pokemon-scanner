"""One-time seed: per-condition price history for the newer games, from snapshots.

The daily Scrydex sync only started covering onepiece/lorcana/gundam/riftbound
when the cron went multi-game, so those games have no per-condition history and
their charts render empty. Their `card_price_snapshots` rows DO carry full
raw/graded contexts from the one-time catalog export — this script replays those
contexts into `card_price_history_daily` (plus its normalized-cell dual-write)
for a single price_date. Zero Scrydex credits: no HTTP anywhere.

Idempotent: `upsert_price_history_daily` merges per (card, date), and its cell
rewrite spares the TCGCSV-owned `raw_main` lane. Snapshots are read-only here.

Usage:
  python3 backend/seed_condition_history_from_snapshots.py \
    --database-path backend/data/spotlight_scanner.sqlite \
    [--games onepiece,lorcana,gundam,riftbound] [--price-date YYYY-MM-DD] [--dry-run]
"""

from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import catalog_tools
from catalog_tools import connect
from sync_scrydex_catalog import parse_games_list

COMMIT_BATCH_SIZE = 500

DEFAULT_SEED_GAMES = "onepiece,lorcana,gundam,riftbound"


def _parse_contexts(value: Any, inner_key: str) -> dict[str, Any] | None:
    """A context blob is seedable only when its inner map has entries; '{}',
    NULL, and malformed JSON all mean "nothing to seed" rather than an error."""
    try:
        payload = json.loads(value) if value else None
    except (TypeError, ValueError):
        return None
    if not isinstance(payload, dict):
        return None
    inner = payload.get(inner_key)
    if not isinstance(inner, dict) or not inner:
        return None
    return payload


def seed_condition_history(
    *,
    database_path: Path,
    games: list[str],
    price_date: str,
    dry_run: bool = False,
) -> dict[str, Any]:
    connection = connect(database_path)
    try:
        return _seed_condition_history(
            connection, games=games, price_date=price_date, dry_run=dry_run
        )
    finally:
        connection.close()


def _seed_condition_history(
    connection: sqlite3.Connection,
    *,
    games: list[str],
    price_date: str,
    dry_run: bool,
) -> dict[str, Any]:
    provider = catalog_tools.pricing_provider()
    # The daily writer's cell dual-write silently no-ops without this table, and
    # the per-condition charts read cells — warn loudly instead of "succeeding".
    cell_table_present = connection.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'card_price_history_cell'"
    ).fetchone() is not None
    if not cell_table_present:
        print(
            json.dumps({"event": "seed_condition_history_warning", "warning": "card_price_history_cell table is absent; only JSON daily rows will be written"}),
            file=sys.stderr,
        )

    placeholders = ",".join(["?"] * len(games))
    rows = connection.execute(
        f"""
        SELECT s.card_id, c.game, s.display_currency_code,
               s.raw_contexts_json, s.graded_contexts_json,
               s.default_raw_variant, s.default_raw_condition,
               s.default_raw_low_price, s.default_raw_market_price,
               s.default_raw_mid_price, s.default_raw_high_price,
               s.default_raw_direct_low_price, s.default_raw_trend_price
        FROM card_price_snapshots s
        JOIN cards c ON c.id = s.card_id
        WHERE c.game IN ({placeholders})
        ORDER BY c.game, s.card_id
        """,
        games,
    ).fetchall()

    per_game: dict[str, dict[str, int]] = {
        game: {"cardsSeeded": 0, "cardsSkippedEmpty": 0} for game in games
    }
    total_seeded = 0
    pending = 0
    for row in rows:
        game_stats = per_game.setdefault(
            str(row["game"]), {"cardsSeeded": 0, "cardsSkippedEmpty": 0}
        )
        raw_contexts = _parse_contexts(row["raw_contexts_json"], "variants")
        graded_contexts = _parse_contexts(row["graded_contexts_json"], "graders")
        if raw_contexts is None and graded_contexts is None:
            game_stats["cardsSkippedEmpty"] += 1
            continue

        game_stats["cardsSeeded"] += 1
        total_seeded += 1
        if dry_run:
            continue

        # Passing a lane as None keeps whatever that lane already holds for the
        # day (lane-scoped merge), so a graded-less snapshot never wipes graded.
        catalog_tools.upsert_price_history_daily(
            connection,
            card_id=str(row["card_id"]),
            provider=provider,
            price_date=price_date,
            display_currency_code=row["display_currency_code"],
            raw_contexts=raw_contexts,
            graded_contexts=graded_contexts,
            default_raw_variant=row["default_raw_variant"],
            default_raw_condition=row["default_raw_condition"],
            default_raw_low_price=row["default_raw_low_price"],
            default_raw_market_price=row["default_raw_market_price"],
            default_raw_mid_price=row["default_raw_mid_price"],
            default_raw_high_price=row["default_raw_high_price"],
            default_raw_direct_low_price=row["default_raw_direct_low_price"],
            default_raw_trend_price=row["default_raw_trend_price"],
            source_url=None,
        )
        pending += 1
        if pending >= COMMIT_BATCH_SIZE:
            connection.commit()
            pending = 0

    if not dry_run:
        connection.commit()

    summary = {
        "event": "seed_condition_history_from_snapshots",
        "provider": provider,
        "priceDate": price_date,
        "dryRun": dry_run,
        "games": per_game,
        "totalSeeded": total_seeded,
    }
    print(json.dumps(summary))
    return summary


def _validated_price_date(value: str) -> str:
    try:
        return datetime.strptime(value, "%Y-%m-%d").date().isoformat()
    except ValueError as exc:
        raise SystemExit(f"--price-date must be YYYY-MM-DD: {value}") from exc


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--database-path", required=True, type=Path)
    parser.add_argument("--games", default=DEFAULT_SEED_GAMES)
    parser.add_argument(
        "--price-date",
        default=datetime.now(timezone.utc).date().isoformat(),
        help="YYYY-MM-DD (default: today UTC)",
    )
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    seed_condition_history(
        database_path=args.database_path,
        games=parse_games_list(args.games),
        price_date=_validated_price_date(args.price_date),
        dry_run=args.dry_run,
    )


if __name__ == "__main__":
    main()
