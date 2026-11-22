"""Case file loading + schema validation (cases.yaml; .json works too)."""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Iterable

from assistant_eval.fixtures import validate_fixtures, validate_state_checks
from assistant_eval.grading import (
    ACTION_TYPES,
    EXPECT_KEYS,
    KNOWN_GAMES,
    MATCHER_OPS,
    PLANNED_TOOLS,
    TILE_PREDICATE_KEYS,
    TILE_SORT_KEYS,
    tile_specs,
    tops,
)

DEFAULT_CASES_PATH = Path(__file__).resolve().parent / "cases.yaml"
CASE_KEYS = frozenset(
    {"id", "category", "description", "holdout", "turns", "review_label", "fixtures", "writes", "state_checks"}
)
# reference: the owner's reference answer (judge guidance). retry: resend the previous
# turn's exact request (same client_message_id), e.g. to prove a write is idempotent.
TURN_KEYS = frozenset({"ask", "card_ids", "game", "expect", "rubric", "reference", "retry"})
# context.game values a turn may send (the app's CARD_GAMES).
CONTEXT_GAMES = ("pokemon", "onepiece", "lorcana", "riftbound", "gundam")
_ID = re.compile(r"^[a-z0-9_]+$")


def normalize_case(case: Any) -> Any:
    """Accept the stub shape from tools/assistant_feedback_export.py --as-cases
    (source, turns[].question, expectations, judge_rubric) as well as ours."""
    if not isinstance(case, dict):
        return case
    case = dict(case)
    if "source" in case:
        case.setdefault("description", case.pop("source"))
    if isinstance(case.get("id"), str):
        case["id"] = case["id"].lower().replace("-", "_")
    turns = case.get("turns")
    if isinstance(turns, list):
        turns = [
            ({**{k: v for k, v in turn.items() if k != "question"}, "ask": turn["question"]}
             if isinstance(turn, dict) and "question" in turn and "ask" not in turn else turn)
            for turn in turns
        ]
        last = turns[-1] if turns and isinstance(turns[-1], dict) else None
        expectations = case.pop("expectations", None)
        rubric = case.pop("judge_rubric", None)
        if last is not None:
            if expectations and not last.get("expect"):
                last["expect"] = expectations
            if rubric and not last.get("rubric"):
                last["rubric"] = rubric
        case["turns"] = turns
    if "category" not in case and str(case.get("id", "")).startswith("feedback_"):
        case["category"] = "feedback"
    return case


def load_case_file(path: str | Path = DEFAULT_CASES_PATH) -> dict[str, Any]:
    path = Path(path)
    text = path.read_text(encoding="utf-8")
    if path.suffix == ".json":
        data = json.loads(text)
    else:
        import yaml  # pyyaml ships with transformers/huggingface_hub on the VM and in dev

        data = yaml.safe_load(text)
    if isinstance(data, dict) and isinstance(data.get("cases"), list):
        data["cases"] = [normalize_case(case) for case in data["cases"]]
    return data


def assistant_tool_names() -> frozenset[str]:
    from mcp_server.assistant.tools import TOOL_DEFINITIONS

    return frozenset(tool["name"] for tool in TOOL_DEFINITIONS)


def _check_matcher(where: str, spec: Any, errors: list[str]) -> None:
    if isinstance(spec, dict):
        unknown = set(spec) - MATCHER_OPS
        if unknown or not spec:
            errors.append(f"{where}: unknown matcher ops {sorted(unknown)} (use {sorted(MATCHER_OPS)})")
    elif isinstance(spec, list):
        errors.append(f"{where}: a list is not a matcher; use {{in: [...]}}")


