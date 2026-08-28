"""Daily TCGCSV main-lane price sync.

Writes ONLY the additive "main lane": main_raw_* columns on card_price_snapshots /
card_price_history_daily plus one lane='raw_main' cell per card/day. The Scrydex
sync and graded lane are untouched — an existing snapshot row keeps its provider,
display_currency_code, default_raw_*, and contexts JSON byte-for-byte. A card
TCGCSV cannot price is simply skipped (the read path falls back to Scrydex).

Hard-gated behind env TCGCSV_SYNC_ENABLED so a deploy can ship the code dark.
"""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import tcgcsv_adapter
from catalog_tools import (
    PROVIDER_SYNC_STATUS_FAILED,
    PROVIDER_SYNC_STATUS_SUCCEEDED,
    _PRICE_HISTORY_CELL_COLUMNS,
    _iter_card_tcgplayer_variants,
    _normalized_variant_label,
    backfill_cards_tcgplayer_id,
    collision_guard,
    pricing_provider,
    runtime_setting,
    start_provider_sync_run,
    update_provider_sync_run,
    upsert_runtime_setting,
    utc_now,
)
from env_loader import load_backend_env_file
from pricing_utils import cleaned_high_price, cleaned_price
from tcgcsv_adapter import (
    SUBTYPE_TO_SCRYDEX_VARIANT_LABEL,
    TCGCSV_CATEGORY_IDS,
    TCGCSV_PROVIDER,
    build_price_and_number_maps,
    card_numbers_match,
    normalized_card_number,
    select_main_price_entry,
    subtype_for_variant_label,
)

load_backend_env_file(Path(__file__).resolve().parent / ".env")

TCGCSV_SYNC_SCOPE = "raw-main"
PRICING_SYNC_GENERATION_KEY = "pricing_sync_generation"
TCGCSV_LAST_UPDATED_KEY = "tcgcsv_last_updated_marker"
TCGPLAYER_ID_OVERRIDES_PATH = Path(__file__).resolve().parent / "data" / "tcgplayer_id_overrides.json"


def load_tcgplayer_id_overrides(path: Path = TCGPLAYER_ID_OVERRIDES_PATH) -> dict[str, str]:
    """{card_id: product_id} human-verified remaps. Overrides replace the Scrydex
    payload claim and are exempt from collision blocking and number verification."""
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    overrides: dict[str, str] = {}
    for card_id, entry in payload.items():
        if card_id.startswith("_"):
            continue
        product_id = str((entry or {}).get("productId") or "").strip() if isinstance(entry, dict) else ""
        if product_id:
            overrides[card_id] = product_id
    return overrides


def tcgcsv_sync_enabled() -> bool:
    return str(os.environ.get("TCGCSV_SYNC_ENABLED") or "").strip().lower() in {"1", "true", "yes", "on"}


def tcgcsv_verify_numbers_enabled() -> bool:
    """Trust-but-verify kill switch — ON unless explicitly disabled. Measured
    2026-08-25: 99.9% of joins verify; the handful that don't are real mis-maps
    (Pikachu V-UNION quarter, off-by-one Kangaskhan) or ambiguous letter
    variants, all safer on the Scrydex fallback."""
    return str(os.environ.get("TCGCSV_VERIFY_NUMBERS") or "").strip().lower() not in {"0", "false", "no", "off"}


def _today_price_date() -> str:
    return datetime.now(timezone.utc).date().isoformat()


def _card_variant_product_ids(connection: sqlite3.Connection) -> dict[str, dict[str, str]]:
    """{card_id: {normalized_variant_label: tcgplayer_product_id}} from stored payloads."""
    by_card: dict[str, dict[str, str]] = {}
    cursor = connection.execute(
        "SELECT id, source_payload_json FROM cards WHERE source_payload_json LIKE '%tcgplayer%'"
    )
    for card_id, payload_json in cursor:
        try:
            payload = json.loads(payload_json) if payload_json else None
        except (TypeError, ValueError):
            continue
        variants: dict[str, str] = {}
        for name, product_id in _iter_card_tcgplayer_variants(payload):
            variants.setdefault(_normalized_variant_label(name), product_id)
        if variants:
            by_card[str(card_id)] = variants
    return by_card


