"""Graded recent-sales (eBay sold comps) helpers.

Scrydex decides which sales belong to a card. This module holds what runs on
those rows around the cache:

- `reconcile_recent_sales_prices`: make every row USD and attach its listing
  photo, before the rows are cached
- `title_conflicts_with_card` / `local_price_outliers`: serve-time filters
- title-match primitives (`_fold`, `_name_matches`, ...), shared with
  `ebay_listings` so there is one tuned copy
"""

from __future__ import annotations

import html
import re
import unicodedata
from datetime import datetime, timezone
from typing import Any, Callable

# Grade mentions to blank out before looking for the collector number. The
# digits are grade-shaped (1-10, half grades) so "Gem Mint 157/264" keeps its
# number.
_GRADE_NUMBER = r"(?:10|[1-9](?:\.5)?)"
_GRADE_MENTION_RE = re.compile(
    rf"\b(psa|cgc|bgs|sgc|tag|ace|ags|beckett)\s*-?\s*{_GRADE_NUMBER}(?![\d/])"
    rf"|\bgem\s*(?:mint|mt)\s*{_GRADE_NUMBER}(?![\d/])"
    rf"|(?<![\d/]){_GRADE_NUMBER}\s*gem\b",
    re.IGNORECASE,
)
_EBAY_ITEM_ID_RE = re.compile(r"/itm/(\d+)")


