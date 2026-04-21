from __future__ import annotations

import csv
import io
import re
from dataclasses import dataclass
from typing import Any


SUPPORTED_IMPORT_SOURCE_TYPES = {
    "tcgplayer_csv_v1",
    "collectr_csv_v1",
}

_HEADER_NORMALIZER = re.compile(r"[^a-z0-9]+")
_MONEY_SANITIZER = re.compile(r"[^0-9.\-]+")

_CONDITION_MAP = {
    "nm": "near_mint",
    "near mint": "near_mint",
    "mint": "near_mint",
    "lp": "lightly_played",
    "light played": "lightly_played",
    "lightly played": "lightly_played",
    "mp": "moderately_played",
    "moderate played": "moderately_played",
    "moderately played": "moderately_played",
    "hp": "heavily_played",
    "heavy played": "heavily_played",
    "heavily played": "heavily_played",
    "damaged": "damaged",
    "dmg": "damaged",
    "dm": "damaged",
}

_LANGUAGE_MAP = {
    "en": "en",
    "eng": "en",
    "english": "en",
    "ja": "ja",
    "jp": "ja",
    "jpn": "ja",
    "japanese": "ja",
}


@dataclass(frozen=True)
class ParsedImportRow:
    raw_row: dict[str, Any]
    normalized_row: dict[str, Any]


@dataclass(frozen=True)
class ParsedImportFile:
    source_type: str
    rows: list[ParsedImportRow]
    warnings: list[str]
    headers: list[str]


def parse_import_csv(*, source_type: str, csv_text: str) -> ParsedImportFile:
    normalized_source_type = str(source_type or "").strip()
    if normalized_source_type not in SUPPORTED_IMPORT_SOURCE_TYPES:
        raise ValueError("unsupported sourceType")

    cleaned_text = str(csv_text or "").replace("\ufeff", "").strip()
    if not cleaned_text:
        raise ValueError("csvText is required")

    reader = csv.DictReader(io.StringIO(cleaned_text, newline=""))
    fieldnames = [str(field or "").strip() for field in (reader.fieldnames or []) if str(field or "").strip()]
    if not fieldnames:
        raise ValueError("CSV headers are required")

    rows: list[ParsedImportRow] = []
    warnings: list[str] = []
    if normalized_source_type == "collectr_csv_v1":
        warnings.append("Collectr CSV parsing is heuristic in this MVP; review unresolved rows carefully.")

    for row_index, row in enumerate(reader, start=1):
        raw_row = _clean_raw_row(fieldnames, row)
        lookup = _row_lookup(raw_row)
        normalized_row = (
            _normalize_tcgplayer_row(raw_row, lookup, row_index)
            if normalized_source_type == "tcgplayer_csv_v1"
            else _normalize_collectr_row(raw_row, lookup, row_index)
        )
        rows.append(ParsedImportRow(raw_row=raw_row, normalized_row=normalized_row))

    return ParsedImportFile(
        source_type=normalized_source_type,
        rows=rows,
        warnings=warnings,
        headers=fieldnames,
    )


def _clean_raw_row(fieldnames: list[str], row: dict[str, Any] | None) -> dict[str, Any]:
    cleaned: dict[str, Any] = {}
    raw_row = row or {}
    for field in fieldnames:
        cleaned[field] = str(raw_row.get(field) or "").strip()
    return cleaned


def _row_lookup(raw_row: dict[str, Any]) -> dict[str, str]:
    lookup: dict[str, str] = {}
    for key, value in raw_row.items():
        normalized_key = _normalized_header(key)
        if not normalized_key:
            continue
        cleaned_value = str(value or "").strip()
        if normalized_key not in lookup or (not lookup[normalized_key] and cleaned_value):
            lookup[normalized_key] = cleaned_value
    return lookup


def _normalized_header(value: object) -> str:
    return _HEADER_NORMALIZER.sub("", str(value or "").strip().lower())


def _value(lookup: dict[str, str], *aliases: str) -> str | None:
    for alias in aliases:
        value = lookup.get(_normalized_header(alias))
        if value:
            return value
    return None


