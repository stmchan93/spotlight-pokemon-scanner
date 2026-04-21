#!/usr/bin/env python3
from __future__ import annotations

import argparse
import csv
import json
import os
import random
import subprocess
import sys
import xml.etree.ElementTree as ET
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from zipfile import ZipFile

from import_raw_visual_training_photos import (
    build_image_lookup,
    canonical_header,
    discover_existing_source_scans,
    parse_metadata_rows,
    resolve_manifest_image,
    sha256_file,
    source_image_issue,
)
from raw_visual_dataset_paths import (
    default_raw_visual_batch_audit_root,
    default_raw_visual_expansion_holdout_root,
    default_raw_visual_scan_registry_path,
    default_raw_visual_train_excluded_root,
    default_raw_visual_train_root,
)


REPO_ROOT = Path(__file__).resolve().parent.parent
HELDOUT_ROOT = REPO_ROOT / "qa" / "raw-footer-layout-check"
REQUIRED_BATCH_FIELDS = ("file_name", "card_name", "number", "set")
VISUAL_REQUIREMENTS_PATH = REPO_ROOT / "tools" / "requirements_raw_visual_poc.txt"
VISUAL_VENV_PATH = REPO_ROOT / ".venv-raw-visual-poc"


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def slugify(value: str) -> str:
    cleaned = str(value or "").strip().lower()
    cleaned = cleaned.replace("&", " and ").replace("'", "")
    return "-".join(part for part in "".join(ch if ch.isalnum() else " " for ch in cleaned).split())


def normalize_name(value: str) -> str:
    return "".join(ch for ch in str(value or "").lower() if ch.isalnum())


def normalize_number(value: str) -> str:
    return str(value or "").strip().upper()


def normalize_set(value: str) -> str:
    return str(value or "").strip().upper()


def truth_key(card_name: str, collector_number: str, set_code: str) -> str:
    return f"{normalize_name(card_name)}|{normalize_number(collector_number)}|{normalize_set(set_code)}"


def registry_entry_key(batch_id: str, file_hash: str, source_file_name: str) -> str:
    return f"{batch_id}|{file_hash}|{source_file_name}"


def col_index(reference: str) -> int:
    letters = "".join(ch for ch in reference if ch.isalpha())
    value = 0
    for ch in letters:
        value = value * 26 + (ord(ch.upper()) - 64)
    return value - 1


def parse_xlsx_rows(path: Path) -> list[dict[str, str]]:
    namespace = {
        "main": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
        "rel": "http://schemas.openxmlformats.org/package/2006/relationships",
    }
    with ZipFile(path) as archive:
        workbook = ET.fromstring(archive.read("xl/workbook.xml"))
        relationships = ET.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
        relationship_map = {
            item.attrib["Id"]: item.attrib["Target"]
            for item in relationships.findall("rel:Relationship", namespace)
        }
        sheets = workbook.findall("main:sheets/main:sheet", namespace)
        if not sheets:
            raise SystemExit(f"Workbook has no sheets: {path}")

        preferred_sheet_names = ("RAW", "Raw", "raw")
        selected_sheet = None
        for preferred_name in preferred_sheet_names:
            selected_sheet = next((sheet for sheet in sheets if sheet.attrib.get("name") == preferred_name), None)
            if selected_sheet is not None:
                break
        if selected_sheet is None:
            selected_sheet = sheets[0]

        target = relationship_map[
            selected_sheet.attrib["{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"]
        ]
        shared_strings: list[str] = []
        if "xl/sharedStrings.xml" in archive.namelist():
            shared = ET.fromstring(archive.read("xl/sharedStrings.xml"))
            for item in shared.findall("main:si", namespace):
                shared_strings.append("".join(text.text or "" for text in item.iterfind(".//main:t", namespace)))

        sheet = ET.fromstring(archive.read("xl/" + target.lstrip("/")))
        rows = sheet.findall("main:sheetData/main:row", namespace)
        if not rows:
            return []

        def cell_value(cell: ET.Element) -> str:
            cell_type = cell.attrib.get("t")
            if cell_type == "inlineStr":
                return "".join(text.text or "" for text in cell.iterfind(".//main:t", namespace))
            value_node = cell.find("main:v", namespace)
            if value_node is None:
                return ""
            raw = value_node.text or ""
            if cell_type == "s":
                return shared_strings[int(raw)]
            return raw

        raw_rows: list[dict[int, str]] = []
        max_col = 0
        for row in rows:
            values: dict[int, str] = {}
            for cell in row.findall("main:c", namespace):
                index = col_index(cell.attrib.get("r", "A1"))
                max_col = max(max_col, index)
                values[index] = cell_value(cell)
            raw_rows.append(values)

        headers = [raw_rows[0].get(index, "") for index in range(max_col + 1)]
        parsed_rows: list[dict[str, str]] = []
        for raw_row in raw_rows[1:]:
            normalized: dict[str, str] = {}
            for index in range(max_col + 1):
                header = canonical_header(headers[index])
                if not header:
                    continue
                normalized[header] = raw_row.get(index, "").strip()
            if not any(normalized.values()):
                continue
            if not normalized.get("file_name"):
                continue
            parsed_rows.append(normalized)
        return parsed_rows


