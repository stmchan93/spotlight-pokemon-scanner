"""Phase-0 parity audit: TCGCSV (TCGplayer) marketPrice vs our current raw main price.

    python3 tools/audit_tcgcsv_parity.py \
        --database-path backend/data/spotlight_scanner.local.sqlite \
        --cache-dir /path/to/cache

Read-only against the DB (opened with mode=ro; the tcgplayer_id join is computed
in-memory from each card's Scrydex payload, so an un-backfilled DB works). TCGCSV
responses are cached on disk per group and reused on re-runs, so the remote is hit
at most once per file — with a ≥0.25s sleep between requests and an identifiable
User-Agent, per https://tcgcsv.com/faq.

Output: a printed report + a JSON artifact (--out) with:
  - product-id and price coverage split EN/JP
  - subtype (printing) match quality for the main-price selection rule
  - delta distribution: TCGCSV marketPrice vs current default_raw_market_price (USD)
  - since-added phantom-jump distribution over deck_entries.added_market_price
  - cards whose TCGCSV price would trip the raw>PSA10 phantom guard

This is the go/no-go artifact for the TCGCSV main-price migration.
"""

from __future__ import annotations

import argparse
import json
import sqlite3
import statistics
import sys
import time
import urllib.error
import urllib.request
from collections import defaultdict
from pathlib import Path

TCGCSV_BASE = "https://tcgcsv.com/tcgplayer"
USER_AGENT = "Spotlight/1.1 (card scanner; contact: stmchan8953@gmail.com)"
REQUEST_SLEEP_SECONDS = 0.3
REQUEST_TIMEOUT_SECONDS = 60.0

# TCGplayer categories for this catalog (Pokemon EN + Pokemon Japan).
DEFAULT_CATEGORIES = (3, 85)

# Scrydex variant label -> TCGCSV subTypeName. Labels are already normalized by
# catalog_tools._normalized_variant_label upstream; the audit normalizes the same way.
VARIANT_TO_SUBTYPE = {
    "Normal": "Normal",
    "Holofoil": "Holofoil",
    "Reverse Holofoil": "Reverse Holofoil",
    "First Edition": "1st Edition Holofoil",
    "Unlimited": "Unlimited Holofoil",
}
SUBTYPE_FALLBACK_ORDER = (
    "Normal",
    "Holofoil",
    "Reverse Holofoil",
    "Unlimited Normal",
    "Unlimited Holofoil",
    "1st Edition Normal",
    "1st Edition Holofoil",
)

_last_request_at = 0.0


def _fetch_json(url: str) -> dict:
    global _last_request_at
    wait = REQUEST_SLEEP_SECONDS - (time.monotonic() - _last_request_at)
    if wait > 0:
        time.sleep(wait)
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    _last_request_at = time.monotonic()
    with urllib.request.urlopen(request, timeout=REQUEST_TIMEOUT_SECONDS) as response:
        return json.loads(response.read().decode("utf-8", "replace"))


def _cached_json(cache_dir: Path, name: str, url: str) -> dict:
    path = cache_dir / name
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    for attempt in range(3):
        try:
            payload = _fetch_json(url)
            break
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
            if attempt == 2:
                raise
            time.sleep(2.0 * (attempt + 1))
            print(f"  retry {attempt + 1} for {url}: {exc}", file=sys.stderr)
    path.write_text(json.dumps(payload), encoding="utf-8")
    return payload


def normalized_card_number(value) -> str:
    """Mirrors tcgcsv_adapter.normalized_card_number."""
    import re
    text = str(value or "").strip().split("/", 1)[0].strip().lower().replace(" ", "")
    return re.sub(r"^([a-z]*)0+(?=\d)", r"\1", text)


def card_numbers_match(card_number: str, product_number: str) -> bool:
    """Mirrors tcgcsv_adapter.card_numbers_match."""
    if not card_number or not product_number:
        return False
    if card_number == product_number:
        return True
    for longer, shorter in ((card_number, product_number), (product_number, card_number)):
        if longer.endswith(shorter):
            prefix = longer[: -len(shorter)]
            if prefix and prefix.isalpha():
                return True
    return False


