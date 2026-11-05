"""Search cards by what is in the picture (card art knowledge graph, Phase 1).

Reads the tables written offline by ``tools/tag_card_art.py``
(``card_art_groups`` / ``card_art_group_members`` / ``card_art_tags``) plus the
catalog. DB-only: never touches a provider, never refreshes pricing.

Only cards that belong to a tagged art group are searchable here; the regular
``/api/v1/cards/search`` is untouched.
"""

from __future__ import annotations

import base64
import hashlib
import json
import re
import sqlite3
import unicodedata
from typing import Any, Iterable

from catalog_tools import RARITY_BUCKET_KEYS, rarity_bucket
from similar_cards import base_name_key

VOCAB_VERSION = "v1.1"
GAME_POKEMON = "pokemon"
# Tags below this are stored (for review) but never match a search.
MIN_CONFIDENCE = 0.6
MAX_LIMIT = 50

PALETTE_COLORS: dict[str, tuple[int, int, int]] = {
    "black": (20, 20, 20),
    "white": (245, 245, 245),
    "gray": (128, 128, 128),
    "red": (210, 40, 40),
    "orange": (240, 140, 30),
    "yellow": (245, 215, 50),
    "gold": (200, 160, 60),
    "brown": (120, 75, 40),
    "beige": (225, 200, 160),
    "green": (60, 160, 60),
    "teal": (30, 150, 150),
    "light_blue": (140, 200, 240),
    "blue": (40, 80, 200),
    "navy": (25, 35, 90),
    "purple": (130, 60, 170),
    "pink": (240, 150, 190),
}

ART_FACETS: dict[str, tuple[str, ...]] = {
    "scene": (
        "beach", "ocean_underwater", "river_lake", "forest", "jungle", "field_meadow",
        "flowers_garden", "mountain", "cave", "desert", "snow_ice", "volcano",
        "sky_clouds", "space_stars", "city_street", "town_village", "indoor_home",
        "bedroom", "kitchen_food", "restaurant_cafe", "shop_market", "school_library",
        "lab", "stadium_arena", "festival_fair", "ruins_temple", "abstract_background",
        "other",
    ),
    "weather_time": (
        "day", "sunset_sunrise", "night", "rain", "snow", "storm", "fog", "rainbow",
        "none_visible",
    ),
    "activity": (
        "sleeping", "eating", "cooking", "playing", "swimming", "flying", "running",
        "battling", "posing", "reading", "celebrating", "resting", "hugging_group",
        "hiding", "other",
    ),
    "mood": (
        "cozy", "cute", "funny", "dramatic", "fierce", "peaceful", "spooky",
        "melancholy", "festive", "majestic", "cheerful", "adventurous",
    ),
    "objects": (
        "food", "drinks", "sweets", "umbrella", "books", "toys", "balloons", "flowers",
        "gifts", "lanterns", "pokeballs", "instruments", "vehicles", "furniture",
        "bed_pillow", "tableware", "trees", "rocks", "water_splash",
        # v1.1: gaps found while drafting the gold set (objects "other" on 58/127 cards).
        "energy_effects", "crystals_gems", "plants", "items_medicine", "lights_lamps",
        "containers", "paper_signs", "gym_equipment", "coins_treasure", "weapons",
        "other",
    ),
    "art_style": (
        "painterly", "watercolor", "pencil_sketch", "anime_cel", "cgi_3d", "papercraft",
        "clay_model", "pixel", "graphic_flat", "photo_composite", "mixed",
    ),
    "composition": (
        "full_art_scene", "framed_window", "character_closeup", "panorama",
        "group_shot", "text_heavy",
    ),
    "palette": tuple(PALETTE_COLORS),
}

POKEMON_ROLES = ("main", "secondary", "background", "cameo")
# Facets the HTTP/filter layer accepts as lists (palette included: computed locally).
LIST_FILTER_FACETS = ("scene", "weather_time", "activity", "mood", "art_style", "palette")
SORTS = ("relevance", "price_asc", "price_desc", "newest")
OWNED_MODES = ("any", "owned", "not_owned")
LANGUAGES = {"english": "English", "japanese": "Japanese", "any": None}
POKEMON_ROLE_FILTERS = ("any", "main", "background_or_cameo")

THEME_LABELS = {
    "beach_day": "Beach day",
    "rainy_day": "Rainy day",
    "cozy_home": "Cozy at home",
    "food": "Food",
    "night_sky": "Night sky",
    "festival": "Festival",
    "snow_day": "Snow day",
    "sleepy": "Sleepy",
}

