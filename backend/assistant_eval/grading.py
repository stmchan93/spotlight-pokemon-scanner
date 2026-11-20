"""Graders for one assistant turn.

(a) Deterministic checks: `grade_turn(record, expect, defaults, known_tools)` -> [CheckResult].
(b) LLM judge: `judge_turn(client, ...)` -> JudgeResult (Anthropic SDK,
    structured JSON output).

A turn record is what tools/assistant_eval.py emits per turn:
  question, status ("ok" | "error" | "http_<code>"), answer, tools [names],
  tool_calls ["name(k=v, ...)"], tool_args [{name, arguments, is_error}],
  tool_results [{name, call, is_error, result (clipped text), data (structured)}],
  cards [{card_id, name, set, number, language, price_usd, grader, grade, variant,
          game, supertype, rarity, quantity, quantity_owned}] (game/supertype/language
          come from the catalog row, so sealed `tcgp-sealed-*` ids get the right game),
  cards_label (only when the reply carries one), chart_series [{card_id, name, variant, range, points}],
  action_details [{type, params, summary, state}], scanner_context, reference, cost_usd.

Checks on planned features (show_cards, add_to_collection_now, grading_upside,
price_trusted, covers_full_range, cards_label, tile quantity) SKIP instead of
failing while the tool/field is absent, so the suite runs before and after they land.
"""

from __future__ import annotations

import json
import os
import re
from dataclasses import asdict, dataclass
from datetime import date
from typing import Any, Callable

# Haiku by default (cost); override e.g. claude-sonnet-5-5 for a stricter spot-check.
DEFAULT_JUDGE_MODEL = "claude-haiku-5-5"
JUDGE_MODEL_ENV = "ASSISTANT_EVAL_JUDGE_MODEL"
# USD per million (input, output) tokens; unknown models are priced as Opus 5.5.
JUDGE_PRICES = {
    "claude-haiku-5-5": (0.10, 0.50),
    "claude-sonnet-5-5": (2.0, 10.0),
    "claude-opus-5-5": (4.0, 20.0),
}

KNOWN_GAMES = ("pokemon", "onepiece", "lorcana", "riftbound", "gundam")
SEALED_ID_PREFIX = "tcgp-sealed-"
ACTION_TYPES = ("add_to_collection", "update_holding", "watch_card")
# Tools other agents are adding; case files may name them before they exist.
PLANNED_TOOLS = frozenset({"show_cards", "add_to_collection_now", "grading_upside"})
WRITE_TOOLS = ("add_to_collection_now",)

# Every key a turn's `expect` block may use (validated by cases.validate_cases).
EXPECT_KEYS = frozenset(
    {
        "status",
        "tools_any",
        "tools_all",
        "tools_none",
        "tool_args",
        "tiles_none_match",
        "tiles_min",
        "chart_required",
        "max_words",
        "must_not_contain",
        "must_contain_any",
        "allow",
        "expect_action",
        "actions_allowed",
        "max_cost_usd",
        # tiles = the cards the answer is about
        "tiles_exact",
        "tiles_include",
        "tiles_within",
        "tiles_max",
        "tile_quantity",
        "tiles_label",
        "tiles_sorted",
        "tiles_price_trusted",
        "named_cards_in_tiles",
        # data-independent tile rules (survive price movement)
        "tiles_all_named",
        "tiles_from_tools",
        "tiles_include_top",
        "chart_card_matches_tile",
        "no_chart",
        # writes
        "expect_write",
        "expect_no_write",
        "undo_offered",
        "proposed_card_ids",
        # tool results
        "tool_result_where",
        "history_range_stated",
    }
)
MATCHER_OPS = frozenset({"not", "in", "not_in", "exists", "contains", "gte", "lte"})
TILE_PREDICATE_KEYS = frozenset(
    {"game", "game_not", "sealed", "japanese", "graded", "id", "id_contains", "id_prefix", "name_regex", "set_regex",
     "number", "grader", "grade", "variant_regex", "rarity_regex", "price_gte", "price_lte"}
)
TILE_SORT_KEYS = ("price", "value")


@dataclass
class CheckResult:
    name: str
    passed: bool
    reason: str = ""
    skipped: bool = False  # passed=True; the feature it checks isn't there yet

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def _ok(name: str) -> CheckResult:
    return CheckResult(name, True)


def _fail(name: str, reason: str) -> CheckResult:
    return CheckResult(name, False, reason)


def _skip(name: str, reason: str) -> CheckResult:
    return CheckResult(name, True, reason, skipped=True)


def _clip(text: Any, limit: int) -> str:
    text = str(text if text is not None else "")
    return text if len(text) <= limit else text[: limit - 1] + "…"


# --- value matching ------------------------------------------------------------


def _norm(value: Any) -> Any:
    if isinstance(value, bool) or value is None:
        return value
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value).strip()
    try:
        return float(text)
    except ValueError:
        return text.casefold()


def _equals(actual: Any, expected: Any) -> bool:
    if isinstance(actual, list):
        return any(_equals(item, expected) for item in actual)
    return _norm(actual) == _norm(expected)


def _contains(actual: Any, needle: Any) -> bool:
    if actual is None:
        return False
    if isinstance(actual, list):
        return any(_contains(item, needle) for item in actual)
    return str(needle).casefold() in str(actual).casefold()


_MISSING = object()


def value_matches(actual: Any, spec: Any) -> bool:
    """spec: a scalar (equals; a list `actual` matches if any item equals), or
    {not|in|not_in|exists|contains|gte|lte: ...} (all given ops must hold)."""
    present = actual is not _MISSING and actual is not None
    if not isinstance(spec, dict):
        return present and _equals(actual, spec)
    for op, expected in spec.items():
        if op == "exists":
            if present != bool(expected):
                return False
        elif op == "not":
            if present and _equals(actual, expected):
                return False
        elif op == "in":
            if not present or not any(_equals(actual, item) for item in expected):
                return False
        elif op == "not_in":
            if present and any(_equals(actual, item) for item in expected):
                return False
        elif op == "contains":
            if not present or not _contains(actual, expected):
                return False
        elif op in ("gte", "lte"):
            try:
                number = float(actual) if present else None
            except (TypeError, ValueError):
                number = None
            if number is None or (number < float(expected) if op == "gte" else number > float(expected)):
                return False
        else:
            raise ValueError(f"unknown matcher op {op!r}")
    return True


def _lookup(arguments: Any, path: str) -> Any:
    node = arguments
    for part in path.split("."):
        if not isinstance(node, dict) or part not in node:
            return _MISSING
        node = node[part]
    return node


