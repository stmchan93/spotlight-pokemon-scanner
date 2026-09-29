"""TCGplayer-only catalog: sort the TCGplayer card products no catalog card claims.

Plan: docs/tcgplayer-only-catalog-plan-2026-09-29.md. Every unclaimed,
card-shaped product from the daily TCGCSV crawl is either
  (a) LINK   — a missing version of a card we have (same number + name),
  (b) CREATE — a card Scrydex does not list at all,
  REVIEW     — ambiguous; a human decides via tcgplayer_only_overrides.json,
  IGNORE     — code cards and other non-card products (plus any class a game
               opts out of in EXCLUDED_CLASSES; none, plan D2).

Phase P0 is SHADOW only: decisions land in `tcgplayer_product_classifications`
under shadow_* statuses and the sync-run notes. No `cards` row, product link or
price is written; nothing downstream reads the table yet.

Scrydex stays primary: a product any card already claims (payload product ids,
cards.tcgplayer_id, the overrides + backfill files, or a real classification)
is never classified.
"""

from __future__ import annotations

import json
import os
import re
import sqlite3
import unicodedata
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable, Mapping

from catalog_tools import (
    GAME_GUNDAM,
    GAME_LORCANA,
    GAME_ONE_PIECE,
    GAME_POKEMON,
    GAME_RIFTBOUND,
    namespaced_catalog_id,
    utc_now,
)
from sealed_products import TCGCSV_CATEGORY_GAME, is_sealed_product
from tcgcsv_adapter import (
    TCGPLAYER_GROUP_ID_BY_SET_ID,
    card_numbers_match,
    normalized_card_number,
)

MODE_OFF = "off"
MODE_SHADOW = "shadow"
MODE_ON = "on"

DECISION_LINK = "link"
DECISION_CREATE = "create"
DECISION_REVIEW = "review"
DECISION_IGNORE = "ignore"

STATUS_LINKED = "linked"
STATUS_CREATED = "created"
STATUS_REVIEW = "review"
STATUS_IGNORED = "ignored"
STATUS_SUPERSEDED = "superseded"
STATUS_SHADOW_MISSING = "shadow_missing"
STATUS_SHADOW_LINKED = "shadow_linked"
# Rows a later phase acted on: shadow never rewrites them, and their products
# count as claimed.
REAL_STATUSES = frozenset({STATUS_LINKED, STATUS_CREATED, STATUS_SUPERSEDED})
_SHADOW_STATUS = {
    DECISION_LINK: STATUS_SHADOW_LINKED,
    DECISION_CREATE: STATUS_SHADOW_MISSING,
    DECISION_REVIEW: STATUS_REVIEW,
    DECISION_IGNORE: STATUS_IGNORED,
}

JP_CATEGORY_ID = 85
OVERRIDES_PATH = Path(__file__).resolve().parent / "tcgplayer_only_overrides.json"

# Games whose printed number names one card game-wide. Riftbound's does only
# with its denominator ("001/298" is Origins, "001/221" Spiritforged), so its key
# keeps it. Pokémon and Lorcana numbers repeat per set and are matched only
# inside the group's mapped set(s).
GLOBAL_NUMBER_GAMES = frozenset({GAME_ONE_PIECE, GAME_GUNDAM, GAME_RIFTBOUND})
_DENOMINATOR_KEYED_GAMES = frozenset({GAME_RIFTBOUND})

