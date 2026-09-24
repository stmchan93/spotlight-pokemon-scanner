"""Replay TCGCSV daily price archives into the main-lane HISTORY (daily rows +
raw_main cells) for past dates — never the current snapshot.

    .venv/bin/python backfill_tcgcsv_history.py \
        --database-path data/spotlight_scanner.sqlite \
        --prices-dir /home/stephenchan/tcgcsv-history [--dates 2026-08-07,...] [--dry-run] [--sealed-only]

`--sealed-only` replays sealed products (booster boxes, ETBs, …) and leaves
every card's history untouched: prices for other products are dropped from
each day before the sync, so cards simply find no match and write nothing.

Input is what tools/extract_tcgcsv_archives.py produces: `prices-<date>.json.gz`
per day and one `products.json.gz` (group + number per product). Each day runs
the regular sync (`run_tcgcsv_price_sync(history_only=True)`), so the join,
overrides, JP id backfill, collision blocking and number verification are
exactly the daily sync's. The pricing generation is bumped once at the end so
every version-token cache (portfolio, Top Trends) refreshes.

Why: prod's TCGplayer lane starts the day the sync is first enabled, and the
Top Trends ranking / price graphs only compare like with like — without a
month of TCGplayer history they'd fall back to Scrydex pairs for a month, and
the trend's "now" would not be the price the card shows.
"""

from __future__ import annotations

import argparse
import gzip
import json
import sqlite3
import sys
from pathlib import Path
from time import perf_counter

BACKEND_ROOT = Path(__file__).resolve().parent
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from env_loader import load_backend_env_file  # noqa: E402
from catalog_tools import SEALED_CARD_ID_PREFIX, SEALED_SUPERTYPE  # noqa: E402
from sync_tcgcsv_prices import (  # noqa: E402
    _bump_pricing_sync_generation,
    run_tcgcsv_price_sync,
)

load_backend_env_file(BACKEND_ROOT / ".env")


def _load_gz(path: Path) -> dict:
    with gzip.open(path, "rt", encoding="utf-8") as handle:
        return json.load(handle)


def sealed_product_ids(connection: sqlite3.Connection) -> set[str]:
    rows = connection.execute("SELECT id FROM cards WHERE supertype = ?", (SEALED_SUPERTYPE,)).fetchall()
    return {str(row[0])[len(SEALED_CARD_ID_PREFIX):] for row in rows if str(row[0]).startswith(SEALED_CARD_ID_PREFIX)}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--database-path", required=True)
    parser.add_argument("--prices-dir", required=True)
    parser.add_argument("--dates", help="comma-separated YYYY-MM-DD subset (default: every prices-*.json.gz)")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--sealed-only", action="store_true", help="replay sealed products only; cards untouched")
    args = parser.parse_args(argv)

    prices_dir = Path(args.prices_dir)
    products = _load_gz(prices_dir / "products.json.gz")
    group_by_product = {pid: tuple(value) for pid, value in products["groupByProduct"].items()}
    product_number_map = dict(products["productNumbers"])

    if args.dates:
        dates = [d.strip() for d in args.dates.split(",") if d.strip()]
    else:
        dates = sorted(p.name[len("prices-"):-len(".json.gz")] for p in prices_dir.glob("prices-*.json.gz"))
    if not dates:
        print("[backfill] no dates to replay", file=sys.stderr)
        return 1

    connection = sqlite3.connect(args.database_path, timeout=60.0)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA journal_mode=WAL")
    # A replay is ~1.4M cell inserts per 32 days into a 40M+-row table; fsync
    # on every 500-card commit made it I/O-bound (~9 min/day on staging).
    # NORMAL is the WAL-safe setting (a crash loses at most the last commits,
    # never corrupts) and the re-run is idempotent, so trade durability for
    # throughput here only. Bigger page cache keeps the cell index hot.
    connection.execute("PRAGMA synchronous=NORMAL")
    connection.execute("PRAGMA cache_size=-262144")  # 256 MB
    connection.execute("PRAGMA temp_store=MEMORY")
    only_pids: set[str] | None = None
    if args.sealed_only:
        only_pids = sealed_product_ids(connection)
        if not only_pids:
            print("[backfill] --sealed-only: no sealed products in this database (import the catalog first)",
                  file=sys.stderr)
            connection.close()
            return 1
        print(f"[backfill] --sealed-only: {len(only_pids)} sealed products", flush=True)
    started = perf_counter()
    try:
        for price_date in dates:
            product_price_map = _load_gz(prices_dir / f"prices-{price_date}.json.gz")
            if only_pids is not None:
                product_price_map = {pid: v for pid, v in product_price_map.items() if str(pid) in only_pids}
            day_started = perf_counter()
            stats = run_tcgcsv_price_sync(
                connection,
                product_price_map=product_price_map,
                product_number_map=product_number_map,
                group_by_product=group_by_product,
                price_date=price_date,
                force=True,
                dry_run=args.dry_run,
                history_only=True,
            )
            print(
                f"[backfill] {price_date}: priced={stats.get('priced')} "
                f"no_match={stats.get('skipped_no_match')} mismatch={stats.get('skipped_number_mismatch')} "
                f"backfill={stats.get('backfill_applied')} {perf_counter() - day_started:.1f}s",
                flush=True,
            )
        if not args.dry_run:
            generation = _bump_pricing_sync_generation(connection)
            connection.commit()
            print(f"[backfill] done: {len(dates)} days, generation {generation}, {perf_counter() - started:.0f}s", flush=True)
    finally:
        connection.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