# Free-text word -> (facet, value). Every vocab value and its underscore parts
# are added below; these cover everyday spellings.
_TEXT_SYNONYMS: dict[str, tuple[tuple[str, str], ...]] = {
    "rainy": (("weather_time", "rain"),),
    "raining": (("weather_time", "rain"),),
    "snowy": (("weather_time", "snow"), ("scene", "snow_ice")),
    "snowing": (("weather_time", "snow"),),
    "winter": (("weather_time", "snow"), ("scene", "snow_ice")),
    "ice": (("scene", "snow_ice"),),
    "sleep": (("activity", "sleeping"),),
    "asleep": (("activity", "sleeping"),),
    "sleepy": (("activity", "sleeping"),),
    "nap": (("activity", "sleeping"),),
    "napping": (("activity", "sleeping"),),
    "eat": (("activity", "eating"),),
    "cook": (("activity", "cooking"),),
    "swim": (("activity", "swimming"),),
    "fly": (("activity", "flying"),),
    "sunset": (("weather_time", "sunset_sunrise"),),
    "sunrise": (("weather_time", "sunset_sunrise"),),
    "stars": (("scene", "space_stars"),),
    "starry": (("scene", "space_stars"), ("weather_time", "night")),
    "underwater": (("scene", "ocean_underwater"),),
    "sea": (("scene", "ocean_underwater"),),
    "lake": (("scene", "river_lake"),),
    "river": (("scene", "river_lake"),),
    "garden": (("scene", "flowers_garden"),),
    "cafe": (("scene", "restaurant_cafe"),),
    "library": (("scene", "school_library"),),
    "festival": (("scene", "festival_fair"), ("mood", "festive")),
    "spooky": (("mood", "spooky"),),
    "halloween": (("mood", "spooky"),),
    "christmas": (("mood", "festive"),),
}
_TEXT_STOPWORDS = {"a", "an", "the", "in", "on", "at", "of", "with", "and", "is", "card", "cards", "pokemon"}


class ArtFilterError(ValueError):
    """A filter value outside the vocabulary; the message lists valid values."""


# --- vocab helpers ------------------------------------------------------------


def _norm_text(value: Any) -> str:
    return unicodedata.normalize("NFKC", str(value or "")).strip().casefold()


def _build_text_index() -> dict[str, tuple[tuple[str, str], ...]]:
    index: dict[str, list[tuple[str, str]]] = {}
    for facet, values in ART_FACETS.items():
        for value in values:
            if value in {"other", "none_visible", "mixed"}:
                continue
            keys = {value, *value.split("_")}
            for key in keys:
                if len(key) >= 3 and key not in _TEXT_STOPWORDS:
                    index.setdefault(key, []).append((facet, value))
    for word, pairs in _TEXT_SYNONYMS.items():
        index.setdefault(word, []).extend(pairs)
    return {key: tuple(dict.fromkeys(pairs)) for key, pairs in index.items()}


_TEXT_INDEX = _build_text_index()


def validate_facet_values(facet: str, values: Iterable[Any]) -> list[str]:
    allowed = ART_FACETS.get(facet)
    if allowed is None:
        raise ArtFilterError(f"unknown facet {facet!r}; valid facets: {', '.join(ART_FACETS)}")
    out: list[str] = []
    for raw in values:
        value = _norm_text(raw)
        if not value:
            continue
        if value not in allowed:
            raise ArtFilterError(
                f"unknown {facet} value {raw!r}; valid values: {', '.join(allowed)}"
            )
        out.append(value)
    return list(dict.fromkeys(out))


def _as_list(value: Any) -> list[Any]:
    if value is None:
        return []
    if isinstance(value, (list, tuple, set)):
        return list(value)
    return [part for part in str(value).split(",")]


# --- pokemon names ------------------------------------------------------------


_NAME_INDEX_CACHE: dict[tuple[str, int], dict[str, int]] = {}


def pokemon_name_index(conn: sqlite3.Connection) -> dict[str, int]:
    """Cached per (database file, Pokémon card count): a request-time read must
    not rescan the catalog on every text search."""
    try:
        db_file = str(conn.execute("PRAGMA database_list").fetchone()[2] or "")
    except (sqlite3.Error, TypeError, IndexError):
        db_file = ""
    count = int(conn.execute("SELECT COUNT(*) FROM cards WHERE game = ?", (GAME_POKEMON,)).fetchone()[0])
    key = (db_file, count)
    if db_file and key in _NAME_INDEX_CACHE:
        return _NAME_INDEX_CACHE[key]
    index = build_pokemon_name_index(conn)
    if db_file:
        _NAME_INDEX_CACHE.clear()
        _NAME_INDEX_CACHE[key] = index
    return index