def download_prices(
    cache_dir: Path, categories: tuple[int, ...]
) -> tuple[dict[str, dict[str, dict]], dict[str, str | None]]:
    """({productId: {subTypeName: price_row}}, {productId: normalized Number or
    None}) across all groups of the categories. The Number map measures the
    trust-but-verify join check."""
    cache_dir.mkdir(parents=True, exist_ok=True)
    by_product: dict[str, dict[str, dict]] = defaultdict(dict)
    number_by_product: dict[str, str | None] = {}
    for category in categories:
        groups_payload = _cached_json(
            cache_dir, f"groups-{category}.json", f"{TCGCSV_BASE}/{category}/groups"
        )
        groups = groups_payload.get("results") or []
        print(f"category {category}: {len(groups)} groups")
        for index, group in enumerate(groups):
            group_id = group.get("groupId")
            if group_id is None:
                continue
            payload = _cached_json(
                cache_dir,
                f"prices-{category}-{group_id}.json",
                f"{TCGCSV_BASE}/{category}/{group_id}/prices",
            )
            for row in payload.get("results") or []:
                product_id = str(row.get("productId") or "").strip()
                sub_type = str(row.get("subTypeName") or "").strip()
                if product_id and sub_type:
                    by_product[product_id][sub_type] = row
            products_payload = _cached_json(
                cache_dir,
                f"products-{category}-{group_id}.json",
                f"{TCGCSV_BASE}/{category}/{group_id}/products",
            )
            for row in products_payload.get("results") or []:
                product_id = str(row.get("productId") or "").strip()
                if not product_id:
                    continue
                number = None
                for entry in row.get("extendedData") or []:
                    if isinstance(entry, dict) and str(entry.get("name") or "").strip() == "Number":
                        number = normalized_card_number(entry.get("value")) or None
                        break
                number_by_product[product_id] = number
            if (index + 1) % 100 == 0:
                print(f"  {index + 1}/{len(groups)} groups fetched")
    return by_product, number_by_product


def _normalized_variant_label(name) -> str:
    text = str(name or "").strip()
    if not text:
        return "Normal"
    lowered = text.replace("_", " ").replace("-", " ").lower()
    collapsed = "".join(lowered.split())
    if collapsed in {"1stedition", "firstedition"}:
        return "First Edition"
    if collapsed in {"raw", "normal", "standard", "unlimitednormal"}:
        return "Normal"
    if collapsed == "holofoil":
        return "Holofoil"
    if collapsed == "reverseholofoil":
        return "Reverse Holofoil"
    return text.title()


def _iter_tcgplayer_variants(payload):
    variants = payload.get("variants") if isinstance(payload, dict) else None
    if not isinstance(variants, list):
        return
    for variant in variants:
        if not isinstance(variant, dict):
            continue
        for marketplace in variant.get("marketplaces") or []:
            if not isinstance(marketplace, dict):
                continue
            if str(marketplace.get("name") or "").strip().lower() != "tcgplayer":
                continue
            product_id = marketplace.get("product_id")
            if product_id is not None and str(product_id).strip():
                yield _normalized_variant_label(variant.get("name")), str(product_id).strip()
                break


def select_main_price(
    card_variant_pids: dict[str, str],
    default_variant: str | None,
    prices_by_product: dict[str, dict[str, dict]],
    colliding: set[str],
):
    """(market_usd, subTypeName, product_id, match_kind) or None.

    Mirrors the planned adapter rule: prefer the product id of the card's default
    printing with the matching subTypeName; otherwise walk the fallback subtype
    order over that product; never guess across colliding ids.
    """
    ordered_pids: list[tuple[str, str]] = []
    normalized_default = _normalized_variant_label(default_variant) if default_variant else None
    if normalized_default and normalized_default in card_variant_pids:
        ordered_pids.append((normalized_default, card_variant_pids[normalized_default]))
    for label, pid in card_variant_pids.items():
        if (label, pid) not in ordered_pids:
            ordered_pids.append((label, pid))
    for label, pid in ordered_pids:
        if pid in colliding:
            continue
        subtypes = prices_by_product.get(pid)
        if not subtypes:
            continue
        wanted = VARIANT_TO_SUBTYPE.get(label)
        candidates = []
        if wanted and wanted in subtypes:
            candidates.append((wanted, "exact"))
        for sub_type in SUBTYPE_FALLBACK_ORDER:
            if sub_type in subtypes and all(sub_type != c[0] for c in candidates):
                candidates.append((sub_type, "fallback"))
        for sub_type in subtypes:
            if all(sub_type != c[0] for c in candidates):
                candidates.append((sub_type, "fallback"))
        for sub_type, match_kind in candidates:
            market = subtypes[sub_type].get("marketPrice")
            if isinstance(market, (int, float)) and market > 0:
                return float(market), sub_type, pid, match_kind
    return None


