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

from build_raw_visual_seed_manifest import TruthKey, choose_mapping, search_cards, truth_from_fixture, utc_now_iso
from raw_visual_dataset_paths import (
    default_raw_visual_train_expansion_snapshot_path,
    default_raw_visual_train_manifest_path,
    default_raw_visual_train_manifest_summary_path,
    default_raw_visual_train_provider_mapping_overrides_path,
    default_raw_visual_train_query_cache_path,
    default_raw_visual_train_reference_image_root,
    default_raw_visual_scan_registry_path,
    default_raw_visual_train_root,
)


USER_AGENT = "Looty/0.1 (+https://local.looty.app)"


def is_scrydex_mapping(mapping: dict[str, Any]) -> bool:
    if not isinstance(mapping, dict):
        return False
    source_provider = str(
        mapping.get("sourceProvider")
        or mapping.get("providerSource")
        or mapping.get("source")
        or ""
    ).strip().lower()
    if source_provider == "scrydex":
        return True
    reference_url = str(mapping.get("referenceImageUrl") or "").strip().lower()
    provider_card_id = str(mapping.get("providerCardId") or "").strip().lower()
    return "scrydex" in reference_url or "_ja-" in provider_card_id


@dataclass(frozen=True)
class TrainingFixture:
    fixture_root: Path
    fixture_dir: Path
    fixture_name: str
    truth: TruthKey
    source_scan_path: Path
    normalized_image_path: Path
    pinned_provider_mapping: dict[str, Any] | None


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
            pinned_provider_mapping: dict[str, Any] | None = None
            label_status_path = fixture_dir / "label_status.json"
            if label_status_path.exists():
                try:
                    label_status = json.loads(label_status_path.read_text())
                    candidate_mapping = label_status.get("providerMapping")
                    if (
                        isinstance(candidate_mapping, dict)
                        and str(candidate_mapping.get("providerCardId") or "").strip()
                        and is_scrydex_mapping(candidate_mapping)
                    ):
                        pinned_provider_mapping = candidate_mapping
                except Exception:  # noqa: BLE001
                    pinned_provider_mapping = None
            fixtures.append(
                TrainingFixture(
                    fixture_root=root,
                    fixture_dir=fixture_dir,
                    fixture_name=fixture_dir.name,
                    truth=truth,
                    source_scan_path=source_scan_path,
                    normalized_image_path=normalized_image_path,
                    pinned_provider_mapping=pinned_provider_mapping,
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
                "pinnedProviderMappings": [],
            },
        )
        entry["fixtures"].append(fixture)
        if fixture.pinned_provider_mapping:
            entry["pinnedProviderMappings"].append(fixture.pinned_provider_mapping)
    return grouped


def load_registry_fixture_metadata(path: Path) -> dict[str, dict[str, Any]]:
    if not path.exists():
        return {}
    payload = json.loads(path.read_text())
    entries = payload.get("entries") or []
    metadata_by_fixture_path: dict[str, dict[str, Any]] = {}
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        fixture_path = str(entry.get("importedFixturePath") or "").strip()
        if not fixture_path:
            continue
        metadata_by_fixture_path[fixture_path] = entry
    return metadata_by_fixture_path


def pinned_mapping_payload(mapping: dict[str, Any]) -> dict[str, Any]:
    return {
        "providerSupported": True,
        "mappingConfidence": 1.0,
        "mappingReason": "pinned_label_status",
        "selected": {
            "providerCardId": mapping.get("providerCardId"),
            "providerName": mapping.get("providerName"),
            "providerCollectorNumber": mapping.get("providerCollectorNumber"),
            "providerSetId": mapping.get("providerSetId"),
            "providerSetPtcgoCode": mapping.get("providerSetPtcgoCode"),
            "providerSetName": mapping.get("providerSetName"),
            "referenceImageUrl": mapping.get("referenceImageUrl"),
            "sourceProvider": "scrydex",
        },
        "candidateSummaries": [
            {
                "providerCardId": mapping.get("providerCardId"),
                "providerName": mapping.get("providerName"),
                "providerCollectorNumber": mapping.get("providerCollectorNumber"),
                "providerSetId": mapping.get("providerSetId"),
                "providerSetPtcgoCode": mapping.get("providerSetPtcgoCode"),
                "providerSetName": mapping.get("providerSetName"),
                "referenceImageUrl": mapping.get("referenceImageUrl"),
                "sourceProvider": "scrydex",
                "mappingScore": 999,
                "mappingReasons": ["pinned_label_status"],
            }
        ],
    }


def load_provider_mapping_overrides(path: Path) -> dict[str, dict[str, Any]]:
    if not path.exists():
        return {}
    payload = json.loads(path.read_text())
    if not isinstance(payload, list):
        return {}
    overrides: dict[str, dict[str, Any]] = {}
    for item in payload:
        if not isinstance(item, dict):
            continue
        truth_key = str(item.get("truthKey") or "").strip()
        if not truth_key:
            continue
        overrides[truth_key] = dict(item)
    return overrides


