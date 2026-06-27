"""Sync PokemonPriceTracker (PPT) prices into our price tables.

PPT becomes the price source by writing the SAME snapshot/daily/cell rows the app
already reads (via catalog_tools.upsert_price_snapshot / upsert_price_history_daily),
joined to our cards by TCGplayer product id (PPT `tcgPlayerId` == `cards.tcgplayer_id`).

Provider labelling: PPT rows are always written under PPT_PROVIDER ("ppt"); the READ
path serves whichever provider `pricing_provider()` selects (env PRICING_PROVIDER).
So the cutover is: set PRICING_PROVIDER=ppt, run a full PPT sync (writes "ppt" rows),
and reads serve PPT. Rollback: flip the flag back + re-run the Scrydex sync.

Transport:
- Business `GET /export` (type=cards + type=ebay) gzip-CSV daily dumps — the
  production full-catalog path (no per-card credits). CSV column mapping is filled
  in once a real dump is sampled (Business key required).
- `GET /cards?tcgPlayerId=...&includeBoth=true` — per-card path for sampling /
  validation on any tier (credit-metered).

The pure core (join + upsert) is transport-agnostic and unit-tested; the HTTP bits
are thin wrappers.
"""

from __future__ import annotations

import gzip
import json
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Iterable

from catalog_tools import (
    pricing_provider,
    upsert_price_history_daily,
    upsert_price_snapshot,
    utc_now,
)
from ppt_adapter import (
    PPT_PROVIDER,
    build_card_population,
    build_ppt_graded_contexts,
    build_ppt_pricing_bundle,
)

PPT_API_BASE = "https://www.pokemonpricetracker.com/api/v2"


# ---------------------------------------------------------------------------
# Pure core: PPT card record -> our price rows
# ---------------------------------------------------------------------------

def _headline_raw(raw_contexts: dict[str, Any]) -> dict[str, float | None]:
    """Primary printing's NM market/low for the snapshot's scalar default columns
    (the fallback the resolver uses when context/cell resolution yields nothing)."""
    variants = (raw_contexts or {}).get("variants") or {}
    best = {"market": None, "low": None}
    for variant_bucket in variants.values():
        conditions = (variant_bucket or {}).get("conditions") or {}
        cell = conditions.get("NM") or next(iter(conditions.values()), None)
        if isinstance(cell, dict) and isinstance(cell.get("market"), (int, float)):
            best = {"market": cell.get("market"), "low": cell.get("low")}
            break
    return best


def card_ids_for_tcgplayer_id(connection, tcgplayer_id: str | None) -> list[str]:
    if not tcgplayer_id:
        return []
    rows = connection.execute(
        "SELECT id FROM cards WHERE tcgplayer_id = ?", (str(tcgplayer_id),)
    ).fetchall()
    return [str(r[0]) for r in rows]


# PPT graded "trust signals" live in their OWN table (ppt_graded_signals), not in
# the snapshot's graded_contexts_json. The daily Scrydex price sync wholesale-
# overwrites graded_contexts_json, so writing signals there is non-durable; the
# side table survives and the READ path joins it back in by (card_id, grader,
# grade). This keeps the signals-only path from ever touching a displayed price or
# provider.


def _coerce_signal_count(value: Any) -> int | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return int(value)


def _coerce_signal_float(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value)