def _default_raw_variants(connection: sqlite3.Connection) -> dict[str, str | None]:
    rows = connection.execute(
        "SELECT card_id, default_raw_variant FROM card_price_snapshots"
    ).fetchall()
    return {str(row[0]): row[1] for row in rows}


def _normalized_card_name(value: Any) -> str:
    import unicodedata

    text = unicodedata.normalize("NFD", str(value or ""))
    return "".join(ch for ch in text if not unicodedata.combining(ch)).casefold().strip()


def _resolve_collision_owners(
    connection: sqlite3.Connection,
    colliding: frozenset[str] | set[str],
    variant_map: dict[str, dict[str, str]],
    group_by_product: dict[str, tuple[int, int]],
) -> dict[str, set[str]]:
    """{product_id: {card_ids}} for shared product ids the TCGCSV product's own
    data can attribute. Rules, in order:
      1. exactly one claimant matches the product's card Number -> that card
         (the svp-221 Professor Birch case);
      2. several match the Number AND all share the same card name -> ALL of
         them (trainer-kit twins: one TCGplayer product covers both kit halves
         of the same card);
      3. several match the Number with different names -> the one whose name
         appears in the product's own name, if exactly one does (the two-Noibat
         kits name the card: "Pokemon Collector (#22)").
    Anything still ambiguous or unfetchable stays blocked."""
    if not colliding or not group_by_product:
        return {}
    claimants: dict[str, set[str]] = {}
    for card_id, variants in variant_map.items():
        for pid in variants.values():
            if pid in colliding:
                claimants.setdefault(pid, set()).add(card_id)
    owners: dict[str, set[str]] = {}
    products_by_location: dict[tuple[int, int], dict[str, dict[str, Any]]] = {}
    for pid, card_ids in claimants.items():
        location = group_by_product.get(pid)
        if location is None:
            continue
        if location not in products_by_location:
            try:
                products_by_location[location] = {
                    str(row.get("productId") or "").strip(): row
                    for row in tcgcsv_adapter.fetch_group_products(*location)
                }
            except Exception:
                products_by_location[location] = {}
        product_row = products_by_location[location].get(pid)
        number = tcgcsv_adapter.product_number(product_row) if product_row else None
        if not number:
            continue
        matches: list[tuple[str, str]] = []
        for card_id in card_ids:
            row = connection.execute(
                "SELECT number, name FROM cards WHERE id = ?", (card_id,)
            ).fetchone()
            if row is not None and card_numbers_match(normalized_card_number(row[0]), number):
                matches.append((card_id, _normalized_card_name(row[1])))
        if len(matches) == 1:
            owners[pid] = {matches[0][0]}
        elif len(matches) > 1:
            names = {name for _, name in matches}
            if len(names) == 1:
                owners[pid] = {card_id for card_id, _ in matches}
            else:
                product_name = _normalized_card_name((product_row or {}).get("name"))
                named = [card_id for card_id, name in matches if name and name in product_name]
                if len(named) == 1:
                    owners[pid] = {named[0]}
    return owners


def _card_numbers(connection: sqlite3.Connection) -> dict[str, str]:
    return {
        str(row[0]): normalized_card_number(row[1])
        for row in connection.execute("SELECT id, number FROM cards")
    }


def _bump_pricing_sync_generation(connection: sqlite3.Connection) -> int:
    setting = runtime_setting(connection, PRICING_SYNC_GENERATION_KEY)
    current = setting["value"] if setting and isinstance(setting["value"], int) else 0
    upsert_runtime_setting(connection, key=PRICING_SYNC_GENERATION_KEY, value=current + 1)
    return current + 1


def _printing_entry(prices: dict[str, Any], sub_type_name: str) -> dict[str, Any] | None:
    """Cleaned per-printing row, or None when the printing has no real market
    (null-market printings deliberately keep their Scrydex rows untouched)."""
    market = cleaned_price(prices.get("marketPrice"))
    if market is None:
        return None
    return {
        "subTypeName": sub_type_name,
        "market": market,
        "low": cleaned_price(prices.get("lowPrice")),
        "mid": cleaned_price(prices.get("midPrice")),
        "high": cleaned_high_price(prices.get("highPrice"), market),
        "directLow": cleaned_price(prices.get("directLowPrice")),
    }


