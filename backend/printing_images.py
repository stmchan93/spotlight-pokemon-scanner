"""Card art for an owned copy / watched printing whose art differs from the card's.

A catalog card has ONE image (Scrydex's base art), but a card id can carry
several TCGplayer printings with their own artwork ("Special Alt Art",
"Manga Alt Art", ...). A copy owned on such a printing shows that printing's
TCGplayer product image; everything else keeps the card image.

Art-changing rule (allow-list on the label, case/space/punctuation-insensitive):
a printing changes the art only when its label names an art version — it
contains "alt art", "alternate art", "full art", "manga", "wanted poster",
"parallel" or "enchanted" (so "Special Alt Art", "Gold Special Alt Art",
"Treasure Cup Alt Art", "Alt Art Stamp" all count). Every other label keeps the
base art: finishes (Normal/Foil/Holofoil/Reverse Holofoil/Cold Foil/Textured
Foil/Jolly Roger Foil/Cosmos/Cracked Ice...), editions (1st Edition/Unlimited/
Shadowless), Reprint, stamps, Jumbo and World Championship player names. An
allow-list because those same-art labels are open-ended (hundreds on Pokémon)
while art versions use a small vocabulary; a miss only falls back to the card
image, which is the old behavior.
"""

from __future__ import annotations

import re
import sqlite3
from typing import Any, Iterable

from catalog_tools import TCGPLAYER_ONLY_CARD_ID_SQL, is_tcgplayer_only_card_id

TCGPLAYER_PRODUCT_IMAGE_URL = "https://tcgplayer-cdn.tcgplayer.com/product/{pid}_in_1000x1000.jpg"
TCGPLAYER_PRODUCT_SMALL_IMAGE_URL = "https://tcgplayer-cdn.tcgplayer.com/product/{pid}_400w.jpg"

ART_VERSION_LABEL_TOKENS = (
    "altart",
    "alternateart",
    "fullart",
    "manga",
    "wantedposter",
    "parallel",
    "enchanted",
)

_SQL_CHUNK = 400

PrintingImageKey = tuple[str, str]


def printing_label_key(label: Any) -> str:
    """Comparison key: 'Special Alt Art' == 'special  alt-art' == 'SpecialAltArt'."""
    text = re.sub(r"\b1st\b", "first", str(label or ""), flags=re.IGNORECASE)
    return re.sub(r"[^a-z0-9]+", "", text.lower())


def is_art_version_label(label: Any) -> bool:
    key = printing_label_key(label)
    return bool(key) and any(token in key for token in ART_VERSION_LABEL_TOKENS)


def _chunks(values: list[str]) -> Iterable[list[str]]:
    for start in range(0, len(values), _SQL_CHUNK):
        yield values[start : start + _SQL_CHUNK]


def _table_exists(connection: sqlite3.Connection, table: str) -> bool:
    return (
        connection.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1", (table,)
        ).fetchone()
        is not None
    )


def printing_images_for(
    connection: sqlite3.Connection,
    pairs: Iterable[tuple[Any, Any]],
) -> dict[PrintingImageKey, dict[str, str]]:
    """``{(card_id, printing_label_key(variant)): {"printingImageUrl", "printingImageSmallUrl"}}``
    for the ``(card_id, variant_name)`` pairs that sit on an art-changing
    printing. Two indexed queries per 400 cards, whatever the row count.

    Skipped: TCGplayer-only cards (their card image already IS the product
    image) and product ids claimed by more than one card (the mis-maps the
    pricing collision guard suppresses — never show another card's art)."""
    wanted: set[PrintingImageKey] = set()
    for card_id, variant_name in pairs:
        card = str(card_id or "").strip()
        if not card or is_tcgplayer_only_card_id(card) or not is_art_version_label(variant_name):
            continue
        wanted.add((card, printing_label_key(variant_name)))
    if not wanted or not _table_exists(connection, "card_tcgplayer_products"):
        return {}

    product_by_key: dict[PrintingImageKey, str] = {}
    for chunk in _chunks(sorted({card for card, _ in wanted})):
        placeholders = ",".join("?" for _ in chunk)
        for card_id, product_id, label in connection.execute(
            "SELECT card_id, product_id, variant_label FROM card_tcgplayer_products "
            f"WHERE card_id IN ({placeholders}) ORDER BY card_id, ordinal",
            chunk,
        ):
            key = (str(card_id), printing_label_key(label))
            pid = str(product_id or "").strip()
            # The first printing listed owns a label it shares (same as the TCGCSV sync).
            if key in wanted and pid.isdigit() and key not in product_by_key:
                product_by_key[key] = pid
    if not product_by_key:
        return {}

    colliding: set[str] = set()
    for chunk in _chunks(sorted(set(product_by_key.values()))):
        placeholders = ",".join("?" for _ in chunk)
        colliding.update(
            str(row[0])
            for row in connection.execute(
                "SELECT product_id FROM card_tcgplayer_products "
                f"WHERE product_id IN ({placeholders}) AND NOT {TCGPLAYER_ONLY_CARD_ID_SQL} "
                "GROUP BY product_id HAVING COUNT(DISTINCT card_id) > 1",
                chunk,
            )
        )

    return {
        key: {
            "printingImageUrl": TCGPLAYER_PRODUCT_IMAGE_URL.format(pid=pid),
            "printingImageSmallUrl": TCGPLAYER_PRODUCT_SMALL_IMAGE_URL.format(pid=pid),
        }
        for key, pid in product_by_key.items()
        if pid not in colliding
    }


def printing_image_fields(
    images: dict[PrintingImageKey, dict[str, str]],
    card_id: Any,
    variant_name: Any,
) -> dict[str, str | None]:
    """The two payload fields for one row; both None when the row keeps the card image."""
    found = images.get((str(card_id or "").strip(), printing_label_key(variant_name))) if images else None
    return {
        "printingImageUrl": found["printingImageUrl"] if found else None,
        "printingImageSmallUrl": found["printingImageSmallUrl"] if found else None,
    }
