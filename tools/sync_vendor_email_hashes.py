#!/usr/bin/env python3
"""Load a show's hashed vendor emails into Supabase for "This is you" booth matching.

Reads the private sidecar tools/build_event_floor_map.py writes next to the map:

    backend/data/spotlight_event_maps/<event-id>.vendor-emails.json

and replaces that show's rows in ``booth_vendor_emails`` (social_29) through the
service-role-only ``replace_booth_vendor_emails`` RPC, in one transaction. Only
sha256 hashes travel; the sidecar never holds a plaintext email.

    python3 tools/sync_vendor_email_hashes.py --event-id seattle-2026-12 --env staging --dry-run
    python3 tools/sync_vendor_email_hashes.py --event-id seattle-2026-12 --env staging

Credentials come from backend/.env.<env> then backend/.env.<env>.secrets
(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY), as on the VM. Production also needs
SPOTLIGHT_PROD_CONFIRM=yes typed on the command line.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path
from typing import Any
from urllib.error import HTTPError
from urllib.request import Request, urlopen

REPO = Path(__file__).resolve().parents[1]
BACKEND = REPO / "backend"
MAPS_DIR = BACKEND / "data" / "spotlight_event_maps"
SIDECAR_SUFFIX = ".vendor-emails.json"
HTTP_TIMEOUT = 30
# One Supabase project per env (docs/production-promotion-plan-2026-08-12.md);
# a staging run aimed at prod's URL is refused.
PROJECT_REFS = {"staging": "mphjenaaorntwkyivqtm", "production": "lvnjshymwvagwadqeofm"}
_HASH_RE = re.compile(r"^[0-9a-f]{64}$")
_ID_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")


class SyncError(RuntimeError):
    pass


def parse_env_file(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.is_file():
        return values
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.removeprefix("export ").partition("=")
        values[key.strip()] = value.strip().strip("'\"")
    return values


def supabase_credentials(env: str, backend_dir: Path | None = None) -> tuple[str, str]:
    backend_dir = backend_dir or BACKEND
    values = parse_env_file(backend_dir / f".env.{env}")
    values.update(parse_env_file(backend_dir / f".env.{env}.secrets"))
    url = (values.get("SUPABASE_URL") or "").rstrip("/")
    key = values.get("SUPABASE_SERVICE_ROLE_KEY") or ""
    if not url or not key:
        raise SyncError(f"SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing from backend/.env.{env}[.secrets]")
    if PROJECT_REFS[env] not in url:
        raise SyncError(f"{env} SUPABASE_URL is not the {env} project ({PROJECT_REFS[env]})")
    return url, key


def load_sidecar(event_id: str, maps_dir: Path = MAPS_DIR) -> dict[str, list[str]]:
    """{vendor id: [hash]} from the sidecar, validated, limited to vendors on the show's map."""
    path = maps_dir / f"{event_id}{SIDECAR_SUFFIX}"
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise SyncError(f"{path}: {error} (rebuild with tools/build_event_floor_map.py --vendors-csv ...)") from error
    if not isinstance(document, dict) or document.get("eventId") != event_id or not isinstance(
        document.get("vendors"), dict
    ):
        raise SyncError(f"{path} is not this show's sidecar")
    try:
        on_map = {v["id"] for v in json.loads((maps_dir / f"{event_id}.json").read_text(encoding="utf-8"))["vendors"]}
    except (OSError, ValueError, KeyError, TypeError) as error:
        raise SyncError(f"no readable map for {event_id}: {error}") from error
    hashes: dict[str, list[str]] = {}
    for vendor_id, values in document["vendors"].items():
        if vendor_id not in on_map:
            raise SyncError(f"sidecar vendor {vendor_id!r} is not on the map; rebuild both together")
        if not isinstance(values, list) or not all(isinstance(v, str) and _HASH_RE.match(v) for v in values):
            raise SyncError(f"vendor {vendor_id!r}: entries must be sha256 hex digests")
        if values:
            hashes[vendor_id] = sorted(set(values))
    return hashes


def replace_hashes(url: str, key: str, event_id: str, hashes: dict[str, list[str]]) -> int:
    body = json.dumps({"p_event_id": event_id, "p_hashes": hashes}).encode("utf-8")
    request = Request(
        f"{url}/rest/v1/rpc/replace_booth_vendor_emails",
        data=body,
        headers={"apikey": key, "Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urlopen(request, timeout=HTTP_TIMEOUT) as response:
            raw = response.read()
    except HTTPError as error:
        detail = error.read().decode("utf-8", "replace")[:300]
        raise SyncError(f"supabase {error.code}: {detail}") from error
    except OSError as error:
        raise SyncError(f"supabase unreachable: {error}") from error
    result: Any = json.loads(raw) if raw else None
    return int(result) if isinstance(result, (int, float)) else 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--event-id", required=True)
    parser.add_argument("--env", required=True, choices=sorted(PROJECT_REFS))
    parser.add_argument("--maps-dir", type=Path, default=MAPS_DIR)
    parser.add_argument("--dry-run", action="store_true", help="validate and count; send nothing")
    args = parser.parse_args(argv)
    if not _ID_RE.match(args.event_id):
        raise SystemExit("--event-id must be a [a-z0-9-] slug")
    try:
        hashes = load_sidecar(args.event_id, args.maps_dir)
        rows = sum(len(v) for v in hashes.values())
        print(f"{args.event_id}: {len(hashes)} vendors, {rows} email hashes")
        if args.dry_run:
            print("dry run: nothing sent")
            return 0
        if args.env == "production" and os.environ.get("SPOTLIGHT_PROD_CONFIRM") != "yes":
            raise SyncError("production needs SPOTLIGHT_PROD_CONFIRM=yes on this invocation")
        url, key = supabase_credentials(args.env)
        written = replace_hashes(url, key, args.event_id, hashes)
    except SyncError as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    print(f"replaced {args.event_id} in {args.env}: {written} rows")
    return 0


if __name__ == "__main__":
    sys.exit(main())
