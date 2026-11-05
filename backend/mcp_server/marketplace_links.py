"""Buy links, ported from apps/spotlight-rn/src/features/cards/marketplace-urls.ts.

Faithful port of buildTcgPlayerSearchUrl / buildTcgPlayerProductUrl /
buildEbaySearchUrl (sold + active) / tcgPlayerProductIdFromCardId and the
per-game keyword table (marketplaceKeywordForGame / ebayKeywordForGame) in
packages/api-client/src/spotlight/types.ts. Keep in step with the TS when
either changes; backend/tests/test_mcp_marketplace_links.py mirrors the TS
expectations in apps/spotlight-rn/__tests__/features/cards/marketplace-urls-test.ts.

Runtime config the TS reads via resolveRuntimeValue becomes an explicit keyword
argument, else an env lookup: the SPOTLIGHT_* name first, then the same
EXPO_PUBLIC_* name the app reads (so one shared env file configures both).
Blank/absent means untagged, byte-identical URLs — the same fallback as the TS.
"""

from __future__ import annotations

import os
import re
import unicodedata
from urllib.parse import quote, quote_plus

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

# normalizeTcgPlayerPrinting (input is lowercased, "_" → " ", trimmed first).
_TCGPLAYER_PRINTINGS = {
    "normal": "Normal",
    "holo": "Holofoil",
    "holofoil": "Holofoil",
    "reverse holo": "Reverse Holofoil",
    "reverse holofoil": "Reverse Holofoil",
    "1st edition normal": "1st Edition Normal",
    "first edition normal": "1st Edition Normal",
    "1st edition holofoil": "1st Edition Holofoil",
    "first edition holofoil": "1st Edition Holofoil",
    "unlimited holofoil": "Unlimited Holofoil",
}

_ASCII_DIGITS = "0123456789"
_EBAY_EPN_TOOL_ID = "10001"
_EBAY_EPN_DEFAULT_ROTATION_ID = "711-53200-19255-0"


def _runtime_value(explicit: str | None, *env_keys: str) -> str:
    """resolveRuntimeValue: first non-blank (trimmed) value wins, else ''."""
    if explicit is not None:
        return str(explicit).strip()
    for key in env_keys:
        value = str(os.environ.get(key) or "").strip()
        if value:
            return value
    return ""


def _game_keywords(game: str | None) -> tuple[str, str | None]:
    # Absent/unknown game → Pokémon, as cardGameCapabilities does. (Case/space
    # normalisation is a lenient superset of the TS exact-key lookup.)
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
        return "." if before and after and before in _ASCII_DIGITS and after in _ASCII_DIGITS else " "

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


def _form_encode(value: str) -> str:
    # URLSearchParams (application/x-www-form-urlencoded): unreserved is
    # A-Z a-z 0-9 * - . _ and space → "+"; "~" IS encoded (Python leaves it).
    return quote_plus(value, safe="*").replace("~", "%7E")


def _search_params(params: list[tuple[str, str]]) -> str:
    return "&".join(f"{_form_encode(k)}={_form_encode(v)}" for k, v in params)


def _tcgplayer_affiliate_base(explicit: str | None = None) -> str | None:
    base = _runtime_value(
        explicit, "SPOTLIGHT_TCGPLAYER_AFFILIATE_BASE_URL", "EXPO_PUBLIC_TCGPLAYER_AFFILIATE_BASE_URL"
    )
    # JS \s is close enough to Python's; https-only, no query/fragment.
    return re.sub(r"/+$", "", base) if re.fullmatch(r"https://[^\s?#]+", base) else None


def _with_tcgplayer_affiliate(url: str, affiliate_base_url: str | None = None) -> str:
    base = _tcgplayer_affiliate_base(affiliate_base_url)
    return f"{base}?u={_encode_component(url)}" if base else url


def tcgplayer_product_id_from_card_id(card_id: str | None) -> str | None:
    match = re.search(r"(?:^|~)tcgplayer-(\d+)$", card_id or "")
    return match.group(1) if match else None


def _tcgplayer_condition(value: str | None) -> str | None:
    return _TCGPLAYER_CONDITIONS.get(str(value or "").strip().lower())


def _tcgplayer_printing(value: str | None) -> str | None:
    return _TCGPLAYER_PRINTINGS.get(str(value or "").strip().lower().replace("_", " "))


