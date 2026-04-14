#!/usr/bin/env python3
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import re
import shutil
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

from raw_visual_dataset_paths import default_raw_visual_train_root


IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif"}
HEADER_ALIASES = {
    "file_name": "file_name",
    "filename": "file_name",
    "image_name": "file_name",
    "image": "file_name",
    "card_name": "card_name",
    "name": "card_name",
    "number": "collector_number",
    "collector_number": "collector_number",
    "collector": "collector_number",
    "set_promo": "set_code",
    "set": "set_code",
    "set_code": "set_code",
    "promo_set": "set_code",
}
REQUIRED_METADATA_FIELDS = ("file_name", "card_name", "collector_number", "set_code")


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def source_image_issue(path: Path) -> str | None:
    try:
        size = path.stat().st_size
    except OSError:
        return "source_stat_failed"
    if size <= 0:
        return "zero_byte_source_file"

    result = subprocess.run(
        ["sips", "-g", "pixelWidth", "-g", "pixelHeight", str(path)],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        return "image_decode_failed"

    width: int | None = None
    height: int | None = None
    for line in result.stdout.splitlines():
        stripped = line.strip()
        if stripped.startswith("pixelWidth:"):
            try:
                width = int(stripped.split(":", 1)[1].strip())
            except ValueError:
                return "image_dimension_parse_failed"
        if stripped.startswith("pixelHeight:"):
            try:
                height = int(stripped.split(":", 1)[1].strip())
            except ValueError:
                return "image_dimension_parse_failed"

    if width is None or height is None:
        return "image_dimensions_missing"
    if width <= 0 or height <= 0:
        return "nonpositive_image_dimensions"
    return None


def discover_input_images(input_root: Path) -> list[Path]:
    return sorted(
        path
        for path in input_root.rglob("*")
        if path.is_file() and path.suffix.lower() in IMAGE_EXTENSIONS
    )


def discover_existing_source_scans(roots: Iterable[Path]) -> dict[str, list[str]]:
    hashes: dict[str, list[str]] = {}
    for root in roots:
        if not root.exists():
            continue
        for metadata_path in root.rglob("import_metadata.json"):
            try:
                payload = json.loads(metadata_path.read_text())
            except Exception:  # noqa: BLE001
                continue
            digest = str(payload.get("sourceImageSha256") or "").strip()
            fixture_path = str(metadata_path.parent.resolve())
            if digest:
                hashes.setdefault(digest, []).append(fixture_path)
        for path in root.rglob("source_scan.jpg"):
            digest = sha256_file(path)
            hashes.setdefault(digest, []).append(str(path.resolve()))
    return hashes


def fixture_dir_name(source_image: Path) -> str:
    return source_image.stem.lower()


def slugify(value: str) -> str:
    value = value.lower().replace("&", " and ")
    value = value.replace("'", "")
    value = re.sub(r"[^a-z0-9]+", "-", value)
    return re.sub(r"-{2,}", "-", value).strip("-")


def collector_slug(value: str) -> str:
    value = value.lower().replace("/", "-")
    value = re.sub(r"[^a-z0-9-]+", "-", value)
    return re.sub(r"-{2,}", "-", value).strip("-")


def metadata_fixture_dir_name(
    *,
    card_name: str,
    collector_number: str,
    set_code: str,
    source_image: Path,
) -> str:
    parts = [
        slugify(card_name) or "unknown-card",
        collector_slug(collector_number) or "unknown-number",
        slugify(set_code) or "unknown-set",
        slugify(source_image.stem) or "image",
    ]
    return "-".join(parts)


def detect_delimiter(path: Path) -> str:
    sample = path.read_text().splitlines()
    header = sample[0] if sample else ""
    return "\t" if header.count("\t") >= header.count(",") else ","


def normalized_header(value: str) -> str:
    lowered = str(value or "").strip().lower()
    lowered = re.sub(r"[^a-z0-9]+", "_", lowered)
    return re.sub(r"_+", "_", lowered).strip("_")


def canonical_header(value: str) -> str:
    normalized = normalized_header(value)
    return HEADER_ALIASES.get(normalized, normalized)


def parse_metadata_rows(path: Path, *, delimiter: str | None) -> list[dict[str, str]]:
    resolved_delimiter = delimiter or detect_delimiter(path)
    with path.open(newline="") as handle:
        reader = csv.DictReader(handle, delimiter=resolved_delimiter)
        if reader.fieldnames is None:
            raise SystemExit(f"Metadata file is missing headers: {path}")

        rows: list[dict[str, str]] = []
        normalized_fields = [canonical_header(field_name) for field_name in reader.fieldnames]
        missing_headers = [field for field in REQUIRED_METADATA_FIELDS if field not in normalized_fields]
        if missing_headers:
            raise SystemExit(
                f"Metadata file is missing required headers {missing_headers}: {path}. "
                "Expected headers like file_name, card_name, number, set promo."
            )

        for row_index, raw_row in enumerate(reader, start=2):
            normalized_row: dict[str, str] = {}
            for field_name, value in raw_row.items():
                normalized_row[canonical_header(field_name)] = str(value or "").strip()
            if not any(normalized_row.values()):
                continue
            missing_values = [field for field in REQUIRED_METADATA_FIELDS if not normalized_row.get(field)]
            if missing_values:
                raise SystemExit(f"Metadata row {row_index} is missing required values {missing_values}")
            normalized_row["_row_number"] = str(row_index)
            rows.append(normalized_row)
    return rows


def build_image_lookup(images: Iterable[Path]) -> tuple[dict[str, Path], dict[str, list[Path]]]:
    by_name: dict[str, Path] = {}
    by_stem: dict[str, list[Path]] = {}
    for image_path in images:
        by_name[image_path.name.lower()] = image_path
        by_stem.setdefault(image_path.stem.lower(), []).append(image_path)
    return by_name, by_stem


def resolve_manifest_image(
    file_name: str,
    *,
    by_name: dict[str, Path],
    by_stem: dict[str, list[Path]],
) -> Path:
    raw_name = str(file_name).strip()
    if not raw_name:
        raise SystemExit("Metadata file has an empty file_name value.")

    exact = by_name.get(raw_name.lower())
    if exact is not None:
        return exact

    stem = Path(raw_name).stem.lower() if Path(raw_name).suffix else raw_name.lower()
    matches = by_stem.get(stem, [])
    if len(matches) == 1:
        return matches[0]
    if not matches:
        raise SystemExit(f"Metadata references image '{file_name}', but it was not found in the input directory.")
    options = ", ".join(sorted(path.name for path in matches))
    raise SystemExit(f"Metadata references ambiguous image '{file_name}'. Matching files: {options}")


def write_source_scan(source_path: Path, destination_path: Path) -> None:
    destination_path.parent.mkdir(parents=True, exist_ok=True)
    if source_path.suffix.lower() in {".jpg", ".jpeg"}:
        shutil.copy2(source_path, destination_path)
        return

    command = [
        "sips",
        "-s",
        "format",
        "jpeg",
        str(source_path),
        "--out",
        str(destination_path),
    ]
    try:
        subprocess.run(command, check=True, capture_output=True, text=True)
    except subprocess.CalledProcessError as exc:
        stderr = exc.stderr.strip()
        raise SystemExit(
            f"Failed to convert '{source_path.name}' to JPEG with sips."
            + (f" stderr: {stderr}" if stderr else "")
        ) from exc


def ensure_unique_directory(root: Path, desired_name: str) -> Path:
    candidate = root / desired_name
    if not candidate.exists():
        return candidate
    index = 2
    while True:
        retry = root / f"{desired_name}-{index}"
        if not retry.exists():
            return retry
        index += 1


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Import raw visual training photos into folder-per-image fixtures."
    )
    parser.add_argument(
        "--input-dir",
        required=True,
        help="Directory containing source images to import.",
    )
    parser.add_argument(
        "--metadata",
        help="Optional CSV/TSV manifest with headers like file_name, card_name, number, set promo.",
    )
    parser.add_argument(
        "--metadata-delimiter",
        choices=[",", "tab"],
        help="Optional metadata delimiter override. Defaults to auto-detect.",
    )
    parser.add_argument(
        "--output-root",
        default=str(default_raw_visual_train_root()),
        help="Fixture root to create/update.",
    )
    parser.add_argument(
        "--summary-output",
        help="Optional path for the import summary JSON. Defaults to <output-root>/raw_visual_train_import_summary.json.",
    )
    parser.add_argument(
        "--exact-duplicate-root",
        action="append",
        default=[],
        help="Optional root to scan for exact source_scan hash overlaps. Can be passed multiple times.",
    )
    args = parser.parse_args()

    input_root = Path(args.input_dir).expanduser().resolve()
    output_root = Path(args.output_root).expanduser().resolve()
    duplicate_roots = [Path(value).expanduser().resolve() for value in args.exact_duplicate_root]
    metadata_path = Path(args.metadata).expanduser().resolve() if args.metadata else None
    metadata_delimiter = "\t" if args.metadata_delimiter == "tab" else args.metadata_delimiter
    summary_output_path = (
        Path(args.summary_output).expanduser().resolve()
        if args.summary_output
        else output_root / "raw_visual_train_import_summary.json"
    )

    images = discover_input_images(input_root)
    if not images:
        raise SystemExit(f"No supported images found in {input_root}")

    output_root.mkdir(parents=True, exist_ok=True)
    existing_hashes = discover_existing_source_scans(duplicate_roots + [output_root])
    by_name, by_stem = build_image_lookup(images)
    metadata_rows = parse_metadata_rows(metadata_path, delimiter=metadata_delimiter) if metadata_path else []

    imported: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []
    import_items: list[tuple[Path, dict[str, str] | None]] = []

    if metadata_rows:
        for row in metadata_rows:
            image_path = resolve_manifest_image(row["file_name"], by_name=by_name, by_stem=by_stem)
            import_items.append((image_path, row))
    else:
        import_items = [(image_path, None) for image_path in images]

    for image_path, metadata_row in import_items:
        issue = source_image_issue(image_path)
        if issue:
            skipped.append(
                {
                    "sourceImageName": image_path.name,
                    "sourceImagePath": str(image_path),
                    "reason": issue,
                    "hasTruth": bool(metadata_row),
                }
            )
            continue
        digest = sha256_file(image_path)
        if metadata_row:
            destination_name = metadata_fixture_dir_name(
                card_name=metadata_row["card_name"],
                collector_number=metadata_row["collector_number"],
                set_code=metadata_row["set_code"],
                source_image=image_path,
            )
        else:
            destination_name = fixture_dir_name(image_path)
        destination_dir = ensure_unique_directory(output_root, destination_name)
        destination_dir.mkdir(parents=True, exist_ok=True)
        destination_path = destination_dir / "source_scan.jpg"
        write_source_scan(image_path, destination_path)

        existing_matches = [
            existing_path
            for existing_path in existing_hashes.get(digest, [])
            if Path(existing_path).resolve() != destination_path.resolve()
        ]
        metadata = {
            "importedAt": utc_now_iso(),
            "sourceImagePath": str(image_path),
            "sourceImageName": image_path.name,
            "sourceImageSha256": digest,
            "importedFixturePath": str(destination_dir),
            "exactImageHashOverlaps": existing_matches,
        }
        if metadata_row:
            metadata["manifestRowNumber"] = int(metadata_row["_row_number"])
            metadata["declaredCardName"] = metadata_row["card_name"]
            metadata["declaredCollectorNumber"] = metadata_row["collector_number"]
            metadata["declaredSetCode"] = metadata_row["set_code"]
            metadata["declaredFileName"] = metadata_row["file_name"]
        write_json(destination_dir / "import_metadata.json", metadata)
        if metadata_row:
            truth = {
                "cardName": metadata_row["card_name"],
                "collectorNumber": metadata_row["collector_number"],
                "setCode": metadata_row["set_code"],
            }
            write_json(destination_dir / "truth.json", truth)
        existing_hashes.setdefault(digest, []).append(str(destination_path.resolve()))

        imported.append(
            {
                "fixtureName": destination_dir.name,
                "fixturePath": str(destination_dir),
                "sourceImageName": image_path.name,
                "sourceImageSha256": digest,
                "exactImageHashOverlapCount": len(existing_matches),
                "hasTruth": bool(metadata_row),
            }
        )

    summary = {
        "generatedAt": utc_now_iso(),
        "inputDir": str(input_root),
        "metadataPath": str(metadata_path) if metadata_path else None,
        "outputRoot": str(output_root),
        "importedCount": len(imported),
        "skippedCount": len(skipped),
        "imported": imported,
        "skipped": skipped,
    }
    write_json(summary_output_path, summary)
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
