"""Graders for one assistant turn.

(a) Deterministic checks: `grade_turn(record, expect, defaults)` -> [CheckResult].
(b) LLM judge: `judge_turn(client, ...)` -> JudgeResult (Anthropic SDK,
    structured JSON output).

A turn record is what tools/assistant_eval.py emits per turn:
  question, status ("ok" | "error" | "http_<code>"), answer, tools [names],
  tool_calls ["name(k=v, ...)"], tool_args [{name, arguments, is_error}],
  cards [{card_id, name, set, number, language, price_usd, grader, grade, variant}],
  chart_series [{card_id, name, range, points}], action_details [{type, params, summary}],
  cost_usd.
"""

from __future__ import annotations

import json
import os
import re
from dataclasses import asdict, dataclass
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
    }
)
MATCHER_OPS = frozenset({"not", "in", "not_in", "exists", "contains", "gte", "lte"})
TILE_PREDICATE_KEYS = frozenset({"game", "game_not", "sealed", "japanese", "id_contains", "id_prefix", "name_regex"})


@dataclass
class CheckResult:
    name: str
    passed: bool
    reason: str = ""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def _ok(name: str) -> CheckResult:
    return CheckResult(name, True)


def _fail(name: str, reason: str) -> CheckResult:
    return CheckResult(name, False, reason)


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


# --- tiles -----------------------------------------------------------------------


def card_game(card_id: str) -> str:
    head, sep, _ = str(card_id).partition("~")
    return head if sep and head in KNOWN_GAMES else "pokemon"


def _provider_id(card_id: str) -> str:
    head, sep, rest = str(card_id).partition("~")
    return rest if sep and head in KNOWN_GAMES else str(card_id)


def tile_is_japanese(card: dict[str, Any]) -> bool:
    return str(card.get("language") or "").casefold() == "japanese" or "_ja-" in str(card.get("card_id") or "")


def tile_matches(card: dict[str, Any], predicate: dict[str, Any]) -> bool:
    card_id = str(card.get("card_id") or "")
    for key, expected in predicate.items():
        if key == "game" and card_game(card_id) != expected:
            return False
        if key == "game_not" and card_game(card_id) == expected:
            return False
        if key == "sealed" and _provider_id(card_id).startswith(SEALED_ID_PREFIX) != bool(expected):
            return False
        if key == "japanese" and tile_is_japanese(card) != bool(expected):
            return False
        if key == "id_contains" and str(expected) not in card_id:
            return False
        if key == "id_prefix" and not _provider_id(card_id).startswith(str(expected)):
            return False
        if key == "name_regex" and not re.search(str(expected), str(card.get("name") or ""), re.IGNORECASE):
            return False
    return True


def _tile_label(card: dict[str, Any]) -> str:
    return f"{card.get('name')} [{card.get('card_id')}]"


# --- checks ----------------------------------------------------------------------


def word_count(text: str) -> int:
    return len(re.findall(r"[^\s*_#>`-]\S*", str(text or "")))


def check_status(record: dict[str, Any], expected: str = "ok") -> CheckResult:
    status = record.get("status")
    return _ok("status") if status == expected else _fail("status", f"status {status!r}, expected {expected!r}")


def check_tools_any(record: dict[str, Any], names: list[str]) -> CheckResult:
    used = set(record.get("tools") or [])
    if used & set(names):
        return _ok("tools_any")
    return _fail("tools_any", f"none of {names} called (called: {sorted(used) or 'nothing'})")


def check_tools_all(record: dict[str, Any], names: list[str]) -> CheckResult:
    missing = [name for name in names if name not in set(record.get("tools") or [])]
    return _fail("tools_all", f"not called: {missing}") if missing else _ok("tools_all")


def check_tools_none(record: dict[str, Any], names: list[str]) -> CheckResult:
    bad = sorted(set(record.get("tools") or []) & set(names))
    return _fail("tools_none", f"should not call: {bad}") if bad else _ok("tools_none")


def check_tool_args(record: dict[str, Any], spec: dict[str, Any]) -> CheckResult:
    """spec = {tool, where: {path: matcher}, mode: any|all}. any (default): at least
    one call of `tool` satisfies every condition. all: every call does (and >=1 exists)."""
    tool = spec["tool"]
    where = spec.get("where") or {}
    mode = spec.get("mode", "any")
    name = f"tool_args:{tool}"
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
        f"{_tile_label(card)} matches {predicate}"
        for card in record.get("cards") or []
        for predicate in predicates
        if tile_matches(card, predicate)
    ]
    if offenders:
        return _fail("tiles_none_match", "; ".join(offenders[:3]) + (f" (+{len(offenders) - 3})" if len(offenders) > 3 else ""))
    return _ok("tiles_none_match")