def fetch_provider_card_by_id(
    provider_card_id: str,
    *,
    api_key: str | None,
    query_cache: dict[str, list[dict[str, Any]]],
) -> dict[str, Any] | None:
    provider_card_id = str(provider_card_id or "").strip()
    if not provider_card_id:
        return None

    lanes = [True, False] if "_ja-" in provider_card_id or provider_card_id.endswith("_ja") else [False, True]
    for japanese in lanes:
        lane = "ja" if japanese else "global"
        query = f"id:{provider_card_id}"
        cache_key = f"{lane}:{query}"
        cards = query_cache.get(cache_key)
        if cards is None:
            try:
                cards = search_cards(query, api_key, page_size=5, japanese=japanese)
            except Exception:  # noqa: BLE001
                cards = []
            query_cache[cache_key] = cards
        for card in cards:
            if str(card.get("id") or "").strip() == provider_card_id:
                return card
    return None


def provider_override_mapping_payload(
    override: dict[str, Any],
    *,
    api_key: str | None,
    query_cache: dict[str, list[dict[str, Any]]],
) -> dict[str, Any]:
    status = str(override.get("status") or "").strip().lower()
    provider_card_id = str(override.get("providerCardId") or "").strip()
    source_url = str(override.get("sourceUrl") or "").strip() or None
    notes = str(override.get("notes") or "").strip() or None

    if status == "not_in_scrydex":
        return {
            "providerSupported": False,
            "mappingConfidence": "unsupported",
            "mappingReason": "Manual override marked truth as NOT_IN_SCRYDEX.",
            "selected": None,
            "candidateSummaries": [],
            "attempts": [],
            "overrideStatus": status,
            "overrideNotes": notes,
        }

    card = fetch_provider_card_by_id(provider_card_id, api_key=api_key, query_cache=query_cache) if provider_card_id else None
    selected = None
    candidate_summaries: list[dict[str, Any]] = []
    if card is not None:
        selected = {
            "providerCardId": card.get("id"),
            "providerName": card.get("name"),
            "providerCollectorNumber": card.get("number"),
            "providerSetId": card.get("set_id") or card.get("setID"),
            "providerSetPtcgoCode": card.get("set_ptcgo_code") or card.get("setPtcgoCode"),
            "providerSetName": card.get("set_name") or card.get("setName"),
            "referenceImageUrl": card.get("reference_image_url") or card.get("imageURL"),
            "sourceProvider": card.get("source") or "scrydex",
        }
        candidate_summaries = [
            {
                **selected,
                "mappingScore": 999,
                "mappingReasons": [f"provider_mapping_override:{status or 'pinned'}"],
            }
        ]
    elif provider_card_id:
        selected = {
            "providerCardId": provider_card_id,
            "providerName": None,
            "providerCollectorNumber": None,
            "providerSetId": None,
            "providerSetPtcgoCode": None,
            "providerSetName": None,
            "referenceImageUrl": source_url,
            "sourceProvider": "scrydex",
        }

    if status == "tentative_scrydex_match":
        return {
            "providerSupported": False,
            "mappingConfidence": "low",
            "mappingReason": "Manual override recorded a tentative Scrydex match that still needs review.",
            "selected": selected,
            "candidateSummaries": candidate_summaries,
            "attempts": [],
            "overrideStatus": status,
            "overrideNotes": notes,
        }

    return {
        "providerSupported": True,
        "mappingConfidence": "high",
        "mappingReason": "Provider mapping was pinned from a verified override.",
        "selected": selected,
        "candidateSummaries": candidate_summaries,
        "attempts": [],
        "overrideStatus": status or "pinned",
        "overrideNotes": notes,
    }