def parse_batch_rows(path: Path) -> list[dict[str, str]]:
    if path.suffix.lower() == ".xlsx":
        raw_rows = parse_xlsx_rows(path)
    else:
        raw_rows = parse_metadata_rows(path, delimiter=None)

    rows: list[dict[str, str]] = []
    for row in raw_rows:
        rows.append(
            {
                "file_name": row.get("file_name", "").strip(),
                "card_name": row.get("card_name", "").strip(),
                "number": row.get("number", row.get("collector_number", "")).strip(),
                "set": row.get("set", row.get("set_code", "")).strip(),
                "promo": row.get("promo", row.get("Promo", "")).strip(),
            }
        )

    missing_fields = [
        {
            "rowIndex": index + 2,
            "missingFields": [field for field in REQUIRED_BATCH_FIELDS if not str(row.get(field) or "").strip()],
        }
        for index, row in enumerate(rows)
        if any(not str(row.get(field) or "").strip() for field in REQUIRED_BATCH_FIELDS)
    ]
    if missing_fields:
        raise SystemExit(f"Batch sheet has rows missing required values: {missing_fields[:10]}")
    return rows


def apply_row_exclusions(
    rows: list[dict[str, str]],
    *,
    exclude_file_names: set[str],
    exclude_truth_keys: set[str],
) -> tuple[list[dict[str, str]], list[dict[str, str]]]:
    filtered_rows: list[dict[str, str]] = []
    excluded_rows: list[dict[str, str]] = []

    normalized_file_names = {name.strip().lower() for name in exclude_file_names if name.strip()}
    normalized_truth_keys = {value.strip() for value in exclude_truth_keys if value.strip()}

    for row in rows:
        file_name = str(row.get("file_name") or "").strip()
        normalized_truth = truth_key(
            str(row.get("card_name") or ""),
            str(row.get("number") or ""),
            str(row.get("set") or ""),
        )
        should_exclude = file_name.lower() in normalized_file_names or normalized_truth in normalized_truth_keys
        if should_exclude:
            excluded_rows.append(row)
        else:
            filtered_rows.append(row)
    return filtered_rows, excluded_rows


@dataclass
class BatchEntry:
    source_file_name: str
    resolved_file_name: str
    resolved_path: Path
    file_hash: str
    card_name: str
    collector_number: str
    set_code: str
    promo: str
    normalized_truth_key: str
    overlap_roots: list[str]
    overlap_registry: list[str]
    notes: list[str]
    source_image_issue: str | None
    bucket: str
    reason: str
    imported_fixture_path: str | None = None


def note_list(card_name: str, collector_number: str, set_code: str) -> list[str]:
    notes: list[str] = []
    if not collector_number.strip():
        notes.append("missing_collector_number")
    if " - " in collector_number:
        notes.append("collector_number_needs_normalization")
    if not normalize_name(card_name):
        notes.append("missing_card_name")
    if not normalize_set(set_code):
        notes.append("missing_set_code")
    return notes


def load_truth_index(root: Path) -> dict[str, list[str]]:
    index: dict[str, list[str]] = defaultdict(list)
    if not root.exists():
        return index
    for truth_path in root.rglob("truth.json"):
        try:
            payload = json.loads(truth_path.read_text())
        except Exception:  # noqa: BLE001
            continue
        key = truth_key(
            str(payload.get("cardName") or ""),
            str(payload.get("collectorNumber") or ""),
            str(payload.get("setCode") or ""),
        )
        index[key].append(str(truth_path.parent.resolve()))
    return index


