#!/usr/bin/env python3
"""Audit historical scan_events for predicted-card language vs device-locale mismatch.

NOTE ON SCOPE -- this is NOT a true "run the probe on historical embeddings"
backfill. We do not currently persist the image embeddings used by the
matcher at scan time, so we cannot rerun the new language probe over
historical scans.

What this script DOES is the audit equivalent: for each scan with a
non-null predicted_card_id, look up the predicted card's catalog
language (from `cards.language`), pull the device locale from
`request_json.clientContext.localeIdentifier`, and bucket the row
into "match" / "mismatch" / "unknown" so we can quantify how many
existing predictions came back in the wrong language for the device.

Output CSV columns:
    scan_id
    created_at
    predicted_card_id
    predicted_card_language    -- from cards.language
    owner_user_id
    locale_identifier          -- from clientContext.localeIdentifier
    match_status               -- match | mismatch | unknown_locale | unknown_card_lang

Top-line stats are printed to stdout.
"""
from __future__ import annotations

import argparse
import csv
import json
import re
import sqlite3
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_DB = REPO_ROOT / "backend" / "data" / "spotlight_scanner.local.sqlite"
DEFAULT_OUTPUT = REPO_ROOT / "tools" / "output" / "language_probe_backfill_audit.csv"


def parse_since(value: str) -> str:
    """Parse a '--since' value like '30d', '7d', '24h', or an ISO datetime.

    Returns a SQLite-friendly ISO datetime string (UTC).
    """
    value = value.strip()
    relative = re.match(r"^(\d+)\s*([dhDH])$", value)
    if relative:
        amount = int(relative.group(1))
        unit = relative.group(2).lower()
        if unit == "d":
            delta = timedelta(days=amount)
        else:
            delta = timedelta(hours=amount)
        cutoff = datetime.now(timezone.utc) - delta
        return cutoff.replace(microsecond=0).isoformat().replace("+00:00", "Z")
    # Assume the user passed an ISO datetime through; trust it.
    return value


def derive_locale_language(locale_identifier: str | None) -> str | None:
    """Map an Apple/POSIX locale identifier to 'English' / 'Japanese' / None."""
    if not locale_identifier:
        return None
    head = re.split(r"[-_]", locale_identifier.strip(), maxsplit=1)[0].lower()
    if head == "ja":
        return "Japanese"
    if head == "en":
        return "English"
    return None


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--db", type=Path, default=DEFAULT_DB)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--since", default="30d", help="Relative window like '30d' or '24h', or an ISO datetime.")
    return parser.parse_args()


def main() -> None:
    args = parse_args()

    db_path = args.db.resolve()
    output_path = args.output.resolve()
    since_iso = parse_since(args.since)

    if not db_path.exists():
        raise SystemExit(f"Missing SQLite DB: {db_path}")

    print(f"DB:    {db_path}", flush=True)
    print(f"Since: {since_iso}", flush=True)

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()

    cur.execute(
        """
        SELECT
            scan_events.scan_id,
            scan_events.created_at,
            scan_events.predicted_card_id,
            scan_events.owner_user_id,
            scan_events.request_json,
            cards.language AS predicted_card_language
        FROM scan_events
        LEFT JOIN cards ON cards.id = scan_events.predicted_card_id
        WHERE scan_events.predicted_card_id IS NOT NULL
          AND scan_events.created_at >= ?
        ORDER BY scan_events.created_at DESC
        """,
        (since_iso,),
    )

    rows: list[dict[str, Any]] = []
    counts = {
        "match": 0,
        "mismatch": 0,
        "unknown_locale": 0,
        "unknown_card_lang": 0,
    }
    total = 0
    for db_row in cur.fetchall():
        total += 1
        request_json_raw = db_row["request_json"]
        locale_identifier = None
        if request_json_raw:
            try:
                request_payload = json.loads(request_json_raw)
                client_context = request_payload.get("clientContext") or {}
                locale_identifier = client_context.get("localeIdentifier") or client_context.get("locale")
            except (json.JSONDecodeError, AttributeError):
                locale_identifier = None
        locale_language = derive_locale_language(locale_identifier)
        card_language = db_row["predicted_card_language"]

        if not card_language:
            match_status = "unknown_card_lang"
        elif not locale_language:
            match_status = "unknown_locale"
        elif card_language == locale_language:
            match_status = "match"
        else:
            match_status = "mismatch"
        counts[match_status] += 1

        rows.append({
            "scan_id": db_row["scan_id"],
            "created_at": db_row["created_at"],
            "predicted_card_id": db_row["predicted_card_id"],
            "predicted_card_language": card_language or "",
            "owner_user_id": db_row["owner_user_id"] or "",
            "locale_identifier": locale_identifier or "",
            "match_status": match_status,
        })

    conn.close()

    output_path.parent.mkdir(parents=True, exist_ok=True)
    fieldnames = [
        "scan_id",
        "created_at",
        "predicted_card_id",
        "predicted_card_language",
        "owner_user_id",
        "locale_identifier",
        "match_status",
    ]
    with output_path.open("w", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)

    print()
    print(f"Total scans audited: {total}")
    if total == 0:
        print("No rows in window; nothing to summarize.")
        return
    for key in ["match", "mismatch", "unknown_locale", "unknown_card_lang"]:
        pct = 100.0 * counts[key] / total
        print(f"  {key:22s}: {counts[key]:5d} ({pct:5.1f}%)")

    # The headline impact stat the orchestrator/PR cares about: of the scans
    # where we COULD compare (both card language and locale language known),
    # what fraction returned a non-locale-matching card?
    decided = counts["match"] + counts["mismatch"]
    if decided > 0:
        mismatch_rate = 100.0 * counts["mismatch"] / decided
        print()
        print(f"Of {decided} scans with known locale + card language: "
              f"{counts['mismatch']} mismatches ({mismatch_rate:.1f}%).")

    print(f"\nWrote CSV: {output_path}")


if __name__ == "__main__":
    main()