def _annotate_existing_graded_signals(
    connection,
    card_id: str,
    ppt_graded_contexts: dict[str, Any],
) -> dict[str, Any]:
    """Signals-only annotation. UPSERT one row per PPT grader/grade into the
    SEPARATE ``ppt_graded_signals`` table (durable: the daily Scrydex price sync
    wholesale-overwrites ``graded_contexts_json`` but never touches this table, so
    the trust signals survive). Values come from each PPT entry's ``payload``
    (confidence / eBay sale count / smartMarketPrice / source / median). The
    snapshot's graded/raw JSON, provider, and prices are NOT touched at all — this
    is a pure side-table overlay that the READ path joins back in by
    (card_id, grader, grade). PPT-only grades are written too (reads only surface a
    signal when the snapshot actually has that grade, so an orphan signal row is
    harmless).

    Returns ``{"annotated": int, "skipped_ppt_only": int}`` where ``annotated`` is
    the number of signal rows upserted. Does not commit (the batch driver commits)."""
    annotated = 0
    graders = ppt_graded_contexts.get("graders") if isinstance(ppt_graded_contexts, dict) else None
    if not isinstance(graders, dict):
        return {"annotated": 0, "skipped_ppt_only": 0}
    now = utc_now()
    for grader_key, grade_map in graders.items():
        if not isinstance(grade_map, dict):
            continue
        for grade_key, ppt_entries in grade_map.items():
            ppt_entry = next((e for e in (ppt_entries or []) if isinstance(e, dict)), None)
            ppt_payload = (ppt_entry or {}).get("payload") if isinstance(ppt_entry, dict) else None
            if not isinstance(ppt_payload, dict):
                continue
            confidence = ppt_payload.get("confidence")
            confidence = str(confidence).strip().lower() if confidence is not None and str(confidence).strip() else None
            count = _coerce_signal_count(ppt_payload.get("count"))
            smart = _coerce_signal_float(ppt_payload.get("smart"))
            source = str(ppt_payload.get("source") or "").strip() or None
            median = _coerce_signal_float(ppt_payload.get("median"))
            connection.execute(
                """
                INSERT INTO ppt_graded_signals
                    (card_id, grader, grade, confidence, count, smart, source, median, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(card_id, grader, grade) DO UPDATE SET
                    confidence = excluded.confidence,
                    count = excluded.count,
                    smart = excluded.smart,
                    source = excluded.source,
                    median = excluded.median,
                    updated_at = excluded.updated_at
                """,
                (card_id, str(grader_key).strip().upper(), str(grade_key).strip().upper(),
                 confidence, count, smart, source, median, now),
            )
            annotated += 1
    return {"annotated": annotated, "skipped_ppt_only": 0}


def upsert_ppt_card_pricing(
    connection,
    ppt_card: dict[str, Any],
    *,
    price_date: str,
    provider: str = PPT_PROVIDER,
    signals_only: bool = False,
) -> dict[str, Any]:
    """Join one PPT card to our catalog by tcgPlayerId and write its snapshot + daily
    rows (cells auto-written by the upserts). Returns a small result dict; callers
    aggregate. Does not commit (the batch driver commits).

    When ``signals_only`` is True, this does NOT write prices/provider at all. It
    upserts PPT trust signals (confidence, eBay sale count, smartMarketPrice) into
    the SEPARATE ``ppt_graded_signals`` table via
    ``_annotate_existing_graded_signals`` — a durable, fully-reversible overlay the
    READ path joins back in by (card_id, grader, grade). It cannot change a
    displayed price (the displayed price + provider stay whatever they already
    were, e.g. Scrydex), and it survives the daily Scrydex sync that overwrites
    ``graded_contexts_json``."""
    bundle = build_ppt_pricing_bundle(ppt_card)
    tcgplayer_id = bundle["tcgplayer_id"]
    if not tcgplayer_id:
        return {"matched": 0, "reason": "no_tcgplayer_id"}
    card_ids = card_ids_for_tcgplayer_id(connection, tcgplayer_id)
    if not card_ids:
        return {"matched": 0, "reason": "no_local_card", "tcgplayerId": tcgplayer_id}

    if signals_only:
        ppt_graded_contexts = build_ppt_graded_contexts(ppt_card)
        if not ppt_graded_contexts.get("graders"):
            return {"matched": 0, "reason": "no_graded_signals", "tcgplayerId": tcgplayer_id}
        annotated_total = 0
        skipped_total = 0
        for card_id in card_ids:
            result = _annotate_existing_graded_signals(connection, card_id, ppt_graded_contexts)
            annotated_total += result.get("annotated", 0)
            skipped_total += result.get("skipped_ppt_only", 0)
        if not annotated_total:
            return {"matched": 0, "reason": "no_matching_grades", "tcgplayerId": tcgplayer_id,
                    "skippedPptOnly": skipped_total}
        return {"matched": len(card_ids), "cardIds": card_ids, "tcgplayerId": tcgplayer_id,
                "annotated": annotated_total, "skippedPptOnly": skipped_total, "signalsOnly": True}

    raw_contexts = bundle["raw_contexts"]
    graded_contexts = bundle["graded_contexts"]
    # If PPT has NO usable price for this card (no raw variant + no graded grade),
    # skip it entirely so its existing Scrydex row stays intact — the unpriced-tail
    # fallback (illiquid JP/promo with no TCGplayer listings). Never blank a price.
    if not raw_contexts.get("variants") and not graded_contexts.get("graders"):
        return {"matched": 0, "reason": "no_price", "tcgplayerId": tcgplayer_id}
    headline = _headline_raw(raw_contexts)
    now = utc_now()
    for card_id in card_ids:
        common = dict(
            connection=connection,
            card_id=card_id,
            provider=provider,
            display_currency_code="USD",
            raw_contexts=raw_contexts,
            graded_contexts=graded_contexts,
            default_raw_market_price=headline["market"],
            default_raw_low_price=headline["low"],
            source_url=None,
            payload={"source": "pokemonpricetracker", "tcgPlayerId": tcgplayer_id},
        )
        upsert_price_snapshot(source_updated_at=now, **common)
        upsert_price_history_daily(price_date=price_date, **common)
    return {"matched": len(card_ids), "cardIds": card_ids, "tcgplayerId": tcgplayer_id}


