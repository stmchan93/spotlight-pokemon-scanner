"""Meta pulse: which GROUPS of cards are rising or cooling in price.

Plan: docs/meta-trends-news-feed-plan-2026-09-23.md ("How Meta pulse works").
Contract: the ``MetaPulse`` type in docs/meta-feed-api-contracts-2026-09-23.md.

Two halves, deliberately split so the request path never touches the price
history tables (the 27M-row cells table lesson):

- ``compute_meta_pulse`` — the nightly job. Pairs each card's price "then" vs
  "now" per window, tags it into groups (era, rarity bucket, language, grader +
  grade, PSA pop band), aggregates per group, and stores small result rows in
  ``meta_pulse_groups`` / ``meta_pulse_cards`` / ``meta_pulse_runs``.
- ``build_meta_pulse_payload`` — reads those tables and fills the headline
  template. No LLM.

Lanes:
- raw    = TCGCSV main-lane price (``card_price_history_daily.main_raw_*``),
           same printing at both ends (the ``market_movers`` pairing rule).
           Scrydex default-raw is NOT used: its flat JP anchors that jump once
           would read as group moves.
- graded = Scrydex graded cells (``card_price_history_cell`` lane 'graded'),
           paired per (card, grader, grade, printing); signed/perfect/error
           cells are excluded. Staging writes no graded cells, so the graded
           lane is simply empty there (summary fields come back null).

Group medians use only cards whose price moved in the window: slabs sell
rarely, so unchanged cards would pin the median at 0.
"""

from __future__ import annotations

import argparse
import json
import re
import sqlite3
import statistics
import sys
import time
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any, Callable, Iterable

from catalog_tools import (
    SUPPORTED_GAMES,
    _table_columns,
    _table_exists,
    normalize_game,
    rarity_bucket,
    runtime_setting,
    upsert_runtime_setting,
    utc_now,
)
from fx_rates import convert_price
from market_movers import (
    NOW_TOLERANCE_DAYS,
    THEN_TOLERANCE_DAYS,
    _jpy_usd_rate,
    _latest_row_per_card,
)

LANE_RAW = "raw"
LANE_GRADED = "graded"
LANES = (LANE_RAW, LANE_GRADED)
LANE_FILTERS = ("all", LANE_RAW, LANE_GRADED)

DEFAULT_WINDOWS = (7, 30, 90)
DEFAULT_GAME = "pokemon"
MIN_GROUP_CARDS = 8  # cards priced at both ends
MIN_MOVED_CARDS = 3  # a median of one or two sales is an anecdote
# Penny cards produce absurd percentages; applied to BOTH ends.
MIN_PRICE_USD = 2.0
# Outside this band a single pair is treated as a data glitch, not a move.
MAX_CHANGE_PCT = 1000.0
MIN_CHANGE_PCT = -90.0
# Medians inside +/- this band count as flat (neither rising nor cooling).
FLAT_BAND_PCT = 0.5
SPARK_POINTS = 30
TOP_CARDS = 5
RETENTION_DAYS = 14
RUN_SETTING_KEY = "meta_pulse_last_run"
SQL_CHUNK = 900  # under SQLite's default variable limit


# --- tagging ------------------------------------------------------------------


@dataclass(frozen=True)
class CardInfo:
    card_id: str
    game: str
    name: str
    number: str | None = None
    set_name: str | None = None
    image_url: str | None = None
    rarity: str | None = None
    language: str | None = None
    release_date: str | None = None


@dataclass(frozen=True)
class CardTags:
    game: str
    era: str | None
    rarity_bucket: str
    rarity: str  # lowercased raw label, for one-off rules
    language: str  # 'en' | 'jp' | other lowercase
    gold_star: bool


# (key, start inclusive, end exclusive) on ISO release dates.
ERA_RULES: tuple[tuple[str, str | None, str | None], ...] = (
    ("vintage", None, "2003-01-01"),
    ("ex_era", "2003-01-01", "2008-01-01"),
)

_GOLD_STAR_RARITY_RE = re.compile(r"\b(holo star|gold star)\b|^star$")


def normalize_release_date(value: Any) -> str | None:
    """'1999/01/09', '1999-01-09T..', '1999' → ISO 'YYYY-MM-DD' (None if unparseable)."""
    text = str(value or "").strip().replace("/", "-")
    match = re.match(r"^(\d{4})(?:-(\d{1,2})(?:-(\d{1,2}))?)?", text)
    if not match:
        return None
    year, month, day = match.group(1), match.group(2) or "1", match.group(3) or "1"
    try:
        return date(int(year), int(month), int(day)).isoformat()
    except ValueError:
        return None


def era_for_release_date(value: Any) -> str | None:
    iso = normalize_release_date(value)
    if iso is None:
        return None
    for key, start, end in ERA_RULES:
        if (start is None or iso >= start) and (end is None or iso < end):
            return key
    return None


def language_key(language: Any) -> str:
    text = str(language or "").strip().lower()
    if text.startswith("ja") or text in {"jp", "jpn"}:
        return "jp"
    if text.startswith("en") or not text:
        return "en"
    return text


def is_gold_star(name: Any, rarity: Any) -> bool:
    if "☆" in str(name or ""):
        return True
    return bool(_GOLD_STAR_RARITY_RE.search(re.sub(r"\s+", " ", str(rarity or "").strip().lower())))


def tag_card(info: CardInfo) -> CardTags:
    return CardTags(
        game=info.game,
        era=era_for_release_date(info.release_date),
        rarity_bucket=rarity_bucket(info.rarity, info.game),
        rarity=re.sub(r"\s+", " ", str(info.rarity or "").strip().lower()),
        language=language_key(info.language),
        gold_star=is_gold_star(info.name, info.rarity),
    )


def normalize_grader(value: Any) -> str:
    text = str(value or "").strip().upper()
    return "BGS" if text in {"BECKETT", "BGS"} else text


def normalize_grade(value: Any) -> str:
    text = str(value or "").strip()
    try:
        number = float(text)
    except ValueError:
        return text.upper()
    return str(int(number)) if number.is_integer() else f"{number:g}"