def _lookup_all(node: Any, path: str) -> list[Any]:
    """Every value at a dotted path; lists on the way fan out over their items."""
    nodes = [node]
    for part in path.split("."):
        nxt: list[Any] = []
        for item in nodes:
            for candidate in item if isinstance(item, list) else [item]:
                if isinstance(candidate, dict) and part in candidate:
                    nxt.append(candidate[part])
        nodes = nxt
    return [value for value in nodes if not isinstance(value, list)] + [
        item for value in nodes if isinstance(value, list) for item in value
    ]


_SUMMARY = re.compile(r"^(?P<name>[A-Za-z_]+)\((?P<body>.*)\)\s*…?$")


def parse_tool_call_summary(summary: str) -> tuple[str, dict[str, Any]] | None:
    """'search_cards(game=onepiece, sort=price_desc)' -> (name, flat args). Nested
    filter keys are flattened by the engine, so lookups use the LAST path segment."""
    match = _SUMMARY.match(str(summary).strip())
    if not match:
        return None
    flat: dict[str, Any] = {}
    for pair in match.group("body").split(", "):
        if "=" in pair:
            key, value = pair.split("=", 1)
            flat[key.strip()] = value.split("|") if "|" in value else value
    return match.group("name"), flat


def tool_invocations(record: dict[str, Any]) -> list[tuple[str, Callable[[str], Any]]]:
    """[(tool name, path -> value)] from structured tool_args, else from the
    compact tool_calls strings (older JSONL)."""
    structured = record.get("tool_args")
    if isinstance(structured, list) and structured:
        return [
            (str(call.get("name")), lambda path, args=call.get("arguments") or {}: _lookup(args, path))
            for call in structured
            if isinstance(call, dict)
        ]
    calls = []
    for summary in record.get("tool_calls") or []:
        parsed = parse_tool_call_summary(summary)
        if parsed is None:
            continue
        name, flat = parsed
        calls.append((name, lambda path, flat=flat: flat.get(path.split(".")[-1], _MISSING)))
    return calls


# --- tool results ----------------------------------------------------------------

_CARD_FIELDS = ("card_id", "name", "set", "number", "language", "price_usd", "variant", "condition", "grader",
                "grade", "quantity", "quantity_owned", "owned", "price_trusted", "price_verified", "rarity_bucket",
                "comp_source", "comp_sale_count", "comp_missing",
                # history coverage (price lows/highs rows) so the judge can check "N days of history"
                "days_covered", "at_window_low", "pct_below_high", "pct_above_low", "high_date", "low_date",
                "first_date", "last_date", "covers_full_range")


def _is_card(node: Any) -> bool:
    return isinstance(node, dict) and bool(node.get("card_id")) and bool(node.get("name"))


def result_cards(data: Any) -> list[dict[str, Any]]:
    """Compact card-shaped dicts (card_id + name) in a structured tool result, in order."""
    found: list[dict[str, Any]] = []

    def walk(node: Any) -> None:
        if isinstance(node, list):
            for item in node:
                walk(item)
            return
        if not isinstance(node, dict):
            return
        if _is_card(node):
            compact = {key: node[key] for key in _CARD_FIELDS if node.get(key) is not None}
            for key, value in node.items():
                if key not in compact and isinstance(value, (int, float)) and not isinstance(value, bool) and (
                    key.endswith("_usd") or key.endswith("_pct")
                ):
                    compact[key] = value
            found.append(compact)
        for key, item in node.items():
            if key != "my_holdings":
                walk(item)

    walk(data)
    return found


MAX_ROWS = 6


def _row_text(row: dict[str, Any]) -> str:
    """'set=Plasma Storm, change_pct=66.3' for a non-card result row (scalars only)."""
    return ", ".join(
        f"{key}={value}" for key, value in row.items()
        if value is not None and not isinstance(value, (dict, list))
    )


def result_fields(data: Any, *, depth: int = 3) -> dict[str, Any]:
    """Scalar fields (dotted paths) of a tool result, skipping card dicts; date/usd
    point lists collapse to count/first/last/min/max."""
    fields: dict[str, Any] = {}

    def walk(node: Any, prefix: str, level: int) -> None:
        if not isinstance(node, dict) or level > depth:
            return
        for key, value in node.items():
            path = f"{prefix}{key}"
            if isinstance(value, dict):
                if not _is_card(value):
                    walk(value, path + ".", level + 1)
            elif isinstance(value, list):
                points = [p for p in value if isinstance(p, dict) and p.get("date") and isinstance(p.get("usd"), (int, float))]
                if points and len(points) == len(value):
                    prices = [float(p["usd"]) for p in points]
                    fields[path] = (
                        f"{len(points)} pts, {points[0]['date']} ${prices[0]:,.2f} -> {points[-1]['date']} "
                        f"${prices[-1]:,.2f}, min ${min(prices):,.2f}, max ${max(prices):,.2f}"
                    )
                elif value and all(not isinstance(item, (dict, list)) for item in value):
                    fields[path] = _clip(", ".join(str(item) for item in value), 160)
                elif value and all(isinstance(item, dict) and not _is_card(item) for item in value):
                    fields[path] = _clip("; ".join(_row_text(item) for item in value[:MAX_ROWS]), 400) + (
                        f" (+{len(value) - MAX_ROWS} more)" if len(value) > MAX_ROWS else ""
                    )
                elif value and not any(_is_card(item) for item in value):
                    fields[path] = f"{len(value)} items"
            elif value is not None:
                fields[path] = _clip(value, 160) if isinstance(value, str) else value

    walk(data, "", 0)
    return fields


def _tool_results(record: dict[str, Any], tool: str | None = None) -> list[dict[str, Any]]:
    return [
        item for item in record.get("tool_results") or []
        if isinstance(item, dict) and (tool is None or item.get("name") == tool)
    ]


def _planned_absent(name: str, known_tools: frozenset[str] | None) -> bool:
    return known_tools is not None and name in PLANNED_TOOLS and name not in known_tools


# --- tiles -----------------------------------------------------------------------


def card_game(card_id: str) -> str:
    head, sep, _ = str(card_id).partition("~")
    return head if sep and head in KNOWN_GAMES else "pokemon"


def _provider_id(card_id: str) -> str:
    head, sep, rest = str(card_id).partition("~")
    return rest if sep and head in KNOWN_GAMES else str(card_id)


def tile_game(card: dict[str, Any]) -> str:
    # The catalog row wins: sealed ids (tcgp-sealed-*) carry no game prefix.
    game = str(card.get("game") or "").strip().casefold()
    return game or card_game(str(card.get("card_id") or ""))


def tile_is_sealed(card: dict[str, Any]) -> bool:
    if card.get("supertype"):
        return str(card["supertype"]).strip().casefold() == "sealed"
    return _provider_id(str(card.get("card_id") or "")).startswith(SEALED_ID_PREFIX)


