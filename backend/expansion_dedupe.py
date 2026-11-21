"""Read-time merge of TCGplayer-only group sets into their Scrydex twin.

tcgplayer_only_catalog.py files every card Scrydex does not list under a
synthetic set per TCGplayer group (`<game>~tcgplayer-group-<groupId>`), even
when that group IS a Scrydex set (One Piece "Romance Dawn" = group 3188). The
sets list then shows the set twice. Nothing is rewritten in the DB: readers
alias the group set onto the Scrydex one.

Pairing rule (deliberately narrow): a set whose bare id starts with
`tcgplayer-group-` pairs with the ONE non-TCGplayer set of the same game,
same language and same normalized name (case, accents, punctuation and
spacing ignored; no prefix stripping). Two Scrydex sets never pair, so
Japanese sets that legitimately share an official name stay apart, and a
group whose name matches several Scrydex sets stays unpaired.

A group card is dropped from the merged set when a canonical card has the
same normalized collector number AND the same normalized name (Scrydex added
the card after TCGplayer-only ingest created it); the canonical card wins.
"""

from __future__ import annotations

import re
import sqlite3
import unicodedata
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Any

from catalog_tools import TCGPLAYER_ONLY_SOURCE_PROVIDER, bare_catalog_id, normalize_game
from tcgcsv_adapter import normalized_card_number
from tcgplayer_only_catalog import normalize_name as normalize_card_name

TCGPLAYER_GROUP_SET_PREFIX = "tcgplayer-group-"


def is_tcgplayer_group_set_id(value: Any) -> bool:
    return bare_catalog_id(value).startswith(TCGPLAYER_GROUP_SET_PREFIX)


def normalize_set_name(value: Any) -> str:
    """"Romance Dawn" == "romance  dawn" == "Romance-Dawn"; unicode letters
    (Japanese names) are kept, unlike sealed_products.normalize_group_name."""
    text = unicodedata.normalize("NFKD", str(value or ""))
    text = "".join(ch for ch in text if not unicodedata.combining(ch)).casefold()
    text = text.replace("&", "and")
    return re.sub(r"[\W_]+", "", text)


@dataclass(frozen=True)
class ExpansionPairing:
    # {group set id: canonical Scrydex set id}
    alias: dict[str, str] = field(default_factory=dict)
    # {canonical set id: [group set id, ...]}
    groups_of: dict[str, list[str]] = field(default_factory=dict)
    # {dropped group card id: the canonical card it duplicates}
    duplicate_of: dict[str, str] = field(default_factory=dict)

    def canonical(self, set_id: Any) -> str:
        key = str(set_id or "").strip()
        return self.alias.get(key, key)

    def member_set_ids(self, set_id: Any) -> list[str]:
        """The canonical id first, then its paired groups."""
        canonical = self.canonical(set_id)
        return [canonical, *self.groups_of.get(canonical, [])]


EMPTY_PAIRING = ExpansionPairing()


def pair_expansions(rows: list[dict[str, Any]]) -> dict[str, str]:
    """{group set id: canonical set id} from expansion rows of ONE game
    (`id`, `name`, `language`, `source_provider`)."""
    canonical_by_key: dict[tuple[str, str], list[str]] = defaultdict(list)
    groups: list[tuple[str, tuple[str, str]]] = []
    for row in rows:
        set_id = str(row.get("id") or "").strip()
        name_key = normalize_set_name(row.get("name"))
        if not set_id or not name_key:
            continue
        key = (str(row.get("language") or "").strip().casefold(), name_key)
        if is_tcgplayer_group_set_id(set_id):
            groups.append((set_id, key))
        elif str(row.get("source_provider") or "") != TCGPLAYER_ONLY_SOURCE_PROVIDER:
            canonical_by_key[key].append(set_id)
    alias: dict[str, str] = {}
    for group_id, key in groups:
        candidates = canonical_by_key.get(key, [])
        if len(candidates) == 1:
            alias[group_id] = candidates[0]
    return alias


def _duplicate_key(number: Any, name: Any) -> tuple[str, str] | None:
    number_key = normalized_card_number(number)
    name_key = normalize_card_name(name)
    if not number_key or not name_key:
        return None
    return number_key, name_key


def build_expansion_pairing(connection: sqlite3.Connection, *, game: str) -> ExpansionPairing:
    normalized_game = normalize_game(game)
    rows = connection.execute(
        "SELECT id, name, language, source_provider FROM expansions WHERE +game = ?",
        (normalized_game,),
    ).fetchall()
    alias = pair_expansions([dict(row) for row in rows])
    if not alias:
        return EMPTY_PAIRING
    groups_of: dict[str, list[str]] = defaultdict(list)
    for group_id, canonical_id in sorted(alias.items()):
        groups_of[canonical_id].append(group_id)
    duplicate_of: dict[str, str] = {}
    for canonical_id, group_ids in groups_of.items():
        canonical_cards: dict[tuple[str, str], str] = {}
        for row in connection.execute(
            "SELECT id, number, name FROM cards WHERE set_id = ? AND +game = ? ORDER BY id",
            (canonical_id, normalized_game),
        ):
            key = _duplicate_key(row["number"], row["name"])
            if key is not None:
                canonical_cards.setdefault(key, str(row["id"]))
        for group_id in group_ids:
            for row in connection.execute(
                "SELECT id, number, name FROM cards WHERE set_id = ? AND +game = ?",
                (group_id, normalized_game),
            ):
                key = _duplicate_key(row["number"], row["name"])
                twin = canonical_cards.get(key) if key is not None else None
                if twin is not None:
                    duplicate_of[str(row["id"])] = twin
    return ExpansionPairing(alias=alias, groups_of=dict(groups_of), duplicate_of=duplicate_of)
