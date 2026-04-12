#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import urlparse
from urllib.request import Request, urlopen

from build_raw_visual_seed_manifest import TruthKey, choose_mapping, truth_from_fixture, utc_now_iso


USER_AGENT = "SpotlightScanner/0.1 (+https://local.spotlight.app)"


@dataclass(frozen=True)
class TrainingFixture:
    fixture_root: Path
    fixture_dir: Path
    fixture_name: str
    truth: TruthKey
    source_scan_path: Path
    normalized_image_path: Path


def discover_fixtures(
    roots: Iterable[Path],
    *,
    limit: int | None = None,
) -> tuple[list[TrainingFixture], list[dict[str, Any]]]:
    fixtures: list[TrainingFixture] = []
    skipped: list[dict[str, Any]] = []

    for root in roots:
        root = root.resolve()
        if not root.exists():
            skipped.append(
                {
                    "fixtureRoot": str(root),
                    "fixtureName": None,
                    "reason": "fixture_root_missing",
                }
            )
            continue

        truth_paths = sorted(root.rglob("truth.json"))
        for truth_path in truth_paths:
            fixture_dir = truth_path.parent
            source_scan_path = fixture_dir / "source_scan.jpg"
            normalized_image_path = fixture_dir / "runtime_normalized.jpg"

            if not source_scan_path.exists():
                skipped.append(
                    {
                        "fixtureRoot": str(root),
                        "fixtureName": fixture_dir.name,
                        "reason": "missing_source_scan",
                    }
                )
                continue
            if not normalized_image_path.exists():
                skipped.append(
                    {
                        "fixtureRoot": str(root),
                        "fixtureName": fixture_dir.name,
                        "reason": "missing_runtime_normalized",
                    }
                )
                continue

            truth = truth_from_fixture(fixture_dir)
            fixtures.append(
                TrainingFixture(
                    fixture_root=root,
                    fixture_dir=fixture_dir,
                    fixture_name=fixture_dir.name,
                    truth=truth,
                    source_scan_path=source_scan_path,
                    normalized_image_path=normalized_image_path,
                )
            )

    fixtures.sort(key=lambda fixture: (fixture.fixture_root.as_posix(), fixture.fixture_name))
    if limit is not None:
        fixtures = fixtures[:limit]
    return fixtures, skipped


def load_query_cache(path: Path) -> dict[str, list[dict[str, Any]]]:
    if not path.exists():
        return {}
    payload = json.loads(path.read_text())
    if not isinstance(payload, dict):
        return {}
    return {
        str(key): value
        for key, value in payload.items()
        if isinstance(key, str) and isinstance(value, list)
    }