@dataclass(frozen=True)
class Segment:
    """A card-level group rule. Adding a group = adding one of these."""

    key: str
    label: str
    description: str
    predicate: Callable[[CardTags], bool]
    games: tuple[str, ...] | None = None
    lanes: tuple[str, ...] = LANES


@dataclass(frozen=True)
class SlabTier:
    """A graded-lane split applied under every segment that allows graded."""

    key: str
    label: str
    grader: str
    grade: str
    max_population: int | None = None
    games: tuple[str, ...] | None = None


SEGMENTS: tuple[Segment, ...] = (
    Segment("vintage", "Vintage", "pre-2003", lambda t: t.era == "vintage"),
    Segment("ex_era", "EX era", "2003–2007", lambda t: t.era == "ex_era", games=("pokemon",)),
    Segment("gold_star", "Gold Star ☆", "Gold Stars", lambda t: t.gold_star, games=("pokemon",)),
    Segment("sir", "Special Illustration Rare", "SIRs", lambda t: t.rarity_bucket == "sir"),
    Segment("illustration", "Illustration Rare", "illustration rares", lambda t: t.rarity_bucket == "illustration"),
    Segment("ultra", "Ultra rares", "ex / GX / V tier", lambda t: t.rarity_bucket == "ultra"),
    Segment("secret", "Secret rares", "secret / hyper rares", lambda t: t.rarity_bucket == "secret"),
    Segment("promo", "Promos", "promo cards", lambda t: t.rarity_bucket == "promo"),
    Segment(
        "jp_promo", "Japanese promos", "Japanese promo cards",
        lambda t: t.language == "jp" and t.rarity_bucket == "promo",
    ),
    Segment("japanese", "Japanese", "Japanese-language cards", lambda t: t.language == "jp"),
)

SLAB_TIERS: tuple[SlabTier, ...] = (
    SlabTier("psa10", "PSA 10", "PSA", "10"),
    SlabTier("psa9", "PSA 9", "PSA", "9"),
    SlabTier("cgc10", "CGC 10", "CGC", "10"),
    SlabTier("bgs9_5", "BGS 9.5", "BGS", "9.5"),
    # Pop counts are Pokémon-only (PPT/GemRate).
    SlabTier("psa10:pop_le_200", "PSA 10 · pop ≤ 200", "PSA", "10", max_population=200, games=("pokemon",)),
    SlabTier("psa10:pop_le_50", "PSA 10 · pop ≤ 50", "PSA", "10", max_population=50, games=("pokemon",)),
)


@dataclass(frozen=True)
class LadderRule:
    title: str
    rungs: tuple[tuple[str, str], ...]  # (rung label, group_key)


LADDERS: tuple[LadderRule, ...] = (
    LadderRule("Vintage: raw vs graded", (
        ("Raw NM", "vintage:raw"),
        ("PSA 9", "vintage:graded:psa9"),
        ("PSA 10", "vintage:graded:psa10"),
        ("PSA 10 · pop ≤ 50", "vintage:graded:psa10:pop_le_50"),
    )),
    LadderRule("Gold Star: raw vs graded", (
        ("Raw NM", "gold_star:raw"),
        ("PSA 9", "gold_star:graded:psa9"),
        ("PSA 10", "gold_star:graded:psa10"),
    )),
    LadderRule("SIRs: raw vs graded", (
        ("Raw NM", "sir:raw"),
        ("PSA 10", "sir:graded:psa10"),
    )),
)


def raw_group_key(segment: Segment) -> str:
    return f"{segment.key}:{LANE_RAW}"


def graded_group_key(segment: Segment, tier: SlabTier) -> str:
    return f"{segment.key}:{LANE_GRADED}:{tier.key}"


def _applies(games: tuple[str, ...] | None, game: str) -> bool:
    return games is None or game in games


def tier_matches(tier: SlabTier, *, game: str, grader: str, grade: str, population: int | None) -> bool:
    if not _applies(tier.games, game):
        return False
    if normalize_grader(grader) != tier.grader or normalize_grade(grade) != tier.grade:
        return False
    if tier.max_population is not None:
        return population is not None and 0 < population <= tier.max_population
    return True


@dataclass(frozen=True)
class GroupDef:
    key: str
    lane: str
    label: str
    segment: Segment
    tier: SlabTier | None = None


def group_defs_for(
    tags: CardTags, *, lane: str, grader: str | None = None, grade: str | None = None,
    population: int | None = None,
) -> list[GroupDef]:
    """Every group one priced item belongs to."""
    out: list[GroupDef] = []
    for segment in SEGMENTS:
        if lane not in segment.lanes or not _applies(segment.games, tags.game):
            continue
        if not segment.predicate(tags):
            continue
        if lane == LANE_RAW:
            out.append(GroupDef(raw_group_key(segment), LANE_RAW, segment.label, segment))
            continue
        for tier in SLAB_TIERS:
            if tier_matches(tier, game=tags.game, grader=grader or "", grade=grade or "", population=population):
                out.append(
                    GroupDef(graded_group_key(segment, tier), LANE_GRADED, f"{segment.label} {tier.label}", segment, tier)
                )
    return out


# --- pairing ------------------------------------------------------------------


@dataclass(frozen=True)
class PricePair:
    card_id: str
    game: str
    lane: str
    price_then: float  # USD
    price_now: float  # USD
    variant: str | None = None
    grader: str | None = None
    grade: str | None = None
    currency: str = "USD"  # source currency of both ends
    population: int | None = None

    @property
    def delta(self) -> float:
        return self.price_now - self.price_then

    @property
    def change_pct(self) -> float:
        return (self.price_now - self.price_then) / self.price_then * 100.0

    @property
    def moved(self) -> bool:
        return round(self.price_now, 2) != round(self.price_then, 2)

    @property
    def item_key(self) -> tuple[str, str | None, str | None, str | None]:
        return (self.card_id, self.grader, self.grade, self.variant)