def tile_is_japanese(card: dict[str, Any]) -> bool:
    return str(card.get("language") or "").casefold() == "japanese" or "_ja-" in str(card.get("card_id") or "")


def _price(card: dict[str, Any]) -> float | None:
    value = card.get("price_usd")
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def _re(pattern: Any, value: Any) -> bool:
    return value is not None and re.search(str(pattern), str(value), re.IGNORECASE) is not None


def _same(actual: Any, expected: Any) -> bool:
    return str(actual if actual is not None else "").strip().casefold() == str(expected).strip().casefold()


def tile_matches(card: dict[str, Any], predicate: dict[str, Any] | str) -> bool:
    """predicate: a card id string, or a mapping of TILE_PREDICATE_KEYS (all must hold)."""
    if isinstance(predicate, str):
        predicate = {"id": predicate}
    card_id = str(card.get("card_id") or "")
    number = str(card.get("number") or "")
    for key, expected in predicate.items():
        if key == "game" and tile_game(card) != expected:
            return False
        if key == "game_not" and tile_game(card) == expected:
            return False
        if key == "sealed" and tile_is_sealed(card) != bool(expected):
            return False
        if key == "japanese" and tile_is_japanese(card) != bool(expected):
            return False
        if key == "graded" and bool(card.get("grader") or card.get("grade")) != bool(expected):
            return False
        if key == "id" and card_id != str(expected):
            return False
        if key == "id_contains" and str(expected) not in card_id:
            return False
        if key == "id_prefix" and not _provider_id(card_id).startswith(str(expected)):
            return False
        if key == "name_regex" and not _re(expected, card.get("name")):
            return False
        if key == "set_regex" and not _re(expected, card.get("set")):
            return False
        if key == "number" and not (_same(number, expected) or _same(number.split("/")[0], expected)):
            return False
        if key == "grader" and not _same(card.get("grader"), expected):
            return False
        if key == "grade" and not _same(card.get("grade"), expected):
            return False
        if key == "variant_regex" and not _re(expected, card.get("variant")):
            return False
        if key == "rarity_regex" and not _re(expected, card.get("rarity")):
            return False
        if key in ("price_gte", "price_lte"):
            price = _price(card)
            if price is None or (price < float(expected) if key == "price_gte" else price > float(expected)):
                return False
    return True


def _tile_label(card: dict[str, Any]) -> str:
    slab = f" {card.get('grader')} {card.get('grade')}" if card.get("grader") else ""
    return f"{card.get('name')}{slab} [{card.get('card_id')}]"


def _spec_label(spec: dict[str, Any] | str) -> str:
    return spec if isinstance(spec, str) else "{" + ", ".join(f"{k}={v}" for k, v in spec.items()) + "}"


def tile_specs(spec: Any) -> tuple[list[Any], bool]:
    """tiles_exact/include/within value: a list, or {tiles: [...], ordered: bool}."""
    if isinstance(spec, dict):
        return list(spec.get("tiles") or []), bool(spec.get("ordered"))
    return list(spec or []), False


def _perfect_match(cards: list[dict[str, Any]], specs: list[Any]) -> bool:
    """Each spec matched by a distinct tile, every tile used (small n: backtracking)."""
    if len(cards) != len(specs):
        return False
    used = [False] * len(cards)

    def place(index: int) -> bool:
        if index == len(specs):
            return True
        for slot, card in enumerate(cards):
            if not used[slot] and tile_matches(card, specs[index]):
                used[slot] = True
                if place(index + 1):
                    return True
                used[slot] = False
        return False

    return place(0)


def _tiles(record: dict[str, Any]) -> list[dict[str, Any]]:
    return [card for card in record.get("cards") or [] if isinstance(card, dict)]


def _tiles_text(cards: list[dict[str, Any]]) -> str:
    return "; ".join(_tile_label(card) for card in cards) or "none"


# --- checks ----------------------------------------------------------------------


def word_count(text: str) -> int:
    return len(re.findall(r"[^\s*_#>`-]\S*", str(text or "")))


def check_status(record: dict[str, Any], expected: str = "ok") -> CheckResult:
    status = record.get("status")
    return _ok("status") if status == expected else _fail("status", f"status {status!r}, expected {expected!r}")


def _present_tools(name: str, names: list[str], known_tools: frozenset[str] | None) -> tuple[list[str], CheckResult | None]:
    present = [tool for tool in names if not _planned_absent(tool, known_tools)]
    if not present:
        return present, _skip(name, f"planned tool(s) {names} not in this build")
    return present, None


def check_tools_any(record: dict[str, Any], names: list[str], known_tools: frozenset[str] | None = None) -> CheckResult:
    names, skipped = _present_tools("tools_any", names, known_tools)
    if skipped:
        return skipped
    used = set(record.get("tools") or [])
    if used & set(names):
        return _ok("tools_any")
    return _fail("tools_any", f"none of {names} called (called: {sorted(used) or 'nothing'})")


def check_tools_all(record: dict[str, Any], names: list[str], known_tools: frozenset[str] | None = None) -> CheckResult:
    names, skipped = _present_tools("tools_all", names, known_tools)
    if skipped:
        return skipped
    missing = [name for name in names if name not in set(record.get("tools") or [])]
    return _fail("tools_all", f"not called: {missing}") if missing else _ok("tools_all")


def check_tools_none(record: dict[str, Any], names: list[str]) -> CheckResult:
    bad = sorted(set(record.get("tools") or []) & set(names))
    return _fail("tools_none", f"should not call: {bad}") if bad else _ok("tools_none")


def check_tool_args(record: dict[str, Any], spec: dict[str, Any], known_tools: frozenset[str] | None = None) -> CheckResult:
    """spec = {tool, where: {path: matcher}, mode: any|all}. any (default): at least
    one call of `tool` satisfies every condition. all: every call does (and >=1 exists)."""
    tool = spec["tool"]
    where = spec.get("where") or {}
    mode = spec.get("mode", "any")
    name = f"tool_args:{tool}"
    if _planned_absent(tool, known_tools):
        return _skip(name, f"planned tool {tool} not in this build")
    calls = [lookup for call_name, lookup in tool_invocations(record) if call_name == tool]
    if not calls:
        return _fail(name, f"{tool} was not called")

    def satisfied(lookup: Callable[[str], Any]) -> list[str]:
        return [path for path, matcher in where.items() if not value_matches(lookup(path), matcher)]

    misses = [satisfied(lookup) for lookup in calls]
    if mode == "all":
        bad = [miss for miss in misses if miss]
        if bad:
            return _fail(name, f"{len(bad)}/{len(calls)} {tool} calls fail {sorted({p for m in bad for p in m})} {where}")
        return _ok(name)
    if any(not miss for miss in misses):
        return _ok(name)
    return _fail(name, f"no {tool} call matched {where}")