def upsert_ppt_card_population(
    connection,
    gemrate_data: dict[str, Any],
) -> dict[str, Any]:
    """Write GemRate population onto the EXISTING price snapshot(s) for one card,
    joined by `tcgPlayerId`. Metadata-only: rewrites `population_json` and nothing
    else (no provider/price/raw/graded touch), so it can never change a displayed
    price and is fully reversible. No-op when the card has no snapshot or PPT has no
    usable population. Does not commit (the batch driver commits).

    Returns ``{"matched": int, "cardIds": [...], "graders": [...]}``."""
    tcgplayer_id = str(gemrate_data.get("tcgPlayerId") or "").strip() if isinstance(gemrate_data, dict) else ""
    if not tcgplayer_id:
        return {"matched": 0, "reason": "no_tcgplayer_id"}
    population = build_card_population(gemrate_data)
    if not population:
        return {"matched": 0, "reason": "no_population", "tcgplayerId": tcgplayer_id}
    card_ids = card_ids_for_tcgplayer_id(connection, tcgplayer_id)
    if not card_ids:
        return {"matched": 0, "reason": "no_local_card", "tcgplayerId": tcgplayer_id}

    payload = json.dumps(population)
    now = utc_now()
    matched: list[str] = []
    for card_id in card_ids:
        cursor = connection.execute(
            "UPDATE card_price_snapshots SET population_json = ?, updated_at = ? WHERE card_id = ?",
            (payload, now, card_id),
        )
        if cursor.rowcount:
            matched.append(card_id)
    if not matched:
        return {"matched": 0, "reason": "no_snapshot", "tcgplayerId": tcgplayer_id}
    return {"matched": len(matched), "cardIds": matched, "tcgplayerId": tcgplayer_id,
            "graders": sorted(population.keys())}