def _fold(value: object) -> str:
    """Lowercase ASCII with accents stripped, HTML entities decoded ("&amp;"),
    and punctuation collapsed to spaces. Keeps "/", "#" and "." for the
    collector-number and half-grade checks."""
    text = unicodedata.normalize("NFKD", html.unescape(str(value or "")))
    text = "".join(ch for ch in text if not unicodedata.combining(ch)).lower()
    text = re.sub(r"[^a-z0-9./#]+", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def _number_parts(card_number: object) -> tuple[str | None, str | None]:
    text = str(card_number or "").strip()
    if not text:
        return None, None
    head, _, tail = text.partition("/")
    head = head.strip().lstrip("#").strip()
    tail = tail.strip()
    return (head or None), (tail or None)


def _number_matches(text: str, card_number: object) -> bool:
    """`157/264`, `#157`, `157 / 264`, `003/034` vs `3/34`, or a bare `157`
    once grade mentions ("PSA 10") are removed so a grade can't pass as a
    collector number."""
    head, tail = _number_parts(card_number)
    if not head:
        return False
    num = re.escape(head.lstrip("0") or head)
    stripped = _GRADE_MENTION_RE.sub(" ", text)
    if tail:
        denom = re.escape(tail.lstrip("0") or tail)
        if re.search(rf"(?<![\d.])0*{num}\s*/\s*0*{denom}(?!\d)", stripped):
            return True
    if tail:
        # The card has a set-size denominator; a bare/hash number must not be
        # followed by a different one.
        after = r"(?![\d/])"
    else:
        # Promo-style numbers ("8", "11"): titles still print "011/025".
        after = r"(?!\d)(?:\s*/\s*\d+)?"
    if re.search(rf"#\s*0*{num}{after}", stripped):
        return True
    return re.search(rf"(?<![\d./])0*{num}{after}", stripped) is not None


def _name_tokens(name: object) -> list[str]:
    """Every word of the card name ("Zeraora V" -> zeraora, v). Single letters
    other than the V suffix are apostrophe debris ("Jasmine's") and dropped."""
    return [tok for tok in _fold(name).replace("/", " ").split() if len(tok) >= 2 or tok == "v"]


def _name_matches(text: str, name: object) -> bool:
    tokens = _name_tokens(name)
    if not tokens:
        return False
    # "FA/Gengar VMAX" and "Gengar-VMAX" are still the name.
    padded = f" {text.replace('/', ' ').replace('.', ' ')} "
    return all(f" {tok} " in padded for tok in tokens)


def _set_tokens(set_name: object) -> list[str]:
    """Phrases any of which identifies the set in a title: the full name, the
    part after a 'SV:' / 'Pokémon TCG Classic -' style prefix, and 'promo'
    for promo sets. Compared with spaces removed so 'Paldean Fates' also hits
    'PaldeanFates'."""
    folded = _fold(set_name).replace("/", " ")
    if not folded:
        return []
    candidates = {folded}
    for sep in (":", " - "):
        if sep.strip() and sep.strip() in str(set_name or ""):
            candidates.add(_fold(str(set_name).rsplit(sep.strip(), 1)[-1]))
    if "promo" in folded:
        candidates.add("promo")
    tokens = {c.replace(" ", "") for c in candidates if c}
    # Sellers drop the plural ("Celebration - Mew"); accept the singular too.
    tokens |= {t[:-1] for t in list(tokens) if t.endswith("s") and len(t) > 5}
    return [t for t in tokens if len(t) >= 4]


def _set_matches(text: str, set_name: object) -> bool:
    squashed = text.replace(" ", "")
    return any(tok in squashed for tok in _set_tokens(set_name))


def _language_conflict(text: str, card: dict[str, Any]) -> bool:
    language = str(card.get("language") or "").strip().lower()
    foreign = ("japanese", "korean", "chinese", "german", "french", "italian", "spanish", "portuguese")
    if language.startswith("jap"):
        return False
    return any(f" {word} " in f" {text} " for word in foreign)


def sale_sort_date(value: object) -> datetime:
    """`YYYY/MM/DD` or ISO -> aware datetime; unparseable sorts oldest."""
    text = str(value or "").strip()
    for fmt in ("%Y/%m/%d", "%Y-%m-%d"):
        try:
            return datetime.strptime(text[:10], fmt).replace(tzinfo=timezone.utc)
        except ValueError:
            continue
    return datetime.min.replace(tzinfo=timezone.utc)


# Reprint lines that reuse an older card's name + number ("Celebrations Classic
# Collection #4 Charizard" vs Base Set 4/102). A title naming one of these is a
# different card unless the card's own set is that line.
_REPRINT_LINE_TOKENS = (
    "celebrations", "classic collection", "evolutions", "base set 2", "legendary collection",
)
# Time-local price check: a served sale far from the sales sold around it is a
# mismatched listing (a $199.99 "Moonbreon PSA 10" among ~$3,900 sales), while a
# card that climbed over the year keeps its honest older sales.
OUTLIER_MIN_SAMPLE = 5
LOCAL_OUTLIER_NEIGHBORS = 10
LOCAL_OUTLIER_WINDOW_DAYS = 60
LOCAL_OUTLIER_FLOOR = 0.25
LOCAL_OUTLIER_CEILING = 4.0


def title_conflicts_with_card(title: object, card: dict[str, Any]) -> bool:
    """True when the listing title names a different printing than the card:
    a reprint line the card isn't from, or "non holo" on a holo card. No year
    check: PSA label years and catalog release dates disagree (Pop Series 1 is
    2004 vs "2006" labels)."""
    text = _fold(title)
    if not text:
        return False
    set_text = _fold(card.get("set_name") or card.get("setName"))
    padded = f" {text} "
    for token in _REPRINT_LINE_TOKENS:
        if f" {token} " in padded and token not in set_text:
            return True
    rarity = _fold(card.get("rarity"))
    if "holo" in rarity and "non holo" in text:
        return True
    return False


def local_price_outliers(sales: list[dict[str, Any]]) -> set[int]:
    """Indexes of sales priced under LOCAL_OUTLIER_FLOOR or over
    LOCAL_OUTLIER_CEILING times the median of the LOCAL_OUTLIER_NEIGHBORS
    sales closest in time within LOCAL_OUTLIER_WINDOW_DAYS. A sale with fewer
    than OUTLIER_MIN_SAMPLE such neighbors is not judged (sparse lists keep
    their history)."""
    priced: list[tuple[int, datetime, float]] = []
    for index, sale in enumerate(sales):
        try:
            price = float(sale.get("price")) if sale.get("price") is not None else None
        except (TypeError, ValueError):
            price = None
        if price is None or price <= 0:
            continue
        priced.append((index, sale_sort_date(sale.get("soldAt") or sale.get("sold_at")), price))
    if len(priced) <= OUTLIER_MIN_SAMPLE:
        return set()
    outliers: set[int] = set()
    for index, sold_at, price in priced:
        window = LOCAL_OUTLIER_WINDOW_DAYS * 86400
        neighbors = sorted(
            (
                other
                for other in priced
                if other[0] != index and abs((other[1] - sold_at).total_seconds()) <= window
            ),
            key=lambda other: abs((other[1] - sold_at).total_seconds()),
        )[:LOCAL_OUTLIER_NEIGHBORS]
        if len(neighbors) < OUTLIER_MIN_SAMPLE:
            continue
        prices = sorted(other[2] for other in neighbors)
        middle = len(prices) // 2
        median = prices[middle] if len(prices) % 2 else (prices[middle - 1] + prices[middle]) / 2
        if price < median * LOCAL_OUTLIER_FLOOR or price > median * LOCAL_OUTLIER_CEILING:
            outliers.add(index)
    return outliers


# ---------------------------------------------------------------------------
# Price/currency reconciliation
# ---------------------------------------------------------------------------


def _coerce_price(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        text = value.strip().replace("$", "").replace(",", "")
        if not text:
            return None
        try:
            return float(text)
        except ValueError:
            return None
    return None


def ebay_item_id_from_url(url: object) -> str | None:
    """The numeric eBay item id in a listing URL (`.../itm/<id>`)."""
    match = _EBAY_ITEM_ID_RE.search(str(url or ""))
    return match.group(1) if match else None


def reconcile_recent_sales_prices(
    sales: list[dict[str, Any]],
    *,
    to_usd: Callable[[float | None, str | None], float | None],
    ebay_items_by_item_id: dict[str, dict[str, Any]] | None = None,
    stored_images_by_item_id: dict[str, str] | None = None,
) -> dict[str, int]:
    """Rewrite each Scrydex sale's price/currency in place so every row is USD.

    Scrydex stamps some foreign-currency sales as USD without converting (an
    AU $5,900 Rayquaza ex PSA 9 came back as `5900 USD`, 2026-09-07). eBay's
    Browse `getItem` (`ebay_items_by_item_id`, see `ebay_comps`) reports a
    foreign sale as `convertedFromCurrency` + the USD figure. Precedence:
      1. eBay says the sale was foreign-currency -> eBay's converted USD amount
      2. Scrydex tagged non-USD                  -> FX-convert via `to_usd`
      3. otherwise                               -> Scrydex's number stands
    A mislabelled-USD row eBay can't vouch for is undetectable here. The eBay
    row (or the stored photo, once Browse stops answering) supplies
    `imageURL`. Provenance lands in `sourcePayload["_spotlight"]` so the
    cache keeps it. Returns counts per source for logging.
    """
    counts = {"ebay": 0, "fx": 0, "scrydex": 0, "unconverted": 0}
    ebay_items = ebay_items_by_item_id or {}
    for sale in sales:
        if not isinstance(sale, dict):
            continue
        original_price = sale.get("price")
        original_currency = str(sale.get("currencyCode") or "USD").strip().upper() or "USD"
        item_id = ebay_item_id_from_url(sale.get("listingURL"))
        ebay_row = ebay_items.get(item_id) if item_id else None
        if not isinstance(ebay_row, dict):
            ebay_row = None
        ebay_price = _coerce_price(ebay_row.get("priceAmount")) if ebay_row else None
        ebay_currency = str(ebay_row.get("priceCurrency") or "").upper() if ebay_row else ""
        ebay_converted_from = str(ebay_row.get("convertedFromCurrency") or "").upper() if ebay_row else ""
        image_url = str(ebay_row.get("imageURL") or "").strip() if ebay_row else ""
        if not image_url and item_id:
            # Browse stops answering ~90 days after a listing ends but the
            # photo is still served, so the URL stored earlier is the fallback.
            image_url = str((stored_images_by_item_id or {}).get(item_id) or "").strip()
        if image_url:
            sale["imageURL"] = image_url
        if (
            ebay_price is not None
            and ebay_currency == "USD"
            and ebay_converted_from
            and ebay_converted_from != "USD"
        ):
            sale["price"] = ebay_price
            sale["currencyCode"] = "USD"
            source = "ebay"
        elif original_currency != "USD":
            converted = to_usd(original_price, original_currency)
            if converted is None:
                source = "unconverted"
            else:
                sale["price"] = converted
                sale["currencyCode"] = "USD"
                source = "fx"
        else:
            source = "scrydex"
        counts[source] += 1
        payload = sale.get("sourcePayload")
        if not isinstance(payload, dict):
            payload = {}
            sale["sourcePayload"] = payload
        payload["_spotlight"] = {
            "priceSource": source,
            "scrydexPrice": original_price,
            "scrydexCurrency": original_currency,
            "ebayItemID": item_id,
            "imageURL": image_url or None,
            "itemLocationCountry": ebay_row.get("itemLocationCountry") if ebay_row else None,
            "ebayConvertedFrom": (
                {"amount": ebay_row.get("convertedFromAmount"), "currency": ebay_converted_from}
                if ebay_row and ebay_converted_from
                else None
            ),
        }
    return counts
