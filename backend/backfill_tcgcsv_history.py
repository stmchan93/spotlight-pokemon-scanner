"""Replay TCGCSV daily price archives into the main-lane HISTORY (daily rows +
raw_main cells) for past dates — never the current snapshot.

    .venv/bin/python backfill_tcgcsv_history.py \
        --database-path data/spotlight_scanner.sqlite \
        --prices-dir /home/stephenchan/tcgcsv-history [--dates 2026-08-07,...] [--dry-run]

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
from sync_tcgcsv_prices import (  # noqa: E402
    _bump_pricing_sync_generation,
    run_tcgcsv_price_sync,
)

load_backend_env_file(BACKEND_ROOT / ".env")


def _load_gz(path: Path) -> dict:
    with gzip.open(path, "rt", encoding="utf-8") as handle:
        return json.load(handle)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--database-path", required=True)
    parser.add_argument("--prices-dir", required=True)
    parser.add_argument("--dates", help="comma-separated YYYY-MM-DD subset (default: every prices-*.json.gz)")
    parser.add_argument("--dry-run", action="store_true")
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
    started = perf_counter()
    try:
        for price_date in dates:
            product_price_map = _load_gz(prices_dir / f"prices-{price_date}.json.gz")
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