def sync_ppt_population(
    connection,
    gemrate_records: Iterable[dict[str, Any]],
    *,
    commit_every: int = 500,
) -> dict[str, int]:
    """Drive a batch of GemrateData records through upsert_ppt_card_population — a
    metadata-only overlay that writes `population_json` onto existing snapshots and
    never touches a price. Returns {seen, matched, unmatched_no_tcg, no_population,
    unmatched_no_card, no_snapshot}."""
    stats = {"seen": 0, "matched": 0, "unmatched_no_tcg": 0, "no_population": 0,
             "unmatched_no_card": 0, "no_snapshot": 0}
    for index, record in enumerate(gemrate_records, start=1):
        stats["seen"] += 1
        result = upsert_ppt_card_population(connection, record)
        reason = result.get("reason")
        if result["matched"]:
            stats["matched"] += result["matched"]
        elif reason == "no_tcgplayer_id":
            stats["unmatched_no_tcg"] += 1
        elif reason == "no_population":
            stats["no_population"] += 1
        elif reason == "no_local_card":
            stats["unmatched_no_card"] += 1
        else:  # no_snapshot
            stats["no_snapshot"] += 1
        if index % commit_every == 0:
            connection.commit()
    connection.commit()
    return stats


def _all_catalog_tcgplayer_ids(connection) -> list[str]:
    """Every distinct non-null cards.tcgplayer_id — the join universe for a full
    population refresh."""
    rows = connection.execute(
        "SELECT DISTINCT tcgplayer_id FROM cards "
        "WHERE tcgplayer_id IS NOT NULL AND TRIM(tcgplayer_id) <> ''"
    ).fetchall()
    return [str(r[0]).strip() for r in rows]


def sync_ppt_population_via_api(
    connection,
    api_key: str,
    *,
    tcgplayer_ids: list[str] | None = None,
    batch_size: int = 50,
    sleep_seconds: float = 0.15,
    commit_every: int = 20,
    language: str = "english",
) -> dict[str, int]:
    """Full population refresh over the per-card `/population` JSON path (Business,
    2 credits/card, max 50 ids/request) — the production path while the bulk
    `/export type=population` CSV layout is unconfirmed. Defaults to every catalog
    tcgPlayerId. Metadata-only: writes population_json onto existing snapshots,
    never a price. Returns {requested, fetched, matched, no_snapshot, ...}."""
    ids = tcgplayer_ids if tcgplayer_ids is not None else _all_catalog_tcgplayer_ids(connection)
    stats = {"requested": len(ids), "fetched": 0, "matched": 0, "no_population": 0,
             "unmatched_no_card": 0, "no_snapshot": 0, "batches": 0}
    for start in range(0, len(ids), batch_size):
        batch = ids[start:start + batch_size]
        stats["batches"] += 1
        records = fetch_ppt_population(api_key, batch, language=language)
        stats["fetched"] += len(records)
        for record in records:
            result = upsert_ppt_card_population(connection, record)
            reason = result.get("reason")
            if result["matched"]:
                stats["matched"] += result["matched"]
            elif reason == "no_population":
                stats["no_population"] += 1
            elif reason == "no_local_card":
                stats["unmatched_no_card"] += 1
            elif reason == "no_snapshot":
                stats["no_snapshot"] += 1
        if stats["batches"] % commit_every == 0:
            connection.commit()
        if sleep_seconds:
            time.sleep(sleep_seconds)
    connection.commit()
    return stats


def sync_ppt_cards(
    connection,
    ppt_cards: Iterable[dict[str, Any]],
    *,
    price_date: str,
    provider: str = PPT_PROVIDER,
    commit_every: int = 500,
    signals_only: bool = False,
) -> dict[str, int]:
    """Drive a batch of PPT card records through upsert_ppt_card_pricing. Returns
    {seen, matched, unmatched_no_tcg, unmatched_no_card, ...}.

    With ``signals_only`` the batch annotates existing graded entries with PPT trust
    signals instead of writing prices (see ``upsert_ppt_card_pricing``)."""
    stats = {"seen": 0, "matched": 0, "unmatched_no_tcg": 0, "unmatched_no_card": 0,
             "skipped_no_price": 0, "annotated": 0, "skipped_no_match": 0}
    for index, ppt_card in enumerate(ppt_cards, start=1):
        stats["seen"] += 1
        result = upsert_ppt_card_pricing(
            connection, ppt_card, price_date=price_date, provider=provider, signals_only=signals_only
        )
        reason = result.get("reason")
        if result["matched"]:
            stats["matched"] += result["matched"]
            stats["annotated"] += result.get("annotated", 0)
        elif reason == "no_tcgplayer_id":
            stats["unmatched_no_tcg"] += 1
        elif reason in ("no_price", "no_graded_signals"):
            stats["skipped_no_price"] += 1
        elif reason == "no_matching_grades":
            stats["skipped_no_match"] += 1
        else:
            stats["unmatched_no_card"] += 1
        if index % commit_every == 0:
            connection.commit()
    connection.commit()
    return stats


