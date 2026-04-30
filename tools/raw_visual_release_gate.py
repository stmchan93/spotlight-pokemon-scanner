#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any, Iterable, Mapping


REQUIRED_SUITES = ("legacy", "expansion", "mixed")
MONITORED_METRICS = (
    "visualTop1PassCount",
    "visualTop5ContainsTruthCount",
    "visualTop10ContainsTruthCount",
    "hybridTop1PassCount",
    "hybridTop5ContainsTruthCount",
)
PRIMARY_IMPROVEMENT_METRICS = (
    "visualTop10ContainsTruthCount",
    "hybridTop1PassCount",
)
EXPECTED_TOP_K = 10


def _normalize_suite_name(value: str) -> str:
    normalized = str(value or "").strip().lower()
    if normalized not in REQUIRED_SUITES:
        raise ValueError(f"Unsupported suite name: {value!r}")
    return normalized


def _scorecard_path(path: str | Path) -> Path:
    return Path(path).expanduser().resolve()


def load_scorecard(path: str | Path) -> dict[str, Any]:
    scorecard_path = _scorecard_path(path)
    payload = json.loads(scorecard_path.read_text())
    if not isinstance(payload, dict):
        raise ValueError(f"Scorecard must be a JSON object: {scorecard_path}")
    payload["_scorecardPath"] = str(scorecard_path)
    return payload


def infer_suite_name(scorecard: Mapping[str, Any], *, path: str | Path | None = None) -> str:
    fixture_roots = [
        str(value).lower()
        for value in (scorecard.get("fixtureRoots") or [])
        if isinstance(value, str)
    ]
    has_legacy = any(
        "qa/raw-footer-layout-check" in root or root.rstrip("/").endswith("raw-footer-layout-check")
        for root in fixture_roots
    )
    has_expansion = any("raw-visual-expansion-holdouts" in root for root in fixture_roots)
    if has_legacy and has_expansion:
        return "mixed"
    if has_legacy:
        return "legacy"
    if has_expansion:
        return "expansion"

    if path is not None:
        stem = _scorecard_path(path).stem.lower()
        if "mixed" in stem:
            return "mixed"
        if "expansion" in stem or "holdout" in stem:
            return "expansion"
        if "legacy" in stem or "footer" in stem or "regression" in stem:
            return "legacy"

    raise ValueError(
        "Could not infer suite name from scorecard fixtureRoots or path. "
        f"fixtureRoots={fixture_roots!r} path={str(path) if path is not None else None!r}"
    )


def load_named_scorecards(paths_by_suite: Mapping[str, str | Path]) -> dict[str, dict[str, Any]]:
    loaded: dict[str, dict[str, Any]] = {}
    for raw_suite_name, scorecard_path in paths_by_suite.items():
        suite_name = _normalize_suite_name(raw_suite_name)
        loaded[suite_name] = load_scorecard(scorecard_path)
    return loaded


def load_inferred_scorecards(paths: Iterable[str | Path]) -> dict[str, dict[str, Any]]:
    loaded: dict[str, dict[str, Any]] = {}
    for scorecard_path in paths:
        payload = load_scorecard(scorecard_path)
        suite_name = infer_suite_name(payload, path=scorecard_path)
        if suite_name in loaded:
            raise ValueError(f"Duplicate inferred suite {suite_name!r} for scorecard {scorecard_path}")
        loaded[suite_name] = payload
    return loaded


def _required_int(scorecard: Mapping[str, Any], key: str, *, suite: str, role: str) -> int:
    value = scorecard.get(key)
    if not isinstance(value, (int, float)):
        raise ValueError(f"{role} {suite} scorecard is missing numeric field {key!r}")
    return int(value)


def _metric_label(metric_name: str) -> str:
    return metric_name


