#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from raw_visual_dataset_paths import (
    default_raw_visual_train_excluded_root,
    default_raw_visual_train_manual_label_overrides_path,
    default_raw_visual_train_root,
)

from build_raw_visual_seed_manifest import utc_now_iso


LABEL_STATUS_FILENAME = "label_status.json"


@dataclass(frozen=True)
class ManualTruth:
    fixture_name: str
    card_name: str
    collector_number: str
    set_code: str | None

    @property
    def truth_key(self) -> str:
        return f"{normalized_title(self.card_name)}|{normalized_collector_number(self.collector_number)}|{normalized_set_token(self.set_code)}"


def normalized_title(value: str | None) -> str:
    return re.sub(r"[^a-z0-9]+", "", str(value or "").lower())


def normalized_set_token(value: str | None) -> str:
    return re.sub(r"[^a-z0-9]+", "", str(value or "").lower())


def normalize_collector_part(value: str) -> str:
    match = re.fullmatch(r"([A-Z]+)?(\d+)", value)
    if not match:
        return value
    prefix = match.group(1) or ""
    number = str(int(match.group(2)))
    return f"{prefix}{number}"


def normalized_collector_number(value: str | None) -> str:
    raw = re.sub(r"[^A-Z0-9/]+", "", str(value or "").upper())
    if not raw:
        return raw
    return "/".join(normalize_collector_part(part) for part in raw.split("/"))


def collector_prefix(value: str | None) -> str:
    normalized = normalized_collector_number(value)
    if "/" in normalized:
        return normalized.split("/", 1)[0]
    return normalized


def slugify_card_name(value: str) -> str:
    value = value.lower()
    value = value.replace("&", " and ")
    value = value.replace("'", "")
    value = re.sub(r"[^a-z0-9]+", "-", value)
    return value.strip("-")


def collector_slug(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", str(value).lower()).strip("-")


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n")


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text())


def load_manual_labels(path: Path) -> list[ManualTruth]:
    payload = json.loads(path.read_text())
    labels: list[ManualTruth] = []
    if not isinstance(payload, list):
        raise SystemExit(f"Manual label file must be a JSON array: {path}")
    for item in payload:
        if not isinstance(item, dict):
            continue
        labels.append(
            ManualTruth(
                fixture_name=str(item["fixtureName"]).strip(),
                card_name=str(item["cardName"]).strip(),
                collector_number=str(item["collectorNumber"]).strip(),
                set_code=(str(item.get("setCode")).strip() or None) if item.get("setCode") is not None else None,
            )
        )
    return labels


def load_visual_index_entries(path: Path) -> list[dict[str, Any]]:
    payload = json.loads(path.read_text())
    entries = payload.get("entries")
    if not isinstance(entries, list):
        raise SystemExit(f"Visual index manifest missing entries array: {path}")
    return entries


def candidate_set_tokens(entry: dict[str, Any]) -> set[str]:
    tokens = {
        normalized_set_token(entry.get("setId")),
        normalized_set_token(entry.get("setPtcgoCode")),
        normalized_set_token(entry.get("setName")),
        normalized_set_token(entry.get("setSeries")),
    }
    return {token for token in tokens if token}


def resolve_provider_mapping(
    truth: ManualTruth,
    *,
    entries: list[dict[str, Any]],
) -> dict[str, Any] | None:
    name_key = normalized_title(truth.card_name)
    full_number = normalized_collector_number(truth.collector_number)
    prefix = collector_prefix(truth.collector_number)
    set_token = normalized_set_token(truth.set_code)

    ranked: list[tuple[int, int, dict[str, Any]]] = []
    for entry in entries:
        entry_name = normalized_title(str(entry.get("name") or ""))
        if entry_name != name_key:
            continue

        entry_number = normalized_collector_number(str(entry.get("collectorNumber") or ""))
        entry_prefix = collector_prefix(entry_number)

        score = 0
        if entry_number == full_number:
            score += 100
        elif entry_prefix and entry_prefix == prefix:
            score += 70
        else:
            continue

        entry_set_tokens = candidate_set_tokens(entry)
        if set_token and set_token in entry_set_tokens:
            score += 20

        ranked.append((score, len(entry_set_tokens), entry))

    ranked.sort(
        key=lambda item: (
            -item[0],
            -item[1],
            str(item[2].get("providerCardId") or ""),
        )
    )
    if not ranked:
        return None

    top_score = ranked[0][0]
    top_entries = [item[2] for item in ranked if item[0] == top_score]
    if len(top_entries) > 1:
        exact_matches = [
            entry
            for entry in top_entries
            if normalized_collector_number(str(entry.get("collectorNumber") or "")) == full_number
        ]
        if len(exact_matches) == 1:
            top_entries = exact_matches
        else:
            set_matched = [
                entry
                for entry in top_entries
                if set_token and set_token in candidate_set_tokens(entry)
            ]
            if len(set_matched) == 1:
                top_entries = set_matched
    if len(top_entries) != 1:
        return None

    return top_entries[0]


