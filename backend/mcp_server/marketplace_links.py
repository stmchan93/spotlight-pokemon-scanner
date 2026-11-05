"""Buy links, ported from apps/spotlight-rn/src/features/cards/marketplace-urls.ts.

Minimal-faithful port of buildTcgPlayerSearchUrl / buildTcgPlayerProductUrl /
buildEbaySearchUrl (sold) / tcgPlayerProductIdFromCardId and the per-game
keyword table in packages/api-client/src/spotlight/types.ts. Keep in step with
the TS when either changes.
"""

from __future__ import annotations

import os
import re
import unicodedata
from urllib.parse import quote, urlencode

# (marketplaceKeyword, ebayKeyword) per game — CARD_GAME_CAPABILITIES.
_GAME_KEYWORDS: dict[str, tuple[str, str | None]] = {
    "pokemon": ("pokemon", None),
    "onepiece": ("one piece", "one piece"),
    "lorcana": ("lorcana", "lorcana"),
    "riftbound": ("riftbound", "riftbound"),
    "gundam": ("gundam", "gundam"),
}

_NAME_GLYPH_REPLACEMENTS = (
    (re.compile(r"[★☆]"), " Gold Star "),
    (re.compile(r"δ"), " Delta Species "),
    (re.compile(r"◇"), " Prism Star "),
    (re.compile(r"♀"), " Female "),
    (re.compile(r"♂"), " Male "),
    (re.compile(r"α"), " Alpha "),
    (re.compile(r"β"), " Beta "),
    (re.compile(r"γ"), " Gamma "),
    (re.compile(r"’"), "'"),
)

_TCGPLAYER_CONDITIONS = {
    "nm": "Near Mint",
    "near mint": "Near Mint",
    "near_mint": "Near Mint",
    "lp": "Lightly Played",
    "lightly played": "Lightly Played",
    "lightly_played": "Lightly Played",
    "mp": "Moderately Played",
    "moderately played": "Moderately Played",
    "moderately_played": "Moderately Played",
    "hp": "Heavily Played",
    "heavily played": "Heavily Played",
    "heavily_played": "Heavily Played",
    "d": "Damaged",
    "dmg": "Damaged",
    "damaged": "Damaged",
}

_EBAY_EPN_TOOL_ID = "10001"
_EBAY_EPN_DEFAULT_ROTATION_ID = "711-53200-19255-0"


def _game_keywords(game: str | None) -> tuple[str, str | None]:
    return _GAME_KEYWORDS.get(str(game or "pokemon").strip().lower(), _GAME_KEYWORDS["pokemon"])


def _expand_name_glyphs(value: str) -> str:
    for pattern, words in _NAME_GLYPH_REPLACEMENTS:
        value = pattern.sub(words, value)
    return value


def _strip_accents(value: str) -> str:
    decomposed = unicodedata.normalize("NFD", value)
    return "".join(ch for ch in decomposed if not ("̀" <= ch <= "ͯ"))


def _cleaned_marketplace_token(value: str | None) -> str:
    text = _strip_accents(_expand_name_glyphs(value or ""))
    text = re.sub(r"[^A-Za-z0-9. ]+", " ", text)

    # Keep a period only between two digits ("9.5" survives).
    def _period(match: re.Match[str]) -> str:
        source = match.string
        before = source[match.start() - 1] if match.start() > 0 else ""
        after = source[match.end()] if match.end() < len(source) else ""
        return "." if before.isdigit() and after.isdigit() else " "

    text = re.sub(r"\.+", _period, text)
    return re.sub(r"\s+", " ", text).strip()


def _cleaned_tcgplayer_token(value: str | None, game_keyword: str = "pokemon") -> str:
    normalized = _strip_accents(_expand_name_glyphs(value or "")).lower()
    cleaned = re.sub(r"\s+", " ", re.sub(r"[^a-z0-9/' ]+", " ", normalized)).strip()
    prefix = f"{game_keyword} "
    return cleaned[len(prefix):] if cleaned.startswith(prefix) else cleaned


def _encode_component(value: str) -> str:
    # encodeURIComponent: unreserved A-Z a-z 0-9 - _ . ! ~ * ' ( )
    return quote(value, safe="-_.!~*'()")


def _with_tcgplayer_affiliate(url: str) -> str:
    base = str(os.environ.get("SPOTLIGHT_TCGPLAYER_AFFILIATE_BASE_URL") or "").strip()
    if not re.fullmatch(r"https://[^\s?#]+", base):
        return url
    return f"{base.rstrip('/')}?u={_encode_component(url)}"


def tcgplayer_product_id_from_card_id(card_id: str | None) -> str | None:
    match = re.search(r"(?:^|~)tcgplayer-(\d+)$", card_id or "")
    return match.group(1) if match else None