# Class labels for card-shaped products, per game: each pattern is searched
# (case-insensitive) in the product name, group name or TCGplayer rarity. They
# label the report; a class is only skipped when listed in EXCLUDED_CLASSES.
_OVERSIZED_NAME = (r"\bjumbo\b", r"\boversized\b")
PRODUCT_CLASS_PATTERNS: dict[str, dict[str, dict[str, tuple[str, ...]]]] = {
    GAME_POKEMON: {
        "oversized": {"name": _OVERSIZED_NAME, "group": (r"\bjumbo cards?\b",)},
        "world_championship_deck": {"group": (r"\bworld championship decks?\b",)},
        "art_card": {"name": (r"\bart cards?\b",)},
    },
    GAME_ONE_PIECE: {"oversized": {"name": _OVERSIZED_NAME}},
    # Lorcana "Quest" rarity = the oversized Illumineer's Quest boss cards.
    GAME_LORCANA: {"oversized": {"name": _OVERSIZED_NAME, "rarity": (r"^quest$",)}},
    GAME_GUNDAM: {"oversized": {"name": _OVERSIZED_NAME}},
    GAME_RIFTBOUND: {"oversized": {"name": _OVERSIZED_NAME}},
}
# Card-sized products that are not cards (Lorcana puzzle inserts, lore cards):
# ignored like code cards. Same shape as PRODUCT_CLASS_PATTERNS.
NON_CARD_PATTERNS: dict[str, dict[str, tuple[str, ...]]] = {
    GAME_LORCANA: {"name": (r"\binserts?\b", r"\bpuzzle set\b", r"\blore cards?\b", r"\bcase file cards?\b")},
}
# Plan D2 (user, 2026-09-29): include as much as possible — nothing beyond
# sealed and code cards is excluded. Kept as data so a game can opt a class out.
EXCLUDED_CLASSES: dict[str, frozenset[str]] = {}

# TCGplayer rarity codes -> the words Scrydex uses, so "L" and "Leader" compare equal.
_RARITY_ALIASES = {
    "c": "common", "u": "uncommon", "uc": "uncommon", "r": "rare",
    "sr": "superrare", "sec": "secretrare", "secret": "secretrare",
    "l": "leader", "p": "promo", "pr": "promo", "lr": "legendrare",
}
_UNKNOWN_RARITIES = frozenset({"", "none", "unknown", "unconfirmed"})

_TRAILING_BRACKET = re.compile(r"\s*(?:\(([^()]*)\)|\[([^\[\]]*)\])\s*$")
# Pokémon's " - 223/197", One Piece's " - ST01-001": a number-like token only,
# so Lorcana subtitles ("Mickey Mouse - Detective") stay part of the name.
_TRAILING_NUMBER = re.compile(r"\s+-\s+(\S*\d\S*)\s*$")


def ingest_mode() -> str:
    """env TCGCSV_TCGPLAYER_ONLY_INGEST: off | shadow (default) | on."""
    value = str(os.environ.get("TCGCSV_TCGPLAYER_ONLY_INGEST") or "").strip().lower()
    if value in {"0", "false", "no", "off"}:
        return MODE_OFF
    if value in {"on", "1", "true", "yes"}:
        return MODE_ON
    return MODE_SHADOW


def proposed_card_id(game: str, product_id: Any) -> str:
    """`tcgplayer-<pid>` (Pokémon) / `<game>~tcgplayer-<pid>`. Never `tcgp-`: that
    prefix is Scrydex's TCG Pocket and carries scanner + search penalties."""
    return namespaced_catalog_id(game, f"tcgplayer-{str(product_id).strip()}")


def split_product_name(name: Any) -> tuple[str, str]:
    """("Monkey.D.Luffy", "Sealed Battle 2024 Vol. 2") from
    "Monkey.D.Luffy (Sealed Battle 2024 Vol. 2)": trailing (…)/[…] and
    " - <number>" disambiguators peel off into the version label."""
    base = re.sub(r"\s+", " ", str(name or "")).strip()
    labels: list[str] = []
    while True:
        match = _TRAILING_BRACKET.search(base) or _TRAILING_NUMBER.search(base)
        if match is None or match.start() == 0:
            break
        label = next((group for group in match.groups() if group is not None), "")
        labels.insert(0, label.strip())
        base = base[: match.start()].rstrip()
    return base, "; ".join(label for label in labels if label)


def normalize_name(value: Any) -> str:
    text = unicodedata.normalize("NFKD", str(value or ""))
    text = "".join(ch for ch in text if not unicodedata.combining(ch)).casefold().strip()
    # "Basic Grass Energy" (modern Scrydex) is the same card as "Grass Energy".
    text = re.sub(r"^basic\s+(?=\w+\s+energy$)", "", text)
    return re.sub(r"[\W_]+", "", text)