def truth_payload(truth: ManualTruth) -> dict[str, Any]:
    return {
        "cardName": truth.card_name,
        "collectorNumber": truth.collector_number,
        "setCode": truth.set_code,
    }


def desired_fixture_name(truth: ManualTruth) -> str:
    return f"{slugify_card_name(truth.card_name)}-{collector_slug(truth.collector_number)}-best"


def desired_excluded_name(truth: ManualTruth, original_fixture_name: str) -> str:
    return f"{desired_fixture_name(truth)}--{original_fixture_name.replace('_', '-')}"


def ensure_unique_directory(root: Path, desired_name: str, *, current_dir: Path | None = None) -> Path:
    candidate = root / desired_name
    if current_dir is not None and candidate.resolve() == current_dir.resolve():
        return candidate
    if not candidate.exists():
        return candidate
    index = 2
    while True:
        retry = root / f"{desired_name}-{index}"
        if current_dir is not None and retry.resolve() == current_dir.resolve():
            return retry
        if not retry.exists():
            return retry
        index += 1


def load_existing_truth_keys(root: Path) -> tuple[dict[str, str], dict[str, str]]:
    truth_keys: dict[str, str] = {}
    provider_ids: dict[str, str] = {}
    for truth_path in sorted(root.rglob("truth.json")):
        fixture_dir = truth_path.parent
        data = read_json(truth_path)
        manual = ManualTruth(
            fixture_name=fixture_dir.name,
            card_name=str(data.get("cardName") or "").strip(),
            collector_number=str(data.get("collectorNumber") or "").strip(),
            set_code=(str(data.get("setCode")).strip() or None) if data.get("setCode") is not None else None,
        )
        truth_keys[manual.truth_key] = fixture_dir.name
        status_path = fixture_dir / LABEL_STATUS_FILENAME
        if status_path.exists():
            status = read_json(status_path)
            provider_card_id = str(((status.get("providerMapping") or {}).get("providerCardId")) or "").strip()
            if provider_card_id:
                provider_ids[provider_card_id] = fixture_dir.name
    return truth_keys, provider_ids


def heldout_truth_and_provider_keys(
    heldout_root: Path,
    entries: list[dict[str, Any]],
) -> tuple[dict[str, str], dict[str, str]]:
    truth_keys: dict[str, str] = {}
    provider_ids: dict[str, str] = {}
    for truth_path in sorted(heldout_root.rglob("truth.json")):
        fixture_dir = truth_path.parent
        data = read_json(truth_path)
        truth = ManualTruth(
            fixture_name=fixture_dir.name,
            card_name=str(data.get("cardName") or "").strip(),
            collector_number=str(data.get("collectorNumber") or "").strip(),
            set_code=(str(data.get("setCode")).strip() or None) if data.get("setCode") is not None else None,
        )
        truth_keys[truth.truth_key] = fixture_dir.name
        mapping = resolve_provider_mapping(truth, entries=entries)
        provider_card_id = str(mapping.get("providerCardId") or "").strip() if mapping else ""
        if provider_card_id:
            provider_ids[provider_card_id] = fixture_dir.name
    return truth_keys, provider_ids


def overlap_paths_by_type(
    overlap_paths: list[str],
    *,
    heldout_root: Path,
    training_root: Path,
    archive_root: Path,
) -> dict[str, list[str]]:
    buckets = {
        "heldout": [],
        "training": [],
        "archive": [],
        "other": [],
    }
    for raw in overlap_paths:
        path = Path(raw).resolve()
        as_posix = path.as_posix()
        if heldout_root.as_posix() in as_posix:
            buckets["heldout"].append(raw)
        elif training_root.as_posix() in as_posix:
            buckets["training"].append(raw)
        elif archive_root.as_posix() in as_posix:
            buckets["archive"].append(raw)
        else:
            buckets["other"].append(raw)
    return buckets