def check_tiles_min(record: dict[str, Any], minimum: int) -> CheckResult:
    count = len(record.get("cards") or [])
    return _ok("tiles_min") if count >= minimum else _fail("tiles_min", f"{count} tiles, expected >= {minimum}")


def check_chart(record: dict[str, Any]) -> CheckResult:
    if record.get("chart_series") or record.get("charts"):
        return _ok("chart_required")
    return _fail("chart_required", "no price chart attached")


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
    actions = record.get("action_details") or []
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


def check_max_cost(record: dict[str, Any], ceiling: float) -> CheckResult:
    cost = float(record.get("cost_usd") or 0.0)
    return _ok("max_cost_usd") if cost <= ceiling else _fail("max_cost_usd", f"${cost:.4f} > ${ceiling:.4f}")


def grade_turn(record: dict[str, Any], expect: dict[str, Any] | None, defaults: dict[str, Any] | None = None) -> list[CheckResult]:
    """All deterministic checks for one turn. `defaults` (cases file top level)
    supplies status/max_words/max_cost_usd/banned; a turn's `allow` drops banned
    patterns by name and its own keys override the defaults."""
    expect = dict(expect or {})
    defaults = defaults or {}
    if record.get("error") or str(record.get("status") or "").startswith("http_"):
        return [_fail("status", f"request failed: {record.get('status')} {record.get('error')}")]
    results = [check_status(record, expect.get("status", defaults.get("status", "ok")))]
    if expect.get("tools_any"):
        results.append(check_tools_any(record, expect["tools_any"]))
    if expect.get("tools_all"):
        results.append(check_tools_all(record, expect["tools_all"]))
    if expect.get("tools_none"):
        results.append(check_tools_none(record, expect["tools_none"]))
    for spec in expect.get("tool_args") or []:
        results.append(check_tool_args(record, spec))
    if expect.get("tiles_none_match"):
        results.append(check_tiles_none_match(record, expect["tiles_none_match"]))
    if expect.get("tiles_min"):
        results.append(check_tiles_min(record, int(expect["tiles_min"])))
    if expect.get("chart_required"):
        results.append(check_chart(record))
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
App conventions (not mistakes): card tiles (name, set, price, image) show under the answer, so the text needn't list cards or prices; USD only; watched cards = "Watchlist"; writes are proposed for the user to Confirm, never "done".
Use the tool results to check facts. Return one {n, pass} per criterion and a reason of at most 30 words."""

MAX_TOOL_RESULT_CHARS = 3000


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


def _clip(text: Any, limit: int) -> str:
    text = str(text or "")
    return text if len(text) <= limit else text[: limit - 1] + "…"


def judge_prompt(criteria: list[str], record: dict[str, Any], prior_turns: list[dict[str, Any]] | None = None) -> str:
    lines: list[str] = []
    for prior in prior_turns or []:
        lines.append(f"[Earlier] User: {_clip(prior.get('question'), 300)}")
        lines.append(f"[Earlier] Assistant: {_clip(prior.get('answer'), 600)}")
        if prior.get("tiles"):
            lines.append(f"[Earlier] Tiles: {'; '.join(prior['tiles'][:5])}")
    if record.get("context_card_ids"):
        lines.append(f"Scanner tray card ids: {', '.join(record['context_card_ids'])}")
    lines.append(f"User: {record.get('question')}")
    lines.append(f"Answer:\n{_clip(record.get('answer'), 2500)}")
    budget = MAX_TOOL_RESULT_CHARS
    results = []
    for item in record.get("tool_results") or []:
        if budget <= 0:
            results.append("…")
            break
        snippet = _clip(item.get("result"), min(budget, 1200))
        budget -= len(snippet)
        results.append(f"{item.get('call') or item.get('name')} -> {snippet}")
    if results:
        lines.append("Tool results (compact):\n" + "\n".join(results))
    else:
        lines.append(f"Tool calls: {'; '.join(record.get('tool_calls') or []) or 'none'}")
    tiles = record.get("tiles") or []
    lines.append(f"Tiles ({len(tiles)}): {'; '.join(tiles[:8]) or 'none'}")
    if record.get("charts"):
        lines.append(f"Charts: {'; '.join(record['charts'])}")
    actions = [a for a in record.get("actions") or [] if a]
    if actions:
        lines.append(f"Proposed actions: {'; '.join(actions)}")
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
