"""Fill the graded recent-sales lane from PokemonPriceTracker's per-grade eBay
sold listings, without letting a loosely-matched sale masquerade as the card.

Scrydex decides tightly which sales belong to a card but is thin: a CGC 9.5
Ditto came back with three 2024 sales. PPT's `ebay.soldListings[gradeKey]` has
far more rows (a year-plus) but matches by listing title, so a PPT-only row is
STORED with a verification tier and only SHOWN once it clears one:

  scrydex    the item id is in Scrydex's list (the Scrydex row is kept)
  aspects    eBay's item specifics (Card Number / Grade / Grader / Set or
             Card Name) all agree with the card — the strong check
  title      the listing title carries name + number + grader/grade + set
             and no lot/signed/pristine/proxy words — the fallback check
  unverified everything else; kept in the cache for later, never served
"""

from __future__ import annotations

import html
import re
import unicodedata
from datetime import datetime, timezone
from typing import Any

SHOWN_VERIFICATION_TIERS: frozenset[str] = frozenset({"scrydex", "aspects", "title"})

# Words that mean "not the plain graded card the row claims to be".
_EXCLUDED_TITLE_WORDS = (
    "pristine", "perfect 10", "black label", "signed", "auto", "autograph", "error",
    "misprint", "miscut", "lot", "bundle", "proxy", "custom", "metal", "replica",
    "fake", "reprint", "sticker", "playtest", "damaged", "crack",
)
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
_SOLD_PREFIX_RE = re.compile(r"^\s*sold\s+[a-z]{3}\s+\d{1,2},?\s*\d{4}\s*", re.IGNORECASE)
# eBay page chrome PPT sometimes captures onto the end of a title.
_TITLE_SUFFIX_JUNK_RE = re.compile(r"\s*opens in a (?:new )?(?:window|tab).*$", re.IGNORECASE)
# A verified row priced this far under the verified median is a mislabelled
# listing ("PSA 10?" for $23), not a comp. Needs a real sample to judge.
OUTLIER_MEDIAN_FRACTION = 0.25
OUTLIER_MIN_SAMPLE = 5
_GRADER_ALIASES = {
    "PSA": ("psa", "professional sports authenticator"),
    "CGC": ("cgc", "certified guaranty", "certified collectibles"),
    "BGS": ("bgs", "beckett"),
    "SGC": ("sgc", "sportscard guaranty"),
    "TAG": ("tag",),
    "ACE": ("ace",),
    "AGS": ("ags",),
}