def product_name_keys(base_name: str) -> frozenset[str]:
    """The product's normalized name plus its halves around the first " - " or
    ", ": Scrydex stores Lorcana's "Mickey Mouse - True Friend" as "Mickey Mouse"
    and some Riftbound champions' "Sett, The Boss" as "The Boss"."""
    keys = {normalize_name(base_name)}
    for separator in (" - ", ", "):
        head, found, tail = base_name.partition(separator)
        if found and head.strip() and tail.strip():
            keys.update({normalize_name(head), normalize_name(tail)})
    return frozenset(key for key in keys if key)


def rarity_class(value: Any) -> str:
    key = re.sub(r"[\W_]+", "", str(value or "").casefold())
    if key in _UNKNOWN_RARITIES:
        return ""
    return _RARITY_ALIASES.get(key, key)


def _denominator(value: Any) -> str:
    text = str(value or "")
    if "/" not in text:
        return ""
    return normalized_card_number(text.split("/", 1)[1])


def number_key(game: str, value: Any) -> str:
    base = normalized_card_number(value)
    if base and game in _DENOMINATOR_KEYED_GAMES:
        denominator = _denominator(value)
        return f"{base}/{denominator}" if denominator else base
    return base


def _extended(product_row: Mapping[str, Any], *names: str) -> str:
    for entry in product_row.get("extendedData") or []:
        if isinstance(entry, dict) and str(entry.get("name") or "").strip() in names:
            return str(entry.get("value") or "").strip()
    return ""


def product_class(game: str, product_row: Mapping[str, Any], group_name: str = "") -> str:
    """sealed | code_card | non_card | don | token | <PRODUCT_CLASS_PATTERNS label> | card."""
    if is_sealed_product(dict(product_row)):
        return "sealed"
    name = str(product_row.get("name") or "").strip()
    rarity = _extended(product_row, "Rarity")
    if name.lower().startswith("code card") or rarity.lower() == "code card":
        return "code_card"
    fields = {"name": name, "group": group_name, "rarity": rarity}
    for field_name, patterns in NON_CARD_PATTERNS.get(game, {}).items():
        if any(re.search(pattern, fields[field_name], re.I) for pattern in patterns):
            return "non_card"
    card_type = _extended(product_row, "CardType", "Card Type")
    if card_type == "DON!!" or name.lower().startswith("don!!"):
        return "don"
    if "token" in card_type.lower() or card_type in {"EX Base", "EX Resource", "Resource"}:
        return "token"
    for label, patterns_by_field in PRODUCT_CLASS_PATTERNS.get(game, {}).items():
        for field_name, patterns in patterns_by_field.items():
            if any(re.search(pattern, fields[field_name], re.I) for pattern in patterns):
                return label
    return "card"


@dataclass(frozen=True)
class CatalogCard:
    id: str
    set_id: str
    name_key: str
    number: str  # normalized_card_number
    number_key: str
    denominator: str
    rarity: str  # rarity_class


@dataclass
class _Scope:
    by_id: dict[str, CatalogCard] = field(default_factory=dict)
    by_number: dict[str, list[CatalogCard]] = field(default_factory=lambda: defaultdict(list))
    by_set: dict[str, list[CatalogCard]] = field(default_factory=lambda: defaultdict(list))
    by_name: dict[str, list[CatalogCard]] = field(default_factory=lambda: defaultdict(list))


class CatalogIndex:
    """The catalog cards the classifier compares against, per (game, language).
    Input rows: id, game, language, name, number, rarity, set_id."""

    def __init__(self, rows: Iterable[Mapping[str, Any]]):
        self._scopes: dict[tuple[str, str], _Scope] = defaultdict(_Scope)
        self._set_of: dict[str, str] = {}
        for row in rows:
            card_id = str(row["id"])
            game = str(row.get("game") or GAME_POKEMON)
            language = str(row.get("language") or "English")
            set_id = str(row.get("set_id") or "")
            card = CatalogCard(
                id=card_id,
                set_id=set_id,
                name_key=normalize_name(split_product_name(row.get("name"))[0]),
                number=normalized_card_number(row.get("number")),
                number_key=number_key(game, row.get("number")),
                denominator=_denominator(row.get("number")),
                rarity=rarity_class(row.get("rarity")),
            )
            scope = self._scopes[(game, language)]
            scope.by_id[card_id] = card
            if card.number_key:
                scope.by_number[card.number_key].append(card)
            if set_id:
                scope.by_set[set_id].append(card)
                self._set_of[card_id] = set_id
            if card.name_key:
                scope.by_name[card.name_key].append(card)

    def scope(self, game: str, language: str) -> _Scope:
        return self._scopes[(game, language)]

    def set_of(self, card_id: str) -> str | None:
        return self._set_of.get(card_id)

    def has_set(self, game: str, language: str, set_id: str) -> bool:
        return set_id in self.scope(game, language).by_set