def _normalize_common_row(
    *,
    source_type: str,
    raw_row: dict[str, Any],
    lookup: dict[str, str],
    row_index: int,
    collection_aliases: tuple[str, ...],
    product_id_aliases: tuple[str, ...],
    collectr_id_aliases: tuple[str, ...] = (),
) -> dict[str, Any]:
    condition_text = _value(lookup, "Condition", "Card Condition")
    language_text = _value(lookup, "Language")
    variant_text = _value(lookup, "Variant", "Printing", "Finish", "Card Type")

    external_ids: dict[str, str] = {}
    tcgplayer_product_id = _value(lookup, *product_id_aliases)
    if tcgplayer_product_id:
        external_ids["tcgplayerProductID"] = tcgplayer_product_id
    collectr_record_id = _value(lookup, *collectr_id_aliases)
    if collectr_record_id:
        external_ids["collectrRecordID"] = collectr_record_id

    return {
        "sourceType": source_type,
        "sourceRowIndex": row_index,
        "sourceCollectionName": _value(lookup, *collection_aliases),
        "externalIDs": external_ids,
        "internalCardID": _value(lookup, "Spotlight Card ID", "Looty Card ID", "Card ID"),
        "cardName": _value(lookup, "Product Name", "Card Name", "Name", "Title"),
        "setName": _value(lookup, "Set Name", "Set", "Expansion"),
        "setCode": _value(lookup, "Set Code", "Set ID", "Set Abbreviation"),
        "collectorNumber": _value(lookup, "Collector Number", "Card Number", "Number"),
        "language": _normalize_language(language_text),
        "condition": _normalize_condition(condition_text),
        "sourceCondition": condition_text,
        "variant": _normalize_variant(variant_text),
        "quantity": _parse_quantity(_value(lookup, "Quantity", "Qty", "Count", "Copies")),
        "acquisitionUnitPrice": _parse_money(
            _value(
                lookup,
                "Acquisition Unit Price",
                "Acquisition Price",
                "Purchase Price",
                "Buy Price",
                "Unit Price",
                "Cost Basis Unit Price",
            )
        ),
        "acquisitionTotalPrice": _parse_money(
            _value(
                lookup,
                "Acquisition Total Price",
                "Total Purchase Price",
                "Purchase Total",
                "Cost Basis Total",
                "Total Cost",
            )
        ),
        "marketUnitPrice": _parse_money(
            _value(
                lookup,
                "Market Price",
                "TCG Market Price",
                "Current Value",
                "Estimated Value",
            )
        ),
        "currencyCode": _normalize_currency(_value(lookup, "Currency", "Currency Code")),
        "notes": _value(lookup, "Notes", "Note", "Comments", "Comment"),
        "grader": _value(lookup, "Grader"),
        "grade": _value(lookup, "Grade"),
        "certNumber": _value(lookup, "Certification Number", "Cert Number", "Cert"),
    }


def _normalize_tcgplayer_row(
    raw_row: dict[str, Any],
    lookup: dict[str, str],
    row_index: int,
) -> dict[str, Any]:
    row = _normalize_common_row(
        source_type="tcgplayer_csv_v1",
        raw_row=raw_row,
        lookup=lookup,
        row_index=row_index,
        collection_aliases=("Collection Name", "Collection", "Binder"),
        product_id_aliases=("Product ID", "TCGplayer Product ID", "TCGplayer ID"),
    )
    if row["marketUnitPrice"] is None:
        row["marketUnitPrice"] = _parse_money(_value(lookup, "Market", "TCG Market"))
    return row


def _normalize_collectr_row(
    raw_row: dict[str, Any],
    lookup: dict[str, str],
    row_index: int,
) -> dict[str, Any]:
    row = _normalize_common_row(
        source_type="collectr_csv_v1",
        raw_row=raw_row,
        lookup=lookup,
        row_index=row_index,
        collection_aliases=("Collection", "Collection Name", "Folder", "Portfolio"),
        product_id_aliases=("TCGplayer Product ID", "Product ID", "External ID"),
        collectr_id_aliases=("Collectr ID", "Collectr Card ID", "Collectr Record ID"),
    )
    if row["marketUnitPrice"] is None:
        row["marketUnitPrice"] = _parse_money(_value(lookup, "Value", "Price"))
    return row


def _normalize_condition(value: str | None) -> str | None:
    cleaned = str(value or "").strip().lower()
    if not cleaned:
        return None
    return _CONDITION_MAP.get(cleaned)


def _normalize_language(value: str | None) -> str | None:
    cleaned = str(value or "").strip().lower()
    if not cleaned:
        return None
    return _LANGUAGE_MAP.get(cleaned, cleaned)


def _normalize_variant(value: str | None) -> str | None:
    cleaned = str(value or "").strip()
    return cleaned or None


def _normalize_currency(value: str | None) -> str | None:
    cleaned = str(value or "").strip().upper()
    return cleaned or "USD"


def _parse_quantity(value: str | None) -> int | None:
    cleaned = str(value or "").strip()
    if not cleaned:
        return None
    try:
        numeric = float(cleaned.replace(",", ""))
    except ValueError:
        return None
    if int(numeric) != numeric:
        return None
    return int(numeric)


def _parse_money(value: str | None) -> float | None:
    cleaned = str(value or "").strip()
    if not cleaned:
        return None
    normalized = _MONEY_SANITIZER.sub("", cleaned.replace(",", ""))
    if not normalized or normalized in {"-", ".", "-."}:
        return None
    try:
        return float(normalized)
    except ValueError:
        return None
