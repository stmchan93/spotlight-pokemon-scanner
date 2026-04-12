#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from collections import Counter, defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Any


VALID_SPLITS = {"tuning", "heldout"}
VALID_CAPTURE_KINDS = {"full_slab", "label_only"}


@dataclass(frozen=True)
class FixtureRecord:
    fixture_dir: Path
    fixture_path: Path
    payload: dict[str, Any]

    @property
    def fixture_name(self) -> str:
        return str(self.payload.get("fixtureName") or self.fixture_dir.name)

    @property
    def split(self) -> str:
        return str(self.payload.get("split") or self.fixture_dir.parent.name)

    @property
    def capture_kind(self) -> str:
        return str(self.payload.get("captureKind") or "")

    @property
    def source_image_value(self) -> str:
        return str(self.payload.get("sourceImage") or "")

    @property
    def source_image_path(self) -> Path | None:
        if not self.source_image_value:
            return None
        return (self.fixture_dir / self.source_image_value).resolve()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Validate and summarize the slab regression fixture scaffold.")
    parser.add_argument(
        "--root",
        type=Path,
        action="append",
        dest="roots",
        default=None,
        help="Fixture root to scan. Defaults to qa/slab-regression/tuning and qa/slab-regression/heldout.",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("qa/slab-regression/manifest_summary.json"),
        help="JSON output path for the manifest summary.",
    )
    return parser.parse_args()


def default_roots() -> list[Path]:
    return [
        Path("qa/slab-regression/tuning"),
        Path("qa/slab-regression/heldout"),
    ]


def load_fixture_records(roots: list[Path]) -> tuple[list[FixtureRecord], list[dict[str, Any]]]:
    fixtures: list[FixtureRecord] = []
    issues: list[dict[str, Any]] = []

    for root in roots:
        if not root.exists():
            issues.append({
                "fixture": None,
                "path": str(root),
                "severity": "warning",
                "reason": "root_missing",
            })
            continue

        for fixture_path in sorted(root.rglob("fixture.json")):
            fixture_dir = fixture_path.parent
            try:
                payload = json.loads(fixture_path.read_text())
            except json.JSONDecodeError as exc:
                issues.append({
                    "fixture": fixture_dir.name,
                    "path": str(fixture_path),
                    "severity": "error",
                    "reason": "invalid_json",
                    "detail": str(exc),
                })
                continue

            if not isinstance(payload, dict):
                issues.append({
                    "fixture": fixture_dir.name,
                    "path": str(fixture_path),
                    "severity": "error",
                    "reason": "fixture_not_object",
                })
                continue

            fixtures.append(FixtureRecord(
                fixture_dir=fixture_dir,
                fixture_path=fixture_path,
                payload=payload,
            ))

    fixtures.sort(key=lambda record: (record.split, record.fixture_name))
    return fixtures, issues


def validate_fixture(record: FixtureRecord) -> list[dict[str, Any]]:
    payload = record.payload
    issues: list[dict[str, Any]] = []

    def error(reason: str, detail: str | None = None) -> None:
        issue = {
            "fixture": record.fixture_name,
            "path": str(record.fixture_path),
            "severity": "error",
            "reason": reason,
        }
        if detail:
            issue["detail"] = detail
        issues.append(issue)

    required_fields = [
        "fixtureName",
        "split",
        "selectedMode",
        "captureKind",
        "sourceImage",
        "truth",
        "expects",
    ]
    for field in required_fields:
        if field not in payload:
            error("missing_field", field)

    if payload.get("selectedMode") != "slab":
        error("invalid_selected_mode", str(payload.get("selectedMode")))

    if record.split not in VALID_SPLITS:
        error("invalid_split", record.split)

    expected_split = record.fixture_dir.parent.name
    if record.split != expected_split:
        error("split_directory_mismatch", f"manifest={record.split} directory={expected_split}")

    if record.capture_kind not in VALID_CAPTURE_KINDS:
        error("invalid_capture_kind", record.capture_kind)

    truth = payload.get("truth")
    if not isinstance(truth, dict):
        error("truth_not_object")
    else:
        for field in [
            "grader",
            "grade",
            "certNumber",
            "cardID",
            "cardName",
            "setName",
            "cardNumber",
            "pricingProvider",
            "pricingLookup",
        ]:
            if field not in truth:
                error("missing_truth_field", field)

        pricing_lookup = truth.get("pricingLookup")
        if not isinstance(pricing_lookup, dict):
            error("pricing_lookup_not_object")
        else:
            mode = str(pricing_lookup.get("mode") or "")
            if mode != "card_id_grade":
                error("unsupported_pricing_lookup_mode", mode or "<missing>")

    expects = payload.get("expects")
    if not isinstance(expects, dict):
        error("expects_not_object")
    else:
        for field in [
            "certReadRequired",
            "identityMustMatch",
            "pricingMayBeUnavailable",
        ]:
            if field not in expects:
                error("missing_expects_field", field)

    source_image_path = record.source_image_path
    if source_image_path is None:
        error("missing_source_image")
    elif not source_image_path.exists():
        error("missing_source_image_file", str(source_image_path))

    return issues


def build_summary(fixtures: list[FixtureRecord], issues: list[dict[str, Any]]) -> dict[str, Any]:
    by_split = Counter(record.split for record in fixtures)
    by_capture_kind = Counter(record.capture_kind for record in fixtures)
    split_capture_kind: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    for record in fixtures:
        split_capture_kind[record.split][record.capture_kind] += 1

    if by_capture_kind.get("label_only", 0) == 0:
        issues.append({
            "fixture": None,
            "path": "qa/slab-regression",
            "severity": "warning",
            "reason": "label_only_fixtures_missing",
            "detail": "Add at least one label_only slab fixture before cert-first tuning.",
        })
    if by_split.get("heldout", 0) == 0:
        issues.append({
            "fixture": None,
            "path": "qa/slab-regression/heldout",
            "severity": "warning",
            "reason": "heldout_fixtures_missing",
            "detail": "Add heldout slab fixtures before claiming regression improvements.",
        })

    missing_images = [
        issue for issue in issues
        if issue.get("reason") == "missing_source_image_file"
    ]
    error_count = sum(1 for issue in issues if issue.get("severity") == "error")
    warning_count = sum(1 for issue in issues if issue.get("severity") == "warning")

    return {
        "fixtureCount": len(fixtures),
        "splitCounts": dict(sorted(by_split.items())),
        "captureKindCounts": dict(sorted(by_capture_kind.items())),
        "splitCaptureKindCounts": {
            split: dict(sorted(counts.items()))
            for split, counts in sorted(split_capture_kind.items())
        },
        "missingImageCount": len(missing_images),
        "errorCount": error_count,
        "warningCount": warning_count,
        "isScaffoldOnly": len(fixtures) == 0,
        "issues": issues,
    }


def main() -> None:
    args = parse_args()
    roots = args.roots or default_roots()
    fixtures, load_issues = load_fixture_records(roots)

    issues = list(load_issues)
    for record in fixtures:
        issues.extend(validate_fixture(record))

    summary = build_summary(fixtures, issues)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(summary, indent=2) + "\n")

    print(f"Slab regression fixture count: {summary['fixtureCount']}")
    print(f"Split counts: {summary['splitCounts']}")
    print(f"Capture counts: {summary['captureKindCounts']}")
    print(f"Missing images: {summary['missingImageCount']}")
    print(f"Issues: errors={summary['errorCount']} warnings={summary['warningCount']}")
    print(f"Summary written to: {args.output}")


if __name__ == "__main__":
    main()
