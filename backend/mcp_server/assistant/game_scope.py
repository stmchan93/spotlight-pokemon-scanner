"""Which trading card game a market-wide answer covers (owner decision 2026-11-20).

Market-wide rankings (rising, dropping, new highs, lows, undervalued, trending,
sets, most expensive, top graded) always cover ONE game. The game is resolved
here, in code, never by the model:

1. the question names a game -> that game ("all games" asked -> unscoped);
2. the game this thread last named or ranked;
3. the game of the screen the chat was opened from (request context.game);
4. the game most of the user's collection is in (by entry count, the same rule
   as the app's Insights game picker default; ties -> catalog order);
5. Pokémon.

enforce_game() then pins that game on market-wide tool calls. Questions about
specific cards (text/set filters), the scan tray, or the user's own things
(owned/collection args) are never game-filtered.
"""

from __future__ import annotations

import logging
import re
import sqlite3
from dataclasses import dataclass, field
from typing import Any

from catalog_tools import DEFAULT_GAME, SUPPORTED_GAMES, game_display_name

logger = logging.getLogger("ekalight.assistant")

# Question text -> game id. Two-letter aliases ("OP") are left out: too ambiguous in prose.
GAME_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("pokemon", re.compile(r"\b(?:pok[eé]mon|pkmn|ptcg)\b", re.IGNORECASE)),
    ("onepiece", re.compile(r"\b(?:one[\s-]?piece|optcg)\b", re.IGNORECASE)),
    ("lorcana", re.compile(r"\blorcana\b", re.IGNORECASE)),
    ("riftbound", re.compile(r"\briftbound\b", re.IGNORECASE)),
    ("gundam", re.compile(r"\bgundam\b", re.IGNORECASE)),
)
# Games Ekalight has no catalog for: named, they must not fall back to another game's ranking.
UNSUPPORTED_GAMES = re.compile(
    r"\b(?:mtg|magic(?::|\s)+the\s+gathering|yu[\s-]?gi[\s-]?oh|digimon|flesh\s+and\s+blood|star\s+wars\s+unlimited"
    r"|weiss\s+schwarz|dragon\s+ball(?:\s+super)?\s+card)\b",
    re.IGNORECASE,
)
ALL_GAMES = re.compile(
    r"\b(?:all|every|each|any)\s+(?:the\s+|of\s+the\s+)?(?:games|tcgs|card\s+games)\b|\bevery\s+(?:game|tcg)\b"
    r"|\bacross\s+(?:all\s+)?(?:the\s+)?(?:games|tcgs)\b|\ball\s+(?:the\s+)?(?:games|tcgs)\b",
    re.IGNORECASE,
)

# Where the resolved game came from (logged, and in the model's turn note).
SOURCE_QUESTION = "question"
SOURCE_ALL = "all_games"
SOURCE_UNSUPPORTED = "unsupported"
SOURCE_THREAD = "thread"
SOURCE_CONTEXT = "context"
SOURCE_COLLECTION = "collection"
SOURCE_DEFAULT = "default"

# Tools whose whole-game ranking is pinned to the resolved game.
MARKET_GAME_TOOLS = frozenset(
    {"get_market_trends", "find_price_lows", "find_new_highs", "find_top_graded", "find_movers", "search_cards"}
)
TOP_LEVEL_GAME_TOOLS = frozenset({"get_market_trends", "find_price_lows", "find_new_highs"})
# A filter naming a card, set or artist is a specific-card question: the card decides the game.
SPECIFIC_FILTER_KEYS = ("text", "set", "artist")
USER_ARGS = ("collection_id", "holding_type", "holding_id")
PRICE_SORTS = frozenset({"price_desc", "price_asc"})


def named_games(question: str) -> tuple[str, ...]:
    """Supported games the question names, in the order they appear."""
    text = str(question or "")
    found = [(match.start(), game) for game, pattern in GAME_PATTERNS if (match := pattern.search(text))]
    return tuple(game for _, game in sorted(found))


def asks_all_games(question: str) -> bool:
    return bool(ALL_GAMES.search(str(question or "")))


def names_unsupported_game(question: str) -> bool:
    return bool(UNSUPPORTED_GAMES.search(str(question or "")))


def supported_game(value: Any) -> str | None:
    text = str(value or "").strip().lower()
    return text if text in SUPPORTED_GAMES else None


@dataclass(frozen=True)
class GameScope:
    game: str | None  # None = unscoped (all games asked, or only an unsupported game named)
    source: str
    named: tuple[str, ...] = ()
    collection_games: tuple[str, ...] = field(default=())  # the user's games, most entries first
    context_game: str | None = None

    @property
    def cache_scope(self) -> str:
        """Shared-answer cache scope: a Pokémon answer is never replayed to a One Piece asker."""
        return f"game:{self.game}" if self.game else f"game:{self.source}"

    @property
    def remembered(self) -> str | None:
        """The game to store on the thread when the question named it."""
        return self.game if self.source == SOURCE_QUESTION else None