def load_registry(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {"schemaVersion": 1, "updatedAt": None, "entries": []}
    payload = json.loads(path.read_text())
    if not isinstance(payload, dict):
        return {"schemaVersion": 1, "updatedAt": None, "entries": []}
    entries = payload.get("entries")
    if not isinstance(entries, list):
        entries = []
    return {
        "schemaVersion": int(payload.get("schemaVersion") or 1),
        "updatedAt": payload.get("updatedAt"),
        "entries": entries,
    }


def registry_indexes(registry: dict[str, Any]) -> tuple[dict[str, list[dict[str, Any]]], dict[str, list[dict[str, Any]]]]:
    by_hash: dict[str, list[dict[str, Any]]] = defaultdict(list)
    by_truth: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for entry in registry.get("entries") or []:
        if not isinstance(entry, dict):
            continue
        file_hash = str(entry.get("fileHash") or "").strip()
        truth_key_value = str(entry.get("normalizedTruthKey") or "").strip()
        if file_hash:
            by_hash[file_hash].append(entry)
        if truth_key_value:
            by_truth[truth_key_value].append(entry)
    return by_hash, by_truth


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n")


def write_tsv(path: Path, rows: list[dict[str, str]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="") as handle:
        writer = csv.DictWriter(
            handle,
            fieldnames=["file_name", "card_name", "number", "set", "Promo"],
            delimiter="\t",
        )
        writer.writeheader()
        for row in rows:
            writer.writerow(row)


def batch_entry_tsv_row(entry: BatchEntry) -> dict[str, str]:
    return {
        "file_name": entry.resolved_file_name,
        "card_name": entry.card_name,
        "number": entry.collector_number,
        "set": entry.set_code,
        "Promo": entry.promo,
    }


def determine_expansion_holdout_count(photo_count: int) -> int:
    if photo_count >= 6:
        return 2
    if photo_count >= 4:
        return 1
    return 0


def split_safe_new_entries_for_expansion_holdout(
    safe_new_entries: list[BatchEntry],
    *,
    batch_id: str,
) -> tuple[list[BatchEntry], list[BatchEntry], list[dict[str, Any]]]:
    grouped_entries: dict[str, list[BatchEntry]] = defaultdict(list)
    for entry in safe_new_entries:
        grouped_entries[entry.normalized_truth_key].append(entry)

    train_entries: list[BatchEntry] = []
    holdout_entries: list[BatchEntry] = []
    holdout_summary: list[dict[str, Any]] = []

    for normalized_truth_key, grouped in sorted(grouped_entries.items()):
        ordered_entries = sorted(grouped, key=lambda entry: (entry.resolved_file_name, entry.file_hash))
        holdout_count = determine_expansion_holdout_count(len(ordered_entries))
        shuffled_entries = list(ordered_entries)
        random.Random(f"{batch_id}:{normalized_truth_key}").shuffle(shuffled_entries)
        selected_holdouts = sorted(
            shuffled_entries[:holdout_count],
            key=lambda entry: (entry.resolved_file_name, entry.file_hash),
        )
        selected_holdout_names = {entry.resolved_file_name for entry in selected_holdouts}
        selected_training = [
            entry
            for entry in ordered_entries
            if entry.resolved_file_name not in selected_holdout_names
        ]
        train_entries.extend(selected_training)
        holdout_entries.extend(selected_holdouts)
        holdout_summary.append(
            {
                "cardName": ordered_entries[0].card_name,
                "collectorNumber": ordered_entries[0].collector_number,
                "setCode": ordered_entries[0].set_code,
                "photoCount": len(ordered_entries),
                "trainingPhotoCount": len(selected_training),
                "holdoutPhotoCount": len(selected_holdouts),
                "holdoutResolvedFiles": [entry.resolved_file_name for entry in selected_holdouts],
                "trainingResolvedFiles": [entry.resolved_file_name for entry in selected_training],
                "insufficientForHoldout": holdout_count == 0,
            }
        )

    train_entries.sort(key=lambda entry: (entry.card_name, entry.collector_number, entry.set_code, entry.resolved_file_name))
    holdout_entries.sort(key=lambda entry: (entry.card_name, entry.collector_number, entry.set_code, entry.resolved_file_name))
    holdout_summary.sort(key=lambda entry: (entry["cardName"], entry["collectorNumber"], entry["setCode"]))
    return train_entries, holdout_entries, holdout_summary


def batch_id_from_path(photo_root: Path) -> str:
    return slugify(photo_root.name or "raw-batch")


def ensure_visual_python() -> Path:
    python_path = VISUAL_VENV_PATH / "bin" / "python"
    if python_path.exists():
        return python_path
    subprocess.run([sys.executable, "-m", "venv", str(VISUAL_VENV_PATH)], check=True, cwd=REPO_ROOT)
    pip_path = VISUAL_VENV_PATH / "bin" / "pip"
    subprocess.run([str(pip_path), "install", "-r", str(VISUAL_REQUIREMENTS_PATH)], check=True, cwd=REPO_ROOT)
    return python_path


def load_env_file(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.exists():
        return values
    for line in path.read_text().splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, value = stripped.split("=", 1)
        values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def run_command(command: list[str], *, env: dict[str, str] | None = None) -> None:
    subprocess.run(command, check=True, cwd=REPO_ROOT, env=env)


def main() -> int:
    parser = argparse.ArgumentParser(description="Audit, registry-track, and safely import a bulk raw visual batch.")
    parser.add_argument("--spreadsheet", required=True, help="Spreadsheet path (.xlsx, .csv, or .tsv).")
    parser.add_argument("--photo-root", required=True, help="Directory containing the batch photos.")
    parser.add_argument("--batch-id", help="Optional stable batch id. Defaults to a slug of the photo-root folder name.")
    parser.add_argument("--training-root", default=str(default_raw_visual_train_root()))
    parser.add_argument("--expansion-holdout-root", default=str(default_raw_visual_expansion_holdout_root()))
    parser.add_argument("--excluded-root", default=str(default_raw_visual_train_excluded_root()))
    parser.add_argument("--heldout-root", default=str(HELDOUT_ROOT))
    parser.add_argument("--audit-root", default=str(default_raw_visual_batch_audit_root()))
    parser.add_argument("--registry-path", default=str(default_raw_visual_scan_registry_path()))
    parser.add_argument(
        "--exclude-file-name",
        action="append",
        default=[],
        help="Exclude a spreadsheet row by file_name. Repeatable.",
    )
    parser.add_argument(
        "--exclude-truth-key",
        action="append",
        default=[],
        help="Exclude rows by normalized truth key: normalize_name(card)|NUMBER|SET. Repeatable.",
    )
    parser.add_argument("--import-safe", action="store_true", help="Import safe_new + safe_training_augment rows into the training root.")
    parser.add_argument(
        "--run-training-pipeline",
        action="store_true",
        help="After importing safe rows, run normalization, auto-labeling, and manifest rebuild for the active training root.",
    )
    args = parser.parse_args()

    spreadsheet_path = Path(args.spreadsheet).expanduser().resolve()
    photo_root = Path(args.photo_root).expanduser().resolve()
    training_root = Path(args.training_root).expanduser().resolve()
    expansion_holdout_root = Path(args.expansion_holdout_root).expanduser().resolve()
    excluded_root = Path(args.excluded_root).expanduser().resolve()
    heldout_root = Path(args.heldout_root).expanduser().resolve()
    audit_root = Path(args.audit_root).expanduser().resolve()
    registry_path = Path(args.registry_path).expanduser().resolve()
    batch_id = args.batch_id or batch_id_from_path(photo_root)
    batch_audit_root = audit_root / batch_id
    batch_expansion_holdout_root = expansion_holdout_root / batch_id

    parsed_batch_rows = parse_batch_rows(spreadsheet_path)
    batch_rows, excluded_rows = apply_row_exclusions(
        parsed_batch_rows,
        exclude_file_names=set(args.exclude_file_name),
        exclude_truth_keys=set(args.exclude_truth_key),
    )
    images = sorted(path for path in photo_root.rglob("*") if path.is_file())
    if not images:
        raise SystemExit(f"No photos found in {photo_root}")
    by_name, by_stem = build_image_lookup(images)

    registry = load_registry(registry_path)
    registry_by_hash, _ = registry_indexes(registry)
    existing_hashes = discover_existing_source_scans([training_root, excluded_root, heldout_root])
    truth_indexes = {
        "training": load_truth_index(training_root),
        "excluded": load_truth_index(excluded_root),
        "heldout": load_truth_index(heldout_root),
    }

    entries: list[BatchEntry] = []
    resolved_files: set[str] = set()
    batch_hash_counts: Counter[str] = Counter()
    unresolved_rows: list[dict[str, Any]] = []

    source_file_name_counts = Counter(str(row.get("file_name") or "").strip() for row in batch_rows if row.get("file_name"))

    for row in batch_rows:
        try:
            image_path = resolve_manifest_image(row["file_name"], by_name=by_name, by_stem=by_stem)
        except SystemExit as exc:
            unresolved_rows.append(
                {
                    "fileName": row.get("file_name"),
                    "cardName": row.get("card_name"),
                    "collectorNumber": row.get("number"),
                    "setCode": row.get("set"),
                    "error": str(exc),
                }
            )
            continue

        file_hash = sha256_file(image_path)
        image_issue = source_image_issue(image_path)
        batch_hash_counts[file_hash] += 1
        resolved_files.add(image_path.name)
        normalized_truth_key = truth_key(row["card_name"], row["number"], row["set"])
        overlap_roots: list[str] = []
        if file_hash in existing_hashes:
            overlap_roots.append("exact_hash_overlap")
        if normalized_truth_key in truth_indexes["heldout"]:
            overlap_roots.append("heldout")
        if normalized_truth_key in truth_indexes["training"]:
            overlap_roots.append("training")
        if normalized_truth_key in truth_indexes["excluded"]:
            overlap_roots.append("excluded")

        registry_overlap_statuses = sorted(
            {
                str(item.get("datasetStatus") or "").strip()
                for item in registry_by_hash.get(file_hash, [])
                if str(item.get("datasetStatus") or "").strip()
                and str(item.get("batchID") or "").strip() != batch_id
            }
        )
        entries.append(
            BatchEntry(
                source_file_name=row["file_name"],
                resolved_file_name=image_path.name,
                resolved_path=image_path,
                file_hash=file_hash,
                card_name=row["card_name"],
                collector_number=row["number"],
                set_code=row["set"],
                promo=str(row.get("promo") or row.get("Promo") or "").strip(),
                normalized_truth_key=normalized_truth_key,
                overlap_roots=overlap_roots,
                overlap_registry=registry_overlap_statuses,
                notes=note_list(row["card_name"], row["number"], row["set"])
                + ([image_issue] if image_issue else []),
                source_image_issue=image_issue,
                bucket="manual_review",
                reason="unclassified",
            )
        )

    by_truth: dict[str, list[BatchEntry]] = defaultdict(list)
    for entry in entries:
        by_truth[entry.normalized_truth_key].append(entry)

    bucket_rows: dict[str, list[BatchEntry]] = {
        "safe_new": [],
        "safe_training_augment": [],
        "heldout_blocked": [],
        "manual_review": [],
    }

    for truth_key_value, grouped in sorted(by_truth.items()):
        truth_roots = {root for entry in grouped for root in entry.overlap_roots}
        has_batch_hash_duplicate = any(batch_hash_counts[entry.file_hash] > 1 for entry in grouped)
        has_duplicate_file_reference = any(source_file_name_counts[entry.source_file_name] > 1 for entry in grouped)
        has_registry_hash_overlap = any(entry.overlap_registry for entry in grouped)
        source_image_issues = sorted({entry.source_image_issue for entry in grouped if entry.source_image_issue})

        if source_image_issues:
            bucket = "manual_review"
            reason = source_image_issues[0]
        elif has_duplicate_file_reference:
            bucket = "manual_review"
            reason = "duplicate_file_reference"
        elif "heldout" in truth_roots:
            bucket = "heldout_blocked"
            reason = "heldout_overlap"
        elif "training" in truth_roots and "excluded" in truth_roots:
            bucket = "manual_review"
            reason = "training_and_excluded_overlap"
        elif "excluded" in truth_roots:
            bucket = "manual_review"
            reason = "excluded_overlap"
        elif "exact_hash_overlap" in truth_roots:
            bucket = "manual_review"
            reason = "exact_hash_overlap"
        elif has_registry_hash_overlap:
            bucket = "manual_review"
            reason = "registry_hash_overlap"
        elif has_batch_hash_duplicate:
            bucket = "manual_review"
            reason = "exact_hash_duplicate_in_batch"
        elif "training" in truth_roots:
            bucket = "safe_training_augment"
            reason = "existing_training_truth"
        else:
            bucket = "safe_new"
            reason = "new_truth"

        for entry in grouped:
            entry.bucket = bucket
            entry.reason = reason
            bucket_rows[bucket].append(entry)

    safe_new_training_entries, expansion_holdout_entries, expansion_holdout_truths = split_safe_new_entries_for_expansion_holdout(
        bucket_rows["safe_new"],
        batch_id=batch_id,
    )

    unreferenced_files = sorted(path.name for path in images if path.name not in resolved_files)

    batch_audit_root.mkdir(parents=True, exist_ok=True)
    bucket_manifests = {
        bucket: batch_audit_root / f"{bucket}.tsv"
        for bucket in ("safe_new", "safe_training_augment", "heldout_blocked", "manual_review")
    }
    safe_import_manifest = batch_audit_root / "safe_import.tsv"
    expansion_holdout_manifest = batch_audit_root / "expansion_holdout.tsv"
    for bucket_name, path in bucket_manifests.items():
        write_tsv(path, [batch_entry_tsv_row(entry) for entry in bucket_rows[bucket_name]])
    write_tsv(
        safe_import_manifest,
        [batch_entry_tsv_row(entry) for entry in safe_new_training_entries]
        + [batch_entry_tsv_row(entry) for entry in bucket_rows["safe_training_augment"]],
    )
    write_tsv(expansion_holdout_manifest, [batch_entry_tsv_row(entry) for entry in expansion_holdout_entries])

    grouped_bucket_summary: dict[str, list[dict[str, Any]]] = {}
    for bucket_name, grouped in bucket_rows.items():
        truth_groups: dict[str, list[BatchEntry]] = defaultdict(list)
        for entry in grouped:
            truth_groups[entry.normalized_truth_key].append(entry)
        grouped_bucket_summary[bucket_name] = [
            {
                "cardName": entries_for_truth[0].card_name,
                "collectorNumber": entries_for_truth[0].collector_number,
                "setCode": entries_for_truth[0].set_code,
                "photoCount": len(entries_for_truth),
                "resolvedFiles": [entry.resolved_file_name for entry in entries_for_truth],
                "reason": entries_for_truth[0].reason,
                "notes": sorted({note for entry in entries_for_truth for note in entry.notes}),
            }
            for entries_for_truth in truth_groups.values()
        ]

    audit_summary = {
        "generatedAt": utc_now_iso(),
        "batchID": batch_id,
        "spreadsheetPath": str(spreadsheet_path),
        "photoRoot": str(photo_root),
        "trainingRoot": str(training_root),
        "expansionHoldoutRoot": str(batch_expansion_holdout_root),
        "excludedRoot": str(excluded_root),
        "heldoutRoot": str(heldout_root),
        "registryPath": str(registry_path),
        "sheetRowCount": len(batch_rows),
        "sourceSheetRowCount": len(parsed_batch_rows),
        "excludedRowCount": len(excluded_rows),
        "resolvedRowCount": len(entries),
        "unresolvedRowCount": len(unresolved_rows),
        "photoFileCount": len(images),
        "unreferencedPhotoCount": len(unreferenced_files),
        "exactDuplicatePhotoCount": sum(count for count in batch_hash_counts.values() if count > 1),
        "invalidSourcePhotoCount": len({entry.resolved_file_name for entry in entries if entry.source_image_issue}),
        "bucketSummary": {
            bucket: {
                "rows": len(grouped),
                "truths": len({entry.normalized_truth_key for entry in grouped}),
            }
            for bucket, grouped in bucket_rows.items()
        },
        "expansionHoldoutSummary": {
            "selectedRowCount": len(expansion_holdout_entries),
            "selectedTruthCount": len({entry.normalized_truth_key for entry in expansion_holdout_entries}),
            "trainingImportRowCount": len(safe_new_training_entries) + len(bucket_rows["safe_training_augment"]),
            "trainingSafeNewRowCount": len(safe_new_training_entries),
            "safeNewRowsReservedForHoldout": len(expansion_holdout_entries),
        },
        "unresolvedRows": unresolved_rows,
        "excludedRows": excluded_rows,
        "unreferencedFiles": unreferenced_files,
        "invalidSourcePhotos": [
            {
                "fileName": entry.resolved_file_name,
                "issue": entry.source_image_issue,
            }
            for entry in entries
            if entry.source_image_issue
        ],
        "bucketTruths": grouped_bucket_summary,
        "expansionHoldoutTruths": expansion_holdout_truths,
        "manifests": {
            "safeNew": str(bucket_manifests["safe_new"]),
            "safeTrainingAugment": str(bucket_manifests["safe_training_augment"]),
            "heldoutBlocked": str(bucket_manifests["heldout_blocked"]),
            "manualReview": str(bucket_manifests["manual_review"]),
            "safeImport": str(safe_import_manifest),
            "expansionHoldout": str(expansion_holdout_manifest),
        },
    }
    write_json(batch_audit_root / "audit_summary.json", audit_summary)

    training_import_summary_by_key: dict[tuple[str, str], str] = {}
    expansion_holdout_import_summary_by_key: dict[tuple[str, str], str] = {}
    import_summary_path = batch_audit_root / "import_summary.json"
    expansion_holdout_import_summary_path = batch_audit_root / "expansion_holdout_import_summary.json"

    if args.import_safe and (safe_new_training_entries or bucket_rows["safe_training_augment"]):
        import_command = [
            sys.executable,
            str(REPO_ROOT / "tools" / "import_raw_visual_training_photos.py"),
            "--input-dir",
            str(photo_root),
            "--metadata",
            str(safe_import_manifest),
            "--output-root",
            str(training_root),
            "--summary-output",
            str(import_summary_path),
            "--exact-duplicate-root",
            str(heldout_root),
            "--exact-duplicate-root",
            str(training_root),
            "--exact-duplicate-root",
            str(expansion_holdout_root),
        ]
        run_command(import_command)

        import_summary_payload = json.loads(import_summary_path.read_text())
        for item in import_summary_payload.get("imported") or []:
            source_name = str(item.get("sourceImageName") or "").strip()
            source_hash = str(item.get("sourceImageSha256") or "").strip()
            fixture_path = str(item.get("fixturePath") or "").strip()
            if source_name and source_hash and fixture_path:
                training_import_summary_by_key[(source_name, source_hash)] = fixture_path

    if args.import_safe and expansion_holdout_entries:
        holdout_import_command = [
            sys.executable,
            str(REPO_ROOT / "tools" / "import_raw_visual_training_photos.py"),
            "--input-dir",
            str(photo_root),
            "--metadata",
            str(expansion_holdout_manifest),
            "--output-root",
            str(batch_expansion_holdout_root),
            "--summary-output",
            str(expansion_holdout_import_summary_path),
            "--exact-duplicate-root",
            str(heldout_root),
            "--exact-duplicate-root",
            str(training_root),
            "--exact-duplicate-root",
            str(expansion_holdout_root),
        ]
        run_command(holdout_import_command)

        import_summary_payload = json.loads(expansion_holdout_import_summary_path.read_text())
        for item in import_summary_payload.get("imported") or []:
            source_name = str(item.get("sourceImageName") or "").strip()
            source_hash = str(item.get("sourceImageSha256") or "").strip()
            fixture_path = str(item.get("fixturePath") or "").strip()
            if source_name and source_hash and fixture_path:
                expansion_holdout_import_summary_by_key[(source_name, source_hash)] = fixture_path

    if args.run_training_pipeline and args.import_safe:
        env = os.environ.copy()
        env.update(load_env_file(REPO_ROOT / "backend" / ".env"))

        if safe_new_training_entries or bucket_rows["safe_training_augment"]:
            run_command(["zsh", str(REPO_ROOT / "tools" / "generate_raw_runtime_artifacts.sh"), str(training_root)])
            visual_python = ensure_visual_python()
            run_command(
                [
                    str(visual_python),
                    str(REPO_ROOT / "tools" / "auto_label_raw_visual_training_fixtures.py"),
                    "--fixture-root",
                    str(training_root),
                ],
                env=env,
            )
            run_command(
                [
                    str(visual_python),
                    str(REPO_ROOT / "tools" / "build_raw_visual_training_manifest.py"),
                    "--fixture-root",
                    str(training_root),
                    "--output",
                    str(training_root / "raw_visual_training_manifest.jsonl"),
                    "--summary-output",
                    str(training_root / "raw_visual_training_manifest_summary.json"),
                    "--query-cache",
                    str(training_root / ".visual_reference_cache" / "provider_search_cache.json"),
                    "--reference-image-root",
                    str(training_root / ".visual_reference_cache" / "reference_images"),
                ],
                env=env,
            )
        if expansion_holdout_entries:
            run_command(["zsh", str(REPO_ROOT / "tools" / "generate_raw_runtime_artifacts.sh"), str(batch_expansion_holdout_root)])
            visual_python = ensure_visual_python()
            run_command(
                [
                    str(visual_python),
                    str(REPO_ROOT / "tools" / "auto_label_raw_visual_training_fixtures.py"),
                    "--fixture-root",
                    str(batch_expansion_holdout_root),
                    "--summary-output",
                    str(batch_expansion_holdout_root / "auto_label_summary.json"),
                ],
                env=env,
            )

    now = utc_now_iso()
    registry_payload = load_registry(registry_path)
    existing_entries = registry_payload.get("entries") or []
    current_registry_keys = {
        registry_entry_key(batch_id, entry.file_hash, entry.source_file_name)
        for entry in entries
    }
    current_registry_keys.update(
        registry_entry_key(batch_id, sha256_file(next(path for path in images if path.name == file_name)), file_name)
        for file_name in unreferenced_files
    )
    existing_entry_by_key = {
        registry_entry_key(
            str(entry.get("batchID") or ""),
            str(entry.get("fileHash") or ""),
            str(entry.get("sourceFileName") or ""),
        ): entry
        for entry in existing_entries
        if isinstance(entry, dict)
    }
    retained_entries = [
        entry
        for entry in existing_entries
        if registry_entry_key(
            str(entry.get("batchID") or ""),
            str(entry.get("fileHash") or ""),
            str(entry.get("sourceFileName") or ""),
        )
        not in current_registry_keys
    ]

    expansion_holdout_file_names = {entry.resolved_file_name for entry in expansion_holdout_entries}

    for entry in entries:
        training_fixture_path = training_import_summary_by_key.get((entry.resolved_file_name, entry.file_hash))
        holdout_fixture_path = expansion_holdout_import_summary_by_key.get((entry.resolved_file_name, entry.file_hash))
        if entry.resolved_file_name in expansion_holdout_file_names:
            dataset_status = "expansion_holdout" if holdout_fixture_path else "staged"
            imported_fixture_path = holdout_fixture_path
        elif entry.bucket in {"safe_new", "safe_training_augment"}:
            dataset_status = "training" if training_fixture_path else "staged"
            imported_fixture_path = training_fixture_path
        elif entry.bucket == "heldout_blocked":
            dataset_status = "blocked"
            imported_fixture_path = None
        else:
            dataset_status = "manual_review"
            imported_fixture_path = None
        registry_key = registry_entry_key(batch_id, entry.file_hash, entry.source_file_name)
        previous_entry = existing_entry_by_key.get(registry_key)
        retained_entries.append(
            {
                "batchID": batch_id,
                "sourceSpreadsheetPath": str(spreadsheet_path),
                "sourcePhotoRoot": str(photo_root),
                "sourceFileName": entry.source_file_name,
                "resolvedFileName": entry.resolved_file_name,
                "resolvedPath": str(entry.resolved_path),
                "fileHash": entry.file_hash,
                "normalizedTruthKey": entry.normalized_truth_key,
                "cardName": entry.card_name,
                "collectorNumber": entry.collector_number,
                "setCode": entry.set_code,
                "promo": entry.promo,
                "bucket": entry.bucket,
                "datasetStatus": dataset_status,
                "expansionHoldoutSelected": entry.resolved_file_name in expansion_holdout_file_names,
                "reason": entry.reason,
                "overlapRoots": entry.overlap_roots,
                "overlapRegistryStatuses": entry.overlap_registry,
                "notes": entry.notes,
                "importedFixturePath": imported_fixture_path,
                "createdAt": previous_entry.get("createdAt") if isinstance(previous_entry, dict) else now,
                "updatedAt": now,
            }
        )

    for file_name in unreferenced_files:
        file_path = photo_root / file_name if (photo_root / file_name).exists() else next(
            path for path in images if path.name == file_name
        )
        file_hash = sha256_file(file_path)
        registry_key = registry_entry_key(batch_id, file_hash, file_name)
        previous_entry = existing_entry_by_key.get(registry_key)
        retained_entries.append(
            {
                "batchID": batch_id,
                "sourceSpreadsheetPath": str(spreadsheet_path),
                "sourcePhotoRoot": str(photo_root),
                "sourceFileName": file_name,
                "resolvedFileName": file_name,
                "resolvedPath": str(file_path),
                "fileHash": file_hash,
                "normalizedTruthKey": "",
                "cardName": "",
                "collectorNumber": "",
                "setCode": "",
                "promo": "",
                "bucket": "manual_review",
                "datasetStatus": "manual_review",
                "reason": "unreferenced_photo",
                "overlapRoots": [],
                "overlapRegistryStatuses": [],
                "notes": ["unreferenced_photo"],
                "importedFixturePath": None,
                "createdAt": previous_entry.get("createdAt") if isinstance(previous_entry, dict) else now,
                "updatedAt": now,
            }
        )

    registry_payload["schemaVersion"] = 1
    registry_payload["updatedAt"] = now
    registry_payload["entries"] = retained_entries
    write_json(registry_path, registry_payload)

    print(json.dumps(audit_summary, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