def load_catalog_index(connection: sqlite3.Connection) -> CatalogIndex:
    """Every catalog card except TCG Pocket and sealed rows (`tcgp-`): neither
    is a physical card a TCGplayer single could be a version of."""
    rows = connection.execute(
        "SELECT id, game, language, name, number, rarity, set_id FROM cards "
        "WHERE id NOT LIKE 'tcgp-%'"
    )
    columns = ("id", "game", "language", "name", "number", "rarity", "set_id")
    return CatalogIndex(dict(zip(columns, row)) for row in rows)


def load_claims(
    connection: sqlite3.Connection,
    extra_card_claims: Mapping[str, str] | None = None,
) -> dict[str, set[str]]:
    """{product_id: {card_id}} for every product a card already claims: the
    payload product index, cards.tcgplayer_id, the overrides + backfill files
    (`extra_card_claims`, {card_id: product_id}) and real classifications."""
    claims: dict[str, set[str]] = defaultdict(set)
    for product_id, card_id in connection.execute(
        "SELECT product_id, card_id FROM card_tcgplayer_products"
    ):
        claims[str(product_id)].add(str(card_id))
    for card_id, product_id in connection.execute(
        "SELECT id, tcgplayer_id FROM cards WHERE tcgplayer_id IS NOT NULL AND tcgplayer_id != ''"
    ):
        claims[str(product_id)].add(str(card_id))
    for card_id, product_id in (extra_card_claims or {}).items():
        if product_id:
            claims[str(product_id)].add(str(card_id))
    placeholders = ",".join("?" * len(REAL_STATUSES))
    for product_id, card_id in connection.execute(
        f"SELECT product_id, COALESCE(card_id, proposed_card_id) FROM tcgplayer_product_classifications "
        f"WHERE status IN ({placeholders})",
        tuple(REAL_STATUSES),
    ):
        claims[str(product_id)].add(str(card_id or ""))
    return claims


def load_overrides(path: Path = OVERRIDES_PATH) -> dict[str, dict[str, Any]]:
    """{productId: {action: link|create|ignore, cardId?, label?}}; "_" keys are docs."""
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    if not isinstance(payload, dict):
        return {}
    return {
        str(product_id).strip(): entry
        for product_id, entry in payload.items()
        if not str(product_id).startswith("_")
        and isinstance(entry, dict)
        and entry.get("action") in {"link", "create", "ignore"}
    }


@dataclass
class Classification:
    product_id: str
    category_id: int
    group_id: int | None
    game: str
    language: str
    decision: str
    card_id: str | None
    proposed_card_id: str | None
    version_label: str
    evidence: dict[str, Any]