def collection_games(conn: sqlite3.Connection, owner_user_id: str) -> tuple[str, ...]:
    """The user's games ranked by collection entry count (ties -> catalog order).

    Entry count, not value: it matches the app's Insights game picker default
    (defaultInsightsGame), and one pricey slab or a stale price shouldn't flip
    which game a 90%-One-Piece collector is shown."""
    try:
        rows = conn.execute(
            """
            SELECT COALESCE(c.game, ?) AS game, COUNT(*) AS entries
            FROM deck_entries d JOIN cards c ON c.id = d.card_id
            WHERE d.owner_user_id = ? AND d.quantity > 0
            GROUP BY 1
            """,
            (DEFAULT_GAME, owner_user_id),
        ).fetchall()
    except sqlite3.Error:
        logger.exception("assistant collection games lookup failed")
        return ()
    counts = {str(row[0]): int(row[1]) for row in rows if str(row[0]) in SUPPORTED_GAMES and int(row[1]) > 0}
    order = {game: index for index, game in enumerate(SUPPORTED_GAMES)}
    return tuple(sorted(counts, key=lambda game: (-counts[game], order[game])))


def resolve_game(
    question: str,
    *,
    thread_game: str | None = None,
    context_game: str | None = None,
    collection: tuple[str, ...] = (),
) -> GameScope:
    """Deterministic resolution order (module docstring)."""
    context_game = supported_game(context_game)
    common = {"collection_games": tuple(collection), "context_game": context_game}
    named = named_games(question)
    if asks_all_games(question):
        return GameScope(None, SOURCE_ALL, named, **common)
    if named:
        return GameScope(named[0], SOURCE_QUESTION, named, **common)
    if names_unsupported_game(question):
        return GameScope(None, SOURCE_UNSUPPORTED, (), **common)
    if supported_game(thread_game):
        return GameScope(supported_game(thread_game), SOURCE_THREAD, (), **common)
    if context_game:
        return GameScope(context_game, SOURCE_CONTEXT, (), **common)
    if collection:
        return GameScope(collection[0], SOURCE_COLLECTION, (), **common)
    return GameScope(DEFAULT_GAME, SOURCE_DEFAULT, (), **common)


def scope_note(scope: GameScope) -> str:
    """The turn note telling the model which game market-wide answers cover."""
    if scope.source == SOURCE_ALL:
        return (
            "Game scope: the user asked about all games, so market-wide rankings may span every game; "
            "name each card's game."
        )
    if scope.game is None:
        return (
            "Game scope: the user named a game Ekalight has no cards or prices for; say so in one short "
            "sentence instead of answering with another game's cards."
        )
    name = game_display_name(scope.game)
    return (
        f"Game scope: {name}. Market-wide rankings (rising, falling, new highs, lows, undervalued, trending, "
        f"sets, most expensive, top graded) cover {name} only; name the game in the first sentence "
        f"(e.g. \"Top **{name}** risers this month…\"). Questions about specific cards, the scan tray, or the "
        "user's own collection are not limited to this game."
    )


def _user_scoped(arguments: dict[str, Any]) -> bool:
    if arguments.get("owned") not in (None, "any"):
        return True
    return any(arguments.get(key) is not None for key in USER_ARGS)


def _specific(card_filter: dict[str, Any]) -> bool:
    return any(str(card_filter.get(key) or "").strip() for key in SPECIFIC_FILTER_KEYS)


def enforce_game(name: str, arguments: Any, scope: GameScope) -> tuple[dict[str, Any], str | None]:
    """(arguments with the resolved game pinned, the game the call is scoped to).

    The model's own game is kept only when the question named it; otherwise an
    omitted, "any", or different game becomes the resolved one. Calls about
    specific cards or the user's own things pass through untouched (None)."""
    args = dict(arguments) if isinstance(arguments, dict) else {}
    if scope.game is None or name not in MARKET_GAME_TOOLS or _user_scoped(args):
        return args, None
    raw_filter = args.get("filter")
    card_filter = dict(raw_filter) if isinstance(raw_filter, dict) else {}
    if _specific(card_filter):
        return args, None
    if name == "find_movers" and not card_filter.get("rarity_bucket"):
        # Without a set/text/rarity scope find_movers refuses (it points at get_market_trends).
        return args, None
    if name == "search_cards" and args.get("sort") not in PRICE_SORTS:
        # Only "most expensive"/"cheapest" whole-game rankings; art and browse searches keep their game.
        return args, None
    chosen = supported_game(args.get("game")) or supported_game(card_filter.get("game"))
    game = chosen if chosen and chosen in scope.named else scope.game
    if name in TOP_LEVEL_GAME_TOOLS:
        args["game"] = game
        if "game" in card_filter:
            card_filter.pop("game")
            args["filter"] = card_filter
    else:
        card_filter["game"] = game
        args["filter"] = card_filter
    return args, game


def switch_suggestion(scope: GameScope, scoped_game: str | None) -> str | None:
    """One tap-to-ask chip for another game the user plausibly cares about:
    their next collection game, else the screen's game; None when there is none."""
    if not scoped_game:
        return None
    for game in (*scope.collection_games, scope.context_game):
        if game and game != scoped_game and game in SUPPORTED_GAMES:
            return f"What about {game_display_name(game)}?"
    return None


def with_switch_suggestion(
    suggestions: list[str], chip: str | None, scoped_game: str | None, *, limit: int = 3
) -> list[str]:
    """On a game-scoped answer, model follow-ups that switch games are dropped (only ours
    does, and only toward a game the user plausibly cares about); our chip goes last."""
    if not scoped_game:
        return list(suggestions)
    kept = [
        item for item in suggestions
        if set(named_games(item)) <= {scoped_game} and (chip is None or item.casefold() != chip.casefold())
    ]
    return [*kept[: limit - 1], chip] if chip else kept[:limit]