def pair_is_eligible(pair: PricePair) -> bool:
    if pair.price_then < MIN_PRICE_USD or pair.price_now < MIN_PRICE_USD:
        return False
    return MIN_CHANGE_PCT <= pair.change_pct <= MAX_CHANGE_PCT


def raw_pairs(now_rows: dict, then_rows: dict, cards: dict[str, CardInfo]) -> list[PricePair]:
    """TCGCSV main-lane pairs: same printing at both ends, always USD."""
    out: list[PricePair] = []
    for card_id, now_row in now_rows.items():
        info = cards.get(card_id)
        then_row = then_rows.get(card_id)
        if info is None or then_row is None:
            continue
        if now_row.main_raw is None or then_row.main_raw is None:
            continue
        if now_row.main_variant != then_row.main_variant:
            continue
        pair = PricePair(
            card_id=card_id, game=info.game, lane=LANE_RAW,
            price_then=then_row.main_raw, price_now=now_row.main_raw, variant=now_row.main_variant,
        )
        if pair_is_eligible(pair):
            out.append(pair)
    return out


GradedKey = tuple[str, str, str, str]  # (card_id, grader, grade, variant_key)


def graded_pairs(
    now_items: dict[GradedKey, tuple[float, str]],
    then_items: dict[GradedKey, tuple[float, str]],
    cards: dict[str, CardInfo],
    populations: dict[str, dict[str, dict[str, int]]],
) -> list[PricePair]:
    out: list[PricePair] = []
    for key, (now_usd, now_currency) in now_items.items():
        then = then_items.get(key)
        info = cards.get(key[0])
        if then is None or info is None or then[1] != now_currency:
            continue
        card_id, grader, grade, variant = key
        pair = PricePair(
            card_id=card_id, game=info.game, lane=LANE_GRADED,
            price_then=then[0], price_now=now_usd, variant=variant, grader=grader, grade=grade,
            currency=now_currency,
            population=populations.get(card_id, {}).get(grader, {}).get(grade),
        )
        if pair_is_eligible(pair):
            out.append(pair)
    return out


# --- aggregation --------------------------------------------------------------


@dataclass
class GroupResult:
    game: str
    lane: str
    group_key: str
    segment_key: str
    label: str
    description: str
    median_change_pct: float
    value_now: float
    value_then: float
    card_count: int
    moved_card_count: int
    pairs: list[PricePair] = field(default_factory=list, repr=False)
    top_pairs: list[PricePair] = field(default_factory=list)
    spark_points: list[float] = field(default_factory=list)

    @property
    def value_change_usd(self) -> float:
        return self.value_now - self.value_then


@dataclass
class LaneTotals:
    paired: int = 0
    moved: int = 0
    value_now: float = 0.0
    value_then: float = 0.0


def top_contributors(pairs: Iterable[PricePair], *, rising: bool, limit: int = TOP_CARDS) -> list[PricePair]:
    """Biggest $ contributors in the group's own direction."""
    same_direction = [p for p in pairs if p.moved and ((p.delta > 0) if rising else (p.delta < 0))]
    same_direction.sort(key=lambda p: (-abs(p.delta), p.card_id, p.grader or "", p.grade or ""))
    return same_direction[:limit]


def aggregate_groups(
    pairs: Iterable[PricePair],
    tags_by_card: dict[str, CardTags],
    *,
    min_group_cards: int = MIN_GROUP_CARDS,
    min_moved_cards: int = MIN_MOVED_CARDS,
) -> tuple[list[GroupResult], dict[tuple[str, str], LaneTotals]]:
    """Per-group median-of-moved, value sums and top cards, plus per
    (game, lane) totals over every eligible pair (the payload summary)."""
    members: dict[tuple[str, str], list[PricePair]] = {}
    defs: dict[tuple[str, str], GroupDef] = {}
    totals: dict[tuple[str, str], LaneTotals] = {}
    for pair in pairs:
        tags = tags_by_card.get(pair.card_id)
        if tags is None:
            continue
        lane_total = totals.setdefault((pair.game, pair.lane), LaneTotals())
        lane_total.paired += 1
        lane_total.moved += 1 if pair.moved else 0
        lane_total.value_now += pair.price_now
        lane_total.value_then += pair.price_then
        for group in group_defs_for(
            tags, lane=pair.lane, grader=pair.grader, grade=pair.grade, population=pair.population
        ):
            members.setdefault((pair.game, group.key), []).append(pair)
            defs[(pair.game, group.key)] = group

    results: list[GroupResult] = []
    for (game, key), group_pairs in members.items():
        if len(group_pairs) < min_group_cards:
            continue
        moved = [p for p in group_pairs if p.moved]
        if len(moved) < min_moved_cards:
            continue
        group = defs[(game, key)]
        median = float(statistics.median(p.change_pct for p in moved))
        results.append(
            GroupResult(
                game=game, lane=group.lane, group_key=key, segment_key=group.segment.key,
                label=group.label,
                description=f"{group.segment.description} · {len(group_pairs):,} cards",
                median_change_pct=median,
                value_now=sum(p.price_now for p in group_pairs),
                value_then=sum(p.price_then for p in group_pairs),
                card_count=len(group_pairs), moved_card_count=len(moved),
                pairs=group_pairs,
                top_pairs=top_contributors(group_pairs, rising=median >= 0),
            )
        )
    results.sort(key=lambda g: (g.game, -g.median_change_pct, g.group_key))
    return results, totals


def downsample_indices(count: int, target: int = SPARK_POINTS) -> list[int]:
    """Evenly spaced indices that always keep the first and last element."""
    if count <= target:
        return list(range(count))
    return sorted({round(i * (count - 1) / (target - 1)) for i in range(target)})


def spark_dates(then_end: date, ref_date: date, target: int = SPARK_POINTS) -> list[str]:
    days = [then_end + timedelta(days=i) for i in range((ref_date - then_end).days + 1)]
    return [days[i].isoformat() for i in downsample_indices(len(days), target)]