def build_manifest(
    *,
    fixtures: list[TrainingFixture],
    api_key: str | None,
    query_cache_path: Path,
    reference_image_root: Path,
    download_reference_images: bool,
    expansion_snapshot_path: Path,
    registry_metadata_by_fixture_path: dict[str, dict[str, Any]],
    provider_mapping_overrides: dict[str, dict[str, Any]],
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
        pinned_mappings = [
            mapping
            for mapping in grouped_entry.get("pinnedProviderMappings") or []
            if isinstance(mapping, dict) and str(mapping.get("providerCardId") or "").strip()
        ]
        pinned_by_id = {
            str(mapping.get("providerCardId") or "").strip(): mapping
            for mapping in pinned_mappings
            if str(mapping.get("providerCardId") or "").strip()
        }
        if len(pinned_by_id) == 1:
            truth_mappings[truth.key] = pinned_mapping_payload(next(iter(pinned_by_id.values())))
        elif truth.key in provider_mapping_overrides:
            truth_mappings[truth.key] = provider_override_mapping_payload(
                provider_mapping_overrides[truth.key],
                api_key=api_key,
                query_cache=query_cache,
            )
        else:
            truth_mappings[truth.key] = choose_mapping(
                truth,
                api_key,
                query_cache,
                allow_live_expansion_lookup=False,
                allow_legacy_set_code_queries=False,
                expansion_snapshot_path=expansion_snapshot_path,
            )

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
            "sourceProvider": selected.get("sourceProvider") or "scrydex",
            "referenceImageUrl": reference_image_url or None,
            "referenceImagePath": reference_image_path,
            "referenceImageError": reference_image_error,
            "mappingConfidence": mapping.get("mappingConfidence"),
            "mappingReason": mapping.get("mappingReason"),
            "candidateSummaries": mapping.get("candidateSummaries") or [],
        }
        registry_entry = registry_metadata_by_fixture_path.get(str(fixture.fixture_dir.resolve())) or {}
        if registry_entry:
            row["datasetStatus"] = registry_entry.get("datasetStatus")
            row["importBatchId"] = registry_entry.get("batchID")
            row["importBucket"] = registry_entry.get("bucket")
            row["expansionHoldoutSelected"] = bool(registry_entry.get("expansionHoldoutSelected"))

        if bool(row.get("expansionHoldoutSelected")):
            skipped_rows.append(
                {
                    "fixtureName": fixture.fixture_name,
                    "truthKey": fixture.truth.key,
                    "reason": "expansion_holdout_selected",
                    "mappingConfidence": mapping.get("mappingConfidence"),
                    "mappingReason": mapping.get("mappingReason"),
                }
            )
            continue

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
        "provider": "scrydex",
        "fixtureCount": len(fixtures),
        "uniqueTruthCount": len(grouped),
        "manifestEntryCount": len(manifest_rows),
        "unsupportedFixtureCount": len(skipped_rows),
        "referenceImageDownloadEnabled": download_reference_images,
        "missingReferenceImageCount": sum(1 for row in manifest_rows if not row["referenceImagePath"]),
        "expansionSnapshotPath": str(expansion_snapshot_path),
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
        default=default_raw_visual_train_manifest_path(),
        help="Path to write the training manifest JSONL.",
    )
    parser.add_argument(
        "--summary-output",
        type=Path,
        default=default_raw_visual_train_manifest_summary_path(),
        help="Path to write the manifest summary JSON.",
    )
    parser.add_argument(
        "--query-cache",
        type=Path,
        default=default_raw_visual_train_query_cache_path(),
        help="Path to cache provider search query results.",
    )
    parser.add_argument(
        "--expansion-snapshot",
        type=Path,
        default=default_raw_visual_train_expansion_snapshot_path(),
        help="Local Scrydex expansions snapshot used for offline expansion resolution.",
    )
    parser.add_argument(
        "--reference-image-root",
        type=Path,
        default=default_raw_visual_train_reference_image_root(),
        help="Directory used to cache official reference images.",
    )
    parser.add_argument(
        "--scan-registry-path",
        type=Path,
        default=default_raw_visual_scan_registry_path(),
        help="Optional raw scan registry used to enrich manifest rows with batch provenance.",
    )
    parser.add_argument(
        "--provider-mapping-overrides",
        type=Path,
        default=default_raw_visual_train_provider_mapping_overrides_path(),
        help="Optional truth-level provider mapping override file.",
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
    fixture_roots = args.fixture_roots or [default_raw_visual_train_root()]
    output_path = args.output.resolve()
    summary_output_path = args.summary_output.resolve()
    query_cache_path = args.query_cache.resolve()
    expansion_snapshot_path = args.expansion_snapshot.resolve()
    reference_image_root = args.reference_image_root.resolve()
    scan_registry_path = args.scan_registry_path.resolve()
    provider_mapping_overrides_path = args.provider_mapping_overrides.resolve()
    api_key = os.environ.get("SCRYDEX_API_KEY")

    if not api_key:
        print("Warning: SCRYDEX_API_KEY is not set; provider mapping may be slower or rate-limited.")

    fixtures, discovery_skips = discover_fixtures(fixture_roots, limit=args.limit)
    registry_metadata_by_fixture_path = load_registry_fixture_metadata(scan_registry_path)
    provider_mapping_overrides = load_provider_mapping_overrides(provider_mapping_overrides_path)
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
        expansion_snapshot_path=expansion_snapshot_path,
        reference_image_root=reference_image_root,
        download_reference_images=not args.skip_reference_download,
        registry_metadata_by_fixture_path=registry_metadata_by_fixture_path,
        provider_mapping_overrides=provider_mapping_overrides,
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