def main() -> None:
    parser = argparse.ArgumentParser(description="Apply manually verified labels to raw visual training fixtures.")
    parser.add_argument(
        "--labels-path",
        default=str(default_raw_visual_train_manual_label_overrides_path()),
        help="JSON file mapping fixtureName -> verified truth label.",
    )
    parser.add_argument(
        "--training-root",
        default=str(default_raw_visual_train_root()),
        help="Accepted training fixture root.",
    )
    parser.add_argument(
        "--heldout-root",
        default="qa/raw-footer-layout-check",
        help="Held-out evaluation fixture root.",
    )
    parser.add_argument(
        "--excluded-root",
        default=str(default_raw_visual_train_excluded_root()),
        help="Archive root for labeled-but-excluded fixtures.",
    )
    parser.add_argument(
        "--visual-index-manifest",
        default="backend/data/visual-index/visual_index_active_manifest.json",
        help="Visual index manifest used to resolve provider mappings.",
    )
    args = parser.parse_args()

    training_root = Path(args.training_root).resolve()
    heldout_root = Path(args.heldout_root).resolve()
    excluded_root = Path(args.excluded_root).resolve()
    labels_path = Path(args.labels_path).resolve()
    visual_index_manifest_path = Path(args.visual_index_manifest).resolve()

    manual_labels = load_manual_labels(labels_path)
    entries = load_visual_index_entries(visual_index_manifest_path)
    heldout_truth_keys, heldout_provider_ids = heldout_truth_and_provider_keys(heldout_root, entries)
    existing_training_truth_keys, existing_training_provider_ids = load_existing_truth_keys(training_root)

    duplicates_by_truth_key: dict[str, list[ManualTruth]] = {}
    review_payloads: dict[str, dict[str, Any]] = {}
    for truth in manual_labels:
        duplicates_by_truth_key.setdefault(truth.truth_key, []).append(truth)
        review_path = training_root / truth.fixture_name / "auto_label_review.json"
        if review_path.exists():
            review_payloads[truth.fixture_name] = read_json(review_path)

    primary_fixture_by_truth_key: dict[str, str] = {}
    for truth_key, grouped in duplicates_by_truth_key.items():
        grouped_sorted = sorted(
            grouped,
            key=lambda item: (
                -1 if bool(((review_payloads.get(item.fixture_name) or {}).get("overlapFlags") or {}).get("isBatchPrimary")) else 0,
                -float((review_payloads.get(item.fixture_name) or {}).get("confidencePercent") or 0.0),
                item.fixture_name,
            ),
        )
        primary_fixture_by_truth_key[truth_key] = grouped_sorted[0].fixture_name

    accepted_root = training_root
    heldout_root_dest = excluded_root / "heldout-overlap"
    duplicate_root_dest = excluded_root / "duplicates"
    blocked_root_dest = excluded_root / "provider-blocked"
    for path in [accepted_root, heldout_root_dest, duplicate_root_dest, blocked_root_dest]:
        path.mkdir(parents=True, exist_ok=True)

    summary_entries: list[dict[str, Any]] = []

    for truth in manual_labels:
        current_dir = training_root / truth.fixture_name
        if not current_dir.exists():
            raise SystemExit(f"Missing fixture directory for {truth.fixture_name}: {current_dir}")

        import_metadata = read_json(current_dir / "import_metadata.json") if (current_dir / "import_metadata.json").exists() else {}
        review_payload = review_payloads.get(truth.fixture_name) or {}
        mapping = resolve_provider_mapping(truth, entries=entries)
        provider_card_id = str(mapping.get("providerCardId") or "").strip() if mapping else ""
        exact_overlap_paths = list(import_metadata.get("exactImageHashOverlaps") or [])
        overlap_buckets = overlap_paths_by_type(
            exact_overlap_paths,
            heldout_root=heldout_root,
            training_root=training_root,
            archive_root=excluded_root,
        )

        overlap_test = truth.truth_key in heldout_truth_keys or (provider_card_id and provider_card_id in heldout_provider_ids) or bool(overlap_buckets["heldout"])
        overlap_existing_training = truth.truth_key in existing_training_truth_keys or (provider_card_id and provider_card_id in existing_training_provider_ids) or bool(overlap_buckets["training"])
        duplicate_within_manual = len(duplicates_by_truth_key[truth.truth_key]) > 1
        is_manual_primary = primary_fixture_by_truth_key[truth.truth_key] == truth.fixture_name
        provider_supported = mapping is not None

        if overlap_test:
            disposition = "excluded_heldout_overlap"
            destination_root = heldout_root_dest
            destination_name = desired_excluded_name(truth, truth.fixture_name)
        elif overlap_existing_training or (duplicate_within_manual and not is_manual_primary):
            disposition = "excluded_duplicate"
            destination_root = duplicate_root_dest
            destination_name = desired_excluded_name(truth, truth.fixture_name)
        elif not provider_supported:
            disposition = "blocked_provider_support"
            destination_root = blocked_root_dest
            destination_name = desired_excluded_name(truth, truth.fixture_name)
        else:
            disposition = "accepted_for_training"
            destination_root = accepted_root
            destination_name = desired_fixture_name(truth)

        target_dir = ensure_unique_directory(destination_root, destination_name, current_dir=current_dir)
        if target_dir != current_dir:
            current_dir.rename(target_dir)
        fixture_dir = target_dir

        truth_payload_data = truth_payload(truth)
        write_json(fixture_dir / "truth.json", truth_payload_data)

        status_payload = {
            "generatedAt": utc_now_iso(),
            "source": "manual_label_overrides_2026-04-12",
            "disposition": disposition,
            "fixtureName": fixture_dir.name,
            "originalFixtureName": truth.fixture_name,
            "fixturePath": str(fixture_dir),
            "manualTruth": truth_payload_data,
            "providerSupported": provider_supported,
            "providerMapping": (
                {
                    "providerCardId": provider_card_id,
                    "providerName": mapping.get("name"),
                    "providerCollectorNumber": mapping.get("collectorNumber"),
                    "providerSetId": mapping.get("setId"),
                    "providerSetPtcgoCode": mapping.get("setPtcgoCode"),
                    "providerSetName": mapping.get("setName"),
                    "providerSetSeries": mapping.get("setSeries"),
                    "referenceImageUrl": mapping.get("imageUrl"),
                }
                if mapping
                else None
            ),
            "overlapFlags": {
                "heldoutTruthOrProviderOverlap": overlap_test,
                "existingTrainingOverlap": overlap_existing_training,
                "exactImageHashOverlap": bool(exact_overlap_paths),
                "duplicateWithinManual": duplicate_within_manual,
                "isManualPrimary": is_manual_primary,
            },
            "exactImageHashOverlaps": exact_overlap_paths,
            "exactImageHashOverlapBuckets": overlap_buckets,
            "autoLabelReview": {
                "confidencePercent": review_payload.get("confidencePercent"),
                "visualTopId": review_payload.get("visualTopId"),
                "hybridTopId": review_payload.get("hybridTopId"),
            },
        }
        write_json(fixture_dir / LABEL_STATUS_FILENAME, status_payload)

        if disposition == "accepted_for_training":
            existing_training_truth_keys[truth.truth_key] = fixture_dir.name
            if provider_card_id:
                existing_training_provider_ids[provider_card_id] = fixture_dir.name

        summary_entries.append(status_payload)

    counts: dict[str, int] = {}
    for entry in summary_entries:
        counts[entry["disposition"]] = counts.get(entry["disposition"], 0) + 1

    summary_payload = {
        "generatedAt": utc_now_iso(),
        "labelsPath": str(labels_path),
        "trainingRoot": str(training_root),
        "heldoutRoot": str(heldout_root),
        "excludedRoot": str(excluded_root),
        "visualIndexManifest": str(visual_index_manifest_path),
        "counts": counts,
        "entries": sorted(summary_entries, key=lambda entry: (entry["disposition"], entry["fixtureName"])),
    }
    write_json(training_root / "manual_label_application_summary.json", summary_payload)
    write_json(excluded_root / "manual_label_application_summary.json", summary_payload)
    print(json.dumps(summary_payload, indent=2))


if __name__ == "__main__":
    main()