def _check_tile_predicate(where: str, predicate: Any, errors: list[str], *, allow_id: bool) -> None:
    if allow_id and isinstance(predicate, str) and predicate:
        return
    if not isinstance(predicate, dict) or not predicate:
        errors.append(f"{where}: must be {'a card id or ' if allow_id else ''}a non-empty mapping")
        return
    for key in sorted(set(predicate) - TILE_PREDICATE_KEYS):
        errors.append(f"{where}: unknown tile predicate {key!r}")
    for key in ("game", "game_not"):
        if key in predicate and predicate[key] not in KNOWN_GAMES:
            errors.append(f"{where}: {key} must be one of {KNOWN_GAMES}")
    for key in ("name_regex", "set_regex", "variant_regex", "rarity_regex"):
        if key in predicate:
            try:
                re.compile(str(predicate[key]))
            except re.error as error:
                errors.append(f"{where}.{key}: bad regex: {error}")


def _tools(where: str, names: Any, known: frozenset[str], errors: list[str]) -> None:
    if not isinstance(names, list) or not names:
        errors.append(f"{where}: must be a non-empty list of tool names")
        return
    for name in names:
        if name not in known:
            errors.append(f"{where}: unknown tool {name!r}")


def _validate_expect(where: str, expect: Any, known: frozenset[str], banned: Iterable[str], errors: list[str]) -> None:
    if not isinstance(expect, dict):
        errors.append(f"{where}: expect must be a mapping")
        return
    for key in sorted(set(expect) - EXPECT_KEYS):
        errors.append(f"{where}: unknown expect key {key!r}")
    for key in ("tools_any", "tools_all", "tools_none"):
        if key in expect:
            _tools(f"{where}.{key}", expect[key], known, errors)
    for i, spec in enumerate(expect.get("tool_args") or []):
        spot = f"{where}.tool_args[{i}]"
        if not isinstance(spec, dict) or spec.get("tool") not in known:
            errors.append(f"{spot}: needs tool = a known tool name")
            continue
        if spec.get("mode", "any") not in ("any", "all"):
            errors.append(f"{spot}: mode must be any or all")
        if not isinstance(spec.get("where"), dict) or not spec["where"]:
            errors.append(f"{spot}: where must be a non-empty mapping")
            continue
        for path, matcher in spec["where"].items():
            _check_matcher(f"{spot}.where.{path}", matcher, errors)
    for i, predicate in enumerate(expect.get("tiles_none_match") or []):
        _check_tile_predicate(f"{where}.tiles_none_match[{i}]", predicate, errors, allow_id=False)
    for key in ("tiles_exact", "tiles_include", "tiles_within"):
        if key not in expect:
            continue
        specs, _ = tile_specs(expect[key])
        if not specs and key != "tiles_exact":
            errors.append(f"{where}.{key}: needs at least one card id or tile predicate")
        for i, spec in enumerate(specs):
            _check_tile_predicate(f"{where}.{key}[{i}]", spec, errors, allow_id=True)
    quantity = expect.get("tile_quantity")
    if quantity is not None:
        if not isinstance(quantity, dict) or not isinstance(quantity.get("quantity"), int) or not (
            quantity.get("card_id") or quantity.get("match")
        ):
            errors.append(f"{where}.tile_quantity: needs card_id (or match) and an integer quantity")
        elif quantity.get("match") is not None:
            _check_tile_predicate(f"{where}.tile_quantity.match", quantity["match"], errors, allow_id=True)
    if "tiles_label" in expect:
        try:
            re.compile(str(expect["tiles_label"]))
        except re.error as error:
            errors.append(f"{where}.tiles_label: bad regex: {error}")
    if "tiles_sorted" in expect and expect["tiles_sorted"] not in TILE_SORT_KEYS:
        errors.append(f"{where}.tiles_sorted: must be one of {TILE_SORT_KEYS}")
    if "tiles_from_tools" in expect:
        _tools(f"{where}.tiles_from_tools", expect["tiles_from_tools"], known, errors)
    if "tiles_include_top" in expect:
        _tools(f"{where}.tiles_include_top", tops(expect["tiles_include_top"]), known, errors)
    if "tiles_max" in expect and (not isinstance(expect["tiles_max"], int) or expect["tiles_max"] < 0):
        errors.append(f"{where}.tiles_max: must be a non-negative integer")
    for i, spec in enumerate(expect.get("tool_result_where") or []):
        spot = f"{where}.tool_result_where[{i}]"
        if not isinstance(spec, dict) or spec.get("tool") not in known or not isinstance(spec.get("where"), dict) or not spec["where"]:
            errors.append(f"{spot}: needs tool = a known tool name and a non-empty where")
            continue
        for path, matcher in spec["where"].items():
            _check_matcher(f"{spot}.where.{path}", matcher, errors)
    amounts = expect.get("amounts_match_tool")
    if amounts is not None and (not isinstance(amounts, dict) or amounts.get("tool") not in known or not isinstance(
        amounts.get("tolerance_pct", 1), (int, float)
    )):
        errors.append(f"{where}.amounts_match_tool: needs tool = a known tool name (and a numeric tolerance_pct)")
    write = expect.get("expect_write")
    if write is not None:
        if not isinstance(write, dict):
            errors.append(f"{where}.expect_write: must be a mapping with params")
        else:
            for path, matcher in (write.get("params") or {}).items():
                _check_matcher(f"{where}.expect_write.params.{path}", matcher, errors)
    ids = expect.get("proposed_card_ids")
    if ids is not None and (not isinstance(ids, list) or not ids or not all(isinstance(i, str) and i for i in ids)):
        errors.append(f"{where}.proposed_card_ids: must be a non-empty list of card ids")
    for key in ("must_not_contain", "must_contain_any"):
        if key in expect:
            value = expect[key]
            if not isinstance(value, list) or not value or not all(isinstance(item, str) for item in value):
                errors.append(f"{where}.{key}: must be a non-empty list of strings")
            elif key == "must_not_contain":
                for pattern in value:
                    try:
                        re.compile(pattern)
                    except re.error as error:
                        errors.append(f"{where}.must_not_contain: bad regex {pattern!r}: {error}")
    for name in expect.get("allow") or []:
        if name not in banned:
            errors.append(f"{where}.allow: {name!r} is not a defaults.banned name")
    action = expect.get("expect_action")
    if action is not None:
        if not isinstance(action, dict) or action.get("type") not in ACTION_TYPES:
            errors.append(f"{where}.expect_action: type must be one of {ACTION_TYPES}")
        else:
            for path, matcher in (action.get("params") or {}).items():
                _check_matcher(f"{where}.expect_action.params.{path}", matcher, errors)
    if "scan_tray_named" in expect and not isinstance(expect["scan_tray_named"], bool):
        errors.append(f"{where}.scan_tray_named: must be true or false")
    for key in ("max_words", "tiles_min"):
        if key in expect and (not isinstance(expect[key], int) or expect[key] < 1):
            errors.append(f"{where}.{key}: must be a positive integer")
    if "max_cost_usd" in expect and not isinstance(expect["max_cost_usd"], (int, float)):
        errors.append(f"{where}.max_cost_usd: must be a number")