def map_groups(
    rows: Iterable[tuple[int, Mapping[str, Any], Mapping[str, Any]]],
    claims: Mapping[str, set[str]],
    index: CatalogIndex,
) -> dict[tuple[int, int], tuple[list[str], str]]:
    """{(category, group): ([set_id…], how)}. A group maps to the set most of its
    claimed products belong to; with no majority, to every set voted for (a
    mixed promo/prize-pack group). Zero claimed products = unmapped, unless a
    hand-verified alias names the set."""
    votes: dict[tuple[int, int], Counter] = defaultdict(Counter)
    groups: set[tuple[int, int]] = set()
    for category_id, group_row, product_row in rows:
        key = (int(category_id), int((group_row or {}).get("groupId") or 0))
        groups.add(key)
        product_id = str(product_row.get("productId") or "").strip()
        sets_for_product = {
            index.set_of(card_id) for card_id in claims.get(product_id, ())
        } - {None}
        for set_id in sets_for_product:
            votes[key][set_id] += 1
    alias_sets = {group_id: set_id for set_id, group_id in TCGPLAYER_GROUP_ID_BY_SET_ID.items()}
    mapping: dict[tuple[int, int], tuple[list[str], str]] = {}
    for key in groups:
        counter = votes.get(key)
        if counter:
            (top, top_votes), = counter.most_common(1)
            if top_votes * 2 >= sum(counter.values()):
                mapping[key] = ([top], "majority")
            else:
                mapping[key] = ([set_id for set_id, _ in counter.most_common()], "mixed")
            continue
        category_id, group_id = key
        game, language = TCGCSV_CATEGORY_GAME.get(category_id, (GAME_POKEMON, "English"))
        alias = alias_sets.get(group_id)
        if alias and index.has_set(game, language, alias):
            mapping[key] = ([alias], "alias")
        else:
            mapping[key] = ([], "unmapped")
    return mapping


def _rarity_compatible(a: str, b: str) -> bool:
    return not a or not b or a == b


def _denominators_compatible(a: str, b: str) -> bool:
    return not a or not b or a == b


def _decide(
    *,
    game: str,
    category_id: int,
    name_keys: frozenset[str],
    raw_number: str,
    rarity: str,
    sets: list[str],
    scope: _Scope,
) -> tuple[str, CatalogCard | None, str, list[CatalogCard]]:
    """The rules table (plan P0). Returns (decision, linked card, reason, candidates)."""
    if not name_keys:
        return DECISION_REVIEW, None, "no-name", []
    key = number_key(game, raw_number)
    number = normalized_card_number(raw_number)
    set_scoped = game not in GLOBAL_NUMBER_GAMES
    in_sets = [card for set_id in sets for card in scope.by_set.get(set_id, ())]
    same_name_in_game = [card for name_key in name_keys for card in scope.by_name.get(name_key, ())]

    denominator = _denominator(raw_number)
    if key and (not set_scoped or sets):
        if set_scoped:
            # "11/35" (an Illumineer's Quest card) is not "11/204" of the same set.
            hits = [
                card for card in in_sets
                if card_numbers_match(card.number, number)
                and _denominators_compatible(denominator, card.denominator)
            ]
        else:
            hits = list(scope.by_number.get(key, ()))
        named = [card for card in hits if card.name_key in name_keys]
        if len(named) == 1:
            return DECISION_LINK, named[0], "number+name", named
        if named:
            return DECISION_REVIEW, None, "number+name-multiple", named
        if hits:
            return DECISION_REVIEW, None, "number-name-differs", hits
        # Set-numbered games: a same-name card in the set may be this card under
        # another number. Where the number is game-unique it is the identity,
        # and a new number is a new card (Crocodile P-143 beside P-004).
        same_name = [card for card in in_sets if card.name_key in name_keys] if set_scoped else []
        if same_name:
            return DECISION_REVIEW, None, "same-name-in-mapped-set", same_name
        # A reprint carrying its home set's number (prize packs, SEA exclusives)
        # whose set the group's votes missed, or a lettered version ("R01a") of
        # a card we hold as "R01".
        unlettered = re.sub(r"(?<=\d)[a-z]+$", "", number)
        elsewhere = [
            card for card in same_name_in_game
            if (card_numbers_match(card.number, number) or card.number == unlettered)
            and _denominators_compatible(denominator, card.denominator)
        ]
        if elsewhere:
            return DECISION_REVIEW, None, "number+name-elsewhere", elsewhere
        return DECISION_CREATE, None, "number-not-in-catalog", []

    if not set_scoped:
        # Game-unique numbers: a product TCGplayer lists without one cannot be
        # a printing of a numbered card (552137, the numberless Sealed Battle
        # Luffy Leader, is not OP01-003), so only numberless cards are twins.
        same_name_in_game = [card for card in same_name_in_game if not card.number]
        in_sets = [card for card in in_sets if not card.number]

    if sets:
        # Numberless in a mapped group. Scrydex's JP vintage + promo cards carry
        # no product ids, so numberless JP products in their groups would
        # mostly duplicate cards we have: never auto-create those.
        if category_id == JP_CATEGORY_ID:
            same_name = [card for card in in_sets if card.name_key in name_keys]
            return DECISION_REVIEW, None, "jp-numberless-mapped-group", same_name
        twins = [
            card for card in in_sets
            if card.name_key in name_keys and _rarity_compatible(rarity, card.rarity)
        ]
        if twins:
            return DECISION_REVIEW, None, "numberless-same-name-rarity-in-set", twins
        return DECISION_CREATE, None, "numberless-new-in-mapped-set", []

    # Unmapped group (numberless, or a set-numbered game whose number means
    # nothing without a set): new only if nothing game-wide shares the name and
    # rarity class (or the name and number).
    twins = [
        card for card in same_name_in_game
        if _rarity_compatible(rarity, card.rarity)
        or (number and card_numbers_match(card.number, number))
    ]
    if twins:
        return DECISION_REVIEW, None, "unmapped-same-name-rarity-in-game", twins
    return DECISION_CREATE, None, "unmapped-new-name", []