# ---------------------------------------------------------------------------
# Transport
# ---------------------------------------------------------------------------

def _request(url: str, api_key: str, *, timeout: float = 120.0) -> tuple[int, bytes, str]:
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {api_key}"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read(), resp.headers.get("Content-Type", "")
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read(), exc.headers.get("Content-Type", "") if exc.headers else ""


def fetch_ppt_card_by_tcgplayer_id(
    api_key: str, tcgplayer_id: str, *, language: str = "english", include_both: bool = True
) -> dict[str, Any] | None:
    """Per-card fetch (credit-metered) — for sampling/validation. Returns the PPT
    card dict or None."""
    params = {"tcgPlayerId": str(tcgplayer_id), "language": language}
    if include_both:
        params["includeBoth"] = "true"
    status, body, _ = _request(f"{PPT_API_BASE}/cards?{urllib.parse.urlencode(params)}", api_key)
    if status != 200:
        return None
    payload = json.loads(body.decode("utf-8", "replace"))
    data = payload.get("data") if isinstance(payload, dict) else None
    if isinstance(data, list):
        return data[0] if data else None
    return data if isinstance(data, dict) else None


def fetch_ppt_population(
    api_key: str, tcgplayer_ids: list[str], *, language: str = "english"
) -> list[dict[str, Any]]:
    """Per-card `/population` (GemRate). Business plan only (403 otherwise), 2 credits
    per card, max 50 ids per bulk request. Returns a list of `GemrateData` dicts (each
    carrying `tcgPlayerId` + `populationByGrader`). Empty list on non-200 or no data.

    Credit-metered — the bulk `/export type=population` path is preferred for the full
    catalog. This is the per-card path for sampling / incremental top-ups."""
    ids = [str(i).strip() for i in tcgplayer_ids if str(i).strip()][:50]
    if not ids:
        return []
    params = {"tcgPlayerIds": ",".join(ids), "language": language}
    status, body, _ = _request(f"{PPT_API_BASE}/population?{urllib.parse.urlencode(params)}", api_key)
    if status != 200:
        return []
    payload = json.loads(body.decode("utf-8", "replace"))
    data = payload.get("data") if isinstance(payload, dict) else None
    if isinstance(data, list):
        return [d for d in data if isinstance(d, dict)]
    return [data] if isinstance(data, dict) else []


def download_ppt_export(api_key: str, export_type: str) -> bytes:
    """Business `/export` (type in cards/ebay/sealed/population). Returns decompressed
    CSV bytes (the endpoint 302-redirects to a gzip blob; urllib follows the redirect).
    Raises RuntimeError on non-200 (e.g. 403 on non-Business keys)."""
    status, body, content_type = _request(f"{PPT_API_BASE}/export?type={urllib.parse.quote(export_type)}", api_key)
    if status != 200:
        raise RuntimeError(f"PPT /export type={export_type} returned {status}: {body[:200]!r}")
    if "gzip" in content_type or body[:2] == b"\x1f\x8b":
        return gzip.decompress(body)
    return body