def compare_suite_scorecards(
    *,
    suite_name: str,
    active_scorecard: Mapping[str, Any],
    candidate_scorecard: Mapping[str, Any],
) -> dict[str, Any]:
    suite_name = _normalize_suite_name(suite_name)
    failures: list[str] = []
    improvements: list[str] = []
    metric_comparisons: dict[str, dict[str, Any]] = {}

    active_top_k = _required_int(active_scorecard, "topK", suite=suite_name, role="active")
    candidate_top_k = _required_int(candidate_scorecard, "topK", suite=suite_name, role="candidate")
    if active_top_k != candidate_top_k:
        failures.append(
            f"{suite_name}: topK mismatch active={active_top_k} candidate={candidate_top_k}"
        )
    if candidate_top_k != EXPECTED_TOP_K:
        failures.append(
            f"{suite_name}: candidate topK must stay {EXPECTED_TOP_K}, got {candidate_top_k}"
        )

    active_supported = _required_int(active_scorecard, "providerSupportedFixtureCount", suite=suite_name, role="active")
    candidate_supported = _required_int(candidate_scorecard, "providerSupportedFixtureCount", suite=suite_name, role="candidate")
    if active_supported != candidate_supported:
        failures.append(
            f"{suite_name}: providerSupportedFixtureCount mismatch active={active_supported} candidate={candidate_supported}"
        )

    active_unsupported = _required_int(active_scorecard, "providerUnsupportedFixtureCount", suite=suite_name, role="active")
    candidate_unsupported = _required_int(candidate_scorecard, "providerUnsupportedFixtureCount", suite=suite_name, role="candidate")
    if active_unsupported != candidate_unsupported:
        failures.append(
            f"{suite_name}: providerUnsupportedFixtureCount mismatch active={active_unsupported} candidate={candidate_unsupported}"
        )

    for metric_name in MONITORED_METRICS:
        active_value = _required_int(active_scorecard, metric_name, suite=suite_name, role="active")
        candidate_value = _required_int(candidate_scorecard, metric_name, suite=suite_name, role="candidate")
        delta = candidate_value - active_value
        if delta > 0:
            status = "improved"
            improvements.append(
                f"{suite_name}: {_metric_label(metric_name)} improved by +{delta} ({active_value} -> {candidate_value})"
            )
        elif delta < 0:
            status = "regressed"
            failures.append(
                f"{suite_name}: {_metric_label(metric_name)} regressed by {delta} ({active_value} -> {candidate_value})"
            )
        else:
            status = "unchanged"
        metric_comparisons[metric_name] = {
            "active": active_value,
            "candidate": candidate_value,
            "delta": delta,
            "status": status,
            "isPrimaryImprovementMetric": metric_name in PRIMARY_IMPROVEMENT_METRICS,
        }

    primary_improvements = [
        comparison
        for metric_name, comparison in metric_comparisons.items()
        if metric_name in PRIMARY_IMPROVEMENT_METRICS and comparison["delta"] > 0
    ]

    return {
        "suite": suite_name,
        "passed": not failures,
        "activeScorecardPath": active_scorecard.get("_scorecardPath"),
        "candidateScorecardPath": candidate_scorecard.get("_scorecardPath"),
        "fixtureCounts": {
            "activeSupported": active_supported,
            "candidateSupported": candidate_supported,
            "activeUnsupported": active_unsupported,
            "candidateUnsupported": candidate_unsupported,
        },
        "topK": {
            "active": active_top_k,
            "candidate": candidate_top_k,
        },
        "metricComparisons": metric_comparisons,
        "improvements": improvements,
        "primaryImprovementCount": len(primary_improvements),
        "failures": failures,
    }


def evaluate_release_gate(
    *,
    active_scorecards: Mapping[str, Mapping[str, Any]],
    candidate_scorecards: Mapping[str, Mapping[str, Any]],
) -> dict[str, Any]:
    missing_active = [suite for suite in REQUIRED_SUITES if suite not in active_scorecards]
    missing_candidate = [suite for suite in REQUIRED_SUITES if suite not in candidate_scorecards]

    failure_reasons: list[str] = []
    if missing_active:
        failure_reasons.append(f"Missing active suites: {', '.join(missing_active)}")
    if missing_candidate:
        failure_reasons.append(f"Missing candidate suites: {', '.join(missing_candidate)}")

    suite_results: dict[str, Any] = {}
    improvement_reasons: list[str] = []
    primary_improvement_reasons: list[str] = []

    for suite_name in REQUIRED_SUITES:
        if suite_name not in active_scorecards or suite_name not in candidate_scorecards:
            continue
        suite_result = compare_suite_scorecards(
            suite_name=suite_name,
            active_scorecard=active_scorecards[suite_name],
            candidate_scorecard=candidate_scorecards[suite_name],
        )
        suite_results[suite_name] = suite_result
        failure_reasons.extend(suite_result["failures"])
        improvement_reasons.extend(suite_result["improvements"])
        for metric_name, comparison in suite_result["metricComparisons"].items():
            if metric_name in PRIMARY_IMPROVEMENT_METRICS and comparison["delta"] > 0:
                primary_improvement_reasons.append(
                    f"{suite_name}: {metric_name} improved by +{comparison['delta']}"
                )

    if not primary_improvement_reasons:
        failure_reasons.append(
            "No primary improvement found across legacy/expansion/mixed. "
            "At least one of visualTop10ContainsTruthCount or hybridTop1PassCount must improve."
        )

    passed = not failure_reasons
    return {
        "passed": passed,
        "decision": "promote" if passed else "reject",
        "requiredSuites": list(REQUIRED_SUITES),
        "monitoredMetrics": list(MONITORED_METRICS),
        "primaryImprovementMetrics": list(PRIMARY_IMPROVEMENT_METRICS),
        "suiteResults": suite_results,
        "failureReasons": failure_reasons,
        "improvementReasons": improvement_reasons,
        "primaryImprovementReasons": primary_improvement_reasons,
        "summary": {
            "suiteCount": len(suite_results),
            "failureCount": len(failure_reasons),
            "improvementCount": len(improvement_reasons),
            "primaryImprovementCount": len(primary_improvement_reasons),
        },
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Compare active vs candidate raw-visual scorecards across legacy, expansion, and mixed suites."
    )
    parser.add_argument("--active-legacy", required=True, type=Path)
    parser.add_argument("--candidate-legacy", required=True, type=Path)
    parser.add_argument("--active-expansion", required=True, type=Path)
    parser.add_argument("--candidate-expansion", required=True, type=Path)
    parser.add_argument("--active-mixed", required=True, type=Path)
    parser.add_argument("--candidate-mixed", required=True, type=Path)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    active_scorecards = load_named_scorecards(
        {
            "legacy": args.active_legacy,
            "expansion": args.active_expansion,
            "mixed": args.active_mixed,
        }
    )
    candidate_scorecards = load_named_scorecards(
        {
            "legacy": args.candidate_legacy,
            "expansion": args.candidate_expansion,
            "mixed": args.candidate_mixed,
        }
    )
    decision = evaluate_release_gate(
        active_scorecards=active_scorecards,
        candidate_scorecards=candidate_scorecards,
    )
    print(json.dumps(decision, indent=2, sort_keys=True))
    return 0 if decision["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