class _SparkTracker:
    """Group value index (then = 100) over sampled dates, carrying each item's
    last known price forward. Group sums move by per-item deltas, so each
    sampled date costs one pass over the paired items."""

    def __init__(self, groups: list[GroupResult]) -> None:
        self.groups = groups
        self.sums = [g.value_then for g in groups]
        self.points: list[list[float]] = [[100.0] for _ in groups]
        # item_key -> [current price, source currency, [group indexes]]
        self.items: dict[tuple, list[Any]] = {}
        for index, group in enumerate(groups):
            for pair in group.pairs:
                entry = self.items.setdefault(
                    (pair.lane, *pair.item_key), [pair.price_then, pair.currency, []]
                )
                entry[2].append(index)

    def apply(self, raw_rows: dict[str, tuple[float, str | None]], graded_rows: dict) -> None:
        for (lane, card_id, grader, grade, variant), entry in self.items.items():
            if lane == LANE_RAW:
                row = raw_rows.get(card_id)
                if row is None or row[1] != variant:
                    continue
                price = row[0]
            else:
                row = graded_rows.get((card_id, grader, grade, variant))
                if row is None or row[1] != entry[1]:
                    continue
                price = row[0]
            delta = price - entry[0]
            if delta == 0:
                continue
            entry[0] = price
            for index in entry[2]:
                self.sums[index] += delta
        for index, group in enumerate(self.groups):
            self.points[index].append(self.sums[index] / group.value_then * 100.0 if group.value_then else 100.0)

    def finish(self) -> None:
        for index, group in enumerate(self.groups):
            points = self.points[index]
            # The last point is exactly the paired "now" (the carried series can
            # differ when a card's newest row predates the reference date).
            points[-1] = group.value_now / group.value_then * 100.0 if group.value_then else 100.0
            group.spark_points = [round(p, 2) for p in points]


# --- reads --------------------------------------------------------------------


def _reference_date(connection: sqlite3.Connection, as_of: date | None) -> date | None:
    if as_of is None:
        row = connection.execute("SELECT MAX(price_date) FROM card_price_history_daily").fetchone()
    else:
        row = connection.execute(
            "SELECT MAX(price_date) FROM card_price_history_daily WHERE price_date <= ?",
            (as_of.isoformat(),),
        ).fetchone()
    value = row[0] if row is not None else None
    if not value:
        return None
    try:
        return date.fromisoformat(str(value)[:10])
    except ValueError:
        return None


def _load_cards(connection: sqlite3.Connection, games: tuple[str, ...]) -> dict[str, CardInfo]:
    card_columns = _table_columns(connection, "cards")
    has_game = "game" in card_columns
    game_col = "c.game" if has_game else "'pokemon'"
    sql = (
        f"SELECT c.id, {game_col}, c.name, c.number, c.set_name, c.image_small_url, c.rarity, "
        "c.language, COALESCE(NULLIF(c.set_release_date, ''), e.release_date) "
        "FROM cards c LEFT JOIN expansions e ON e.id = c.set_id"
    )
    params: tuple[Any, ...] = ()
    if has_game:
        sql += f" WHERE c.game IN ({','.join('?' for _ in games)})"
        params = tuple(games)
    out: dict[str, CardInfo] = {}
    for row in connection.execute(sql, params):
        game = str(row[1] or "pokemon")
        if game not in games:
            continue
        out[str(row[0])] = CardInfo(
            card_id=str(row[0]), game=game, name=str(row[2] or ""), number=row[3], set_name=row[4],
            image_url=row[5], rarity=row[6], language=row[7], release_date=row[8],
        )
    return out


def _raw_rows_for_date(
    connection: sqlite3.Connection, price_date: str, *, has_variant: bool = True
) -> dict[str, tuple[float, str | None]]:
    variant_col = "main_raw_variant" if has_variant else "NULL"
    rows = connection.execute(
        f"SELECT card_id, main_raw_market_price, {variant_col} FROM card_price_history_daily "
        "WHERE price_date = ? AND main_raw_market_price > 0",
        (price_date,),
    ).fetchall()
    return {str(r[0]): (float(r[1]), r[2]) for r in rows}


def _graded_rows_for_date(
    connection: sqlite3.Connection, price_date: str, *, jpy_usd: Decimal | None
) -> dict[GradedKey, tuple[float, str]]:
    """One day's plain graded cells → {(card, grader, grade, variant): (usd, currency)}.

    ``+lane`` keeps the planner on ``idx_cell_date`` instead of scanning the
    graded partial index (which leads with card_id)."""
    rows = connection.execute(
        "SELECT card_id, grader, grade, variant_key, currency_code, market "
        "FROM card_price_history_cell "
        "WHERE price_date = ? AND +lane = 'graded' "
        "AND is_perfect = 0 AND is_signed = 0 AND is_error = 0 AND market > 0",
        (price_date,),
    ).fetchall()
    out: dict[GradedKey, tuple[float, str]] = {}
    for card_id, grader, grade, variant, currency, market in rows:
        currency = str(currency or "USD").upper()
        if currency == "USD":
            usd = float(market)
        elif currency == "JPY" and jpy_usd is not None:
            converted = convert_price(float(market), rate=jpy_usd)
            if converted is None:
                continue
            usd = float(converted)
        else:
            continue
        key = (str(card_id), normalize_grader(grader), normalize_grade(grade), str(variant or ""))
        out[key] = (usd, currency)
    return out


def _latest_graded_items(
    connection: sqlite3.Connection,
    *,
    start: date,
    end: date,
    jpy_usd: Decimal | None,
    card_ids: set[str],
    wanted: set[GradedKey] | None = None,
) -> dict[GradedKey, tuple[float, str]]:
    """Newest graded price per item in [start, end], one date at a time
    newest-first; stops once every ``wanted`` item is resolved."""
    out: dict[GradedKey, tuple[float, str]] = {}
    day = end
    while day >= start:
        for key, value in _graded_rows_for_date(connection, day.isoformat(), jpy_usd=jpy_usd).items():
            if key[0] not in card_ids or key in out:
                continue
            if wanted is not None and key not in wanted:
                continue
            out[key] = value
        if wanted is not None and len(out) >= len(wanted):
            break
        day -= timedelta(days=1)
    return out