def build_pokemon_name_index(conn: sqlite3.Connection) -> dict[str, int]:
    """base-name key -> national dex number, from single-dex Pokémon cards in
    the catalog (majority vote per name). Never invents a name."""
    votes: dict[str, dict[int, int]] = {}
    rows = conn.execute(
        "SELECT name, supertype, national_pokedex_numbers_json FROM cards "
        "WHERE game = ? AND national_pokedex_numbers_json NOT IN ('', '[]')",
        (GAME_POKEMON,),
    ).fetchall()
    for name, supertype, dex_json in rows:
        try:
            dex = json.loads(dex_json or "[]")
        except (TypeError, ValueError):
            continue
        if not isinstance(dex, list) or len(dex) != 1 or not isinstance(dex[0], int):
            continue
        key = base_name_key(name, game=GAME_POKEMON, supertype=supertype)
        if key:
            bucket = votes.setdefault(key, {})
            bucket[dex[0]] = bucket.get(dex[0], 0) + 1
    return {key: max(counts.items(), key=lambda item: (item[1], -item[0]))[0] for key, counts in votes.items()}


def resolve_pokemon_name(name: Any, index: dict[str, int]) -> int | None:
    text = unicodedata.normalize("NFKC", str(name or "")).strip()
    if not text:
        return None
    for key in (base_name_key(text, game=GAME_POKEMON), text.casefold()):
        if key in index:
            return index[key]
    return None


# --- price (USD only) ---------------------------------------------------------

# Same stored headline the catalog shows: TCGCSV main lane (already USD), else
# the Scrydex default only when that snapshot is USD. JPY-only rows count as
# unpriced; nothing here converts or refreshes.
_PRICE_USD_SQL = (
    "COALESCE(p.main_raw_market_price, "
    "CASE WHEN UPPER(p.display_currency_code) = 'USD' THEN p.default_raw_market_price END)"
)


# --- cursor -------------------------------------------------------------------


def _filter_fingerprint(card_filter: dict, owned_mode: str, sort: str) -> str:
    blob = json.dumps({"f": card_filter, "o": owned_mode, "s": sort}, sort_keys=True, default=str)
    return hashlib.sha1(blob.encode("utf-8")).hexdigest()[:12]


def _encode_cursor(offset: int, fingerprint: str) -> str:
    raw = json.dumps({"o": offset, "h": fingerprint}, separators=(",", ":")).encode("utf-8")
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _decode_cursor(cursor: str, fingerprint: str) -> int:
    try:
        padded = cursor + "=" * (-len(cursor) % 4)
        payload = json.loads(base64.urlsafe_b64decode(padded.encode("ascii")))
        offset = int(payload["o"])
        fp = str(payload["h"])
    except Exception as error:  # noqa: BLE001
        raise ArtFilterError("invalid cursor") from error
    if fp != fingerprint or offset < 0:
        raise ArtFilterError("cursor does not match this filter/sort")
    return offset


# --- query building -----------------------------------------------------------


class _Query:
    def __init__(self) -> None:
        self.where: list[str] = []
        self.params: list[Any] = []
        self.score_terms: list[str] = []
        self.score_params: list[Any] = []

    def tag_exists(self, pairs: Iterable[tuple[str, str]], *, roles: tuple[str, ...] | None = None) -> tuple[str, list[Any]]:
        pairs = list(pairs)
        clause = " OR ".join("(t.facet = ? AND t.value = ?)" for _ in pairs)
        params: list[Any] = [x for pair in pairs for x in pair]
        role_sql = ""
        if roles:
            role_sql = f" AND t.role IN ({','.join('?' for _ in roles)})"
            params.extend(roles)
        sql = (
            "SELECT MAX(t.confidence) FROM card_art_tags t WHERE t.art_group_id = m.art_group_id "
            f"AND t.confidence >= {MIN_CONFIDENCE} AND ({clause}){role_sql}"
        )
        return sql, params

    def add_tag_filter(self, pairs: list[tuple[str, str]], **kwargs: Any) -> None:
        sql, params = self.tag_exists(pairs, **kwargs)
        self.where.append(f"({sql}) IS NOT NULL")
        self.params.extend(params)
        self.score_terms.append(f"COALESCE(({sql}), 0)")
        self.score_params.extend(params)