def _build_printings_map(
    variant_product_ids: dict[str, str],
    blocked: frozenset[str] | set[str],
    product_price_map: dict[str, dict[str, dict[str, Any]]],
    product_number_map: dict[str, str],
    card_number: str,
    verify_numbers: bool,
) -> dict[str, dict[str, Any]]:
    """{Scrydex variant label: printing entry} for every printing with its own
    marketPrice. Exact label->subTypeName rows only — no fallback-order walking
    (the walk is a headline-only behavior)."""
    printings: dict[str, dict[str, Any]] = {}
    for label, product_id in variant_product_ids.items():
        if product_id in blocked:
            continue
        if verify_numbers:
            product_num = product_number_map.get(product_id)
            if product_num and card_number and not card_numbers_match(card_number, product_num):
                continue
        sub_type_name = subtype_for_variant_label(label)
        if not sub_type_name:
            continue
        entry = _printing_entry(
            (product_price_map.get(product_id) or {}).get(sub_type_name) or {}, sub_type_name
        )
        if entry is not None:
            printings.setdefault(label, entry)
    return printings


def _printings_from_override(
    override_pid: str,
    product_price_map: dict[str, dict[str, dict[str, Any]]],
) -> dict[str, dict[str, Any]]:
    """Override cards: every priced subtype of the human-verified product, mapped
    back to Scrydex labels. When two subtypes share a label (1st Edition Normal +
    Holofoil), the canonical label->subtype mapping wins."""
    printings: dict[str, dict[str, Any]] = {}
    for sub_type_name, prices in (product_price_map.get(override_pid) or {}).items():
        label = SUBTYPE_TO_SCRYDEX_VARIANT_LABEL.get(sub_type_name)
        if not label:
            continue
        entry = _printing_entry(prices or {}, sub_type_name)
        if entry is None:
            continue
        if label not in printings or subtype_for_variant_label(label) == sub_type_name:
            printings[label] = entry
    return printings


def _clear_card_main_price(
    connection: sqlite3.Connection, *, card_id: str, price_date: str
) -> None:
    connection.execute(
        """
        UPDATE card_price_snapshots SET
            main_raw_market_price = NULL, main_raw_low_price = NULL,
            main_raw_mid_price = NULL, main_raw_high_price = NULL,
            main_raw_direct_low_price = NULL, main_raw_variant = NULL,
            main_raw_updated_at = NULL, main_raw_printings_json = '{}'
        WHERE card_id = ? AND main_raw_market_price IS NOT NULL
        """,
        (card_id,),
    )
    connection.execute(
        "UPDATE card_price_history_daily SET main_raw_market_price = NULL, main_raw_variant = NULL "
        "WHERE card_id = ? AND price_date = ? AND main_raw_market_price IS NOT NULL",
        (card_id, price_date),
    )
    connection.execute(
        "DELETE FROM card_price_history_cell WHERE card_id = ? AND price_date = ? AND lane = 'raw_main'",
        (card_id, price_date),
    )