def _populations(connection: sqlite3.Connection, card_ids: Iterable[str]) -> dict[str, dict[str, dict[str, int]]]:
    """{card_id: {grader: {grade: count}}} from ``card_price_snapshots.population_json``."""
    ids = sorted(set(card_ids))
    if not ids or "population_json" not in _table_columns(connection, "card_price_snapshots"):
        return {}
    out: dict[str, dict[str, dict[str, int]]] = {}
    for offset in range(0, len(ids), SQL_CHUNK):
        chunk = ids[offset : offset + SQL_CHUNK]
        rows = connection.execute(
            "SELECT card_id, population_json FROM card_price_snapshots "
            f"WHERE card_id IN ({','.join('?' for _ in chunk)}) AND population_json != '{{}}'",
            tuple(chunk),
        ).fetchall()
        for card_id, payload in rows:
            try:
                parsed = json.loads(payload or "{}")
            except (TypeError, ValueError):
                continue
            if not isinstance(parsed, dict):
                continue
            by_grader: dict[str, dict[str, int]] = {}
            for grader, entry in parsed.items():
                grades = entry.get("grades") if isinstance(entry, dict) else None
                if not isinstance(grades, dict):
                    continue
                by_grader[normalize_grader(grader)] = {
                    normalize_grade(grade): int(count)
                    for grade, count in grades.items()
                    if isinstance(count, (int, float))
                }
            if by_grader:
                out[str(card_id)] = by_grader
    return out


# --- schema -------------------------------------------------------------------


