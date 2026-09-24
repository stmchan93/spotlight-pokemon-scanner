"""Sealed product (booster boxes, ETBs, tins, …) catalog from TCGCSV.

Sealed products live as rows in `cards` (`supertype='Sealed'`) rather than a
table of their own: every price, history and ownership table keys off
`cards(id)`, so a row shaped like a card with a TCGplayer product id is priced
by the daily TCGCSV sync with no changes there. The cost is that card-only
features must skip these rows — see `is_sealed_card` and its callers.

They come from TCGCSV (TCGplayer), not Scrydex: Scrydex documents no sealed
price history, and TCGCSV already sets every card's main raw price.
"""

from __future__ import annotations

import re
import sqlite3
from typing import Any, Iterable

from catalog_tools import (
    GAME_GUNDAM,
    GAME_LORCANA,
    GAME_ONE_PIECE,
    GAME_POKEMON,
    GAME_RIFTBOUND,
    SEALED_CARD_ID_PREFIX,
    SEALED_SUPERTYPE,
    cards_by_ids,
    normalize_game,
    upsert_card,
)

SEALED_VARIANT = "Sealed"
TCGCSV_SEALED_SOURCE = "tcgcsv"

# TCGplayer category -> (game, language). Mirrors tcgcsv_adapter.TCGCSV_CATEGORY_IDS.
TCGCSV_CATEGORY_GAME: dict[int, tuple[str, str]] = {
    3: (GAME_POKEMON, "English"),
    85: (GAME_POKEMON, "Japanese"),
    68: (GAME_ONE_PIECE, "English"),
    71: (GAME_LORCANA, "English"),
    86: (GAME_GUNDAM, "English"),
    89: (GAME_RIFTBOUND, "English"),
}

# extendedData fields only CARDS carry. "No Number" alone is not sealed: whole
# vintage Japanese sets are cards without one (TCGCSV group 24207).
_CARD_FIELDS = frozenset({"Number", "Rarity", "CardType", "HP", "Card Type", "Stage"})

# First match wins, so the containers come before what they contain
# ("Booster Bundle Display Case" is a Case, not a Bundle).
_PRODUCT_TYPE_RULES: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("Case", re.compile(r"\bcase\b", re.I)),
    ("Display", re.compile(r"\bdisplay\b", re.I)),
    ("Elite Trainer Box", re.compile(r"\belite trainer box\b|\betb\b", re.I)),
    ("Booster Box", re.compile(r"\bbooster box\b", re.I)),
    ("Booster Bundle", re.compile(r"\bbooster bundle\b", re.I)),
    ("Build & Battle", re.compile(r"\bbuild\s*(&|and)\s*battle\b", re.I)),
    ("Tin", re.compile(r"\btin\b", re.I)),
    ("Blister", re.compile(r"\bblister\b", re.I)),
    ("Collection", re.compile(r"\bcollection\b", re.I)),
    ("Booster Pack", re.compile(r"\bbooster pack\b|\bsleeved booster\b", re.I)),
    ("Bundle", re.compile(r"\bbundle\b", re.I)),
    ("Starter Deck", re.compile(r"\bstarter deck\b|\btheme deck\b|\bbattle deck\b", re.I)),
)
SEALED_PRODUCT_TYPES = tuple(label for label, _ in _PRODUCT_TYPE_RULES) + ("Other",)


def _extended_names(product_row: dict[str, Any]) -> set[str]:
    return {
        str(entry.get("name") or "").strip()
        for entry in product_row.get("extendedData") or []
        if isinstance(entry, dict)
    }


def is_sealed_product(product_row: dict[str, Any]) -> bool:
    """A TCGCSV product that is sealed product rather than a card or a code card."""
    name = str(product_row.get("name") or "").strip()
    if not name or not str(product_row.get("productId") or "").strip():
        return False
    if name.lower().startswith("code card"):
        return False
    return not (_extended_names(product_row) & _CARD_FIELDS)


def sealed_product_type(name: str) -> str:
    for label, pattern in _PRODUCT_TYPE_RULES:
        if pattern.search(name or ""):
            return label
    return "Other"


def sealed_card_id(product_id: Any) -> str:
    return f"{SEALED_CARD_ID_PREFIX}{str(product_id).strip()}"


def is_sealed_card(card: dict[str, Any] | sqlite3.Row | None) -> bool:
    """True for a sealed-product row, whether a card dict (`supertype`) or a raw
    `cards` row (`supertype` column)."""
    if card is None:
        return False
    try:
        supertype = card["supertype"]
    except (KeyError, IndexError, TypeError):
        supertype = None
    return str(supertype or "").strip() == SEALED_SUPERTYPE