def classify_products(
    rows: list[tuple[int, Mapping[str, Any], Mapping[str, Any]]],
    index: CatalogIndex,
    claims: Mapping[str, set[str]],
    *,
    overrides: Mapping[str, Mapping[str, Any]] | None = None,
    product_price_map: Mapping[str, Mapping[str, Mapping[str, Any]]] | None = None,
) -> tuple[list[Classification], dict[str, int]]:
    """Classify every unclaimed card-shaped product in `rows`
    ((category_id, group_row, product_row), the crawl's product_rows_out)."""
    overrides = overrides or {}
    group_sets = map_groups(rows, claims, index)
    stats: Counter = Counter()
    results: list[Classification] = []
    seen: set[str] = set()
    for category_id, group_row, product_row in rows:
        category_id = int(category_id)
        product_id = str(product_row.get("productId") or "").strip()
        game_language = TCGCSV_CATEGORY_GAME.get(category_id)
        if not product_id or game_language is None or product_id in seen:
            continue
        seen.add(product_id)
        if product_id in claims:
            stats["claimed"] += 1
            continue
        game, language = game_language
        group_id = (group_row or {}).get("groupId")
        group_name = str((group_row or {}).get("name") or "")
        klass = product_class(game, product_row, group_name)
        if klass == "sealed":
            # The sealed ingest owns these; not card-shaped.
            stats["sealed"] += 1
            continue
        base_name, version_label = split_product_name(product_row.get("name"))
        keys = product_name_keys(base_name)
        raw_number = _extended(product_row, "Number")
        raw_rarity = _extended(product_row, "Rarity")
        sets, mapping_how = group_sets.get((category_id, int(group_id or 0)), ([], "unmapped"))
        scope = index.scope(game, language)

        card: CatalogCard | None = None
        candidates: list[CatalogCard] = []
        override = overrides.get(product_id)
        if override:
            decision = {"link": DECISION_LINK, "create": DECISION_CREATE, "ignore": DECISION_IGNORE}[override["action"]]
            reason = f"override:{override['action']}"
            if decision == DECISION_LINK:
                card = scope.by_id.get(str(override.get("cardId") or ""))
                if card is None:
                    decision, reason = DECISION_REVIEW, "override:link-card-not-found"
            version_label = str(override.get("label") or version_label)
        elif klass in {"code_card", "non_card"}:
            decision, reason = DECISION_IGNORE, klass
        elif klass in EXCLUDED_CLASSES.get(game, frozenset()):
            decision, reason = DECISION_IGNORE, f"excluded:{klass}"
        else:
            decision, card, reason, candidates = _decide(
                game=game, category_id=category_id, name_keys=keys,
                raw_number=raw_number, rarity=rarity_class(raw_rarity),
                sets=sets, scope=scope,
            )
        market = None
        for price_row in ((product_price_map or {}).get(product_id) or {}).values():
            value = price_row.get("marketPrice")
            if isinstance(value, (int, float)) and not isinstance(value, bool) and value > 0:
                market = max(market or 0.0, float(value))
        results.append(Classification(
            product_id=product_id,
            category_id=category_id,
            group_id=int(group_id) if group_id is not None else None,
            game=game,
            language=language,
            decision=decision,
            card_id=card.id if card is not None else None,
            proposed_card_id=proposed_card_id(game, product_id) if decision == DECISION_CREATE else None,
            version_label=version_label,
            evidence={
                "name": product_row.get("name"),
                "number": raw_number or None,
                "rarity": raw_rarity or None,
                "class": klass,
                "reason": reason,
                "groupName": group_name,
                "mapping": mapping_how,
                "mappedSets": sets[:5],
                "candidates": [c.id for c in candidates[:5]],
                "marketPrice": market,
            },
        ))
        stats[decision] += 1
    return results, dict(stats)