def check_tiles_none_match(record: dict[str, Any], predicates: list[dict[str, Any]]) -> CheckResult:
    offenders = [
        f"{_tile_label(card)} matches {_spec_label(predicate)}"
        for card in _tiles(record)
        for predicate in predicates
        if tile_matches(card, predicate)
    ]
    if offenders:
        return _fail("tiles_none_match", "; ".join(offenders[:3]) + (f" (+{len(offenders) - 3})" if len(offenders) > 3 else ""))
    return _ok("tiles_none_match")


def check_tiles_min(record: dict[str, Any], minimum: int) -> CheckResult:
    count = len(_tiles(record))
    return _ok("tiles_min") if count >= minimum else _fail("tiles_min", f"{count} tiles, expected >= {minimum}")


def check_tiles_max(record: dict[str, Any], maximum: int) -> CheckResult:
    count = len(_tiles(record))
    return _ok("tiles_max") if count <= maximum else _fail("tiles_max", f"{count} tiles, expected <= {maximum}: {_tiles_text(_tiles(record))}")


def check_tiles_exact(record: dict[str, Any], spec: Any) -> CheckResult:
    """Exactly these tiles (each spec a card id or a tile predicate); order only if ordered: true."""
    specs, ordered = tile_specs(spec)
    cards = _tiles(record)
    if ordered:
        ok = len(cards) == len(specs) and all(tile_matches(card, item) for card, item in zip(cards, specs))
    else:
        ok = _perfect_match(cards, specs)
    if ok:
        return _ok("tiles_exact")
    return _fail(
        "tiles_exact",
        f"tiles {_tiles_text(cards)} != expected {'(in order) ' if ordered else ''}{[_spec_label(item) for item in specs]}",
    )


def check_tiles_include(record: dict[str, Any], spec: Any) -> CheckResult:
    specs, _ = tile_specs(spec)
    cards = _tiles(record)
    missing = [_spec_label(item) for item in specs if not any(tile_matches(card, item) for card in cards)]
    if missing:
        return _fail("tiles_include", f"no tile for {missing} (tiles: {_tiles_text(cards)})")
    return _ok("tiles_include")


def check_tiles_within(record: dict[str, Any], spec: Any) -> CheckResult:
    specs, _ = tile_specs(spec)
    extra = [_tile_label(card) for card in _tiles(record) if not any(tile_matches(card, item) for item in specs)]
    if extra:
        return _fail("tiles_within", f"tiles the answer isn't about: {extra}")
    return _ok("tiles_within")


def _tile_quantity(card: dict[str, Any]) -> Any:
    # Direct-add tiles carry quantity_owned (owned after the add); the L007 fixture
    # clears prior copies so that equals the amount added.
    for key in ("quantity", "quantity_added", "quantity_owned"):
        if card.get(key) is not None:
            return card[key]
    return None


def check_tile_quantity(record: dict[str, Any], spec: dict[str, Any]) -> CheckResult:
    """spec = {card_id | match: predicate, quantity: N}. Skips while tiles carry no quantity."""
    predicate = spec.get("match") or spec.get("card_id")
    matches = [card for card in _tiles(record) if tile_matches(card, predicate)]
    if not matches:
        return _fail("tile_quantity", f"no tile for {_spec_label(predicate)}")
    quantities = [_tile_quantity(card) for card in matches]
    if all(value is None for value in quantities):
        return _skip("tile_quantity", "tiles carry no quantity field yet")
    if any(value is not None and _equals(value, spec["quantity"]) for value in quantities):
        return _ok("tile_quantity")
    return _fail("tile_quantity", f"tile quantity {quantities}, expected {spec['quantity']}")


def check_tiles_label(record: dict[str, Any], pattern: str) -> CheckResult:
    if not _tiles(record):
        return _ok("tiles_label")
    if "cards_label" not in record:
        return _skip("tiles_label", "reply has no cards_label yet")
    label = record.get("cards_label")
    if label and re.search(pattern, str(label), re.IGNORECASE):
        return _ok("tiles_label")
    return _fail("tiles_label", f"label {label!r} does not match {pattern!r}")


def check_tiles_sorted(record: dict[str, Any], by: str) -> CheckResult:
    """Descending by price (`price`) or price x quantity owned (`value`)."""
    cards = _tiles(record)
    keys = []
    for card in cards:
        price = _price(card)
        quantity = card.get("quantity_owned") or card.get("quantity") or 1
        if price is None:
            return _skip("tiles_sorted", f"{_tile_label(card)} has no price")
        keys.append(price * float(quantity) if by == "value" else price)
    if all(a >= b - 0.005 for a, b in zip(keys, keys[1:])):
        return _ok("tiles_sorted")
    return _fail("tiles_sorted", f"tiles not sorted by {by} desc: {[round(k, 2) for k in keys]}")


def check_tiles_price_trusted(record: dict[str, Any]) -> CheckResult:
    """No tile may show a price the tool marked price_trusted=false (e.g. the $999,999 placeholder)."""
    flags: dict[tuple[str, str, str], bool] = {}
    for item in _tool_results(record):
        for card in result_cards(item.get("data")):
            if "price_trusted" in card:
                key = (str(card["card_id"]), str(card.get("grader") or ""), str(card.get("grade") or ""))
                flags[key] = flags.get(key, True) and bool(card["price_trusted"])
    if not flags:
        return _skip("tiles_price_trusted", "tool results carry no price_trusted yet")
    bad = []
    for card in _tiles(record):
        key = (str(card.get("card_id")), str(card.get("grader") or ""), str(card.get("grade") or ""))
        if flags.get(key) is False:
            bad.append(_tile_label(card))
    return _fail("tiles_price_trusted", f"untrusted prices shown: {bad}") if bad else _ok("tiles_price_trusted")


def named_cards(record: dict[str, Any]) -> list[str]:
    """Card names (from tool results and the scanner tray) that the answer text mentions;
    longest names win so 'Charizard ex' doesn't also count as 'Charizard'."""
    names: set[str] = set()
    for item in _tool_results(record):
        names.update(str(card["name"]).strip() for card in result_cards(item.get("data")))
    for card in record.get("context_cards") or []:
        if isinstance(card, dict) and card.get("name"):
            names.add(str(card["name"]).strip())
    answer = str(record.get("answer") or "")
    taken: list[tuple[int, int]] = []
    found: list[str] = []
    for name in sorted((n for n in names if len(n) >= 3), key=len, reverse=True):
        for match in re.finditer(r"(?<!\w)" + re.escape(name) + r"(?!\w)", answer, re.IGNORECASE):
            if any(start < match.end() and match.start() < end for start, end in taken):
                continue
            taken.append(match.span())
            if name not in found:
                found.append(name)
    return found