# --- /export CSV parsers (column layout confirmed against a real Business dump) -----
# cards dump cols: tcgPlayerId,name,setName,setId,cardNumber,rarity,language,printing,
#                  marketPrice,lowPrice,sellers,lastPriceUpdate
# ebay  dump cols: tcgPlayerId,grade,salesCount,averagePrice,medianPrice,
#                  smartMarketPrice,smartMarketConfidence,marketPrice7Day,marketTrend,
#                  salesVelocityWeekly   (grade e.g. psa10/cgc9_5; "ungraded" is skipped
#                  downstream by parse_ppt_grade_key)
import csv as _csv


def parse_export_cards(path: str) -> dict[str, dict[str, Any]]:
    """cards dump -> {tcgPlayerId: partial PPT card dict (prices + variants)}."""
    by_id: dict[str, dict[str, Any]] = {}
    with open(path, newline="") as f:
        for row in _csv.DictReader(f):
            tid = str(row.get("tcgPlayerId") or "").strip()
            if not tid:
                continue
            printing = str(row.get("printing") or "").strip() or "Normal"
            market = row.get("marketPrice")
            card = by_id.setdefault(
                tid,
                {"tcgPlayerId": tid, "name": row.get("name"), "language": row.get("language"),
                 "prices": {}, "variants": {}},
            )
            # headline = the first printing that carries a market price
            if not card["prices"].get("market") and str(market or "").strip():
                card["prices"] = {"market": market, "low": row.get("lowPrice"), "primaryPrinting": printing}
            card["variants"].setdefault(printing, {})["Near Mint"] = {"price": market}
    return by_id


def parse_export_ebay(path: str) -> dict[str, dict[str, Any]]:
    """ebay dump -> {tcgPlayerId: {grade: salesByGrade-entry}}."""
    by_id: dict[str, dict[str, Any]] = {}
    with open(path, newline="") as f:
        for row in _csv.DictReader(f):
            tid = str(row.get("tcgPlayerId") or "").strip()
            grade = str(row.get("grade") or "").strip()
            if not tid or not grade:
                continue
            by_id.setdefault(tid, {})[grade] = {
                "medianPrice": row.get("medianPrice"),
                "averagePrice": row.get("averagePrice"),
                "smartMarketPrice": row.get("smartMarketPrice"),
                "smartMarketConfidence": row.get("smartMarketConfidence"),
                "marketPrice7Day": row.get("marketPrice7Day"),
                "count": row.get("salesCount"),
            }
    return by_id


def iter_ppt_cards_from_exports(cards_path: str, ebay_path: str):
    """Merge the two dumps into PPT card dicts (one per tcgPlayerId present in either),
    ready for build_ppt_pricing_bundle / sync_ppt_cards."""
    cards = parse_export_cards(cards_path)
    ebay = parse_export_ebay(ebay_path)
    for tid in set(cards) | set(ebay):
        card = cards.get(tid) or {"tcgPlayerId": tid, "prices": {}, "variants": {}}
        sales = ebay.get(tid)
        if sales:
            card["ebay"] = {"salesByGrade": sales}
        yield card


# population dump cols: ASSUMED long format — one row per (tcgPlayerId, grader) with
# per-grade count columns (g1..g10, g1_5..g9_5) plus gemRate, totalPopulation. This
# mirrors how the ebay dump is one row per (tcgPlayerId, grade). NOT YET confirmed
# against a real Business `/export type=population` dump — verify the exact column
# names/shape on the first run and adjust the two field reads below if needed. The
# per-grade reader is tolerant: build_population_entry only consumes `g*` count keys
# plus gemRate/totalPopulation, so extra columns are ignored automatically.
def parse_export_population(path: str) -> dict[str, dict[str, Any]]:
    """population dump -> {tcgPlayerId: GemrateData dict}, ready for
    upsert_ppt_card_population (which normalizes via build_card_population)."""
    by_id: dict[str, dict[str, Any]] = {}
    with open(path, newline="") as f:
        for row in _csv.DictReader(f):
            tid = str(row.get("tcgPlayerId") or "").strip()
            grader = str(row.get("grader") or row.get("company") or "").strip()
            if not tid or not grader:
                continue
            data = by_id.setdefault(tid, {"tcgPlayerId": tid, "populationByGrader": {}})
            # Pass the raw row through as the GraderPopulation object; the normalizer
            # downstream picks out the g* counts + gemRate/totalPopulation and drops
            # tcgPlayerId/grader and any other columns.
            data["populationByGrader"][grader.upper()] = {
                k: v for k, v in row.items() if k not in ("tcgPlayerId", "grader", "company")
            }
    return by_id