def _percentiles(values: list[float]) -> dict[str, float]:
    if not values:
        return {}
    ordered = sorted(values)
    def pct(p: float) -> float:
        index = min(len(ordered) - 1, max(0, round(p * (len(ordered) - 1))))
        return round(ordered[index], 4)
    return {
        "p5": pct(0.05), "p25": pct(0.25), "p50": pct(0.50),
        "p75": pct(0.75), "p95": pct(0.95),
        "mean": round(statistics.fmean(ordered), 4),
        "n": len(ordered),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database-path", default="backend/data/spotlight_scanner.local.sqlite")
    parser.add_argument("--cache-dir", required=True)
    parser.add_argument("--out", default=None, help="JSON artifact path (default: <cache-dir>/report.json)")
    parser.add_argument("--categories", default=",".join(str(c) for c in DEFAULT_CATEGORIES))
    args = parser.parse_args()

    categories = tuple(int(c) for c in args.categories.split(",") if c.strip())
    cache_dir = Path(args.cache_dir)
    prices_by_product, number_by_product = download_prices(cache_dir, categories)
    print(f"TCGCSV products with prices: {len(prices_by_product)}")

    connection = sqlite3.connect(f"file:{args.database_path}?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row

    fx_row = connection.execute(
        "SELECT rate FROM fx_rate_snapshots WHERE base_currency='JPY' AND quote_currency='USD' "
        "ORDER BY updated_at DESC LIMIT 1"
    ).fetchone()
    jpy_to_usd = float(fx_row["rate"]) if fx_row else None
    print(f"JPY->USD rate: {jpy_to_usd}")

    # In-memory join map + collision set (the DB's tcgplayer_id backfill may not have run).
    card_variants: dict[str, dict[str, str]] = {}
    card_language: dict[str, str] = {}
    card_name: dict[str, str] = {}
    card_number: dict[str, str] = {}
    pid_to_cards: dict[str, set[str]] = defaultdict(set)
    cursor = connection.execute(
        "SELECT id, name, number, language, source_payload_json FROM cards"
    )
    for row in cursor:
        try:
            payload = json.loads(row["source_payload_json"] or "{}")
        except (TypeError, ValueError):
            payload = {}
        variant_pids = dict(_iter_tcgplayer_variants(payload))
        card_language[row["id"]] = (row["language"] or "").upper() or "EN"
        card_name[row["id"]] = row["name"]
        card_number[row["id"]] = normalized_card_number(row["number"])
        if variant_pids:
            card_variants[row["id"]] = variant_pids
            for pid in variant_pids.values():
                pid_to_cards[pid].add(row["id"])
    colliding = {pid for pid, cards in pid_to_cards.items() if len(cards) > 1}

    total_by_lang: dict[str, int] = defaultdict(int)
    for language in card_language.values():
        total_by_lang[language] += 1
    with_pid_by_lang: dict[str, int] = defaultdict(int)
    for card_id in card_variants:
        with_pid_by_lang[card_language[card_id]] += 1

    snapshots = connection.execute(
        "SELECT card_id, default_raw_market_price, default_raw_variant, display_currency_code, "
        "graded_contexts_json, raw_contexts_json FROM card_price_snapshots"
    )

    coverage = defaultdict(lambda: defaultdict(int))
    deltas_pct: dict[str, list[float]] = defaultdict(list)
    match_kinds: dict[str, int] = defaultdict(int)
    large_moves: list[dict] = []
    phantom_trips: list[dict] = []
    new_main_by_card: dict[str, float] = {}
    number_check = defaultdict(lambda: defaultdict(int))
    number_mismatches: list[dict] = []

    for row in snapshots:
        card_id = row["card_id"]
        language = card_language.get(card_id, "EN")
        variant_pids = card_variants.get(card_id)
        coverage[language]["snapshots"] += 1
        if not variant_pids:
            coverage[language]["no_product_id"] += 1
            continue
        selected = select_main_price(
            variant_pids, row["default_raw_variant"], prices_by_product, colliding
        )
        if selected is None:
            coverage[language]["no_tcgcsv_price"] += 1
            continue
        market_usd, sub_type, pid, match_kind = selected
        coverage[language]["priced"] += 1
        match_kinds[match_kind] += 1
        new_main_by_card[card_id] = market_usd

        # Trust-but-verify measurement: would the product's own card Number
        # agree with the card this join prices?
        product_num = number_by_product.get(pid)
        our_num = card_number.get(card_id, "")
        if product_num is None or not our_num:
            number_check[language]["no_number"] += 1
        elif card_numbers_match(our_num, product_num):
            number_check[language]["verified"] += 1
        else:
            number_check[language]["mismatch"] += 1
            if len(number_mismatches) < 200:
                number_mismatches.append({
                    "card_id": card_id, "name": card_name.get(card_id),
                    "language": language, "card_number": our_num,
                    "product_number": product_num, "product_id": pid,
                    "tcgcsv_usd": round(market_usd, 2),
                    "current": row["default_raw_market_price"],
                })

        current = row["default_raw_market_price"]
        if current is None or current <= 0:
            coverage[language]["gained_price"] += 1
        else:
            current_usd = float(current)
            if (row["display_currency_code"] or "USD") == "JPY":
                if jpy_to_usd is None:
                    continue
                current_usd *= jpy_to_usd
            if current_usd > 0:
                delta_pct = (market_usd - current_usd) / current_usd * 100.0
                deltas_pct[language].append(delta_pct)
                if abs(market_usd - current_usd) >= 20.0 and abs(delta_pct) >= 25.0:
                    large_moves.append({
                        "card_id": card_id, "name": card_name.get(card_id),
                        "language": language, "current_usd": round(current_usd, 2),
                        "tcgcsv_usd": round(market_usd, 2),
                        "delta_pct": round(delta_pct, 1),
                        "subTypeName": sub_type, "product_id": pid,
                    })

        # Phantom check: new raw main above the card's own PSA 10 (any printing count —
        # superset of the guard's single-printing gate, so this over-counts slightly).
        try:
            graded = json.loads(row["graded_contexts_json"] or "{}")
            psa10 = (((graded.get("graders") or {}).get("PSA") or {}).get("10") or [])
            psa10_markets = [
                entry.get("market") for entry in psa10
                if isinstance(entry, dict) and isinstance(entry.get("market"), (int, float))
            ]
            if psa10_markets and market_usd > min(psa10_markets):
                phantom_trips.append({
                    "card_id": card_id, "name": card_name.get(card_id),
                    "language": language, "tcgcsv_usd": round(market_usd, 2),
                    "psa10_usd": round(min(psa10_markets), 2),
                })
        except (TypeError, ValueError):
            pass

    # Since-added jump over real holdings.
    since_added_deltas: list[float] = []
    try:
        entries = connection.execute(
            "SELECT card_id, added_market_price FROM deck_entries "
            "WHERE added_market_price IS NOT NULL AND added_market_price > 0"
        )
        for row in entries:
            new_price = new_main_by_card.get(row["card_id"])
            if new_price is not None:
                since_added_deltas.append(
                    (new_price - float(row["added_market_price"])) / float(row["added_market_price"]) * 100.0
                )
    except sqlite3.OperationalError:
        pass

    large_moves.sort(key=lambda m: abs(m["tcgcsv_usd"] - m["current_usd"]), reverse=True)
    report = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "database_path": args.database_path,
        "categories": list(categories),
        "tcgcsv_products_priced": len(prices_by_product),
        "cards_total_by_language": dict(total_by_lang),
        "cards_with_product_id_by_language": dict(with_pid_by_lang),
        "colliding_product_ids": len(colliding),
        "snapshot_coverage": {lang: dict(counts) for lang, counts in coverage.items()},
        "subtype_match_kinds": dict(match_kinds),
        "delta_pct_by_language": {lang: _percentiles(vals) for lang, vals in deltas_pct.items()},
        "since_added_delta_pct": _percentiles(since_added_deltas),
        "phantom_trip_count": len(phantom_trips),
        "phantom_trips_sample": phantom_trips[:25],
        "large_moves_top": large_moves[:25],
        "number_check_by_language": {lang: dict(counts) for lang, counts in number_check.items()},
        "number_mismatches": number_mismatches,
    }

    out_path = Path(args.out) if args.out else cache_dir / "report.json"
    out_path.write_text(json.dumps(report, indent=2), encoding="utf-8")

    print("\n===== TCGCSV parity report =====")
    for key in (
        "cards_total_by_language", "cards_with_product_id_by_language",
        "colliding_product_ids", "snapshot_coverage", "subtype_match_kinds",
        "delta_pct_by_language", "since_added_delta_pct", "phantom_trip_count",
        "number_check_by_language",
    ):
        print(f"{key}: {json.dumps(report[key])}")
    print(f"\nNumber mismatches ({len(number_mismatches)}): "
          f"{json.dumps(number_mismatches[:15], indent=2, default=str)}")
    print(f"\nTop large moves: {json.dumps(report['large_moves_top'][:10], indent=2)}")
    print(f"\nArtifact: {out_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