def check_named_cards_in_tiles(record: dict[str, Any]) -> CheckResult:
    tile_names = [str(card.get("name") or "").strip().casefold() for card in _tiles(record)]
    missing = [
        name for name in named_cards(record)
        if not any(tile == name.casefold() or tile.startswith(name.casefold() + " ") for tile in tile_names)
    ]
    if missing:
        return _fail("named_cards_in_tiles", f"named in the text but not a tile: {missing}")
    return _ok("named_cards_in_tiles")


def _named_tile(tile_name: str, names: list[str]) -> bool:
    tile_name = tile_name.strip().casefold()
    return any(tile_name == name.casefold() or tile_name.startswith(name.casefold() + " ") for name in names)


def check_tiles_all_named(record: dict[str, Any]) -> CheckResult:
    """Every tile is a card the answer names (no un-named extras)."""
    names = named_cards(record)
    extra = [_tile_label(card) for card in _tiles(record) if not _named_tile(str(card.get("name") or ""), names)]
    if extra:
        return _fail("tiles_all_named", f"tiles the answer doesn't name: {extra}")
    return _ok("tiles_all_named")


def _result_keys(record: dict[str, Any], tools: list[str]) -> list[tuple[str, str, str]]:
    keys = []
    for tool in tools:
        for item in _tool_results(record, tool):
            for card in result_cards(item.get("data")):
                keys.append((str(card["card_id"]), str(card.get("grader") or ""), str(card.get("grade") or "")))
    return keys


def _tile_in(card: dict[str, Any], keys: list[tuple[str, str, str]]) -> bool:
    card_id, grader, grade = str(card.get("card_id")), str(card.get("grader") or ""), str(card.get("grade") or "")
    return any(key[0] == card_id and (not grader or (key[1].casefold(), key[2]) == (grader.casefold(), grade))
               for key in keys)


def check_tiles_from_tools(record: dict[str, Any], tools: list[str]) -> CheckResult:
    """Every tile came out of these tools' results (same card, and same slab for a graded tile)."""
    keys = _result_keys(record, tools)
    if not keys:
        return _fail("tiles_from_tools", f"no cards in {tools} results")
    extra = [_tile_label(card) for card in _tiles(record) if not _tile_in(card, keys)]
    if extra:
        return _fail("tiles_from_tools", f"tiles not in {tools} results: {extra}")
    return _ok("tiles_from_tools")


def tops(value: Any) -> list[str]:
    """tiles_include_top: one tool name or a list of them."""
    if not value:
        return []
    return [str(item) for item in value] if isinstance(value, list) else [str(value)]


def check_tiles_include_top(record: dict[str, Any], tool: str) -> CheckResult:
    """The tool's first (top-ranked) result card is a tile (same slab when graded)."""
    keys = _result_keys(record, [tool])
    if not keys:
        return _fail("tiles_include_top", f"no cards in {tool} results")
    top = keys[0]
    if any(_tile_in(card, [top]) and bool(card.get("grader")) == bool(top[1]) for card in _tiles(record)):
        return _ok("tiles_include_top")
    return _fail("tiles_include_top", f"top {tool} result {top} is not a tile (tiles: {_tiles_text(_tiles(record))})")


def check_chart(record: dict[str, Any]) -> CheckResult:
    if record.get("chart_series") or record.get("charts"):
        return _ok("chart_required")
    return _fail("chart_required", "no price chart attached")


def check_no_chart(record: dict[str, Any]) -> CheckResult:
    if record.get("chart_series") or record.get("charts"):
        return _fail("no_chart", "a chart is attached but there should be no history to draw")
    return _ok("no_chart")


def check_chart_card_matches_tile(record: dict[str, Any]) -> CheckResult:
    """One tile + its chart: same card id (and variant when both carry one)."""
    cards = _tiles(record)
    charts = record.get("chart_series") or []
    if len(cards) != 1:
        return _fail("chart_card_matches_tile", f"{len(cards)} tiles, expected exactly 1: {_tiles_text(cards)}")
    if not charts:
        return _fail("chart_card_matches_tile", "no chart attached")
    tile = cards[0]
    for chart in charts:
        if str(chart.get("card_id")) != str(tile.get("card_id")):
            return _fail("chart_card_matches_tile", f"chart {chart.get('card_id')} != tile {tile.get('card_id')}")
        if chart.get("variant") and tile.get("variant") and not _same(chart["variant"], tile["variant"]):
            return _fail("chart_card_matches_tile", f"chart variant {chart['variant']} != tile variant {tile['variant']}")
    return _ok("chart_card_matches_tile")


def check_max_words(record: dict[str, Any], limit: int) -> CheckResult:
    count = word_count(record.get("answer") or "")
    return _ok("max_words") if count <= limit else _fail("max_words", f"{count} words > {limit}")


def check_must_not_contain(record: dict[str, Any], patterns: dict[str, str], name: str = "must_not_contain") -> CheckResult:
    answer = str(record.get("answer") or "")
    hits = []
    for label, pattern in patterns.items():
        found = re.search(pattern, answer, re.IGNORECASE)
        if found:
            hits.append(f"{label}: {found.group(0)!r}")
    return _fail(name, "; ".join(hits)) if hits else _ok(name)


def check_must_contain_any(record: dict[str, Any], needles: list[str]) -> CheckResult:
    answer = str(record.get("answer") or "").casefold()
    if any(str(needle).casefold() in answer for needle in needles):
        return _ok("must_contain_any")
    return _fail("must_contain_any", f"answer has none of {needles}")


def check_actions(record: dict[str, Any], expected: dict[str, Any] | None) -> CheckResult:
    actions = [a for a in record.get("action_details") or [] if str(a.get("state") or "proposed") == "proposed"]
    if expected is None:
        if actions:
            return _fail("actions", f"unexpected proposed actions: {[a.get('summary') or a.get('type') for a in actions]}")
        return _ok("actions")
    wanted_type = expected.get("type")
    params = expected.get("params") or {}
    typed = [action for action in actions if action.get("type") == wanted_type]
    if not typed:
        return _fail("actions", f"no {wanted_type} action proposed (got {[a.get('type') for a in actions]})")
    for action in typed:
        args = action.get("params") or {}
        if all(value_matches(_lookup(args, path), matcher) for path, matcher in params.items()):
            return _ok("actions")
    return _fail("actions", f"{wanted_type} params {[a.get('params') for a in typed]} do not match {params}")


def check_proposed_card_ids(record: dict[str, Any], card_ids: list[str]) -> CheckResult:
    """The add proposals cover exactly these cards (e.g. both scanned cards)."""
    proposed = sorted(
        str((a.get("params") or {}).get("card_id"))
        for a in record.get("action_details") or []
        if a.get("type") == "add_to_collection" and str(a.get("state") or "proposed") == "proposed"
    )
    if proposed == sorted(card_ids):
        return _ok("proposed_card_ids")
    return _fail("proposed_card_ids", f"proposed {proposed}, expected {sorted(card_ids)}")