def _main_dex_sql() -> str:
    return "EXISTS (SELECT 1 FROM json_each(c.national_pokedex_numbers_json) j WHERE j.value = ?)"


def _pokemon_clause(q: _Query, dex: int, role_filter: str) -> None:
    dex_value = str(dex)
    if role_filter == "background_or_cameo":
        sql, params = q.tag_exists([("pokemon", dex_value)], roles=("background", "cameo"))
        q.where.append(f"(({sql}) IS NOT NULL AND NOT {_main_dex_sql()})")
        q.params.extend([*params, dex])
        q.score_terms.append(f"COALESCE(({sql}), 0)")
        q.score_params.extend(params)
        return
    roles = ("main",) if role_filter == "main" else None
    sql, params = q.tag_exists([("pokemon", dex_value)], roles=roles)
    q.where.append(f"({_main_dex_sql()} OR ({sql}) IS NOT NULL)")
    q.params.extend([dex, *params])
    q.score_terms.append(f"(CASE WHEN {_main_dex_sql()} THEN 1.0 ELSE COALESCE(({sql}), 0) END)")
    q.score_params.extend([dex, *params])


def _resolve_pokemon_filter(conn: sqlite3.Connection, values: list[Any]) -> list[int]:
    dexes: list[int] = []
    index: dict[str, int] | None = None
    for raw in values:
        text = str(raw).strip()
        if not text:
            continue
        if text.isdigit():
            dexes.append(int(text))
            continue
        if index is None:
            index = pokemon_name_index(conn)
        dex = resolve_pokemon_name(text, index)
        # Unknown names match nothing rather than erroring: user-typed input.
        dexes.append(dex if dex is not None else -1)
    return list(dict.fromkeys(dexes))


def _text_clause(conn: sqlite3.Connection, q: _Query, text: str) -> None:
    words = [w for w in re.findall(r"[\w']+", _norm_text(text)) if w not in _TEXT_STOPWORDS]
    if not words:
        return
    index: dict[str, int] | None = None
    i = 0
    while i < len(words):
        word = words[i]
        # Two-word Pokémon names ("mr mime", "tapu koko").
        if index is None:
            index = pokemon_name_index(conn)
        if i + 1 < len(words) and f"{word} {words[i + 1]}" in index:
            _pokemon_clause(q, index[f"{word} {words[i + 1]}"], "any")
            i += 2
            continue
        if word in index:
            _pokemon_clause(q, index[word], "any")
            i += 1
            continue
        like = f"%{word}%"
        pairs = list(_TEXT_INDEX.get(word, ()))
        alts = ["g.alt_text LIKE ?", "c.name LIKE ?", "c.artist LIKE ?"]
        alt_params: list[Any] = [like, like, like]
        if pairs:
            sql, params = q.tag_exists(pairs)
            q.where.append(f"(({sql}) IS NOT NULL OR {' OR '.join(alts)})")
            q.params.extend([*params, *alt_params])
            q.score_terms.append(f"COALESCE(({sql}), CASE WHEN g.alt_text LIKE ? THEN 0.3 ELSE 0.1 END)")
            q.score_params.extend([*params, like])
        else:
            q.where.append(f"({' OR '.join(alts)})")
            q.params.extend(alt_params)
            q.score_terms.append("(CASE WHEN g.alt_text LIKE ? THEN 0.3 ELSE 0.1 END)")
            q.score_params.append(like)
        i += 1


def _rarity_labels(conn: sqlite3.Connection, buckets: list[str]) -> list[str]:
    rows = conn.execute("SELECT DISTINCT rarity FROM cards WHERE game = ?", (GAME_POKEMON,)).fetchall()
    return [str(r[0]) for r in rows if rarity_bucket(r[0], GAME_POKEMON) in buckets]


