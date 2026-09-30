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


def _art_products_by_card(
    connection: sqlite3.Connection,
    card_ids: Iterable[Any],
) -> dict[str, dict[str, tuple[str, str]]]:
    """``{card_id: {printing_label_key(label): (label, product_id)}}`` for every
    art-changing printing of ``card_ids``, in listing order. Two indexed
    queries per 400 cards, whatever the row count.

    Skipped: TCGplayer-only cards (their card image already IS the product
    image) and product ids claimed by more than one card (the mis-maps the
    pricing collision guard suppresses — never show another card's art)."""
    cards = sorted(
        {
            card
            for card in (str(value or "").strip() for value in card_ids)
            if card and not is_tcgplayer_only_card_id(card)
        }
    )
    if not cards or not _table_exists(connection, "card_tcgplayer_products"):
        return {}

    products: dict[str, dict[str, tuple[str, str]]] = {}
    for chunk in _chunks(cards):
        placeholders = ",".join("?" for _ in chunk)
        for card_id, product_id, label in connection.execute(
            "SELECT card_id, product_id, variant_label FROM card_tcgplayer_products "
            f"WHERE card_id IN ({placeholders}) ORDER BY card_id, ordinal",
            chunk,
        ):
            pid = str(product_id or "").strip()
            if not pid.isdigit() or not is_art_version_label(label):
                continue
            by_key = products.setdefault(str(card_id), {})
            # The first printing listed owns a label it shares (same as the TCGCSV sync).
            by_key.setdefault(printing_label_key(label), (str(label).strip(), pid))
    if not products:
        return {}

    colliding: set[str] = set()
    all_pids = sorted({pid for by_key in products.values() for _, pid in by_key.values()})
    for chunk in _chunks(all_pids):
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
        card_id: kept
        for card_id, by_key in products.items()
        if (kept := {key: entry for key, entry in by_key.items() if entry[1] not in colliding})
    }


def printing_images_for(
    connection: sqlite3.Connection,
    pairs: Iterable[tuple[Any, Any]],
) -> dict[PrintingImageKey, dict[str, str]]:
    """``{(card_id, printing_label_key(variant)): {"printingImageUrl", "printingImageSmallUrl"}}``
    for the ``(card_id, variant_name)`` pairs that sit on an art-changing
    printing (see ``_art_products_by_card`` for what is skipped)."""
    wanted: set[PrintingImageKey] = set()
    for card_id, variant_name in pairs:
        card = str(card_id or "").strip()
        if card and is_art_version_label(variant_name):
            wanted.add((card, printing_label_key(variant_name)))
    if not wanted:
        return {}
    products = _art_products_by_card(connection, {card for card, _ in wanted})
    images: dict[PrintingImageKey, dict[str, str]] = {}
    for card_id, key in wanted:
        found = products.get(card_id, {}).get(key)
        if found:
            images[(card_id, key)] = {
                "printingImageUrl": TCGPLAYER_PRODUCT_IMAGE_URL.format(pid=found[1]),
                "printingImageSmallUrl": TCGPLAYER_PRODUCT_SMALL_IMAGE_URL.format(pid=found[1]),
            }
    return images


def printing_images_by_card(
    connection: sqlite3.Connection,
    card_ids: Iterable[Any],
) -> dict[str, list[dict[str, str]]]:
    """``{card_id: [{"label", "imageUrl", "smallImageUrl"}]}``: every art-changing
    printing of each card, so a printing picker can show the selected
    printing's art. Base/finish printings get no entry (they keep the card image)."""
    return {
        card_id: [
            {
                "label": label,
                "imageUrl": TCGPLAYER_PRODUCT_IMAGE_URL.format(pid=pid),
                "smallImageUrl": TCGPLAYER_PRODUCT_SMALL_IMAGE_URL.format(pid=pid),
            }
            for label, pid in by_key.values()
        ]
        for card_id, by_key in _art_products_by_card(connection, card_ids).items()
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
