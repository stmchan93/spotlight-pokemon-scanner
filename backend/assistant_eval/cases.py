"""Case file loading + schema validation (cases.yaml; .json works too)."""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Iterable

from assistant_eval.grading import ACTION_TYPES, EXPECT_KEYS, KNOWN_GAMES, MATCHER_OPS, TILE_PREDICATE_KEYS

DEFAULT_CASES_PATH = Path(__file__).resolve().parent / "cases.yaml"
CASE_KEYS = frozenset({"id", "category", "description", "holdout", "turns"})
TURN_KEYS = frozenset({"ask", "card_ids", "expect", "rubric"})
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
        spot = f"{where}.tiles_none_match[{i}]"
        if not isinstance(predicate, dict) or not predicate:
            errors.append(f"{spot}: must be a non-empty mapping")
            continue
        for key in sorted(set(predicate) - TILE_PREDICATE_KEYS):
            errors.append(f"{spot}: unknown tile predicate {key!r}")
        for key in ("game", "game_not"):
            if key in predicate and predicate[key] not in KNOWN_GAMES:
                errors.append(f"{spot}: {key} must be one of {KNOWN_GAMES}")
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
    for key in ("max_words", "tiles_min"):
        if key in expect and (not isinstance(expect[key], int) or expect[key] < 1):
            errors.append(f"{where}.{key}: must be a positive integer")
    if "max_cost_usd" in expect and not isinstance(expect["max_cost_usd"], (int, float)):
        errors.append(f"{where}.max_cost_usd: must be a number")


def validate_cases(data: Any, known_tools: frozenset[str] | None = None) -> list[str]:
    """Human-readable problems; [] means the file is well-formed."""
    known = known_tools if known_tools is not None else assistant_tool_names()
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