def write_query_cache(path: Path, cache: dict[str, list[dict[str, Any]]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(cache, indent=2) + "\n")


def reference_image_extension(url: str) -> str:
    suffix = Path(urlparse(url).path).suffix.lower()
    if suffix in {".jpg", ".jpeg", ".png", ".webp"}:
        return suffix
    return ".png"


def download_reference_image(
    *,
    provider_card_id: str,
    url: str,
    reference_image_root: Path,
) -> Path:
    reference_image_root.mkdir(parents=True, exist_ok=True)
    output_path = reference_image_root / f"{provider_card_id}{reference_image_extension(url)}"
    if output_path.exists():
        return output_path

    request = Request(url)
    request.add_header("User-Agent", USER_AGENT)
    with urlopen(request, timeout=20) as response:
        output_path.write_bytes(response.read())
    return output_path


def grouped_truths(fixtures: Iterable[TrainingFixture]) -> dict[str, dict[str, Any]]:
    grouped: dict[str, dict[str, Any]] = {}
    for fixture in fixtures:
        entry = grouped.setdefault(
            fixture.truth.key,
            {
                "truth": fixture.truth,
                "fixtures": [],
            },
        )
        entry["fixtures"].append(fixture)
    return grouped


def build_manifest(
    *,
    fixtures: list[TrainingFixture],
    api_key: str | None,
    query_cache_path: Path,
    reference_image_root: Path,
    download_reference_images: bool,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    query_cache = load_query_cache(query_cache_path)
    grouped = grouped_truths(fixtures)
    manifest_rows: list[dict[str, Any]] = []
    skipped_rows: list[dict[str, Any]] = []
    truth_mappings: dict[str, dict[str, Any]] = {}

    total_truths = len(grouped)
    for index, grouped_entry in enumerate(grouped.values(), start=1):
        truth: TruthKey = grouped_entry["truth"]
        print(f"[{index}/{total_truths}] Mapping {truth.card_name} | {truth.collector_number} | {truth.set_code or '-'}")
        truth_mappings[truth.key] = choose_mapping(truth, api_key, query_cache)

    write_query_cache(query_cache_path, query_cache)

    for fixture in fixtures:
        mapping = truth_mappings[fixture.truth.key]
        selected = mapping.get("selected") or {}
        provider_supported = bool(mapping.get("providerSupported"))
        provider_card_id = str(selected.get("providerCardId") or "")
        reference_image_url = str(selected.get("referenceImageUrl") or "")
        reference_image_path: str | None = None
        reference_image_error: str | None = None

        if provider_supported and provider_card_id and reference_image_url and download_reference_images:
            try:
                downloaded_path = download_reference_image(
                    provider_card_id=provider_card_id,
                    url=reference_image_url,
                    reference_image_root=reference_image_root,
                )
                reference_image_path = str(downloaded_path.resolve())
            except Exception as exc:  # noqa: BLE001
                reference_image_error = str(exc)

        row = {
            "fixtureName": fixture.fixture_name,
            "fixtureRoot": str(fixture.fixture_root),
            "fixturePath": str(fixture.fixture_dir),
            "truthKey": fixture.truth.key,
            "cardName": fixture.truth.card_name,
            "collectorNumber": fixture.truth.collector_number,
            "setCode": fixture.truth.set_code,
            "sourceScanPath": str(fixture.source_scan_path),
            "normalizedImagePath": str(fixture.normalized_image_path),
            "providerSupported": provider_supported,
            "providerCardId": provider_card_id or None,
            "providerName": selected.get("providerName"),
            "providerCollectorNumber": selected.get("providerCollectorNumber"),
            "providerSetId": selected.get("providerSetId"),
            "providerSetPtcgoCode": selected.get("providerSetPtcgoCode"),
            "providerSetName": selected.get("providerSetName"),
            "referenceImageUrl": reference_image_url or None,
            "referenceImagePath": reference_image_path,
            "referenceImageError": reference_image_error,
            "mappingConfidence": mapping.get("mappingConfidence"),
            "mappingReason": mapping.get("mappingReason"),
            "candidateSummaries": mapping.get("candidateSummaries") or [],
        }

        if provider_supported:
            manifest_rows.append(row)
        else:
            skipped_rows.append(
                {
                    "fixtureName": fixture.fixture_name,
                    "truthKey": fixture.truth.key,
                    "reason": "provider_unsupported",
                    "mappingConfidence": mapping.get("mappingConfidence"),
                    "mappingReason": mapping.get("mappingReason"),
                }
            )

    manifest_rows.sort(key=lambda row: (str(row["providerCardId"] or ""), str(row["fixtureName"])))
    summary = {
        "generatedAt": utc_now_iso(),
        "provider": "pokemontcg_api",
        "fixtureCount": len(fixtures),
        "uniqueTruthCount": len(grouped),
        "manifestEntryCount": len(manifest_rows),
        "unsupportedFixtureCount": len(skipped_rows),
        "referenceImageDownloadEnabled": download_reference_images,
        "missingReferenceImageCount": sum(1 for row in manifest_rows if not row["referenceImagePath"]),
        "skipped": skipped_rows,
    }
    return manifest_rows, summary


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build a raw visual training manifest from normalized training fixtures.")
    parser.add_argument(
        "--fixture-root",
        type=Path,
        action="append",
        dest="fixture_roots",
        default=None,
        help="Training fixture root. Repeat this flag to include multiple roots.",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("qa/raw-visual-train/raw_visual_training_manifest.jsonl"),
        help="Path to write the training manifest JSONL.",
    )
    parser.add_argument(
        "--summary-output",
        type=Path,
        default=Path("qa/raw-visual-train/raw_visual_training_manifest_summary.json"),
        help="Path to write the manifest summary JSON.",
    )
    parser.add_argument(
        "--query-cache",
        type=Path,
        default=Path("qa/raw-visual-train/.visual_reference_cache/provider_search_cache.json"),
        help="Path to cache provider search query results.",
    )
    parser.add_argument(
        "--reference-image-root",
        type=Path,
        default=Path("qa/raw-visual-train/.visual_reference_cache/reference_images"),
        help="Directory used to cache official reference images.",
    )
    parser.add_argument(
        "--skip-reference-download",
        action="store_true",
        help="Do not download official reference images; emit only referenceImageUrl values.",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=None,
        help="Optional fixture limit for smoke tests.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    fixture_roots = args.fixture_roots or [Path("qa/raw-visual-train")]
    output_path = args.output.resolve()
    summary_output_path = args.summary_output.resolve()
    query_cache_path = args.query_cache.resolve()
    reference_image_root = args.reference_image_root.resolve()
    api_key = os.environ.get("POKEMONTCG_API_KEY")

    if not api_key:
        print("Warning: POKEMONTCG_API_KEY is not set; provider mapping may be slower or rate-limited.")

    fixtures, discovery_skips = discover_fixtures(fixture_roots, limit=args.limit)
    if not fixtures:
        print("No eligible training fixtures were found.")
        if discovery_skips:
            print("Discovery skips:")
            for skipped in discovery_skips[:20]:
                print(f"  - {skipped}")
        return 1

    manifest_rows, summary = build_manifest(
        fixtures=fixtures,
        api_key=api_key,
        query_cache_path=query_cache_path,
        reference_image_root=reference_image_root,
        download_reference_images=not args.skip_reference_download,
    )
    if discovery_skips:
        summary["discoverySkips"] = discovery_skips

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text("".join(json.dumps(row) + "\n" for row in manifest_rows))

    summary_output_path.parent.mkdir(parents=True, exist_ok=True)
    summary_output_path.write_text(json.dumps(summary, indent=2) + "\n")

    print(f"Wrote raw visual training manifest to {output_path}")
    print(f"Wrote training manifest summary to {summary_output_path}")
    print(
        "Fixtures:",
        summary["fixtureCount"],
        "Manifest entries:",
        summary["manifestEntryCount"],
        "Unsupported:",
        summary["unsupportedFixtureCount"],
        "Missing references:",
        summary["missingReferenceImageCount"],
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