def game_key(game: str, language: str) -> str:
    """Report/notes bucket: Pokémon splits by language (two TCGplayer categories)."""
    return f"{game}-jp" if language == "Japanese" else game


def persist_classifications(
    connection: sqlite3.Connection,
    classifications: list[Classification],
    claims: Mapping[str, set[str]],
    *,
    mode: str = MODE_SHADOW,
    now: str | None = None,
) -> None:
    """Upsert shadow rows (first_seen_at kept) and drop shadow rows whose product
    the catalog has since claimed. Rows under a REAL status are never touched."""
    if mode != MODE_SHADOW:
        raise NotImplementedError("P0 writes shadow classifications only")
    now = now or utc_now()
    existing = {
        str(product_id): str(status)
        for product_id, status in connection.execute(
            "SELECT product_id, status FROM tcgplayer_product_classifications"
        )
    }
    stale = [(pid,) for pid, status in existing.items() if pid in claims and status not in REAL_STATUSES]
    connection.executemany(
        "DELETE FROM tcgplayer_product_classifications WHERE product_id = ?", stale
    )
    connection.executemany(
        """
        INSERT INTO tcgplayer_product_classifications (
            product_id, category_id, group_id, game, status, card_id, proposed_card_id,
            version_label, evidence_json, first_seen_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(product_id) DO UPDATE SET
            category_id = excluded.category_id,
            group_id = excluded.group_id,
            game = excluded.game,
            status = excluded.status,
            card_id = excluded.card_id,
            proposed_card_id = excluded.proposed_card_id,
            version_label = excluded.version_label,
            evidence_json = excluded.evidence_json,
            updated_at = excluded.updated_at
        """,
        [
            (
                c.product_id, c.category_id, c.group_id, game_key(c.game, c.language),
                _SHADOW_STATUS[c.decision], c.card_id, c.proposed_card_id,
                c.version_label or None, json.dumps(c.evidence, sort_keys=True, ensure_ascii=False),
                now, now,
            )
            for c in classifications
            if existing.get(c.product_id) not in REAL_STATUSES
        ],
    )


def run_shadow_classification(
    connection: sqlite3.Connection,
    crawled_products: list[tuple[int, Mapping[str, Any], Mapping[str, Any]]],
    *,
    product_price_map: Mapping[str, Mapping[str, Mapping[str, Any]]] | None = None,
    extra_card_claims: Mapping[str, str] | None = None,
    overrides: Mapping[str, Mapping[str, Any]] | None = None,
    mode: str = MODE_SHADOW,
    now: str | None = None,
) -> dict[str, Any]:
    """Classify the crawl and persist shadow rows. Zero network; the caller commits.
    Returns {"counts": {game_key: {status: n}}, **classifier stats}."""
    if mode != MODE_SHADOW:
        raise NotImplementedError("P0 supports shadow mode only")
    index = load_catalog_index(connection)
    claims = load_claims(connection, extra_card_claims)
    classifications, stats = classify_products(
        crawled_products, index, claims,
        overrides=load_overrides() if overrides is None else overrides,
        product_price_map=product_price_map,
    )
    persist_classifications(connection, classifications, claims, mode=mode, now=now)
    counts: dict[str, Counter] = defaultdict(Counter)
    for c in classifications:
        counts[game_key(c.game, c.language)][_SHADOW_STATUS[c.decision]] += 1
    return {**stats, "counts": {game: dict(counter) for game, counter in counts.items()}}