def _build_query(conn: sqlite3.Connection, card_filter: dict, owned_card_ids: set[str] | None, owned_mode: str) -> _Query:
    q = _Query()
    q.where.append("c.game = ?")
    q.params.append(GAME_POKEMON)

    unknown = set(card_filter) - {
        "text", "pokemon", "pokemon_role", "artist", "scene", "weather_time", "activity",
        "mood", "art_style", "palette", "theme", "set", "rarity_bucket", "language",
        "price_min_usd", "price_max_usd",
    }
    if unknown:
        raise ArtFilterError(f"unknown filter keys: {', '.join(sorted(unknown))}")

    text = str(card_filter.get("text") or "").strip()
    if text:
        _text_clause(conn, q, text)

    role_filter = _norm_text(card_filter.get("pokemon_role") or "any")
    if role_filter not in POKEMON_ROLE_FILTERS:
        raise ArtFilterError(f"unknown pokemon_role {role_filter!r}; valid values: {', '.join(POKEMON_ROLE_FILTERS)}")
    pokemon_values = _as_list(card_filter.get("pokemon"))
    if pokemon_values:
        dexes = _resolve_pokemon_filter(conn, pokemon_values)
        # Several Pokémon = all of them in the picture.
        for dex in dexes:
            _pokemon_clause(q, dex, role_filter)

    for facet in LIST_FILTER_FACETS:
        values = validate_facet_values(facet, _as_list(card_filter.get(facet)))
        if values:
            q.add_tag_filter([(facet, v) for v in values])

    theme = _norm_text(card_filter.get("theme"))
    if theme:
        pairs = [
            (str(r[0]), str(r[1]))
            for r in conn.execute("SELECT facet, value FROM art_themes WHERE theme = ?", (theme,)).fetchall()
        ]
        if not pairs:
            valid = [str(r[0]) for r in conn.execute("SELECT DISTINCT theme FROM art_themes ORDER BY theme")]
            raise ArtFilterError(f"unknown theme {theme!r}; valid values: {', '.join(valid)}")
        q.add_tag_filter(pairs)

    artist = str(card_filter.get("artist") or "").strip()
    if artist:
        q.where.append("c.artist LIKE ?")
        q.params.append(f"%{artist}%")

    set_value = str(card_filter.get("set") or "").strip()
    if set_value:
        q.where.append("(c.set_id = ? OR c.set_name = ? COLLATE NOCASE)")
        q.params.extend([set_value, set_value])

    buckets = [_norm_text(b) for b in _as_list(card_filter.get("rarity_bucket")) if _norm_text(b)]
    if buckets:
        bad = [b for b in buckets if b not in RARITY_BUCKET_KEYS]
        if bad:
            raise ArtFilterError(f"unknown rarity_bucket {bad[0]!r}; valid values: {', '.join(RARITY_BUCKET_KEYS)}")
        labels = _rarity_labels(conn, buckets)
        q.where.append(f"c.rarity IN ({','.join('?' for _ in labels)})" if labels else "0")
        q.params.extend(labels)

    language_key = _norm_text(card_filter.get("language") or "any")
    if language_key not in LANGUAGES:
        raise ArtFilterError(f"unknown language {language_key!r}; valid values: English, Japanese, any")
    if LANGUAGES[language_key]:
        q.where.append("c.language = ?")
        q.params.append(LANGUAGES[language_key])

    for key, op in (("price_min_usd", ">="), ("price_max_usd", "<=")):
        raw = card_filter.get(key)
        if raw is None or raw == "":
            continue
        try:
            bound = float(raw)
        except (TypeError, ValueError) as error:
            raise ArtFilterError(f"{key} must be a number") from error
        q.where.append(f"{_PRICE_USD_SQL} {op} ?")
        q.params.append(bound)

    if owned_mode not in OWNED_MODES:
        raise ArtFilterError(f"unknown owned_mode {owned_mode!r}; valid values: {', '.join(OWNED_MODES)}")
    if owned_mode != "any":
        owned_json = json.dumps(sorted(owned_card_ids or ()))
        negate = "NOT " if owned_mode == "not_owned" else ""
        q.where.append(f"c.id {negate}IN (SELECT value FROM json_each(?))")
        q.params.append(owned_json)
    return q


_ORDER_BY = {
    "relevance": "score DESC, c.id ASC",
    "price_asc": "price_usd IS NULL, price_usd ASC, c.id ASC",
    "price_desc": "price_usd IS NULL, price_usd DESC, c.id ASC",
    "newest": "c.set_release_date IS NULL, c.set_release_date DESC, c.id ASC",
}


