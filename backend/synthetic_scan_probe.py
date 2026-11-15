#!/usr/bin/env python3
"""End-to-end synthetic scan for run_vm_health_check.sh.

POSTs a known card photo to the local /api/v1/scan/visual-match exactly the
way the app does (multipart `payload` + `normalized_image`), and fails unless
the expected card comes back in the top PASS_TOP_K within the deadline. The
X-Spotlight-Synthetic-Scan header (token from SPOTLIGHT_SYNTHETIC_SCAN_TOKEN)
puts the request on the server's no-persistence, no-provider-spend lane.

Rate-limited to one real scan per MIN_INTERVAL_SECONDS via a state file that is
written only on success, so a failing scan is retried on every cron tick (the
health ping stays withheld until it passes again).

Stdlib only: it runs under the VM's system python3. Exit 0 = pass or skipped,
1 = fail.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from typing import Any

SYNTHETIC_SCAN_HEADER = "X-Spotlight-Synthetic-Scan"
SYNTHETIC_SCAN_TOKEN_ENV = "SPOTLIGHT_SYNTHETIC_SCAN_TOKEN"

# Real phone capture (qa/raw-footer-layout-check/team-rockets-weezing-199-182,
# app-normalized 630x880, re-encoded q80). Wins top-1 by ~0.25 cosine over the
# runner-up on both the v002 and v003 indexes, so it only drops out of the top
# 5 when the matcher is actually broken.
FIXTURE_PATH = Path(__file__).resolve().parent / "health_fixtures" / "synthetic_scan_sv10-199.jpg"
FIXTURE_WIDTH = 630
FIXTURE_HEIGHT = 880
EXPECTED_CARD_ID = "sv10-199"
# Top-5, not top-1: this is an outage alarm, not an accuracy gate. A broken
# index/adapter/encoder scatters the card far past rank 5; a model swap that
# nudges ranks is the eval harness's job, not a 3am page. Rank is logged.
PASS_TOP_K = 5
DEFAULT_TIMEOUT_SECONDS = 30.0
MIN_INTERVAL_SECONDS = 15 * 60


def build_match_payload(scan_id: str) -> dict[str, Any]:
    """Same shape as createScannerMatchPayload (packages/api-client) for a raw
    Pokémon scan; the image bytes travel as the `normalized_image` part."""
    return {
        "scanID": scan_id,
        "capturedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "clientContext": {
            "platform": "synthetic_probe",
            "appVersion": "0",
            "buildNumber": "0",
            "localeIdentifier": "en_US",
            "timeZoneIdentifier": "UTC",
        },
        "image": {"width": FIXTURE_WIDTH, "height": FIXTURE_HEIGHT},
        "recognizedTokens": [],
        "collectorNumber": None,
        "setHintTokens": [],
        "setBadgeHint": None,
        "promoCodeHint": None,
        "resolverModeHint": "raw_card",
        "rawResolverMode": "visual",
        "game": "pokemon",
        "cardLanguage": "english",
        "cropConfidence": 1,
        "warnings": [],
        "ocrAnalysis": None,
    }


def build_multipart_body(payload: dict[str, Any], image_bytes: bytes, boundary: str) -> bytes:
    delimiter = b"--" + boundary.encode("ascii")
    return b"".join([
        delimiter, b"\r\n",
        b'Content-Disposition: form-data; name="payload"\r\n',
        b"Content-Type: application/json\r\n\r\n",
        json.dumps(payload).encode("utf-8"), b"\r\n",
        delimiter, b"\r\n",
        b'Content-Disposition: form-data; name="normalized_image"; filename="normalized.jpg"\r\n',
        b"Content-Type: image/jpeg\r\n\r\n",
        image_bytes, b"\r\n",
        delimiter, b"--\r\n",
    ])


def expected_card_rank(response: dict[str, Any], expected_card_id: str) -> int | None:
    for index, row in enumerate(response.get("topCandidates") or [], start=1):
        candidate = (row or {}).get("candidate") or {}
        if str(candidate.get("id") or "") == expected_card_id:
            return int(row.get("rank") or index)
    return None


def evaluate_response(
    response: dict[str, Any], expected_card_id: str = EXPECTED_CARD_ID, pass_top_k: int = PASS_TOP_K
) -> tuple[bool, str]:
    if response.get("synthetic") is not True:
        # The server ignored the header (old build?) and ran a LOGGED scan.
        return False, "response is not marked synthetic (server did not honor the probe lane)"
    rank = expected_card_rank(response, expected_card_id)
    top = ((response.get("topCandidates") or [{}])[0] or {}).get("candidate") or {}
    detail = f"expected={expected_card_id} rank={rank} top1={top.get('id')}"
    if rank is None or rank > pass_top_k:
        return False, f"expected card not in top {pass_top_k}: {detail}"
    return True, detail


def recently_passed(state_file: Path, now: float, min_interval_seconds: float) -> bool:
    try:
        last_ok = float(state_file.read_text().strip())
    except (OSError, ValueError):
        return False
    return 0 <= now - last_ok < min_interval_seconds


def run_probe(base_url: str, token: str, timeout_seconds: float) -> tuple[bool, str]:
    scan_id = f"synthetic-probe-{uuid.uuid4()}"
    boundary = f"spotlight-probe-{uuid.uuid4().hex}"
    body = build_multipart_body(build_match_payload(scan_id), FIXTURE_PATH.read_bytes(), boundary)
    request = urllib.request.Request(
        f"{base_url.rstrip('/')}/api/v1/scan/visual-match",
        data=body,
        method="POST",
        headers={
            "Content-Type": f"multipart/form-data; boundary={boundary}",
            SYNTHETIC_SCAN_HEADER: token,
        },
    )
    started = time.monotonic()
    try:
        with urllib.request.urlopen(request, timeout=timeout_seconds) as http_response:
            raw = http_response.read()
    except urllib.error.HTTPError as error:
        return False, f"HTTP {error.code}: {error.read()[:300]!r}"
    except Exception as error:  # timeout, refused, reset
        return False, f"{type(error).__name__}: {error}"
    elapsed = time.monotonic() - started
    if elapsed > timeout_seconds:
        return False, f"slow: {elapsed:.1f}s > {timeout_seconds:.0f}s deadline"
    try:
        response = json.loads(raw)
    except ValueError:
        return False, "response is not JSON"
    ok, detail = evaluate_response(response)
    server_ms = (response.get("performance") or {}).get("serverProcessingMs")
    return ok, f"{detail} elapsed={elapsed:.2f}s serverMs={server_ms}"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default=f"http://127.0.0.1:{os.environ.get('SPOTLIGHT_PORT') or 8788}")
    parser.add_argument("--state-file", default="/tmp/spotlight-synthetic-scan.last-ok")
    parser.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT_SECONDS)
    parser.add_argument("--min-interval", type=float, default=MIN_INTERVAL_SECONDS)
    parser.add_argument("--force", action="store_true", help="ignore the rate limit")
    args = parser.parse_args(argv)

    token = str(os.environ.get(SYNTHETIC_SCAN_TOKEN_ENV) or "").strip()
    if not token:
        print(f"synthetic-scan skipped: {SYNTHETIC_SCAN_TOKEN_ENV} not set")
        return 0
    state_file = Path(args.state_file)
    if not args.force and recently_passed(state_file, time.time(), args.min_interval):
        print("synthetic-scan skipped: passed within the last interval")
        return 0

    ok, detail = run_probe(args.base_url, token, args.timeout)
    if not ok:
        print(f"synthetic-scan FAILED: {detail}", file=sys.stderr)
        return 1
    try:
        state_file.write_text(f"{int(time.time())}\n")
    except OSError as error:
        print(f"synthetic-scan state write failed (non-fatal): {error}", file=sys.stderr)
    print(f"synthetic-scan ok: {detail}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