def validate_cases(data: Any, known_tools: frozenset[str] | None = None) -> list[str]:
    """Human-readable problems; [] means the file is well-formed."""
    # Planned tools (other agents' work) may be named before they exist; their checks skip.
    known = (known_tools if known_tools is not None else assistant_tool_names()) | PLANNED_TOOLS
    errors: list[str] = []
    if not isinstance(data, dict) or not isinstance(data.get("cases"), list):
        return ["top level must be a mapping with a `cases` list"]
    defaults = data.get("defaults") or {}
    banned = defaults.get("banned") or {}
    if not isinstance(banned, dict):
        errors.append("defaults.banned must map name -> regex")
        banned = {}
    for label, pattern in banned.items():
        try:
            re.compile(pattern)
        except re.error as error:
            errors.append(f"defaults.banned.{label}: bad regex: {error}")
    seen: set[str] = set()
    for index, case in enumerate(data["cases"]):
        where = f"cases[{index}]"
        if not isinstance(case, dict):
            errors.append(f"{where}: must be a mapping")
            continue
        case_id = case.get("id")
        if not isinstance(case_id, str) or not _ID.match(case_id):
            errors.append(f"{where}: id must be snake_case")
        elif case_id in seen:
            errors.append(f"{where}: duplicate id {case_id!r}")
        else:
            seen.add(case_id)
            where = case_id
        for key in sorted(set(case) - CASE_KEYS):
            errors.append(f"{where}: unknown key {key!r}")
        if "holdout" in case and not isinstance(case["holdout"], bool):
            errors.append(f"{where}: holdout must be true/false")
        if "writes" in case and not isinstance(case["writes"], bool):
            errors.append(f"{where}: writes must be true/false")
        if "fixtures" in case:
            validate_fixtures(where, case["fixtures"], errors)
        if "state_checks" in case:
            validate_state_checks(where, case["state_checks"], errors)
            if not case.get("writes"):
                errors.append(f"{where}: state_checks need writes: true (they run on the DB copy)")
        if not isinstance(case.get("category"), str) or not case["category"].strip():
            errors.append(f"{where}: category is required")
        turns = case.get("turns")
        if not isinstance(turns, list) or not turns:
            errors.append(f"{where}: turns must be a non-empty list")
            continue
        for number, turn in enumerate(turns, start=1):
            spot = f"{where}.turn{number}"
            if not isinstance(turn, dict):
                errors.append(f"{spot}: must be a mapping")
                continue
            for key in sorted(set(turn) - TURN_KEYS):
                errors.append(f"{spot}: unknown key {key!r}")
            ask = turn.get("ask")
            if not isinstance(ask, str) or not ask.strip() or len(ask) > 1000:
                errors.append(f"{spot}: ask must be 1..1000 chars")
            card_ids = turn.get("card_ids")
            if card_ids is not None and (
                not isinstance(card_ids, list) or not 0 < len(card_ids) <= 20
                or not all(isinstance(item, str) and item for item in card_ids)
            ):
                errors.append(f"{spot}: card_ids must be 1..20 card id strings")
            if "game" in turn and turn["game"] not in CONTEXT_GAMES:
                errors.append(f"{spot}: game must be one of {', '.join(CONTEXT_GAMES)}")
            if "reference" in turn and (not isinstance(turn["reference"], str) or not turn["reference"].strip()):
                errors.append(f"{spot}: reference must be a non-empty string")
            if turn.get("retry") is not None:
                if not isinstance(turn["retry"], bool):
                    errors.append(f"{spot}: retry must be true/false")
                elif turn["retry"] and (number == 1 or turns[number - 2].get("ask") != ask
                                        or turns[number - 2].get("card_ids") != card_ids):
                    errors.append(f"{spot}: a retry turn repeats the previous turn's ask/card_ids exactly")
            if "rubric" in turn:
                rubric = turn["rubric"]
                items = [rubric] if isinstance(rubric, str) else rubric
                if not isinstance(items, list) or not items or not all(isinstance(i, str) and i.strip() for i in items):
                    errors.append(f"{spot}: rubric must be a non-empty list of yes/no criteria")
                elif any("TODO" in item for item in items):
                    errors.append(f"{spot}: rubric still has a TODO; replace it with yes/no criteria")
            _validate_expect(spot, turn.get("expect") or {}, known, banned, errors)
    return errors


def select_cases(data: dict[str, Any], ids: list[str] | None = None, categories: list[str] | None = None) -> list[dict[str, Any]]:
    cases = data["cases"]
    if ids:
        unknown = sorted(set(ids) - {case["id"] for case in cases})
        if unknown:
            raise ValueError(f"unknown case ids: {unknown}")
        cases = [case for case in cases if case["id"] in ids]
    if categories:
        cases = [case for case in cases if case["category"] in categories]
    return cases