def tcgplayer_search_url(
    *,
    name: str,
    set_name: str,
    card_number: str,
    condition: str | None = None,
    printing: str | None = None,
    game: str | None = None,
    affiliate_base_url: str | None = None,
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
    filter_parts = []
    tcg_condition = _tcgplayer_condition(condition)
    if tcg_condition:
        filter_parts.append(f"Condition={_encode_component(tcg_condition).replace('%20', '+')}")
    tcg_printing = _tcgplayer_printing(printing)
    if tcg_printing:
        filter_parts.append(f"Printing={_encode_component(tcg_printing).replace('%20', '+')}")
    filter_suffix = f"&{'&'.join(filter_parts)}" if filter_parts else ""
    return _with_tcgplayer_affiliate(
        f"https://www.tcgplayer.com/search/all/product?q={encoded_q}&view=grid{filter_suffix}",
        affiliate_base_url,
    )


def tcgplayer_product_url(
    product_id: str | None, *, condition: str | None = None, affiliate_base_url: str | None = None
) -> str | None:
    product_id = str(product_id or "").strip()
    if not product_id:
        return None
    tcg_condition = _tcgplayer_condition(condition)
    suffix = f"?Condition={_encode_component(tcg_condition).replace('%20', '+')}" if tcg_condition else ""
    return _with_tcgplayer_affiliate(
        f"https://www.tcgplayer.com/product/{_encode_component(product_id)}{suffix}",
        affiliate_base_url,
    )


def _ebay_collector_number_term(card_number: str) -> str | None:
    raw = re.sub(r"^#", "", card_number or "").strip()
    # ASCII digits only, like JS \d (Python's \d would accept e.g. fullwidth).
    fraction = re.fullmatch(r"([0-9]+)\s*/\s*([0-9]+)", raw)
    if not fraction:
        return _cleaned_marketplace_token(raw) or None
    return f"{int(fraction.group(1))}/{int(fraction.group(2))}"


def _cleaned_epn_custom_id(value: str | None) -> str | None:
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "-", (value or "").strip())
    return re.sub(r"^-+|-+$", "", cleaned)[:256] or None


def ebay_search_url(
    *,
    name: str,
    set_name: str,
    card_number: str,
    grader: str | None = None,
    grade: str | None = None,
    language: str | None = None,
    game: str | None = None,
    listing_type: str = "sold",
    epn_custom_id: str | None = None,
    epn_campaign_id: str | None = None,
    epn_rotation_id: str | None = None,
) -> str | None:
    """buildEbaySearchUrl. listing_type "sold" (default, recent solds, _sop=13)
    or "active" (live listings, price+shipping lowest first, _sop=15)."""
    grader_token = _cleaned_marketplace_token(grader)
    grade_token = _cleaned_marketplace_token(grade)
    # TS: (language ?? '').toLowerCase() === 'japanese' — no trim.
    is_japanese = str(language or "").lower() == "japanese"
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
    if listing_type == "active":
        params: list[tuple[str, str]] = [("_nkw", query), ("_sop", "15")]
    else:
        params = [("_nkw", query), ("LH_Sold", "1"), ("LH_Complete", "1"), ("_sop", "13")]
    campaign_id = _runtime_value(
        epn_campaign_id, "SPOTLIGHT_EBAY_EPN_CAMPAIGN_ID", "EXPO_PUBLIC_EBAY_EPN_CAMPAIGN_ID"
    )
    if campaign_id:
        rotation_id = (
            _runtime_value(epn_rotation_id, "SPOTLIGHT_EBAY_EPN_ROTATION_ID", "EXPO_PUBLIC_EBAY_EPN_ROTATION_ID")
            or _EBAY_EPN_DEFAULT_ROTATION_ID
        )
        params += [
            ("mkevt", "1"),
            ("mkcid", "1"),
            ("mkrid", rotation_id),
            ("campid", campaign_id),
            ("toolid", _EBAY_EPN_TOOL_ID),
        ]
        custom_id = _cleaned_epn_custom_id(epn_custom_id)
        if custom_id:
            params.append(("customid", custom_id))
    return f"https://www.ebay.com/sch/i.html?{_search_params(params)}"


def buy_links(
    card: dict,
    *,
    tcgplayer_product_id: str | None,
    grader: str | None = None,
    grade: str | None = None,
    condition: str | None = "NM",
    printing: str | None = None,
    ebay_listing_type: str = "active",
    epn_custom_id: str | None = "mcp",
    tcgplayer_affiliate_base_url: str | None = None,
    epn_campaign_id: str | None = None,
    epn_rotation_id: str | None = None,
) -> dict[str, str]:
    """{"tcgplayer": url, "ebay": url} (either key omitted when no URL builds).

    Raw → TCGplayer product page when a product id resolves (explicit, else
    encoded in a `tcgplayer-<id>` card id), else the keyword search — the
    card-detail raw Buy flow, condition Near Mint by default. Graded → no
    TCGplayer (it doesn't list slabs). eBay defaults to ACTIVE listings sorted
    price+shipping lowest-first (the TS "Lowest Listed" buy surface); pass
    ebay_listing_type="sold" for recent-sales comps instead."""
    name = str(card.get("name") or "")
    set_name = str(card.get("setName") or "")
    number = str(card.get("number") or "")
    game = card.get("game")
    links: dict[str, str] = {}
    if not (grader or grade):
        product_id = tcgplayer_product_id or tcgplayer_product_id_from_card_id(card.get("id"))
        tcg = (
            tcgplayer_product_url(
                product_id, condition=condition, affiliate_base_url=tcgplayer_affiliate_base_url
            )
            if product_id
            else None
        ) or tcgplayer_search_url(
            name=name,
            set_name=set_name,
            card_number=number,
            condition=condition,
            printing=printing,
            game=game,
            affiliate_base_url=tcgplayer_affiliate_base_url,
        )
        if tcg:
            links["tcgplayer"] = tcg
    ebay = ebay_search_url(
        name=name,
        set_name=set_name,
        card_number=number,
        grader=grader,
        grade=grade,
        language=card.get("language"),
        game=game,
        listing_type=ebay_listing_type,
        epn_custom_id=epn_custom_id,
        epn_campaign_id=epn_campaign_id,
        epn_rotation_id=epn_rotation_id,
    )
    if ebay:
        links["ebay"] = ebay
    return links
