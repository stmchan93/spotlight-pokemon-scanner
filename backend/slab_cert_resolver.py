from __future__ import annotations

import json
import re
import sqlite3
from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class CachedSlabCertResolution:
    card_id: str
    resolver_path: str
    matched_scan_id: str | None
    request_cert: str | None
    response_cert: str | None


def normalize_cert_number(value: str | None) -> str | None:
    digits = re.sub(r"\D+", "", str(value or ""))
    if len(digits) < 7:
        return None
    return digits


def resolver_path_for_psa_cert(
    cert_number: str | None,
    *,
    barcode_payloads: list[str] | tuple[str, ...] | None = None,
) -> str | None:
    normalized_cert = normalize_cert_number(cert_number)
    if normalized_cert is None:
        return None
    if barcode_payload_matches_cert(barcode_payloads or [], normalized_cert):
        return "psa_cert_barcode"
    return "psa_cert_ocr"


def barcode_payload_matches_cert(
    barcode_payloads: list[str] | tuple[str, ...],
    cert_number: str | None,
) -> bool:
    normalized_cert = normalize_cert_number(cert_number)
    if normalized_cert is None:
        return False

    for payload in barcode_payloads:
        payload_digits = normalize_cert_number(str(payload or ""))
        if payload_digits == normalized_cert:
            return True
        if payload_digits and normalized_cert in payload_digits:
            return True
    return False


def resolve_psa_cert_from_scan_cache(
    connection: sqlite3.Connection,
    cert_number: str | None,
    *,
    barcode_payloads: list[str] | tuple[str, ...] | None = None,
    limit: int = 250,
) -> CachedSlabCertResolution | None:
    normalized_cert = normalize_cert_number(cert_number)
    resolver_path = resolver_path_for_psa_cert(
        normalized_cert,
        barcode_payloads=barcode_payloads,
    )
    if normalized_cert is None or resolver_path is None:
        return None

    rows = connection.execute(
        """
        SELECT scan_id, request_json, response_json, selected_card_id, correction_type
        FROM scan_events
        WHERE resolver_mode = 'psa_slab'
          AND selected_card_id IS NOT NULL
          AND correction_type IS NOT NULL
        ORDER BY created_at DESC
        LIMIT ?
        """,
        (limit,),
    ).fetchall()

    for row in rows:
        request_payload = _json_load_dict(row["request_json"])
        response_payload = _json_load_dict(row["response_json"])
        if str(response_payload.get("reviewDisposition") or "").strip().lower() == "unsupported":
            continue
        if str(row["correction_type"] or "").strip().lower() == "abandoned":
            continue

        request_cert = normalize_cert_number(request_payload.get("slabCertNumber"))
        slab_context = response_payload.get("slabContext") or {}
        response_cert = normalize_cert_number(
            slab_context.get("certNumber") if isinstance(slab_context, dict) else None
        )
        if normalized_cert not in {request_cert, response_cert}:
            continue

        card_id = str(row["selected_card_id"] or "").strip()
        if not card_id:
            continue

        return CachedSlabCertResolution(
            card_id=card_id,
            resolver_path=resolver_path,
            matched_scan_id=str(row["scan_id"] or "").strip() or None,
            request_cert=request_cert,
            response_cert=response_cert,
        )

    return None


def _json_load_dict(value: Any) -> dict[str, Any]:
    if not value:
        return {}
    if isinstance(value, dict):
        return value
    try:
        decoded = json.loads(value)
    except (TypeError, json.JSONDecodeError):
        return {}
    return decoded if isinstance(decoded, dict) else {}