def search_card_ids(
    conn: sqlite3.Connection,
    card_filter: dict,
    *,
    owned_card_ids: set[str] | None = None,
    owned_mode: str = "any",
    sort: str = "relevance",
    limit: int = 20,
    cursor: str | None = None,
) -> dict:
    """{"card_ids", "next_cursor", "total_estimate"}; see module doc."""
    card_filter = dict(card_filter or {})
    if sort not in SORTS:
        raise ArtFilterError(f"unknown sort {sort!r}; valid values: {', '.join(SORTS)}")
    try:
        limit = int(limit)
    except (TypeError, ValueError):
        limit = 20
    limit = max(1, min(MAX_LIMIT, limit))
    fingerprint = _filter_fingerprint(card_filter, owned_mode, sort)
    offset = _decode_cursor(cursor, fingerprint) if cursor else 0

    q = _build_query(conn, card_filter, owned_card_ids, owned_mode)
    score_sql = " + ".join(q.score_terms) if q.score_terms else "0"
    from_sql = (
        "FROM cards c "
        "JOIN card_art_group_members m ON m.card_id = c.id "
        "JOIN card_art_groups g ON g.art_group_id = m.art_group_id "
        "LEFT JOIN card_price_snapshots p ON p.card_id = c.id "
        f"WHERE {' AND '.join(q.where)}"
    )
    total = int(conn.execute(f"SELECT COUNT(*) {from_sql}", q.params).fetchone()[0])
    rows = conn.execute(
        f"SELECT c.id, ({score_sql}) AS score, {_PRICE_USD_SQL} AS price_usd {from_sql} "
        f"ORDER BY {_ORDER_BY[sort]} LIMIT ? OFFSET ?",
        [*q.score_params, *q.params, limit, offset],
    ).fetchall()
    card_ids = [str(row[0]) for row in rows]
    next_offset = offset + len(card_ids)
    next_cursor = _encode_cursor(next_offset, fingerprint) if next_offset < total and card_ids else None
    return {"card_ids": card_ids, "next_cursor": next_cursor, "total_estimate": total}


def list_facets(conn: sqlite3.Connection, *, game: str = GAME_POKEMON) -> dict:
    """{"facets": {facet: [{"value", "count"}]}, "themes": [{"id", "label", "count"}]}.
    Counts are art groups with a confident tag; zero-count values are omitted."""
    facets: dict[str, list[dict[str, Any]]] = {facet: [] for facet in ART_FACETS}
    themes: list[dict[str, Any]] = []
    if _norm_text(game) != GAME_POKEMON:
        return {"facets": facets, "themes": themes}
    rows = conn.execute(
        "SELECT t.facet, t.value, COUNT(DISTINCT t.art_group_id) FROM card_art_tags t "
        "JOIN card_art_groups g ON g.art_group_id = t.art_group_id "
        "JOIN cards c ON c.id = g.representative_card_id "
        f"WHERE c.game = ? AND t.confidence >= {MIN_CONFIDENCE} GROUP BY t.facet, t.value",
        (GAME_POKEMON,),
    ).fetchall()
    for facet, value, count in rows:
        if facet in ART_FACETS and value in ART_FACETS[facet]:
            facets[facet].append({"value": value, "count": int(count)})
    for facet in facets:
        order = {v: i for i, v in enumerate(ART_FACETS[facet])}
        facets[facet].sort(key=lambda item: (-item["count"], order[item["value"]]))
    theme_rows = conn.execute(
        "SELECT th.theme, COUNT(DISTINCT t.art_group_id) FROM art_themes th "
        "LEFT JOIN card_art_tags t ON t.facet = th.facet AND t.value = th.value "
        f"AND t.confidence >= {MIN_CONFIDENCE} GROUP BY th.theme ORDER BY th.theme"
    ).fetchall()
    for theme, count in theme_rows:
        themes.append({"id": theme, "label": THEME_LABELS.get(theme, theme.replace("_", " ").capitalize()), "count": int(count)})
    themes.sort(key=lambda item: (-item["count"], item["id"]))
    return {"facets": facets, "themes": themes}


def get_card_art(conn: sqlite3.Connection, card_id: str) -> dict | None:
    row = conn.execute(
        "SELECT g.art_group_id, g.tags_json, g.alt_text FROM card_art_group_members m "
        "JOIN card_art_groups g ON g.art_group_id = m.art_group_id WHERE m.card_id = ?",
        (card_id,),
    ).fetchone()
    if row is None:
        return None
    try:
        tags = json.loads(row[1] or "{}")
    except (TypeError, ValueError):
        tags = {}
    return {"tags": tags if isinstance(tags, dict) else {}, "alt_text": row[2], "art_group_id": str(row[0])}