def _successful_writes(record: dict[str, Any]) -> list[dict[str, Any]]:
    """Direct-add calls that wrote. add_to_collection_now falls back to a proposal
    (no error, added=false) when details aren't exact, so the result decides."""
    calls = [call for call in record.get("tool_args") or [] if isinstance(call, dict)]
    results = record.get("tool_results") or []
    paired = len(results) == len(calls)
    writes = []
    for index, call in enumerate(calls):
        if call.get("name") not in WRITE_TOOLS or call.get("is_error"):
            continue
        data = results[index].get("data") if paired and isinstance(results[index], dict) else None
        if isinstance(data, dict) and "added" in data and data["added"] is not True:
            continue
        writes.append(call)
    return writes


def check_expect_write(record: dict[str, Any], spec: dict[str, Any], known_tools: frozenset[str] | None = None) -> CheckResult:
    """A direct add ran (add_to_collection_now succeeded) with these arguments."""
    if all(_planned_absent(tool, known_tools) for tool in WRITE_TOOLS):
        return _skip("expect_write", "add_to_collection_now not in this build")
    params = spec.get("params") or {}
    writes = _successful_writes(record)
    if not writes:
        return _fail("expect_write", "no successful direct add")
    for call in writes:
        args = call.get("arguments") or {}
        if all(value_matches(_lookup(args, path), matcher) for path, matcher in params.items()):
            return _ok("expect_write")
    return _fail("expect_write", f"write args {[c.get('arguments') for c in writes]} do not match {params}")


def check_expect_no_write(record: dict[str, Any]) -> CheckResult:
    writes = _successful_writes(record)
    if writes:
        return _fail("expect_no_write", f"wrote without being asked to: {[c.get('arguments') for c in writes]}")
    return _ok("expect_no_write")


def _has_undo(node: Any) -> bool:
    if isinstance(node, list):
        return any(_has_undo(item) for item in node)
    if isinstance(node, dict):
        if "undo" in str(node.get("type") or "").casefold():
            return True
        return any(("undo" in str(key).casefold() and bool(value)) or _has_undo(value) for key, value in node.items())
    return False


def check_undo_offered(record: dict[str, Any], known_tools: frozenset[str] | None = None) -> CheckResult:
    if all(_planned_absent(tool, known_tools) for tool in WRITE_TOOLS):
        return _skip("undo_offered", "add_to_collection_now not in this build")
    write_results = [item.get("data") for tool in WRITE_TOOLS for item in _tool_results(record, tool)]
    if _has_undo(record.get("action_details") or []) or _has_undo(write_results):
        return _ok("undo_offered")
    return _fail("undo_offered", "no Undo affordance on the reply or the write result")


def check_tool_result_where(record: dict[str, Any], spec: dict[str, Any], known_tools: frozenset[str] | None = None) -> CheckResult:
    """spec = {tool, where: {path: matcher}}: some call's result meets every condition.
    Conditions whose field is absent from every result are skipped (planned fields)."""
    tool = spec["tool"]
    name = f"tool_result:{tool}"
    if _planned_absent(tool, known_tools):
        return _skip(name, f"planned tool {tool} not in this build")
    results = [item.get("data") for item in _tool_results(record, tool) if item.get("data") is not None]
    if not results:
        return _fail(name, f"no {tool} result")
    where = {path: matcher for path, matcher in (spec.get("where") or {}).items()
             if any(_lookup_all(data, path) for data in results)}
    absent = sorted(set(spec.get("where") or {}) - set(where))
    if not where:
        return _skip(name, f"fields {absent} not in {tool} results yet")
    for data in results:
        if all(any(value_matches(value, matcher) for value in _lookup_all(data, path)) for path, matcher in where.items()):
            return _ok(name)
    return _fail(name, f"no {tool} result has {where}")


_MONTHS = ("january", "february", "march", "april", "may", "june", "july", "august", "september", "october",
           "november", "december")


def check_history_range_stated(record: dict[str, Any]) -> CheckResult:
    """When history doesn't cover the asked range, the answer must say where it starts
    (month name, 'Mon', or the date). Skips until results carry covers_full_range."""
    flagged = [
        item["data"] for item in _tool_results(record, "get_price_history")
        if isinstance(item.get("data"), dict) and "covers_full_range" in item["data"]
    ]
    partial = [data for data in flagged if data.get("covers_full_range") is False]
    if not flagged:
        return _skip("history_range_stated", "price history has no covers_full_range yet")
    if not partial:
        return _ok("history_range_stated")
    answer = str(record.get("answer") or "").casefold()
    for data in partial:
        first = str(data.get("first_date") or "")[:10]
        try:
            month = _MONTHS[date.fromisoformat(first).month - 1]
        except ValueError:
            month = None
        if first and (first in answer or (month and (month in answer or re.search(rf"\b{month[:3]}\b", answer)))):
            return _ok("history_range_stated")
    return _fail("history_range_stated", f"history starts {partial[0].get('first_date')} but the answer doesn't say so")


def check_max_cost(record: dict[str, Any], ceiling: float) -> CheckResult:
    cost = float(record.get("cost_usd") or 0.0)
    return _ok("max_cost_usd") if cost <= ceiling else _fail("max_cost_usd", f"${cost:.4f} > ${ceiling:.4f}")


