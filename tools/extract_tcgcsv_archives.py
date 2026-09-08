"""Turn TCGCSV's daily price archives into compact per-day price maps for
backend/backfill_tcgcsv_history.py.

    python3 tools/extract_tcgcsv_archives.py --start 2026-08-07 --end 2026-09-07 \
        --out-dir /path/to/tcgcsv-history

Per date it downloads https://tcgcsv.com/archive/tcgplayer/prices-<date>.ppmd.7z
(~4 MB, PPMd — needs the `7zz` CLI, `brew install sevenzip`), extracts it, and
writes `<out-dir>/prices-<date>.json.gz` = {productId: {subTypeName: price row}}
restricted to the six categories the sync uses. It also crawls every group's
/products ONCE (courtesy-spaced like the adapter) into
`<out-dir>/products.json.gz` = {"groupByProduct": {pid: [category, group]},
"productNumbers": {pid: normalized number}} — the trust-but-verify side of the
join, which the archives don't carry. Runs on a laptop; the VM never needs 7z.
"""

from __future__ import annotations

import argparse
import gzip
import json
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
from datetime import date, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
from tcgcsv_adapter import (  # noqa: E402
    TCGCSV_CATEGORY_IDS,
    TCGCSV_USER_AGENT,
    fetch_group_ids,
    fetch_group_products,
    product_number,
)

ARCHIVE_URL = "https://tcgcsv.com/archive/tcgplayer/prices-{date}.ppmd.7z"


def _download(url: str, dest: Path) -> None:
    request = urllib.request.Request(url, headers={"User-Agent": TCGCSV_USER_AGENT})
    with urllib.request.urlopen(request, timeout=120) as response, dest.open("wb") as handle:
        shutil.copyfileobj(response, handle)


def extract_prices(archive: Path, price_date: str, categories: tuple[int, ...]) -> dict[str, dict[str, dict]]:
    with tempfile.TemporaryDirectory() as tmp:
        subprocess.run(["7zz", "x", "-y", f"-o{tmp}", str(archive)], check=True, capture_output=True)
        root = Path(tmp) / price_date
        by_product: dict[str, dict[str, dict]] = {}
        for category_id in categories:
            category_dir = root / str(category_id)
            if not category_dir.is_dir():
                continue
            for prices_file in category_dir.glob("*/prices"):
                try:
                    payload = json.loads(prices_file.read_text(encoding="utf-8"))
                except ValueError:
                    continue
                for row in payload.get("results") or []:
                    product_id = row.get("productId")
                    sub_type = str(row.get("subTypeName") or "").strip()
                    if product_id is None or not sub_type:
                        continue
                    by_product.setdefault(str(product_id), {})[sub_type] = row
        return by_product


def crawl_products(categories: tuple[int, ...]) -> dict:
    group_by_product: dict[str, list[int]] = {}
    numbers: dict[str, str] = {}
    for category_id in categories:
        group_ids = fetch_group_ids(category_id)
        print(f"[products] category {category_id}: {len(group_ids)} groups", flush=True)
        for group_id in group_ids:
            for row in fetch_group_products(category_id, group_id):
                product_id = str(row.get("productId") or "").strip()
                if not product_id:
                    continue
                group_by_product.setdefault(product_id, [category_id, group_id])
                number = product_number(row)
                if number:
                    numbers[product_id] = number
    return {"groupByProduct": group_by_product, "productNumbers": numbers}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--start", required=True, help="first date, inclusive (YYYY-MM-DD)")
    parser.add_argument("--end", required=True, help="last date, inclusive")
    parser.add_argument("--out-dir", required=True)
    parser.add_argument("--skip-products", action="store_true", help="reuse an existing products.json.gz")
    parser.add_argument("--sleep", type=float, default=1.0, help="seconds between archive downloads")
    args = parser.parse_args(argv)

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    if shutil.which("7zz") is None:
        print("7zz not found — brew install sevenzip", file=sys.stderr)
        return 2

    products_path = out_dir / "products.json.gz"
    if not args.skip_products or not products_path.exists():
        products = crawl_products(TCGCSV_CATEGORY_IDS)
        with gzip.open(products_path, "wt", encoding="utf-8") as handle:
            json.dump(products, handle)
        print(f"[products] {len(products['groupByProduct'])} products, {len(products['productNumbers'])} numbered", flush=True)

    current = date.fromisoformat(args.start)
    last = date.fromisoformat(args.end)
    while current <= last:
        price_date = current.isoformat()
        target = out_dir / f"prices-{price_date}.json.gz"
        if target.exists():
            print(f"[archive] {price_date}: cached", flush=True)
        else:
            archive = out_dir / f"prices-{price_date}.ppmd.7z"
            try:
                _download(ARCHIVE_URL.format(date=price_date), archive)
                by_product = extract_prices(archive, price_date, TCGCSV_CATEGORY_IDS)
                with gzip.open(target, "wt", encoding="utf-8") as handle:
                    json.dump(by_product, handle)
                print(f"[archive] {price_date}: {len(by_product)} products", flush=True)
            except Exception as error:  # noqa: BLE001 - one missing day must not stop the run
                print(f"[archive] {price_date}: FAILED {error}", flush=True)
            finally:
                archive.unlink(missing_ok=True)
            time.sleep(args.sleep)
        current += timedelta(days=1)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
