"""Era + promo classification for the sets list (`/api/v1/expansions`).

The Search sets list groups a game's sets under ERA headings (Scrydex
`series`: "Mega Evolution", "Scarlet & Violet", …), eras newest first, with
each era's promos after its main sets. This module decides, per set:

- whether it is listed at all (online-only / TCG Pocket sets are not),
- its `era` (string, or None for games with no series data),
- `isPromo`.

Pure functions over rows already read from `expansions`; the endpoint adds the
two fields to each record (additive — older app builds ignore them).
"""

from __future__ import annotations

import json
import re
from typing import Any, Iterable, Mapping

# Digital-only sets. Narrow on purpose: Scrydex's own flag, or the Pocket series
# by exact name (covers rows whose payload predates the flag).
ONLINE_ONLY_SERIES = frozenset({"Pokémon TCG Pocket"})

# Scrydex series values that are a catch-all bucket, not an era ("Other" holds
# McDonald's Collections, TCG Classic, …). Such sets get an era by date, the
# same way TCGplayer-only groups do.
NON_ERA_SERIES = frozenset({"other"})

# Promo-by-name rule. Conservative: only names that SAY promo.
#   - "promo" anywhere: "SV Black Star Promos", "Promotional Cards", "Promotion Cards"
#   - "Black Star" (WotC/TPCi promo line)
#   - "McDonald's" (McDonald's Collection / Promos)
# Deliberately NOT matched: "Trainer Kit", "Starter Deck", "Release Event",
# "Battle Academy" — real products whose cards are not promos.
PROMO_NAME_PATTERN = re.compile(r"promo|black\s*star|mcdonald", re.IGNORECASE)

TCGPLAYER_ONLY_SOURCE_PROVIDER = "tcgplayer"
TCGPLAYER_GROUP_ID_MARKER = "tcgplayer-group-"


def parse_payload(raw: Any) -> dict[str, Any]:
    if isinstance(raw, Mapping):
        return dict(raw)
    if not raw:
        return {}
    try:
        value = json.loads(raw)
    except (TypeError, ValueError):
        return {}
    return value if isinstance(value, dict) else {}


def is_online_only(series: Any, payload: Mapping[str, Any]) -> bool:
    return payload.get("is_online_only") is True or str(series or "").strip() in ONLINE_ONLY_SERIES


def is_tcgplayer_only(expansion_id: Any, source_provider: Any) -> bool:
    return (
        str(source_provider or "") == TCGPLAYER_ONLY_SOURCE_PROVIDER
        or TCGPLAYER_GROUP_ID_MARKER in str(expansion_id or "")
    )


def era_series(series: Any) -> str | None:
    """The series as an era name, or None when it is absent or a catch-all."""
    text = str(series or "").strip()
    if not text or text.casefold() in NON_ERA_SERIES:
        return None
    return text


def classify_expansions(
    expansions: Iterable[dict[str, Any]],
    meta_by_id: Mapping[str, Mapping[str, Any]],
) -> list[dict[str, Any]]:
    """Drop online-only sets and add `era` + `isPromo` to the rest, order kept.

    `expansions` are the endpoint's records (`id`, `name`, `series`,
    `language`, `releaseDate`, …) for ONE game. `meta_by_id` carries each row's
    `source_provider` and parsed `payload` (missing ids are treated as plain
    Scrydex rows).

    Promo: TCGplayer-only group (only in games that HAVE eras — elsewhere those
    groups are often the real sets Scrydex lacks, e.g. One Piece "Romance
    Dawn"), or a promo-ish name (PROMO_NAME_PATTERN).

    Era: the set's own series when it is a real era. Otherwise (TCGplayer-only,
    series "Other", no series) the era of the most recent MAIN set with a real
    series released on or before it, same language; none earlier → the oldest
    era. A game with no real series anywhere gets `era = None` throughout.
    """
    rows: list[dict[str, Any]] = []
    for expansion in expansions:
        meta = meta_by_id.get(str(expansion.get("id") or "")) or {}
        payload = parse_payload(meta.get("payload"))
        if is_online_only(expansion.get("series"), payload):
            continue
        rows.append(dict(expansion))

    game_has_eras = any(era_series(row.get("series")) for row in rows)

    for row in rows:
        meta = meta_by_id.get(str(row.get("id") or "")) or {}
        tcgplayer_only = is_tcgplayer_only(row.get("id"), meta.get("source_provider"))
        row["isPromo"] = bool(
            (game_has_eras and tcgplayer_only) or PROMO_NAME_PATTERN.search(str(row.get("name") or ""))
        )

    if not game_has_eras:
        for row in rows:
            row["era"] = None
        return rows

    # Era anchors: main sets with a real series, per language, oldest first.
    anchors: dict[str, list[tuple[str, str]]] = {}
    all_anchors: list[tuple[str, str]] = []
    for row in rows:
        era = era_series(row.get("series"))
        date = str(row.get("releaseDate") or "")
        if era and not row["isPromo"] and date:
            anchors.setdefault(_language_key(row), []).append((date, era))
            all_anchors.append((date, era))
    for values in anchors.values():
        values.sort()
    all_anchors.sort()

    for row in rows:
        own = era_series(row.get("series"))
        if own:
            row["era"] = own
            continue
        candidates = anchors.get(_language_key(row)) or all_anchors
        row["era"] = _era_on_or_before(candidates, str(row.get("releaseDate") or ""))
    return rows


def _language_key(row: Mapping[str, Any]) -> str:
    return str(row.get("language") or "").strip().casefold()


def _era_on_or_before(anchors: list[tuple[str, str]], date: str) -> str | None:
    """Era of the latest anchor dated <= `date`; the oldest era otherwise.

    Dates compare as strings: every source here writes `YYYY/MM/DD`.
    """
    if not anchors:
        return None
    chosen = anchors[0][1]
    if not date:
        return chosen
    for anchor_date, era in anchors:
        if anchor_date <= date:
            chosen = era
        else:
            break
    return chosen