def grade_turn(
    record: dict[str, Any],
    expect: dict[str, Any] | None,
    defaults: dict[str, Any] | None = None,
    known_tools: frozenset[str] | None = None,
) -> list[CheckResult]:
    """All deterministic checks for one turn. `defaults` (cases file top level)
    supplies status/max_words/max_cost_usd/banned; a turn's `allow` drops banned
    patterns by name and its own keys override the defaults. `known_tools` = the
    build's assistant tools (None = assume every planned tool exists)."""
    expect = dict(expect or {})
    defaults = defaults or {}
    if record.get("error") or str(record.get("status") or "").startswith("http_"):
        return [_fail("status", f"request failed: {record.get('status')} {record.get('error')}")]
    results = [check_status(record, expect.get("status", defaults.get("status", "ok")))]
    if expect.get("tools_any"):
        results.append(check_tools_any(record, expect["tools_any"], known_tools))
    if expect.get("tools_all"):
        results.append(check_tools_all(record, expect["tools_all"], known_tools))
    if expect.get("tools_none"):
        results.append(check_tools_none(record, expect["tools_none"]))
    for spec in expect.get("tool_args") or []:
        results.append(check_tool_args(record, spec, known_tools))
    for spec in expect.get("tool_result_where") or []:
        results.append(check_tool_result_where(record, spec, known_tools))
    if expect.get("tiles_none_match"):
        results.append(check_tiles_none_match(record, expect["tiles_none_match"]))
    if expect.get("tiles_min"):
        results.append(check_tiles_min(record, int(expect["tiles_min"])))
    if "tiles_max" in expect:
        results.append(check_tiles_max(record, int(expect["tiles_max"])))
    if "tiles_exact" in expect:
        results.append(check_tiles_exact(record, expect["tiles_exact"]))
    if expect.get("tiles_include"):
        results.append(check_tiles_include(record, expect["tiles_include"]))
    if expect.get("tiles_within"):
        results.append(check_tiles_within(record, expect["tiles_within"]))
    if expect.get("tile_quantity"):
        results.append(check_tile_quantity(record, expect["tile_quantity"]))
    if expect.get("tiles_label"):
        results.append(check_tiles_label(record, expect["tiles_label"]))
    if expect.get("tiles_sorted"):
        results.append(check_tiles_sorted(record, expect["tiles_sorted"]))
    if expect.get("tiles_price_trusted"):
        results.append(check_tiles_price_trusted(record))
    if expect.get("named_cards_in_tiles"):
        results.append(check_named_cards_in_tiles(record))
    if expect.get("tiles_all_named"):
        results.append(check_tiles_all_named(record))
    if expect.get("tiles_from_tools"):
        results.append(check_tiles_from_tools(record, list(expect["tiles_from_tools"])))
    for tool in tops(expect.get("tiles_include_top")):
        results.append(check_tiles_include_top(record, tool))
    if expect.get("chart_required"):
        results.append(check_chart(record))
    if expect.get("no_chart"):
        results.append(check_no_chart(record))
    if expect.get("chart_card_matches_tile"):
        results.append(check_chart_card_matches_tile(record))
    if expect.get("history_range_stated"):
        results.append(check_history_range_stated(record))
    max_words = expect.get("max_words", defaults.get("max_words"))
    if max_words:
        results.append(check_max_words(record, int(max_words)))
    allowed = set(expect.get("allow") or [])
    banned = {label: pattern for label, pattern in (defaults.get("banned") or {}).items() if label not in allowed}
    if banned:
        results.append(check_must_not_contain(record, banned, name="banned"))
    if expect.get("must_not_contain"):
        extra = {f"pattern{i}": pattern for i, pattern in enumerate(expect["must_not_contain"], start=1)}
        results.append(check_must_not_contain(record, extra))
    if expect.get("must_contain_any"):
        results.append(check_must_contain_any(record, expect["must_contain_any"]))
    if not expect.get("actions_allowed"):
        results.append(check_actions(record, expect.get("expect_action")))
    if expect.get("proposed_card_ids"):
        results.append(check_proposed_card_ids(record, expect["proposed_card_ids"]))
    if expect.get("expect_write"):
        results.append(check_expect_write(record, expect["expect_write"], known_tools))
    if expect.get("expect_no_write"):
        results.append(check_expect_no_write(record))
    if expect.get("undo_offered"):
        results.append(check_undo_offered(record, known_tools))
    ceiling = expect.get("max_cost_usd", defaults.get("max_cost_usd"))
    if ceiling:
        results.append(check_max_cost(record, float(ceiling)))
    return results


# --- LLM judge -------------------------------------------------------------------
# Rubrics are lists of narrow yes/no criteria; the judge answers each one and the
# turn passes only if all are yes. Deterministic checks stay the primary gate.

JUDGE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "criteria": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {"n": {"type": "integer"}, "pass": {"type": "boolean"}},
                "required": ["n", "pass"],
                "additionalProperties": False,
            },
        },
        "reason": {"type": "string", "description": "At most 30 words; name the failed criterion's problem."},
    },
    "required": ["criteria", "reason"],
    "additionalProperties": False,
}

JUDGE_SYSTEM = """You check one answer from "Ask Ekalight", the AI assistant in a trading-card collection app, against numbered yes/no criteria. Answer each criterion strictly and literally: pass=true only if the answer clearly meets it.
App conventions (not mistakes): card tiles (name, set, price, image) show under the answer, so the text needn't list cards or prices; USD only; watched cards = "Watchlist". Writes are proposed for the user to Confirm, except a fully specified single add (exact printing, quantity, condition), which is done directly and offers Undo. Real app features: users can delete or edit a card themselves from its ⋯ menu in Collection or on its card page.
A reference answer, when given, shows what a good answer says: equivalent meaning passes; exact wording is not required. Its numbers may be stale, so check facts against the tool results and scanner context, not the reference.
Return one {n, pass} per criterion and a reason of at most 30 words."""

MAX_TOOL_RESULT_CHARS = 12000


def rubric_criteria(rubric: Any) -> list[str]:
    if isinstance(rubric, str):
        return [rubric.strip()] if rubric.strip() else []
    return [str(item).strip() for item in rubric or [] if str(item).strip()]


@dataclass
class JudgeResult:
    passed: bool
    score: int  # criteria passed
    reason: str
    total: int = 0
    criteria: list[bool] | None = None
    cost_usd: float = 0.0
    model: str | None = None
    error: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def judge_model() -> str:
    return (os.environ.get(JUDGE_MODEL_ENV) or DEFAULT_JUDGE_MODEL).strip()


def _money(value: Any) -> str:
    return f"${value:,.2f}" if isinstance(value, (int, float)) and not isinstance(value, bool) else "no price"


def _card_line(card: dict[str, Any]) -> str:
    parts = [str(card.get("card_id")), str(card.get("name"))]
    where = " ".join(p for p in (str(card.get("set") or ""), f"#{card['number']}" if card.get("number") else "") if p)
    if where:
        parts.append(where)
    if card.get("language") and str(card["language"]).casefold() != "english":
        parts.append(str(card["language"]))
    if card.get("grader"):
        parts.append(f"{card['grader']} {card.get('grade')}")
    if card.get("variant"):
        parts.append(str(card["variant"]))
    parts.append(_money(card.get("price_usd")))
    extras = [
        f"{key}={value}" for key, value in card.items()
        if key not in ("card_id", "name", "set", "number", "language", "grader", "grade", "variant", "price_usd")
    ]
    if extras:
        parts.append(", ".join(extras))
    return "  - " + " | ".join(parts)