def _write_card_main_price(
    connection: sqlite3.Connection,
    *,
    card_id: str,
    prices: dict[str, Any],
    sub_type_name: str,
    price_date: str,
    now: str,
    printings: dict[str, dict[str, Any]] | None = None,
) -> None:
    market = cleaned_price(prices.get("marketPrice"))
    low = cleaned_price(prices.get("lowPrice"))
    mid = cleaned_price(prices.get("midPrice"))
    direct_low = cleaned_price(prices.get("directLowPrice"))
    high = cleaned_high_price(prices.get("highPrice"), market)
    printings = printings or {}

    # Snapshot: the DO UPDATE branch sets ONLY the main lane — an existing Scrydex
    # row keeps provider/display_currency_code/default_raw_*/contexts/updated_at.
    connection.execute(
        """
        INSERT INTO card_price_snapshots (
            card_id, provider, display_currency_code,
            main_raw_market_price, main_raw_low_price, main_raw_mid_price,
            main_raw_high_price, main_raw_direct_low_price, main_raw_variant,
            main_raw_updated_at, main_raw_printings_json, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(card_id) DO UPDATE SET
            main_raw_market_price = excluded.main_raw_market_price,
            main_raw_low_price = excluded.main_raw_low_price,
            main_raw_mid_price = excluded.main_raw_mid_price,
            main_raw_high_price = excluded.main_raw_high_price,
            main_raw_direct_low_price = excluded.main_raw_direct_low_price,
            main_raw_variant = excluded.main_raw_variant,
            main_raw_updated_at = excluded.main_raw_updated_at,
            main_raw_printings_json = excluded.main_raw_printings_json
        """,
        (card_id, TCGCSV_PROVIDER, "USD", market, low, mid, high, direct_low,
         sub_type_name, now, json.dumps(printings), now),
    )

    # Daily: INSERT-branch provider must be pricing_provider() (NOT 'tcgcsv') so the
    # history readers' WHERE provider = ? filters still see the row.
    connection.execute(
        """
        INSERT INTO card_price_history_daily (
            card_id, provider, price_date, display_currency_code,
            main_raw_market_price, main_raw_variant, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(card_id, price_date) DO UPDATE SET
            main_raw_market_price = excluded.main_raw_market_price,
            main_raw_variant = excluded.main_raw_variant
        """,
        (card_id, pricing_provider(), price_date, "USD", market, sub_type_name, now),
    )

    connection.execute(
        "DELETE FROM card_price_history_cell WHERE card_id = ? AND price_date = ? AND lane = 'raw_main'",
        (card_id, price_date),
    )
    # One cell per priced printing; the main selection keeps its cell even when
    # its subtype fell outside the exact per-printing mapping (fallback-walk mains).
    cell_values: dict[str, dict[str, Any]] = {
        entry["subTypeName"]: entry for entry in printings.values()
    }
    cell_values.setdefault(sub_type_name, {
        "subTypeName": sub_type_name, "market": market, "low": low,
        "mid": mid, "high": high, "directLow": direct_low,
    })
    placeholders = ",".join(["?"] * len(_PRICE_HISTORY_CELL_COLUMNS))
    for entry in cell_values.values():
        cell_row = {
            "card_id": card_id,
            "provider": TCGCSV_PROVIDER,
            "price_date": price_date,
            "lane": "raw_main",
            "cell_key": f"raw_main|{entry['subTypeName']}|NM",
            "variant_key": entry["subTypeName"],
            "condition": "NM",
            "grader": None,
            "grade": None,
            "is_perfect": 0,
            "is_signed": 0,
            "is_error": 0,
            "currency_code": "USD",
            "low": entry.get("low"),
            "market": entry.get("market"),
            "mid": entry.get("mid"),
            "high": entry.get("high"),
            "direct_low": entry.get("directLow"),
            "trend": entry.get("market"),
            "updated_at": now,
        }
        connection.execute(
            f"INSERT INTO card_price_history_cell ({', '.join(_PRICE_HISTORY_CELL_COLUMNS)}) "
            f"VALUES ({placeholders})",
            tuple(cell_row[column] for column in _PRICE_HISTORY_CELL_COLUMNS),
        )