def _fold(value: object) -> str:
    """Lowercase ASCII with accents stripped, HTML entities decoded ("&amp;"),
    and punctuation collapsed to spaces. Keeps "/", "#" and "." for the
    collector-number and half-grade checks."""
    text = unicodedata.normalize("NFKD", html.unescape(str(value or "")))
    text = "".join(ch for ch in text if not unicodedata.combining(ch)).lower()
    text = re.sub(r"[^a-z0-9./#]+", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def clean_ppt_title(title: object) -> str:
    """PPT sometimes bakes 'Sold  Oct 9, 2025' onto the front of the title and
    'Opens in a new window or tab' onto the end."""
    text = _SOLD_PREFIX_RE.sub("", html.unescape(str(title or "")))
    return _TITLE_SUFFIX_JUNK_RE.sub("", text).strip()


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


def _grade_matches(text: str, grader: str, grade: str) -> bool:
    grader_key = str(grader or "").strip().upper()
    grade_text = str(grade or "").strip()
    if not grader_key or not grade_text:
        return False
    aliases = _GRADER_ALIASES.get(grader_key, (grader_key.lower(),))
    grade_re = re.escape(grade_text.rstrip("0").rstrip(".") if "." in grade_text else grade_text)
    for alias in aliases:
        # "(?!\d|\.\d)": a trailing "." ("PSA 9. Pokemon") is punctuation, but
        # "9.5" must not pass as 9.
        if re.search(rf"\b{re.escape(alias)}\s*-?\s*(?:gem\s*(?:mint|mt)\s*)?{grade_re}(?!\d|\.\d)", text):
            return True
    if grade_text in {"10", "10.0"} and re.search(r"\bgem\s*(?:mint|mt)\s*10\b", text) and any(a in text for a in aliases):
        return True
    return False


def _has_excluded_words(text: str) -> bool:
    padded = f" {text} "
    return any(f" {word} " in padded for word in _EXCLUDED_TITLE_WORDS)


def _language_conflict(text: str, card: dict[str, Any]) -> bool:
    language = str(card.get("language") or "").strip().lower()
    foreign = ("japanese", "korean", "chinese", "german", "french", "italian", "spanish", "portuguese")
    if language.startswith("jap"):
        return False
    return any(f" {word} " in f" {text} " for word in foreign)


def verify_title(title: object, *, card: dict[str, Any], grader: str, grade: str) -> bool:
    text = _fold(clean_ppt_title(title))
    if not text or _has_excluded_words(text) or _language_conflict(text, card):
        return False
    return (
        _name_matches(text, card.get("name"))
        and _number_matches(text, card.get("number"))
        and _grade_matches(text, grader, grade)
        and _set_matches(text, card.get("set_name") or card.get("setName"))
    )


def _aspect(aspects: dict[str, str], *names: str) -> str:
    folded = {_fold(k): v for k, v in aspects.items()}
    for name in names:
        value = folded.get(_fold(name))
        if value:
            return str(value)
    return ""


def verify_aspects(aspects: dict[str, str] | None, *, card: dict[str, Any], grader: str, grade: str) -> bool | None:
    """True/False when eBay's item specifics can decide; None when the listing
    has no usable specifics (fall through to the title check)."""
    if not aspects:
        return None
    number = _aspect(aspects, "Card Number", "Card #", "Number")
    grade_value = _aspect(aspects, "Grade")
    grader_value = _aspect(aspects, "Professional Grader", "Grader", "Grading Company")
    set_value = _aspect(aspects, "Set", "Expansion")
    name_value = _aspect(aspects, "Card Name", "Character", "Pokémon", "Pokemon")
    features = _fold(_aspect(aspects, "Features", "Autographed", "Signed By"))
    if not number or not grade_value:
        return None
    if _has_excluded_words(features) or _has_excluded_words(_fold(grade_value)):
        return False
    if not _number_matches(_fold(number), card.get("number")):
        return False
    wanted_grade = str(grade).strip()
    got_grade = re.sub(r"\.0$", "", _fold(grade_value).replace(" ", ""))
    if re.sub(r"\.0$", "", wanted_grade) not in {got_grade, got_grade.rstrip("0").rstrip(".")}:
        return False
    if grader_value:
        aliases = _GRADER_ALIASES.get(str(grader).upper(), (str(grader).lower(),))
        if not any(alias in _fold(grader_value) for alias in aliases):
            return False
    if set_value and _set_matches(_fold(set_value), card.get("set_name") or card.get("setName")):
        return True
    if name_value and _name_matches(_fold(name_value), card.get("name")):
        return True
    return False


def _iso_to_scrydex_date(value: object) -> str | None:
    text = str(value or "").strip()
    match = re.match(r"^(\d{4})-(\d{2})-(\d{2})", text)
    if match:
        return f"{match.group(1)}/{match.group(2)}/{match.group(3)}"
    if re.match(r"^\d{4}/\d{2}/\d{2}$", text):
        return text
    return None


def sale_sort_date(value: object) -> datetime:
    """`YYYY/MM/DD` or ISO -> aware datetime; unparseable sorts oldest."""
    text = str(value or "").strip()
    for fmt in ("%Y/%m/%d", "%Y-%m-%d"):
        try:
            return datetime.strptime(text[:10], fmt).replace(tzinfo=timezone.utc)
        except ValueError:
            continue
    return datetime.min.replace(tzinfo=timezone.utc)


def ppt_row_grade(row: dict[str, Any]) -> tuple[str, str] | None:
    from ppt_adapter import parse_ppt_grade_key

    return parse_ppt_grade_key(str(row.get("gradeKey") or ""))


def ppt_row_to_sale(
    row: dict[str, Any],
    *,
    card: dict[str, Any],
    grader: str,
    grade: str,
    ebay_item: dict[str, Any] | None,
) -> dict[str, Any]:
    item_id = str(row.get("listingId") or "").strip()
    title = clean_ppt_title(row.get("title"))
    aspects = ebay_item.get("aspects") if isinstance(ebay_item, dict) else None
    by_aspects = verify_aspects(aspects if isinstance(aspects, dict) else None, card=card, grader=grader, grade=grade)
    if by_aspects is True:
        verification = "aspects"
    elif by_aspects is False:
        verification = "unverified"
    else:
        # eBay's own title beats PPT's copy of it when we have the item.
        ebay_title = str(ebay_item.get("title") or "") if isinstance(ebay_item, dict) else ""
        verification = "title" if verify_title(ebay_title or title, card=card, grader=grader, grade=grade) else "unverified"
    folded_title = _fold(title)
    variant = None
    if "1st edition" in folded_title or "first edition" in folded_title:
        variant = "First Edition"
    elif "shadowless" in folded_title:
        variant = "Shadowless"
    elif "reverse holo" in folded_title:
        variant = "Reverse Holofoil"
    price = row.get("price")
    try:
        price = float(price) if price is not None else None
    except (TypeError, ValueError):
        price = None
    image_url = str(ebay_item.get("imageURL") or "").strip() if isinstance(ebay_item, dict) else ""
    return {
        "sourceSaleID": f"ppt:{item_id}",
        "title": title or None,
        "soldAt": _iso_to_scrydex_date(row.get("soldDate")),
        "price": price,
        "currencyCode": str(row.get("currency") or "USD").strip().upper() or "USD",
        "listingURL": str(row.get("url") or "").strip() or (f"https://www.ebay.com/itm/{item_id}" if item_id else None),
        "variant": variant,
        "imageURL": image_url or None,
        "sourcePayload": {
            "ppt": {k: v for k, v in row.items() if k != "gradeKey"},
            "_spotlight": {
                "origin": "ppt",
                "verification": verification,
                "priceSource": "ppt",
                "ebayItemID": item_id or None,
                "imageURL": image_url or None,
                "itemLocationCountry": ebay_item.get("itemLocationCountry") if isinstance(ebay_item, dict) else None,
            },
        },
    }


def ppt_only_rows_for_grade(
    ppt_rows_by_item_id: dict[str, dict[str, Any]],
    *,
    grader: str,
    grade: str,
    scrydex_item_ids: set[str],
) -> list[dict[str, Any]]:
    """PPT rows filed under this grader/grade that Scrydex did not return, newest first."""
    wanted = (str(grader).strip().upper(), str(grade).strip())
    rows = [
        row
        for item_id, row in ppt_rows_by_item_id.items()
        if item_id not in scrydex_item_ids and ppt_row_grade(row) == wanted
    ]
    rows.sort(key=lambda r: sale_sort_date(_iso_to_scrydex_date(r.get("soldDate"))), reverse=True)
    return rows


def merge_ppt_sold_listings(
    sales: list[dict[str, Any]],
    ppt_only_rows: list[dict[str, Any]],
    *,
    card: dict[str, Any],
    grader: str,
    grade: str,
    ebay_items_by_item_id: dict[str, dict[str, Any]] | None = None,
) -> dict[str, int]:
    """Append PPT-only rows to `sales` (in place), stamp every row's verification
    tier, and order the list newest-first with verified rows ahead of the rest
    so the cache's rank order is the serve order. Returns tier counts."""
    ebay_items = ebay_items_by_item_id or {}
    counts = {"scrydex": 0, "aspects": 0, "title": 0, "unverified": 0}
    for sale in sales:
        payload = sale.get("sourcePayload")
        if not isinstance(payload, dict):
            payload = {}
            sale["sourcePayload"] = payload
        spotlight = payload.get("_spotlight")
        if not isinstance(spotlight, dict):
            spotlight = {}
            payload["_spotlight"] = spotlight
        spotlight.setdefault("origin", "scrydex")
        spotlight["verification"] = "scrydex"
        counts["scrydex"] += 1
    for row in ppt_only_rows:
        item_id = str(row.get("listingId") or "").strip()
        sale = ppt_row_to_sale(row, card=card, grader=grader, grade=grade, ebay_item=ebay_items.get(item_id))
        counts[sale["sourcePayload"]["_spotlight"]["verification"]] += 1
        sales.append(sale)
    counts["outlier"] = _demote_price_outliers(sales)
    sales.sort(
        key=lambda s: (
            0 if sale_verification(s) in SHOWN_VERIFICATION_TIERS else 1,
            -sale_sort_date(s.get("soldAt")).timestamp(),
        )
    )
    # Rank is the cache's unique key per (card, grader, grade, source). Scrydex
    # rows arrive numbered 1..N and PPT rows unnumbered, so renumber the merged
    # order or the writer collides on rank.
    for index, sale in enumerate(sales, start=1):
        sale["rank"] = index
    return counts


def _demote_price_outliers(sales: list[dict[str, Any]]) -> int:
    """Mark verified rows priced under OUTLIER_MEDIAN_FRACTION of the verified
    median as `outlier` (kept, never served). Scrydex rows are left alone: its
    identity match is tight and a real crash must stay visible."""
    prices: list[float] = []
    for sale in sales:
        if sale_verification(sale) not in SHOWN_VERIFICATION_TIERS:
            continue
        try:
            price = float(sale.get("price")) if sale.get("price") is not None else None
        except (TypeError, ValueError):
            price = None
        if price is not None and price > 0:
            prices.append(price)
    if len(prices) < OUTLIER_MIN_SAMPLE:
        return 0
    prices.sort()
    median = prices[len(prices) // 2]
    floor = median * OUTLIER_MEDIAN_FRACTION
    demoted = 0
    for sale in sales:
        spotlight = (sale.get("sourcePayload") or {}).get("_spotlight") or {}
        if spotlight.get("origin") != "ppt" or sale_verification(sale) not in SHOWN_VERIFICATION_TIERS:
            continue
        try:
            price = float(sale.get("price")) if sale.get("price") is not None else None
        except (TypeError, ValueError):
            continue
        if price is not None and price < floor:
            spotlight["verification"] = "outlier"
            spotlight["outlierFloor"] = round(floor, 2)
            demoted += 1
    return demoted


def sale_verification(sale: dict[str, Any]) -> str:
    payload = sale.get("sourcePayload")
    spotlight = payload.get("_spotlight") if isinstance(payload, dict) else None
    tier = str((spotlight or {}).get("verification") or "").strip().lower() if isinstance(spotlight, dict) else ""
    # Rows cached before verification existed are Scrydex rows.
    return tier or "scrydex"
