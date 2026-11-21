"""Shared answer cache for market-wide questions ("Undervalued cards", "What's
trending?"): the answer is the same for every user until prices change, so a
clean first-message answer built only from market-wide reads is stored once
and replayed to later askers without an LLM call.

Key = (normalized question, scope, data version, engine fingerprint). Scope is
the resolved game (game_scope.GameScope.cache_scope), so a Pokémon ranking is
never replayed to a One Piece asker. The data
version is the price_lows / market movers token (newest price date + pricing
sync generation), so a price sync invalidates; rows also expire after 24h.

Knowledge answers ("What's a SIR?", "PSA vs CGC?") ran no tools, so they do not
depend on prices: keyed on a fixed version (+ engine fingerprint), 7-day expiry."""

from __future__ import annotations

import hashlib
import json
import re
import sqlite3
from datetime import datetime, timedelta, timezone
from typing import Any

TTL = timedelta(hours=24)
KNOWLEDGE_TTL = timedelta(days=7)
KNOWLEDGE_SCOPE = "knowledge"
KNOWLEDGE_VERSION = "knowledge"

# Reads whose result is the same for every user (when called without owned filters).
MARKET_TOOLS = frozenset(
    {"get_market_trends", "find_price_lows", "find_new_highs", "list_facets", "search_cards", "find_top_graded"}
)
# show_cards only picks tiles from this turn's results; it reads nothing itself.
NEUTRAL_TOOLS = frozenset({"show_cards"})
# Arguments that scope a market tool to the caller.
USER_ARGS = ("collection_id", "holding_type", "holding_id")
# Keys in a tool result that only exist for this user (owned printing, holdings).
USER_RESULT_KEYS = frozenset({"resolved_owned_card_id", "resolved_owned_note", "my_holdings", "holding_id"})
# Card/tile keys carrying the asker's ownership; stripped before storing and serving.
USER_CARD_KEYS = ("quantity_owned", "holding_id", "my_holdings")
# Operational flags (latency, cost) say nothing about the answer's quality.
NON_QUALITY_FLAGS = frozenset({"slow", "expensive"})

# Exact-match aliases for the default starter chips: normalized variant -> canonical.
QUESTION_ALIASES = {
    "show me undervalued cards": "undervalued cards",
    "what cards are undervalued": "undervalued cards",
    "cards with the most recent new highs": "cards with the most recent new high sales",
    "what's trending right now": "what's trending in the market right now",
    "what's trending in the market": "what's trending in the market right now",
}

# Questions about the asker's own things are never shared, whatever tools ran.
_PERSONAL = re.compile(
    r"\b(my|mine|i own|i have|i've got|i got|i bought|collection|watchlist|wishlist|portfolio|holdings?)\b"
)
# Knowledge asks the length guard does not class as explanations ("What does NM mean?").
_KNOWLEDGE = re.compile(r"\bwhat does\b.*\bmean\b|\bmeaning of\b|\bstand for\b")
# An off-topic decline or a clarifying question must not be replayed to others.
_DECLINE = re.compile(
    r"\b(?:i can only|i can't help|i cannot help|i'm not able to|i am not able to|only help with|outside (?:of )?what|"
    r"not something i)\b",
    re.IGNORECASE,
)
_LEADING_FILLER = re.compile(r"^(?:(?:hey|so)\b[\s,]*)+")
_WHAT_IS = re.compile(r"\bwhat(?: is|s)\b")
_THE = re.compile(r"\bthe\b")

_QUOTES = str.maketrans({"‘": "'", "’": "'", "‛": "'", "′": "'",
                         "“": '"', "”": '"', "‟": '"', "″": '"'})