def _image_url(product_row: dict[str, Any], size: str) -> str | None:
    """TCGplayer CDN art. `_in_1000x1000` / `_400w` / `_200w` all resolve."""
    product_id = str(product_row.get("productId") or "").strip()
    if not product_id:
        return None
    if size == "large":
        return f"https://tcgplayer-cdn.tcgplayer.com/product/{product_id}_in_1000x1000.jpg"
    return f"https://tcgplayer-cdn.tcgplayer.com/product/{product_id}_400w.jpg"


def upsert_sealed_products(
    connection: sqlite3.Connection,
    rows: Iterable[tuple[int, dict[str, Any], dict[str, Any]]],
) -> dict[str, int]:
    """Upsert `(category_id, group_row, product_row)` triples that are sealed.

    The payload carries the product id in the same `variants[].marketplaces[]`
    shape as a Scrydex card, which is what the TCGCSV price sync reads — so the
    next price sync prices these rows, snapshot and history included. `set_id`
    stays NULL on purpose: set browse lists cards by `set_id`, and sealed
    product must never appear in a set's card grid."""
    stats = {"seen": 0, "upserted": 0, "skipped_not_sealed": 0, "skipped_unknown_category": 0}
    for category_id, group_row, product_row in rows:
        stats["seen"] += 1
        game_language = TCGCSV_CATEGORY_GAME.get(int(category_id))
        if game_language is None:
            stats["skipped_unknown_category"] += 1
            continue
        if not is_sealed_product(product_row):
            stats["skipped_not_sealed"] += 1
            continue
        game, language = game_language
        product_id = str(product_row["productId"]).strip()
        name = re.sub(r"\s+", " ", str(product_row.get("name") or "")).strip()
        group_name = str((group_row or {}).get("name") or "").strip()
        released_on = str(((product_row.get("presaleInfo") or {}).get("releasedOn")) or "").strip()
        release_date = released_on[:10] or str((group_row or {}).get("publishedOn") or "")[:10] or None
        upsert_card(
            connection,
            card_id=sealed_card_id(product_id),
            name=name,
            set_name=group_name,
            number="",
            rarity="",
            variant=SEALED_VARIANT,
            language=language,
            game=game,
            source_provider=TCGCSV_SEALED_SOURCE,
            source_record_id=product_id,
            set_id=None,
            set_ptcgo_code=str((group_row or {}).get("abbreviation") or "").strip() or None,
            set_release_date=release_date,
            supertype=SEALED_SUPERTYPE,
            subtypes=[sealed_product_type(name)],
            image_url=_image_url(product_row, "large"),
            image_small_url=_image_url(product_row, "small"),
            tcgplayer_id=product_id,
            source_payload={
                "provider": TCGCSV_SEALED_SOURCE,
                "tcgplayerCategoryId": int(category_id),
                "tcgplayerGroupId": (group_row or {}).get("groupId"),
                "tcgplayerUrl": product_row.get("url"),
                "variants": [
                    {
                        "name": "normal",
                        "marketplaces": [{"name": "tcgplayer", "product_id": int(product_id)}],
                    }
                ],
            },
        )
        stats["upserted"] += 1
    return stats


def search_sealed_products(
    connection: sqlite3.Connection,
    query: str,
    *,
    game: str | None,
    limit: int = 20,
    offset: int = 0,
) -> list[dict[str, Any]]:
    """Sealed products whose name or set contains every query token.

    A plain LIKE scan is enough: there are ~7k sealed rows, a small slice of
    the catalog, and `supertype` narrows to them first. `game=None` searches
    every game (typed queries do, like card search)."""
    tokens = [token for token in re.split(r"\s+", str(query or "").strip().lower()) if token]
    where = ["supertype = ?"]
    params: list[Any] = [SEALED_SUPERTYPE]
    if game is not None:
        where.append("+game = ?")
        params.append(normalize_game(game))
    for token in tokens:
        where.append("(LOWER(name) LIKE ? OR LOWER(set_name) LIKE ?)")
        params.extend([f"%{token}%", f"%{token}%"])
    params.extend([max(1, min(int(limit), 100)), max(0, int(offset))])
    rows = connection.execute(
        f"SELECT id FROM cards WHERE {' AND '.join(where)} "
        # Newest sets first, then by name, so "prismatic" leads with the set's
        # own boxes rather than an alphabetical mix.
        "ORDER BY set_release_date DESC, name ASC, id ASC LIMIT ? OFFSET ?",
        params,
    ).fetchall()
    ids = [str(row[0]) for row in rows]
    by_id = cards_by_ids(connection, ids)
    return [by_id[card_id] for card_id in ids if card_id in by_id]
