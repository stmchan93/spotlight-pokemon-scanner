"""Browse-level hiding of filler sets in the sets list (`/api/v1/expansions`).

The sets list (and the app's set search, which filters that list) skips
products that are not sets a collector browses: energy-only sets, Battle
Academy, trainer kits, starter/theme decks, deck kits, gift boxes, jumbo
cards. Nothing else changes: the cards stay in card search, scanning, card
pages, collection and watchlist, and a hidden set's own page
(`/expansions/<id>/cards`) still serves. `?includeHidden=1` returns the full
list with `hidden: true` on these rows (for a set page opened by link).

Pokémon only: in other games unpaired TCGplayer groups are often the real
sets Scrydex lacks, and "Starter Deck" is a real One Piece set line.

Rules, in order (first match wins):
  1. KEEP_SET_IDS / KEEP_TCGPLAYER_GROUP_IDS -> listed.
  2. Name matches FILLER_NAME_PATTERN -> hidden (Scrydex sets and groups).
  3. TCGplayer-only group set still unpaired after expansion_dedupe ->
     hidden, unless it looks like a new main set Scrydex has not added yet:
     released within NEW_GROUP_SET_WINDOW_DAYS and at least
     NEW_GROUP_SET_MIN_CARDS cards.
"""

from __future__ import annotations

import re
from datetime import date, datetime
from typing import Any, Iterable, Mapping

from catalog_tools import GAME_POKEMON, bare_catalog_id, normalize_game
from expansion_dedupe import is_tcgplayer_group_set_id, tcgplayer_group_id

FILLER_NAME_PATTERN = re.compile(
    r"\benergies\b"
    r"|battle\s*academy"
    r"|trainer\s*kit"
    r"|\bstart(?:er)?\s*(?:deck|set)s?\b"
    r"|\btheme\s*deck"
    r"|\bdeck\s*kit\b"
    r"|\bjumbo\b"
    r"|world\s*championships?\s*deck"
    r"|gift\s*box"
    r"|premium\s*trainer\s*box"
    # Japanese Scrydex names: starter set, start deck, high-class deck,
    # commemorative (Worlds) deck, gift box, premium deck set, intro pack.
    r"|スターターセット|スタートデッキ|ハイクラスデッキ|記念デッキ|ギフトボックス|プレミアムデッキセット|イントロパック",
    re.IGNORECASE,
)

# Bare Scrydex ids the name rule would wrongly hide.
KEEP_SET_IDS: dict[str, frozenset[str]] = {
    GAME_POKEMON: frozenset({
        "xy0",  # Kalos Starter Set: a numbered set (39 cards, own symbol)
    }),
}

# Unpaired TCGplayer groups that are real collected lines with no Scrydex twin.
KEEP_TCGPLAYER_GROUP_IDS: dict[str, frozenset[int]] = {
    GAME_POKEMON: frozenset({
        1539,   # League & Championship Cards
        24529,  # Player Placement Trainer Promos
    }),
}

NEW_GROUP_SET_WINDOW_DAYS = 90
NEW_GROUP_SET_MIN_CARDS = 50

HIDING_GAMES = frozenset({GAME_POKEMON})


def _release_date(value: Any) -> date | None:
    text = str(value or "").strip()[:10].replace("/", "-")
    try:
        return datetime.strptime(text, "%Y-%m-%d").date()
    except ValueError:
        return None


def hidden_reason(
    expansion: Mapping[str, Any],
    *,
    game: str,
    card_count: int | None = None,
    today: date | None = None,
) -> str | None:
    """Why this set is hidden from the sets list, or None when it is listed.

    `expansion` is an endpoint record (`id`, `name`, `releaseDate`); paired
    group sets are already removed by the caller."""
    normalized_game = normalize_game(game)
    if normalized_game not in HIDING_GAMES:
        return None
    set_id = str(expansion.get("id") or "")
    is_group = is_tcgplayer_group_set_id(set_id)
    if is_group and tcgplayer_group_id(set_id) in KEEP_TCGPLAYER_GROUP_IDS.get(normalized_game, frozenset()):
        return None
    if not is_group and bare_catalog_id(set_id) in KEEP_SET_IDS.get(normalized_game, frozenset()):
        return None
    if FILLER_NAME_PATTERN.search(str(expansion.get("name") or "")):
        return "filler_name"
    if is_group:
        released = _release_date(expansion.get("releaseDate"))
        age_days = ((today or date.today()) - released).days if released else None
        # A new main set TCGplayer lists before Scrydex does stays visible.
        if age_days is not None and age_days <= NEW_GROUP_SET_WINDOW_DAYS and (card_count or 0) >= NEW_GROUP_SET_MIN_CARDS:
            return None
        return "unpaired_tcgplayer_group"
    return None


def filter_browse_expansions(
    expansions: Iterable[dict[str, Any]],
    *,
    game: str,
    card_counts: Mapping[str, int] | None = None,
    include_hidden: bool = False,
    today: date | None = None,
) -> list[dict[str, Any]]:
    """Drop hidden sets (order kept); with `include_hidden`, keep them all and
    mark the hidden ones `hidden: True`."""
    counts = card_counts or {}
    result: list[dict[str, Any]] = []
    for expansion in expansions:
        set_id = str(expansion.get("id") or "")
        reason = hidden_reason(expansion, game=game, card_count=counts.get(set_id), today=today)
        if reason is None:
            result.append(expansion)
        elif include_hidden:
            result.append({**expansion, "hidden": True})
    return result