def tcgplayer_search_url(
    *, name: str, set_name: str, card_number: str, condition: str | None = None, game: str | None = None
) -> str | None:
    game_keyword, _ = _game_keywords(game)
    parts = [
        game_keyword,
        _cleaned_tcgplayer_token(set_name, game_keyword),
        _cleaned_tcgplayer_token(name, game_keyword),
        _cleaned_tcgplayer_token(re.sub(r"^#", "", card_number or ""), game_keyword),
    ]
    query = " ".join(part for part in parts if part)
    if not query or query == game_keyword:
        return None
    encoded_q = _encode_component(query).replace("%20", "+").replace("%2F", "/").replace("%27", "'")
    filter_suffix = ""
    tcg_condition = _TCGPLAYER_CONDITIONS.get(str(condition or "").strip().lower())
    if tcg_condition:
        filter_suffix = f"&Condition={_encode_component(tcg_condition).replace('%20', '+')}"
    return _with_tcgplayer_affiliate(
        f"https://www.tcgplayer.com/search/all/product?q={encoded_q}&view=grid{filter_suffix}"
    )


def tcgplayer_product_url(product_id: str | None, *, condition: str | None = None) -> str | None:
    product_id = str(product_id or "").strip()
    if not product_id:
        return None
    tcg_condition = _TCGPLAYER_CONDITIONS.get(str(condition or "").strip().lower())
    suffix = f"?Condition={_encode_component(tcg_condition).replace('%20', '+')}" if tcg_condition else ""
    return _with_tcgplayer_affiliate(
        f"https://www.tcgplayer.com/product/{_encode_component(product_id)}{suffix}"
    )


def _ebay_collector_number_term(card_number: str) -> str | None:
    raw = re.sub(r"^#", "", card_number or "").strip()
    fraction = re.fullmatch(r"(\d+)\s*/\s*(\d+)", raw)
    if not fraction:
        return _cleaned_marketplace_token(raw) or None
    return f"{int(fraction.group(1))}/{int(fraction.group(2))}"


def ebay_sold_search_url(
    *,
    name: str,
    set_name: str,
    card_number: str,
    grader: str | None = None,
    grade: str | None = None,
    language: str | None = None,
    game: str | None = None,
    epn_custom_id: str | None = "mcp",
) -> str | None:
    grader_token = _cleaned_marketplace_token(grader)
    grade_token = _cleaned_marketplace_token(grade)
    is_japanese = str(language or "").strip().lower() == "japanese"
    # Graded English searches drop the collector number (see the TS for why).
    drop_number = not is_japanese and bool(grade_token)
    number_token = None if drop_number else _ebay_collector_number_term(card_number)
    grade_term = " ".join(token for token in (grader_token, grade_token) if token) or None
    _, ebay_keyword = _game_keywords(game)
    parts = [
        grade_term,
        ebay_keyword,
        _cleaned_marketplace_token(name),
        "Japanese" if is_japanese else None,
        number_token,
        _cleaned_marketplace_token(set_name),
    ]
    query = " ".join(part for part in parts if part)
    if not query:
        return None
    params: dict[str, str] = {"_nkw": query, "LH_Sold": "1", "LH_Complete": "1", "_sop": "13"}
    campaign_id = str(os.environ.get("SPOTLIGHT_EBAY_EPN_CAMPAIGN_ID") or "").strip()
    if campaign_id:
        params.update(
            {
                "mkevt": "1",
                "mkcid": "1",
                "mkrid": str(os.environ.get("SPOTLIGHT_EBAY_EPN_ROTATION_ID") or "").strip()
                or _EBAY_EPN_DEFAULT_ROTATION_ID,
                "campid": campaign_id,
                "toolid": _EBAY_EPN_TOOL_ID,
            }
        )
        custom_id = re.sub(r"[^A-Za-z0-9._-]+", "-", (epn_custom_id or "").strip()).strip("-")[:256]
        if custom_id:
            params["customid"] = custom_id
    # URLSearchParams encodes spaces as "+".
    return f"https://www.ebay.com/sch/i.html?{urlencode(params)}"


def buy_links(
    card: dict,
    *,
    tcgplayer_product_id: str | None,
    grader: str | None = None,
    grade: str | None = None,
    condition: str | None = "NM",
) -> dict[str, str]:
    """Raw → TCGplayer (product page when the id resolves, else search) plus eBay
    sold; graded → eBay sold only (TCGplayer doesn't list slabs)."""
    name = str(card.get("name") or "")
    set_name = str(card.get("setName") or "")
    number = str(card.get("number") or "")
    game = card.get("game")
    links: dict[str, str] = {}
    if not (grader or grade):
        product_id = tcgplayer_product_id or tcgplayer_product_id_from_card_id(card.get("id"))
        tcg = (
            tcgplayer_product_url(product_id, condition=condition)
            if product_id
            else tcgplayer_search_url(
                name=name, set_name=set_name, card_number=number, condition=condition, game=game
            )
        )
        if tcg:
            links["tcgplayer"] = tcg
    ebay = ebay_sold_search_url(
        name=name,
        set_name=set_name,
        card_number=number,
        grader=grader,
        grade=grade,
        language=card.get("language"),
        game=game,
    )
    if ebay:
        links["ebay"] = ebay
    return links