def ensure_schema(connection: sqlite3.Connection) -> None:
    """Small precomputed-result tables; cheap to create on a live DB."""
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS meta_pulse_groups (
            game TEXT NOT NULL,
            as_of_date TEXT NOT NULL,
            window_days INTEGER NOT NULL,
            lane TEXT NOT NULL,
            group_key TEXT NOT NULL,
            segment_key TEXT NOT NULL,
            label TEXT NOT NULL,
            description TEXT NOT NULL,
            median_change_percent REAL NOT NULL,
            value_now REAL NOT NULL,
            value_then REAL NOT NULL,
            value_change_usd REAL NOT NULL,
            card_count INTEGER NOT NULL,
            moved_card_count INTEGER NOT NULL,
            spark_points_json TEXT NOT NULL DEFAULT '[]',
            computed_at TEXT NOT NULL,
            PRIMARY KEY (game, as_of_date, window_days, lane, group_key)
        )
        """
    )
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS meta_pulse_cards (
            game TEXT NOT NULL,
            as_of_date TEXT NOT NULL,
            window_days INTEGER NOT NULL,
            lane TEXT NOT NULL,
            group_key TEXT NOT NULL,
            rank INTEGER NOT NULL,
            card_id TEXT NOT NULL,
            name TEXT NOT NULL,
            number TEXT,
            set_name TEXT,
            image_url TEXT,
            grader TEXT,
            grade TEXT,
            population INTEGER,
            price_now REAL NOT NULL,
            price_then REAL NOT NULL,
            change_percent REAL NOT NULL,
            PRIMARY KEY (game, as_of_date, window_days, lane, group_key, rank)
        )
        """
    )
    # One row per (game, date, window, lane): lane totals for the summary and
    # the evidence for availableWindows.
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS meta_pulse_runs (
            game TEXT NOT NULL,
            as_of_date TEXT NOT NULL,
            window_days INTEGER NOT NULL,
            lane TEXT NOT NULL,
            paired_card_count INTEGER NOT NULL,
            moved_card_count INTEGER NOT NULL,
            value_now REAL NOT NULL,
            value_then REAL NOT NULL,
            group_count INTEGER NOT NULL,
            computed_at TEXT NOT NULL,
            PRIMARY KEY (game, as_of_date, window_days, lane)
        )
        """
    )
    connection.execute("CREATE INDEX IF NOT EXISTS idx_meta_pulse_runs_as_of ON meta_pulse_runs (as_of_date)")


# --- compute ------------------------------------------------------------------


def _normalize_games(games: Iterable[str] | None) -> tuple[str, ...]:
    if not games:
        return tuple(SUPPORTED_GAMES)
    out: list[str] = []
    for game in games:
        normalized = normalize_game(game)
        if normalized in SUPPORTED_GAMES and normalized not in out:
            out.append(normalized)
    return tuple(out)


def compute_meta_pulse(
    connection: sqlite3.Connection,
    *,
    games: Iterable[str] | None = None,
    windows: Iterable[int] = DEFAULT_WINDOWS,
    as_of: date | None = None,
    today: date | None = None,
    min_group_cards: int = MIN_GROUP_CARDS,
    min_moved_cards: int = MIN_MOVED_CARDS,
) -> dict[str, Any]:
    """The nightly job. Returns a small run summary (also logged by the CLI)."""
    started = time.monotonic()
    ensure_schema(connection)
    game_list = _normalize_games(games)
    window_list = tuple(sorted({int(w) for w in windows if int(w) > 0}))
    summary: dict[str, Any] = {"games": list(game_list), "windows": list(window_list), "asOfDate": None}

    ref_date = _reference_date(connection, as_of)
    if ref_date is None:
        return {**summary, "status": "no_history"}
    summary["asOfDate"] = ref_date.isoformat()
    anchor = as_of or today or datetime.now(timezone.utc).date()
    if (anchor - ref_date).days > NOW_TOLERANCE_DAYS:
        # A stale sync is not a trend; keep the last good result instead.
        return {**summary, "status": "stale"}

    cards = _load_cards(connection, game_list)
    tags = {card_id: tag_card(info) for card_id, info in cards.items()}
    card_ids = set(cards)
    jpy_usd = _jpy_usd_rate(connection)
    history_columns = _table_columns(connection, "card_price_history_daily")
    has_main = "main_raw_market_price" in history_columns
    has_main_variant = "main_raw_variant" in history_columns
    has_cells = _table_exists(connection, "card_price_history_cell")

    raw_now: dict = {}
    if has_main:
        total_cards = int(connection.execute("SELECT COUNT(*) FROM cards").fetchone()[0] or 0)
        raw_now = _latest_row_per_card(
            connection,
            start=(ref_date - timedelta(days=NOW_TOLERANCE_DAYS)).isoformat(), end=ref_date.isoformat(),
            has_main_column=True, has_main_variant_column=has_main_variant,
            expected_cards=total_cards or None,
        )
    graded_now: dict[GradedKey, tuple[float, str]] = {}
    if has_cells:
        graded_now = _latest_graded_items(
            connection, start=ref_date - timedelta(days=NOW_TOLERANCE_DAYS), end=ref_date,
            jpy_usd=jpy_usd, card_ids=card_ids,
        )
    populations = _populations(
        connection,
        {key[0] for key in graded_now if cards[key[0]].game == "pokemon"},
    )

    per_window: dict[int, tuple[list[GroupResult], dict[tuple[str, str], LaneTotals]]] = {}
    trackers: dict[int, tuple[_SparkTracker, set[str]]] = {}
    for window in window_list:
        then_end = ref_date - timedelta(days=window)
        pairs: list[PricePair] = []
        if raw_now:
            raw_then = _latest_row_per_card(
                connection,
                start=(then_end - timedelta(days=THEN_TOLERANCE_DAYS)).isoformat(), end=then_end.isoformat(),
                has_main_column=True, has_main_variant_column=has_main_variant,
                expected_cards=len(raw_now),
            )
            pairs.extend(raw_pairs(raw_now, raw_then, cards))
        if graded_now:
            graded_then = _latest_graded_items(
                connection, start=then_end - timedelta(days=THEN_TOLERANCE_DAYS), end=then_end,
                jpy_usd=jpy_usd, card_ids=card_ids, wanted=set(graded_now),
            )
            pairs.extend(graded_pairs(graded_now, graded_then, cards, populations))
        groups, totals = aggregate_groups(
            pairs, tags, min_group_cards=min_group_cards, min_moved_cards=min_moved_cards
        )
        per_window[window] = (groups, totals)
        if groups:
            dates = spark_dates(then_end, ref_date)
            trackers[window] = (_SparkTracker(groups), set(dates[1:]))

    # One read per sampled date, shared by every window that samples it.
    needed = sorted({d for _, dates in trackers.values() for d in dates})
    need_raw = any(g.lane == LANE_RAW for groups, _ in per_window.values() for g in groups)
    need_graded = any(g.lane == LANE_GRADED for groups, _ in per_window.values() for g in groups)
    for price_date in needed:
        raw_rows = _raw_rows_for_date(connection, price_date, has_variant=has_main_variant) if need_raw else {}
        graded_rows = _graded_rows_for_date(connection, price_date, jpy_usd=jpy_usd) if need_graded else {}
        for tracker, dates in trackers.values():
            if price_date in dates:
                tracker.apply(raw_rows, graded_rows)
    for tracker, _ in trackers.values():
        tracker.finish()

    computed_at = utc_now()
    _write_results(connection, game_list, ref_date, per_window, cards, computed_at=computed_at)
    duration_ms = int((time.monotonic() - started) * 1000)
    try:
        upsert_runtime_setting(
            connection, key=RUN_SETTING_KEY,
            value={"asOfDate": ref_date.isoformat(), "computedAt": computed_at, "durationMs": duration_ms,
                   "games": list(game_list), "windows": list(window_list)},
        )
    except sqlite3.Error:
        pass
    connection.commit()
    return {
        **summary,
        "status": "ok",
        "computedAt": computed_at,
        "durationMs": duration_ms,
        "groupCounts": {
            str(window): len(groups) for window, (groups, _) in per_window.items()
        },
        "rawPairs": {str(w): sum(t.paired for (g, l), t in totals.items() if l == LANE_RAW)
                     for w, (_, totals) in per_window.items()},
        "gradedPairs": {str(w): sum(t.paired for (g, l), t in totals.items() if l == LANE_GRADED)
                        for w, (_, totals) in per_window.items()},
    }


def _write_results(
    connection: sqlite3.Connection,
    games: tuple[str, ...],
    ref_date: date,
    per_window: dict[int, tuple[list[GroupResult], dict[tuple[str, str], LaneTotals]]],
    cards: dict[str, CardInfo],
    *,
    computed_at: str,
) -> None:
    as_of = ref_date.isoformat()
    cutoff = (ref_date - timedelta(days=RETENTION_DAYS)).isoformat()
    game_marks = ",".join("?" for _ in games)
    for table in ("meta_pulse_groups", "meta_pulse_cards", "meta_pulse_runs"):
        connection.execute(
            f"DELETE FROM {table} WHERE game IN ({game_marks}) AND (as_of_date = ? OR as_of_date < ?)",
            (*games, as_of, cutoff),
        )
    for window, (groups, totals) in per_window.items():
        group_counts: dict[tuple[str, str], int] = {}
        for group in groups:
            if group.game not in games:
                continue
            group_counts[(group.game, group.lane)] = group_counts.get((group.game, group.lane), 0) + 1
            connection.execute(
                "INSERT INTO meta_pulse_groups (game, as_of_date, window_days, lane, group_key, segment_key, "
                "label, description, median_change_percent, value_now, value_then, value_change_usd, "
                "card_count, moved_card_count, spark_points_json, computed_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    group.game, as_of, window, group.lane, group.group_key, group.segment_key,
                    group.label, group.description, round(group.median_change_pct, 2),
                    round(group.value_now, 2), round(group.value_then, 2), round(group.value_change_usd, 2),
                    group.card_count, group.moved_card_count, json.dumps(group.spark_points), computed_at,
                ),
            )
            for rank, pair in enumerate(group.top_pairs, start=1):
                info = cards[pair.card_id]
                connection.execute(
                    "INSERT INTO meta_pulse_cards (game, as_of_date, window_days, lane, group_key, rank, "
                    "card_id, name, number, set_name, image_url, grader, grade, population, "
                    "price_now, price_then, change_percent) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        group.game, as_of, window, group.lane, group.group_key, rank,
                        pair.card_id, info.name, info.number, info.set_name, info.image_url,
                        pair.grader, pair.grade, pair.population,
                        round(pair.price_now, 2), round(pair.price_then, 2), round(pair.change_pct, 1),
                    ),
                )
        for (game, lane), lane_total in totals.items():
            if game not in games:
                continue
            connection.execute(
                "INSERT INTO meta_pulse_runs (game, as_of_date, window_days, lane, paired_card_count, "
                "moved_card_count, value_now, value_then, group_count, computed_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    game, as_of, window, lane, lane_total.paired, lane_total.moved,
                    round(lane_total.value_now, 2), round(lane_total.value_then, 2),
                    group_counts.get((game, lane), 0), computed_at,
                ),
            )


# --- payload ------------------------------------------------------------------


def meta_pulse_version_token(connection: sqlite3.Connection) -> str | None:
    """Changes whenever the job writes a new result (cache key for the route)."""
    try:
        setting = runtime_setting(connection, RUN_SETTING_KEY)
    except sqlite3.Error:
        return None
    value = (setting or {}).get("value") or {}
    if not value.get("computedAt"):
        return None
    return f"{value.get('asOfDate')}|{value['computedAt']}"


def _window_phrase(window_days: int) -> str:
    return {7: "this week", 30: "this month"}.get(window_days, f"over {window_days} days")


def _pct_text(value: float) -> str:
    return f"{abs(value):.1f}".rstrip("0").rstrip(".") + "%"


def _direction_verb(value: float, *, up: str = "is up", down: str = "is down") -> str:
    return up if value >= 0 else down


def build_headline(groups: list[dict[str, Any]], summary: dict[str, Any], window_days: int) -> dict[str, str]:
    """Fill-in-the-blanks headline from payload-shaped groups + summary."""
    phrase = _window_phrase(window_days)
    risers = sorted(
        (g for g in groups if g["medianChangePercent"] >= FLAT_BAND_PCT),
        key=lambda g: -g["medianChangePercent"],
    )
    coolers = sorted(
        (g for g in groups if g["medianChangePercent"] <= -FLAT_BAND_PCT),
        key=lambda g: g["medianChangePercent"],
    )
    raw_pct = summary.get("rawValueChangePercent")
    graded_pct = summary.get("gradedValueChangePercent")

    if not groups:
        return {
            "title": "Not enough price history yet.",
            "body": "Group trends appear once there are enough priced cards at both ends of the window.",
        }
    if risers and coolers:
        title = f"{risers[0]['label']} is running. {coolers[0]['label']} is cooling."
    elif risers:
        title = f"{risers[0]['label']} is running."
    elif coolers:
        title = f"{coolers[0]['label']} is cooling."
    else:
        title = "Prices are holding steady."

    sentences: list[str] = []
    if risers:
        lead = risers[0]
        sentences.append(f"{lead['label']} gained {_pct_text(lead['medianChangePercent'])} {phrase}.")
    elif coolers:
        lead = coolers[0]
        sentences.append(f"{lead['label']} slipped {_pct_text(lead['medianChangePercent'])} {phrase}.")
    else:
        sentences.append(f"No group moved more than {_pct_text(FLAT_BAND_PCT)} {phrase}.")
    if raw_pct is not None and graded_pct is not None:
        sentences.append(
            f"Graded value {_direction_verb(graded_pct)} {_pct_text(graded_pct)} "
            f"while raw {_direction_verb(raw_pct)} {_pct_text(raw_pct)}."
        )
    elif raw_pct is not None:
        sentences.append(f"Raw value {_direction_verb(raw_pct)} {_pct_text(raw_pct)}.")
    elif graded_pct is not None:
        sentences.append(f"Graded value {_direction_verb(graded_pct)} {_pct_text(graded_pct)}.")
    return {"title": title, "body": " ".join(sentences)}


def build_ladders(groups: list[dict[str, Any]]) -> list[dict[str, Any]]:
    by_key = {g["groupKey"]: g for g in groups}
    ladders: list[dict[str, Any]] = []
    for rule in LADDERS:
        rungs = [
            {"label": label, "lane": by_key[key]["lane"], "medianChangePercent": by_key[key]["medianChangePercent"]}
            for label, key in rule.rungs
            if key in by_key
        ]
        if len(rungs) >= 2:
            ladders.append({"title": rule.title, "rungs": rungs})
    return ladders


def _pct_change(now: float, then: float) -> float | None:
    return round((now - then) / then * 100.0, 1) if then else None


def build_meta_pulse_payload(
    connection: sqlite3.Connection,
    *,
    game: str = DEFAULT_GAME,
    window_days: int = 7,
    lane: str = "all",
    max_groups_per_direction: int | None = 10,
) -> dict[str, Any]:
    """``MetaPulse`` for one (game, window, lane) from the precomputed tables.

    ``groups`` keeps the top ``max_groups_per_direction`` risers (>= 0%) and
    coolers (< 0%); counts, headline and ladders use every group."""
    if not _table_exists(connection, "meta_pulse_runs"):
        ensure_schema(connection)
    game = normalize_game(game)
    lane = lane if lane in LANE_FILTERS else "all"
    window_days = int(window_days)

    rows = connection.execute(
        "SELECT DISTINCT game FROM meta_pulse_runs WHERE paired_card_count >= ?", (MIN_GROUP_CARDS,)
    ).fetchall()
    present = {str(r[0]) for r in rows}
    available_games = [g for g in SUPPORTED_GAMES if g in present]

    row = connection.execute("SELECT MAX(as_of_date) FROM meta_pulse_runs WHERE game = ?", (game,)).fetchone()
    as_of = row[0] if row is not None else None
    runs = (
        connection.execute(
            "SELECT window_days, lane, paired_card_count, value_now, value_then, computed_at "
            "FROM meta_pulse_runs WHERE game = ? AND as_of_date = ?",
            (game, as_of),
        ).fetchall()
        if as_of
        else []
    )
    available_windows = sorted({int(r[0]) for r in runs if int(r[2]) >= MIN_GROUP_CARDS})
    lane_runs = {
        str(r[1]): r for r in runs if int(r[0]) == window_days and int(r[2]) >= MIN_GROUP_CARDS
    }
    computed_at = max((str(r[5]) for r in runs), default=None) or utc_now()

    def lane_summary(name: str) -> tuple[float | None, float | None]:
        run = lane_runs.get(name)
        if run is None:
            return None, None
        return _pct_change(float(run[3]), float(run[4])), round(float(run[3]) - float(run[4]), 2)

    raw_pct, raw_usd = lane_summary(LANE_RAW)
    graded_pct, graded_usd = lane_summary(LANE_GRADED)

    groups: list[dict[str, Any]] = []
    if as_of:
        lane_sql, lane_params = ("", ()) if lane == "all" else (" AND lane = ?", (lane,))
        group_rows = connection.execute(
            "SELECT lane, group_key, label, description, median_change_percent, value_now, value_then, "
            "value_change_usd, card_count, moved_card_count, spark_points_json "
            "FROM meta_pulse_groups WHERE game = ? AND as_of_date = ? AND window_days = ?" + lane_sql,
            (game, as_of, window_days, *lane_params),
        ).fetchall()
        card_rows = connection.execute(
            "SELECT lane, group_key, card_id, name, number, set_name, image_url, grader, grade, population, "
            "price_now, price_then, change_percent FROM meta_pulse_cards "
            "WHERE game = ? AND as_of_date = ? AND window_days = ?" + lane_sql + " ORDER BY rank",
            (game, as_of, window_days, *lane_params),
        ).fetchall()
        cards_by_group: dict[tuple[str, str], list[dict[str, Any]]] = {}
        for c in card_rows:
            cards_by_group.setdefault((str(c[0]), str(c[1])), []).append(
                {
                    "cardId": c[2], "game": game, "name": c[3], "number": c[4], "setName": c[5],
                    "imageUrl": c[6], "lane": c[0], "grader": c[7], "grade": c[8], "population": c[9],
                    "priceNow": c[10], "priceThen": c[11], "changePercent": c[12], "currencyCode": "USD",
                }
            )
        for g in group_rows:
            try:
                spark = [float(p) for p in json.loads(g[10] or "[]")]
            except (TypeError, ValueError):
                spark = []
            groups.append(
                {
                    "groupKey": g[1],
                    "label": g[2],
                    "lane": g[0],
                    "description": g[3],
                    "medianChangePercent": round(float(g[4]), 1),
                    "valueNow": round(float(g[5]), 2),
                    "valueThen": round(float(g[6]), 2),
                    "valueChangeUsd": round(float(g[7]), 2),
                    "cardCount": int(g[8]),
                    "movedCardCount": int(g[9]),
                    "sparkPoints": spark,
                    "topCards": cards_by_group.get((str(g[0]), str(g[1])), []),
                }
            )
        groups.sort(key=lambda g: (-g["medianChangePercent"], g["groupKey"]))

    summary = {
        "rawValueChangePercent": raw_pct,
        "rawValueChangeUsd": raw_usd,
        "gradedValueChangePercent": graded_pct,
        "gradedValueChangeUsd": graded_usd,
        "risingCount": sum(1 for g in groups if g["medianChangePercent"] >= FLAT_BAND_PCT),
        "coolingCount": sum(1 for g in groups if g["medianChangePercent"] <= -FLAT_BAND_PCT),
    }
    shown = groups
    if max_groups_per_direction is not None:
        cap = max(0, int(max_groups_per_direction))
        risers = [g for g in groups if g["medianChangePercent"] >= 0]
        coolers = [g for g in groups if g["medianChangePercent"] < 0]
        # groups is sorted desc, so the strongest coolers are at the tail.
        shown = risers[:cap] + (coolers[-cap:] if cap else [])
    return {
        "game": game,
        "windowDays": window_days,
        "lane": lane,
        "availableWindows": available_windows,
        "availableGames": available_games,
        "computedAt": computed_at,
        "asOfDate": as_of,
        "headline": build_headline(groups, summary, window_days),
        "summary": summary,
        "groups": shown,
        "ladders": build_ladders(groups),
    }


# --- CLI ----------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    from catalog_tools import connect

    parser = argparse.ArgumentParser(description="Compute / inspect the Meta pulse group trends")
    parser.add_argument("--database-path", default=str(Path(__file__).resolve().parent / "data" / "spotlight_scanner.sqlite"))
    parser.add_argument("--compute", action="store_true", help="run the nightly compute (default action)")
    parser.add_argument("--games", help="comma-separated games (default: all)")
    parser.add_argument("--windows", default=",".join(str(w) for w in DEFAULT_WINDOWS))
    parser.add_argument("--as-of", help="YYYY-MM-DD; compute as of this price date")
    parser.add_argument("--print-payload", action="store_true", help="print the stored payload instead of computing")
    parser.add_argument("--game", default=DEFAULT_GAME)
    parser.add_argument("--window", type=int, default=7)
    parser.add_argument("--lane", default="all", choices=LANE_FILTERS)
    args = parser.parse_args(argv)

    connection = connect(args.database_path, timeout_seconds=30.0)
    try:
        if args.print_payload:
            payload = build_meta_pulse_payload(connection, game=args.game, window_days=args.window, lane=args.lane)
            print(json.dumps(payload, indent=2, ensure_ascii=False))
            return 0
        result = compute_meta_pulse(
            connection,
            games=[g.strip() for g in args.games.split(",") if g.strip()] if args.games else None,
            windows=[int(w) for w in args.windows.split(",") if w.strip()],
            as_of=date.fromisoformat(args.as_of) if args.as_of else None,
        )
        print(json.dumps({"event": "meta_pulse_compute", **result}, ensure_ascii=False))
        return 0 if result.get("status") in {"ok", "stale", "no_history"} else 1
    finally:
        connection.close()


if __name__ == "__main__":
    sys.exit(main())