def compact_tool_results(record: dict[str, Any], budget: int = MAX_TOOL_RESULT_CHARS) -> str:
    """Per-tool compact view for the judge: key scalar fields, then one line per card.
    Cards the answer names go in first; the rest fill what's left of the budget."""
    answer = str(record.get("answer") or "").casefold()
    items = _tool_results(record)
    if not items:
        return ""
    blocks: list[dict[str, Any]] = []
    for item in items:
        data = item.get("data")
        header = f"{item.get('call') or item.get('name')}" + (" [ERROR]" if item.get("is_error") else "")
        if data is None:
            blocks.append({"header": header, "raw": str(item.get("result") or ""), "cards": []})
            continue
        fields = result_fields(data)
        if fields:
            header += " -> " + _clip(json.dumps(fields, ensure_ascii=False, default=str), 900)
        cards = [_card_line(card) for card in result_cards(data)]
        named = [str(card.get("name") or "").casefold() in answer for card in result_cards(data)]
        blocks.append({"header": header, "cards": cards, "named": named, "keep": [False] * len(cards)})
    remaining = budget - sum(len(block["header"]) + 1 for block in blocks)
    for block in blocks:  # raw fallbacks (older records) get a fair share
        if "raw" in block:
            share = max(200, min(1500, remaining // max(1, len(blocks))))
            block["raw"] = _clip(block["raw"], share)
            remaining -= len(block["raw"])
    for want_named in (True, False):
        for block in blocks:
            for index, line in enumerate(block["cards"]):
                if block["keep"][index] or block["named"][index] != want_named:
                    continue
                if len(line) + 1 > remaining:
                    continue
                block["keep"][index] = True
                remaining -= len(line) + 1
    lines = []
    for block in blocks:
        lines.append(block["header"] + (f" -> {block['raw']}" if "raw" in block else ""))
        kept = [line for line, keep in zip(block["cards"], block.get("keep", [])) if keep]
        lines += kept
        dropped = len(block["cards"]) - len(kept)
        if dropped:
            lines.append(f"  (+{dropped} more cards not shown)")
    return "\n".join(lines)


def judge_prompt(criteria: list[str], record: dict[str, Any], prior_turns: list[dict[str, Any]] | None = None) -> str:
    lines: list[str] = []
    for prior in prior_turns or []:
        lines.append(f"[Earlier] User: {_clip(prior.get('question'), 300)}")
        lines.append(f"[Earlier] Assistant: {_clip(prior.get('answer'), 600)}")
        if prior.get("tiles"):
            lines.append(f"[Earlier] Tiles: {'; '.join(prior['tiles'][:8])}")
    if record.get("scanner_context"):
        lines.append(f"Scanner context the assistant saw:\n{record['scanner_context']}")
    elif record.get("context_card_ids"):
        lines.append(f"Scanner tray card ids: {', '.join(record['context_card_ids'])}")
    lines.append(f"User: {record.get('question')}")
    lines.append(f"Answer:\n{_clip(record.get('answer'), 2500)}")
    results = compact_tool_results(record)
    if results:
        lines.append("Tool results (compact):\n" + results)
    else:
        lines.append(f"Tool calls: {'; '.join(record.get('tool_calls') or []) or 'none'}")
    tiles = record.get("tiles") or []
    label = f" labelled {record['cards_label']!r}" if record.get("cards_label") else ""
    lines.append(f"Tiles shown{label} ({len(tiles)}): {'; '.join(tiles[:12]) or 'none'}")
    if record.get("charts"):
        lines.append(f"Charts: {'; '.join(record['charts'])}")
    actions = [a for a in record.get("actions") or [] if a]
    if actions:
        lines.append(f"Actions: {'; '.join(actions)}")
    if record.get("reference"):
        lines.append(f"\nReference answer (guidance; equivalent meaning passes, exact wording not required):\n{record['reference']}")
    lines.append("\nCriteria:")
    lines += [f"{n}. {criterion}" for n, criterion in enumerate(criteria, start=1)]
    return "\n".join(lines)


def _judge_cost(usage: Any, model: str) -> float:
    input_price, output_price = JUDGE_PRICES.get(model, JUDGE_PRICES["claude-opus-5-5"])

    def tokens(name: str) -> int:
        value = getattr(usage, name, None)
        return int(value) if isinstance(value, (int, float)) else 0

    per_input = input_price / 1_000_000
    return (
        tokens("input_tokens") * per_input
        + tokens("cache_read_input_tokens") * per_input * 0.1
        + tokens("cache_creation_input_tokens") * per_input * 1.25
        + tokens("output_tokens") * output_price / 1_000_000
    )


def judge_turn(
    client: Any,
    rubric: Any,
    record: dict[str, Any],
    prior_turns: list[dict[str, Any]] | None = None,
    *,
    model: str | None = None,
) -> JudgeResult:
    """One judge call (sync `anthropic.Anthropic` client or a test double).
    No sampling params or thinking config (current models reject them); effort low."""
    model = model or judge_model()
    criteria = rubric_criteria(rubric)
    if not criteria:
        return JudgeResult(False, 0, "", model=model, error="empty rubric")
    try:
        response = client.messages.create(
            model=model,
            max_tokens=2000,
            system=JUDGE_SYSTEM,
            messages=[{"role": "user", "content": judge_prompt(criteria, record, prior_turns)}],
            output_config={"effort": "low", "format": {"type": "json_schema", "schema": JUDGE_SCHEMA}},
        )
    except Exception as error:  # noqa: BLE001 - any SDK/network failure = judge error, not a verdict
        return JudgeResult(False, 0, "", total=len(criteria), error=f"{type(error).__name__}: {_clip(error, 200)}", model=model)
    cost = _judge_cost(getattr(response, "usage", None), model)
    if getattr(response, "stop_reason", None) == "refusal":
        return JudgeResult(False, 0, "", total=len(criteria), cost_usd=cost, model=model, error="judge refused")
    text = "".join(
        str(getattr(block, "text", "")) for block in getattr(response, "content", None) or []
        if getattr(block, "type", None) == "text"
    )
    try:
        verdict = json.loads(text)
        by_number = {int(item["n"]): item["pass"] for item in verdict["criteria"]}
        if not all(isinstance(value, bool) for value in by_number.values()):
            raise ValueError("pass is not a boolean")
        reason = str(verdict.get("reason") or "")
    except (ValueError, KeyError, TypeError) as error:
        return JudgeResult(False, 0, "", total=len(criteria), cost_usd=cost, model=model, error=f"unparseable verdict: {error}")
    # A criterion the judge skipped counts as a fail.
    results = [by_number.get(n, False) for n in range(1, len(criteria) + 1)]
    return JudgeResult(
        all(results), sum(results), " ".join(reason.split()[:30]), total=len(criteria), criteria=results,
        cost_usd=cost, model=model,
    )


def judge_check(result: JudgeResult) -> CheckResult:
    if result.error:
        return _fail("judge", f"judge error: {result.error}")
    failed = [str(n) for n, ok in enumerate(result.criteria or [], start=1) if not ok]
    reason = f"{result.score}/{result.total}" + (f" (failed #{', #'.join(failed)})" if failed else "") + f": {result.reason}"
    return CheckResult("judge", result.passed, reason)