def iter_ppt_population_from_export(population_path: str):
    """Yield GemrateData dicts (one per tcgPlayerId) for upsert_ppt_card_population."""
    yield from parse_export_population(population_path).values()


def _main(argv: list[str] | None = None) -> int:
    import argparse
    import sqlite3
    from catalog_tools import backfill_cards_tcgplayer_id

    parser = argparse.ArgumentParser(description="Sync PPT /export dumps into the price tables")
    parser.add_argument("--cards-csv")
    parser.add_argument("--ebay-csv")
    parser.add_argument("--database-path", required=True)
    parser.add_argument("--price-date", help="YYYY-MM-DD (required for the pricing sync)")
    parser.add_argument("--provider", default=PPT_PROVIDER)
    parser.add_argument("--backfill", action="store_true", help="backfill cards.tcgplayer_id first")
    parser.add_argument(
        "--signals-only",
        action="store_true",
        help="metadata-only: annotate existing graded entries with PPT trust signals "
        "(confidence + eBay sale count + smartMarketPrice) WITHOUT changing any "
        "displayed price or provider",
    )
    parser.add_argument(
        "--population-csv",
        help="GemRate population /export dump. Metadata-only overlay: writes "
        "population_json onto existing snapshots WITHOUT touching any price. May run "
        "standalone or alongside the pricing sync.",
    )
    parser.add_argument(
        "--population-api",
        action="store_true",
        help="Refresh GemRate population over the per-card /population JSON path "
        "(Business, 2 credits/card) for every catalog tcgPlayerId — the path used "
        "while the bulk export CSV layout is unconfirmed. Needs --ppt-api-key.",
    )
    parser.add_argument("--ppt-api-key", help="PPT Business API key (or set PPT_API_KEY).")
    args = parser.parse_args(argv)

    connection = sqlite3.connect(args.database_path, timeout=60.0)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA journal_mode=WAL")
    try:
        if args.backfill:
            stats = backfill_cards_tcgplayer_id(connection)
            print(f"[backfill] {json.dumps(stats)}")
        if args.cards_csv and args.ebay_csv:
            if not args.price_date:
                parser.error("--price-date is required with --cards-csv/--ebay-csv")
            cards = iter_ppt_cards_from_exports(args.cards_csv, args.ebay_csv)
            stats = sync_ppt_cards(
                connection, cards, price_date=args.price_date, provider=args.provider,
                signals_only=args.signals_only,
            )
            print(f"[sync{' signals-only' if args.signals_only else ''}] {json.dumps(stats)}")
        if args.population_csv:
            pop_stats = sync_ppt_population(
                connection, iter_ppt_population_from_export(args.population_csv)
            )
            print(f"[population:csv] {json.dumps(pop_stats)}")
        if args.population_api:
            import os
            api_key = args.ppt_api_key or os.environ.get("PPT_API_KEY")
            if not api_key:
                parser.error("--population-api needs --ppt-api-key or PPT_API_KEY")
            pop_stats = sync_ppt_population_via_api(connection, api_key)
            print(f"[population:api] {json.dumps(pop_stats)}")
        if not (args.cards_csv and args.ebay_csv) and not args.population_csv and not args.population_api:
            parser.error("provide --cards-csv + --ebay-csv, --population-csv, and/or --population-api")
    finally:
        connection.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(_main())
