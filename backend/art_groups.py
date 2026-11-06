"""Art groups: one entry per distinct ILLUSTRATION, so each artwork is tagged once.

Rules (conservative: when unsure, cards stay in their own group):

- EN↔JP pairs from ``card_language_links`` share a group.
- Same-art reprints share a group when ALL hold: same artist (non-empty), same
  normalised base name, and a ``card_similar`` score >= REPRINT_MIN_SCORE.
- Everything else is its own group.

The group id is the canonical member's card_id: an English card first, then the
earliest release, then the smallest id. Offline only; never imported by the
server. Groups are computed fresh each run and only persisted together with
their tags by ``tools/tag_card_art.py``.
"""

from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable

from catalog_tools import _table_exists
from similar_cards import base_name_key

GAME_POKEMON = "pokemon"
# card_similar is SigLIP2 cosine over art crops; near-identical art lands well
# above 0.9 while "same Pokémon, different pose" sits in the 0.8s.
REPRINT_MIN_SCORE = 0.95

LINK_SELF = "self"
LINK_LANGUAGE = "language_link"
LINK_REPRINT = "reprint_similar"


@dataclass(frozen=True)
class CardRow:
    card_id: str
    name: str
    language: str
    artist: str | None
    supertype: str | None
    set_release_date: str | None
    image_url: str | None


@dataclass
class ArtGroup:
    art_group_id: str
    representative_card_id: str
    members: dict[str, str] = field(default_factory=dict)  # card_id -> link_source

    def as_dict(self) -> dict[str, Any]:
        return {
            "art_group_id": self.art_group_id,
            "representative_card_id": self.representative_card_id,
            "members": dict(sorted(self.members.items())),
        }


class _UnionFind:
    def __init__(self, items: Iterable[str]) -> None:
        self.parent = {item: item for item in items}

    def find(self, item: str) -> str:
        root = item
        while self.parent[root] != root:
            root = self.parent[root]
        while self.parent[item] != root:
            self.parent[item], item = root, self.parent[item]
        return root

    def union(self, a: str, b: str) -> None:
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.parent[max(ra, rb)] = min(ra, rb)


def _artist_key(artist: str | None) -> str:
    return " ".join(str(artist or "").split()).casefold()


def is_reprint_pair(a: CardRow, b: CardRow, score: float) -> bool:
    if score < REPRINT_MIN_SCORE:
        return False
    artist = _artist_key(a.artist)
    if not artist or artist != _artist_key(b.artist):
        return False
    name_a = base_name_key(a.name, game=GAME_POKEMON, supertype=a.supertype)
    return bool(name_a) and name_a == base_name_key(b.name, game=GAME_POKEMON, supertype=b.supertype)


def _canonical_sort_key(card: CardRow) -> tuple:
    return (
        0 if card.language == "English" else 1,
        card.set_release_date or "9999",
        card.card_id,
    )


def build_art_groups(
    cards: Iterable[CardRow],
    language_links: Iterable[tuple[str, str]],
    similar_pairs: Iterable[tuple[str, str, float]],
) -> list[ArtGroup]:
    """Pure grouping step. Links/pairs naming unknown cards are ignored."""
    by_id = {card.card_id: card for card in cards}
    uf = _UnionFind(by_id)
    language_edges: set[frozenset[str]] = set()
    for card_id, counterpart in language_links:
        if card_id in by_id and counterpart in by_id and card_id != counterpart:
            uf.union(card_id, counterpart)
            language_edges.add(frozenset((card_id, counterpart)))
    for card_id, neighbour, score in similar_pairs:
        a, b = by_id.get(card_id), by_id.get(neighbour)
        if a is None or b is None or card_id == neighbour:
            continue
        if is_reprint_pair(a, b, float(score)):
            uf.union(card_id, neighbour)

    clusters: dict[str, list[CardRow]] = {}
    for card_id, card in by_id.items():
        clusters.setdefault(uf.find(card_id), []).append(card)

    groups: list[ArtGroup] = []
    for members in clusters.values():
        members.sort(key=_canonical_sort_key)
        canonical = members[0]
        representative = next((m for m in members if m.image_url), canonical)
        group = ArtGroup(art_group_id=canonical.card_id, representative_card_id=representative.card_id)
        member_ids = {m.card_id for m in members}
        for member in members:
            if member.card_id == canonical.card_id:
                group.members[member.card_id] = LINK_SELF
            elif any(frozenset((member.card_id, other)) in language_edges for other in member_ids):
                group.members[member.card_id] = LINK_LANGUAGE
            else:
                group.members[member.card_id] = LINK_REPRINT
        groups.append(group)
    groups.sort(key=lambda g: g.art_group_id)
    return groups


# --- DB loading -----------------------------------------------------------------


def load_cards(conn: sqlite3.Connection, *, game: str = GAME_POKEMON) -> list[CardRow]:
    rows = conn.execute(
        "SELECT id, name, language, artist, supertype, set_release_date, image_url "
        "FROM cards WHERE game = ?",
        (game,),
    ).fetchall()
    return [CardRow(str(r[0]), str(r[1] or ""), str(r[2] or ""), r[3], r[4], r[5], r[6]) for r in rows]


def load_language_links(conn: sqlite3.Connection) -> list[tuple[str, str]]:
    if not _table_exists(conn, "card_language_links"):
        return []
    return [(str(r[0]), str(r[1])) for r in conn.execute("SELECT card_id, counterpart_card_id FROM card_language_links")]


def load_similar_pairs(conn: sqlite3.Connection, *, game: str = GAME_POKEMON) -> list[tuple[str, str, float]]:
    if not _table_exists(conn, "card_similar"):
        return []
    rows = conn.execute(
        "SELECT card_id, neighbour_id, score FROM card_similar WHERE game = ? AND score >= ?",
        (game, REPRINT_MIN_SCORE),
    ).fetchall()
    return [(str(r[0]), str(r[1]), float(r[2])) for r in rows]


def compute_art_groups(conn: sqlite3.Connection, *, game: str = GAME_POKEMON) -> list[ArtGroup]:
    return build_art_groups(load_cards(conn, game=game), load_language_links(conn), load_similar_pairs(conn, game=game))


def summarize(groups: list[ArtGroup]) -> dict[str, Any]:
    sources = Counter(src for g in groups for src in g.members.values())
    sizes = Counter(len(g.members) for g in groups)
    return {
        "groups": len(groups),
        "cards": sum(len(g.members) for g in groups),
        "link_sources": dict(sources),
        "group_sizes": {str(k): v for k, v in sorted(sizes.items())},
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Compute card art groups (offline, read-only).")
    parser.add_argument("--database", required=True, help="Path to spotlight_scanner.sqlite")
    parser.add_argument("--out", help="Write groups as JSON to this path")
    args = parser.parse_args(argv)
    conn = sqlite3.connect(f"file:{Path(args.database).resolve()}?mode=ro", uri=True)
    try:
        groups = compute_art_groups(conn)
    finally:
        conn.close()
    print(json.dumps(summarize(groups), indent=2))
    if args.out:
        Path(args.out).write_text(json.dumps([g.as_dict() for g in groups], indent=1))
        print(f"wrote {len(groups)} groups to {args.out}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