def run_tcgcsv_price_sync(
    connection: sqlite3.Connection,
    *,
    scheduled_for: str | None = None,
    dry_run: bool = False,
    product_price_map: dict[str, dict[str, dict[str, Any]]] | None = None,
    price_date: str | None = None,
    commit_every: int = 500,
    last_updated: str | None = None,
    group_by_product: dict[str, tuple[int, int]] | None = None,
    product_number_map: dict[str, str] | None = None,
    force: bool = False,
) -> dict[str, int]:
    price_date = price_date or _today_price_date()

    # Publish-marker guard (their docs: check last-updated.txt first; one pull per
    # 24h). The cron fires several catch-up minutes around the ~13:05 PT publish;
    # only the first attempt after the marker advances does the real crawl — the
    # rest cost one request each.
    if last_updated is None and product_price_map is None:
        last_updated = tcgcsv_adapter.fetch_last_updated()
    if last_updated and not force:
        previous = runtime_setting(connection, TCGCSV_LAST_UPDATED_KEY)
        if previous and previous.get("value") == last_updated:
            stats = {"skipped_not_updated": 1}
            print(f"[tcgcsv] skip (last-updated unchanged: {last_updated})")
            return stats

    has_tcgplayer_ids = connection.execute(
        "SELECT COUNT(*) FROM cards WHERE tcgplayer_id IS NOT NULL AND tcgplayer_id != ''"
    ).fetchone()[0]
    if not has_tcgplayer_ids:
        backfill_cards_tcgplayer_id(connection)

    run_id: str | None = None
    if not dry_run:
        run_id = start_provider_sync_run(
            connection,
            provider=TCGCSV_PROVIDER,
            sync_scope=TCGCSV_SYNC_SCOPE,
            page_size=0,
            scheduled_for=scheduled_for,
        )
        connection.commit()

    try:
        requests_before = tcgcsv_adapter.request_count
        if group_by_product is None:
            group_by_product = {}
        failed_groups: list[tuple[int, int, str]] = []
        if product_price_map is None:
            product_price_map, product_number_map = build_price_and_number_maps(
                TCGCSV_CATEGORY_IDS, group_by_product, failed_groups
            )
            # A few flaky groups are tolerated (their cards keep yesterday's main
            # via staleness); a broadly failing crawl means TCGCSV is down —
            # abort so the catch-up cron attempts retry the whole day.
            if len(failed_groups) > 40:
                raise RuntimeError(f"TCGCSV crawl failed for {len(failed_groups)} groups; aborting run")
        if product_number_map is None:
            product_number_map = {}

        variant_map = _card_variant_product_ids(connection)
        defaults = _default_raw_variants(connection)
        colliding = collision_guard(connection)["colliding_product_ids"]
        collision_owners = _resolve_collision_owners(
            connection, colliding, variant_map, group_by_product
        )
        owned_pids_by_card: dict[str, set[str]] = {}
        for pid, owner_card_ids in collision_owners.items():
            for owner_card_id in owner_card_ids:
                owned_pids_by_card.setdefault(owner_card_id, set()).add(pid)
        overrides = load_tcgplayer_id_overrides()
        requests_made = tcgcsv_adapter.request_count - requests_before

        card_numbers = _card_numbers(connection)
        verify_numbers = tcgcsv_verify_numbers_enabled()

        now = utc_now()
        all_card_ids = list(variant_map) + [c for c in overrides if c not in variant_map]
        stats = {"cards_seen": len(all_card_ids), "priced": 0, "skipped_no_match": 0,
                 "skipped_number_mismatch": 0, "overrides_applied": 0,
                 "requests": requests_made, "products": len(product_price_map),
                 "collisions_resolved": len(collision_owners)}
        mismatch_suspects: list[dict[str, str]] = []
        pending = 0
        for card_id in all_card_ids:
            override_pid = overrides.get(card_id)
            if override_pid:
                # Human-verified remap: replaces the payload claim entirely and is
                # exempt from collision blocking and number verification.
                label = _normalized_variant_label(defaults.get(card_id) or "Normal")
                selection = select_main_price_entry(
                    {label: override_pid}, defaults.get(card_id), product_price_map, frozenset()
                )
                if selection is None:
                    stats["skipped_no_match"] += 1
                    continue
                prices, sub_type_name, product_id = selection
                stats["overrides_applied"] += 1
                stats["priced"] += 1
                if not dry_run:
                    _write_card_main_price(
                        connection, card_id=card_id, prices=prices,
                        sub_type_name=sub_type_name, price_date=price_date, now=now,
                        printings=_printings_from_override(override_pid, product_price_map),
                    )
                    pending += 1
                    if pending % commit_every == 0:
                        connection.commit()
                continue
            variant_product_ids = variant_map[card_id]
            owned = owned_pids_by_card.get(card_id)
            blocked = colliding - owned if owned else colliding
            selection = select_main_price_entry(
                variant_product_ids, defaults.get(card_id), product_price_map, blocked
            )
            if selection is None:
                stats["skipped_no_match"] += 1
                continue
            prices, sub_type_name, product_id = selection
            # Trust-but-verify: the product's own card Number must agree with the
            # card, else the Scrydex product-id claim is a suspected mis-map and
            # the card stays on the Scrydex fallback. No Number on either side =
            # unverifiable, price anyway.
            if verify_numbers:
                product_num = product_number_map.get(product_id)
                card_num = card_numbers.get(card_id, "")
                if product_num and card_num and not card_numbers_match(card_num, product_num):
                    stats["skipped_number_mismatch"] += 1
                    if len(mismatch_suspects) < 50:
                        mismatch_suspects.append({
                            "cardId": card_id, "productId": product_id,
                            "cardNumber": card_num, "productNumber": product_num,
                        })
                    if not dry_run:
                        # A CONFIRMED mismatch clears any previously-written main
                        # lane immediately — a known-bad join must not keep
                        # serving until the staleness window expires.
                        _clear_card_main_price(connection, card_id=card_id, price_date=price_date)
                        pending += 1
                    continue
            stats["priced"] += 1
            if dry_run:
                continue
            _write_card_main_price(
                connection, card_id=card_id, prices=prices,
                sub_type_name=sub_type_name, price_date=price_date, now=now,
                printings=_build_printings_map(
                    variant_product_ids, blocked, product_price_map,
                    product_number_map, card_numbers.get(card_id, ""), verify_numbers,
                ),
            )
            pending += 1
            if pending % commit_every == 0:
                connection.commit()

        if dry_run:
            print(f"[tcgcsv] dry-run {json.dumps(stats)}")
            return stats

        connection.commit()
        # Store the publish marker only after a FULLY clean crawl: with failed
        # groups left un-marked, the next catch-up cron attempt re-crawls and
        # fills the gap instead of waiting for tomorrow.
        if last_updated and not failed_groups:
            upsert_runtime_setting(connection, key=TCGCSV_LAST_UPDATED_KEY, value=last_updated)
        stats["failed_groups"] = len(failed_groups)
        stats["generation"] = _bump_pricing_sync_generation(connection)
        update_provider_sync_run(
            connection,
            run_id,
            status=PROVIDER_SYNC_STATUS_SUCCEEDED,
            completed_at=utc_now(),
            pages_fetched=requests_made,
            cards_seen=stats["cards_seen"],
            raw_snapshots_upserted=stats["priced"],
            notes={"priceDate": price_date, "categories": list(TCGCSV_CATEGORY_IDS),
                   "skippedNoMatch": stats["skipped_no_match"], "products": stats["products"],
                   "collisionsResolved": stats["collisions_resolved"],
                   "skippedNumberMismatch": stats["skipped_number_mismatch"],
                   "numberMismatchSuspects": mismatch_suspects,
                   "overridesApplied": stats["overrides_applied"],
                   "failedGroups": failed_groups[:20]},
        )
        connection.commit()
        print(f"[tcgcsv] sync {json.dumps(stats)}")
        return stats
    except Exception as exc:
        if run_id is not None:
            update_provider_sync_run(
                connection,
                run_id,
                status=PROVIDER_SYNC_STATUS_FAILED,
                completed_at=utc_now(),
                error_text=str(exc),
            )
            connection.commit()
        raise


def _main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Sync TCGCSV main-lane prices into the price tables")
    parser.add_argument("--database-path", required=True)
    parser.add_argument("--scheduled-for")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument(
        "--force", action="store_true",
        help="Manual validation runs only: crawl even when last-updated.txt has "
             "not advanced (keep this rare — the guard is TCGCSV's once-per-24h rule)",
    )
    args = parser.parse_args(argv)

    if not tcgcsv_sync_enabled():
        print("[tcgcsv] TCGCSV_SYNC_ENABLED is not truthy; skipping sync")
        return 0

    connection = sqlite3.connect(args.database_path, timeout=60.0)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA journal_mode=WAL")
    try:
        run_tcgcsv_price_sync(
            connection, scheduled_for=args.scheduled_for, dry_run=args.dry_run,
            force=args.force,
        )
    finally:
        connection.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(_main())