_TRAILING_PUNCT = re.compile(r"[\s.?!,;:…]+$")

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS assistant_shared_answers (
    key TEXT PRIMARY KEY, question_norm TEXT NOT NULL, version TEXT NOT NULL, reply_json TEXT NOT NULL,
    hits INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_assistant_shared_answers_expires ON assistant_shared_answers(expires_at);
"""


def _normalize(text: str) -> str:
    value = " ".join(str(text or "").translate(_QUOTES).lower().split())
    value = _LEADING_FILLER.sub("", value)
    value = _WHAT_IS.sub("what's", value)
    value = " ".join(_THE.sub(" ", value).split())
    return _TRAILING_PUNCT.sub("", value)


_ALIASES = {_normalize(key): _normalize(value) for key, value in QUESTION_ALIASES.items()}


def normalize_question(text: str) -> str:
    """Exact-match key: lowercased, curly quotes, "what is"/"whats" -> "what's",
    leading "hey"/"so" and every "the" dropped, trailing punctuation stripped."""
    value = _normalize(text)
    return _ALIASES.get(value, value)


def personal_question(text: str) -> bool:
    return bool(_PERSONAL.search(str(text or "").translate(_QUOTES).lower()))


def data_version(conn: sqlite3.Connection) -> str | None:
    from price_lows import price_lows_version_token

    return price_lows_version_token(conn)


def cache_key(question_norm: str, *, version: str, fingerprint: str, scope: str = "") -> str:
    raw = "\x1f".join((question_norm, scope, version, fingerprint))
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def engine_fingerprint(model: str, system_prompt: str) -> str:
    """A model or prompt change must not replay answers the old engine wrote."""
    return f"{model}|{hashlib.sha256(system_prompt.encode('utf-8')).hexdigest()[:16]}"


def _has_user_data(node: Any) -> bool:
    if isinstance(node, list):
        return any(_has_user_data(item) for item in node)
    if isinstance(node, dict):
        if USER_RESULT_KEYS.intersection(node):
            return True
        return any(_has_user_data(item) for item in node.values())
    return False


def tool_record(name: str, arguments: Any, content: Any, cards: list[dict[str, Any]]) -> dict[str, Any]:
    """What eligibility needs from one executed tool call (engine records one per call)."""
    user_data = _has_user_data(content) or any(card.get("quantity_owned") is not None for card in cards)
    return {"name": name, "arguments": arguments if isinstance(arguments, dict) else {}, "user_data": user_data}


def market_wide_call(record: dict[str, Any]) -> bool:
    if record.get("name") not in MARKET_TOOLS or record.get("user_data"):
        return False
    args = record.get("arguments") or {}
    if args.get("owned") not in (None, "any"):
        return False
    return not any(args.get(key) is not None for key in USER_ARGS)


def request_eligible(request: dict[str, Any]) -> bool:
    """First message of a new thread, no scanned cards, not about the asker's own things."""
    return (
        request.get("thread_id") is None
        and not request.get("card_ids")
        and not personal_question(request.get("text") or "")
    )


def knowledge_cacheable(question: str, turn: Any, flags: list[str]) -> bool:
    """A clean pure-knowledge answer: no tools at all, so nothing price- or user-dependent."""
    from mcp_server.assistant.length_guard import turn_kind

    if getattr(turn, "status", None) != "ok" or getattr(turn, "actions", None):
        return False
    if getattr(turn, "tool_errors", None) or getattr(turn, "round_limit_hit", False):
        return False
    if any(flag not in NON_QUALITY_FLAGS for flag in flags):
        return False
    if getattr(turn, "tools_used", None) or getattr(turn, "tool_inputs", None):
        return False
    if getattr(turn, "cards", None) or getattr(turn, "charts", None) or getattr(turn, "sets", None):
        return False
    text = str(getattr(turn, "text", "") or "").strip()
    if not text or text.endswith("?") or _DECLINE.search(text):
        return False
    # No tools + not a knowledge question = the length guard's "refusal" kind.
    if turn_kind(question, []) == "refusal" and not _KNOWLEDGE.search(normalize_question(question)):
        return False
    return True


def turn_cacheable(turn: Any, flags: list[str]) -> bool:
    if getattr(turn, "status", None) != "ok" or getattr(turn, "actions", None):
        return False
    if getattr(turn, "tool_errors", None) or getattr(turn, "round_limit_hit", False):
        return False
    if any(flag not in NON_QUALITY_FLAGS for flag in flags):
        return False
    records = list(getattr(turn, "tool_inputs", None) or [])
    if not records or not all(market_wide_call(record) for record in records):
        return False
    # tools_used also lists show_cards; anything else must be a recorded market call.
    if not set(getattr(turn, "tools_used", None) or []) <= MARKET_TOOLS | NEUTRAL_TOOLS:
        return False
    return any(record["name"] != "list_facets" for record in records)


def strip_user_data(cards: list[Any]) -> list[dict[str, Any]]:
    return [
        {key: value for key, value in card.items() if key not in USER_CARD_KEYS}
        for card in cards or []
        if isinstance(card, dict)
    ]


def shared_reply(turn: Any) -> dict[str, Any]:
    """The user-neutral part of a reply worth replaying."""
    return {
        "text": turn.text,
        "cards": strip_user_data(turn.cards),
        "cards_label": turn.cards_label,
        "cards_view_all": turn.cards_view_all,
        "suggestions": list(turn.suggestions or []),
        "charts": list(turn.charts or []),
        "sets": list(getattr(turn, "sets", None) or []),
        "tools_used": list(turn.tools_used or []),
        "tool_calls": list(turn.tool_calls or []),
        # Not replayed as-is: the replaying asker gets their own game-switch chip from it.
        "scoped_game": getattr(turn, "scoped_game", None),
    }


def replay(cached: dict[str, Any]) -> dict[str, Any]:
    """Cached reply -> a save_turn reply: zero tokens and cost, no flags/actions."""
    return {
        "flags": [],
        "text": str(cached.get("text") or ""),
        "cards": strip_user_data(cached.get("cards") or []),
        "cards_label": cached.get("cards_label"),
        "cards_view_all": cached.get("cards_view_all"),
        "actions": [],
        "suggestions": list(cached.get("suggestions") or []),
        "charts": list(cached.get("charts") or []),
        "sets": list(cached.get("sets") or []),
        "status": "ok",
        "input_tokens": 0,
        "output_tokens": 0,
        "cost_usd": 0.0,
        "tools_used": list(cached.get("tools_used") or []),
        "tool_calls": list(cached.get("tool_calls") or []),
        "cached": True,
    }


def _iso(moment: datetime) -> str:
    return moment.isoformat(timespec="seconds").replace("+00:00", "Z")


class SharedAnswerStore:
    """Not owner-scoped by design: rows hold only user-neutral market and knowledge answers."""

    def __init__(self, conn_provider: Any) -> None:
        self._conn_provider = conn_provider

    @property
    def conn(self) -> sqlite3.Connection:
        return self._conn_provider()

    def get(self, key: str, version: str, *, now: datetime | None = None) -> dict[str, Any] | None:
        stamp = _iso(now or datetime.now(timezone.utc))
        row = self.conn.execute(
            "SELECT reply_json FROM assistant_shared_answers WHERE key = ? AND version = ? AND expires_at > ?",
            (key, version, stamp),
        ).fetchone()
        if row is None:
            return None
        try:
            reply = json.loads(row[0])
        except (TypeError, ValueError):
            return None
        self.conn.execute("UPDATE assistant_shared_answers SET hits = hits + 1 WHERE key = ?", (key,))
        self.conn.commit()
        return reply if isinstance(reply, dict) else None

    def put(self, key: str, *, question_norm: str, version: str, reply: dict[str, Any],
            now: datetime | None = None, ttl: timedelta = TTL) -> None:
        moment = now or datetime.now(timezone.utc)
        stamp = _iso(moment)
        conn = self.conn
        # Expired rows and older versions of this question are dead weight.
        conn.execute(
            "DELETE FROM assistant_shared_answers WHERE expires_at <= ? OR (question_norm = ? AND version != ?)",
            (stamp, question_norm, version),
        )
        conn.execute(
            """
            INSERT INTO assistant_shared_answers (key, question_norm, version, reply_json, hits, created_at, expires_at)
            VALUES (?, ?, ?, ?, 0, ?, ?)
            ON CONFLICT(key) DO UPDATE SET reply_json = excluded.reply_json, created_at = excluded.created_at,
                expires_at = excluded.expires_at
            """,
            (key, question_norm, version, json.dumps(reply, default=str), stamp, _iso(moment + ttl)),
        )
        conn.commit()
