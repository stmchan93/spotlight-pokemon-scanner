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
from ppt_adapter import PPT_PROVIDER, build_ppt_pricing_bundle

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


def upsert_ppt_card_pricing(
    connection,
    ppt_card: dict[str, Any],
    *,
    price_date: str,
    provider: str = PPT_PROVIDER,
) -> dict[str, Any]:
    """Join one PPT card to our catalog by tcgPlayerId and write its snapshot + daily
    rows (cells auto-written by the upserts). Returns a small result dict; callers
    aggregate. Does not commit (the batch driver commits)."""
    bundle = build_ppt_pricing_bundle(ppt_card, as_of=price_date)
    tcgplayer_id = bundle["tcgplayer_id"]
    if not tcgplayer_id:
        return {"matched": 0, "reason": "no_tcgplayer_id"}
    card_ids = card_ids_for_tcgplayer_id(connection, tcgplayer_id)
    if not card_ids:
        return {"matched": 0, "reason": "no_local_card", "tcgplayerId": tcgplayer_id}

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


def sync_ppt_cards(
    connection,
    ppt_cards: Iterable[dict[str, Any]],
    *,
    price_date: str,
    provider: str = PPT_PROVIDER,
    commit_every: int = 500,
) -> dict[str, int]:
    """Drive a batch of PPT card records through upsert_ppt_card_pricing. Returns
    {seen, matched, unmatched_no_tcg, unmatched_no_card}."""
    stats = {"seen": 0, "matched": 0, "unmatched_no_tcg": 0, "unmatched_no_card": 0, "skipped_no_price": 0}
    for index, ppt_card in enumerate(ppt_cards, start=1):
        stats["seen"] += 1
        result = upsert_ppt_card_pricing(connection, ppt_card, price_date=price_date, provider=provider)
        reason = result.get("reason")
        if result["matched"]:
            stats["matched"] += result["matched"]
        elif reason == "no_tcgplayer_id":
            stats["unmatched_no_tcg"] += 1
        elif reason == "no_price":
            stats["skipped_no_price"] += 1
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


def _main(argv: list[str] | None = None) -> int:
    import argparse
    import sqlite3
    from catalog_tools import backfill_cards_tcgplayer_id

    parser = argparse.ArgumentParser(description="Sync PPT /export dumps into the price tables")
    parser.add_argument("--cards-csv", required=True)
    parser.add_argument("--ebay-csv", required=True)
    parser.add_argument("--database-path", required=True)
    parser.add_argument("--price-date", required=True, help="YYYY-MM-DD")
    parser.add_argument("--provider", default=PPT_PROVIDER)
    parser.add_argument("--backfill", action="store_true", help="backfill cards.tcgplayer_id first")
    args = parser.parse_args(argv)

    connection = sqlite3.connect(args.database_path, timeout=60.0)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA journal_mode=WAL")
    try:
        if args.backfill:
            stats = backfill_cards_tcgplayer_id(connection)
            print(f"[backfill] {json.dumps(stats)}")
        cards = iter_ppt_cards_from_exports(args.cards_csv, args.ebay_csv)
        stats = sync_ppt_cards(connection, cards, price_date=args.price_date, provider=args.provider)
        print(f"[sync] {json.dumps(stats)}")
    finally:
        connection.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(_main())
