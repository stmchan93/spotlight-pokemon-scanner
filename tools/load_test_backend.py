#!/usr/bin/env python3
"""Concurrent load test for the Spotlight backend — sizing it for a card show.

Simulates ~40-60 people scanning at once plus a burst of onboarding (the first
screens a new user loads). Mirrors the EXACT authenticated requests the app makes
(the scan payload + auth come from tools/run_release_gate.py), so the numbers
reflect real production behavior. Reports p50/p95/p99 latency, error rate, and
throughput per endpoint.

WHY: a single VM serves the show. docs/show-prep-ops-checklist.md says resize to
t2d-standard-4 for show day and load-test "< 3s p95". Run this against the current
machine, then after the resize, and confirm p95 stays under ~3s at 40-60 concurrent.

USAGE (from repo root):

    # 1. Point it at the live backend + Supabase (same values the staging app uses).
    export SPOTLIGHT_LOADTEST_BASE_URL="https://<your-backend-host>"
    export SPOTLIGHT_LOADTEST_SUPABASE_URL="https://<project>.supabase.co"
    export SPOTLIGHT_LOADTEST_SUPABASE_ANON_KEY="<anon/publishable key>"

    # 2. Auth: a DEDICATED load-test user (preferred) — either a pre-fetched token
    #    or email/password (Supabase password grant), via the same env the smoke
    #    test uses (environment defaults to "staging"):
    export SPOTLIGHT_STAGING_SMOKE_BEARER_TOKEN="<jwt>"        # OR:
    export SPOTLIGHT_STAGING_SMOKE_EMAIL="loadtest@example.com"
    export SPOTLIGHT_STAGING_SMOKE_PASSWORD="..."

    # 3. Run it.
    python3 tools/load_test_backend.py --mode mixed --concurrency 50 --duration 30

CAVEATS:
  - Each scan persists a real scan_event + uploads an artifact to GCS under the
    test user. Use a dedicated load-test account and purge it afterward.
  - Do NOT run during show hours — it competes with real users for the one VM.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import random
import statistics
import sys
import time
import urllib.error
import urllib.request
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_FIXTURE_ROOT = REPO_ROOT / "qa" / "raw-footer-layout-check"


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def env(*names: str) -> str | None:
    for name in names:
        value = os.environ.get(name)
        if value and value.strip():
            return value.strip()
    return None


# ---------------------------------------------------------------------------
# JPEG dimensions + scan payload — copied from tools/run_release_gate.py so the
# request body is byte-for-byte what the backend expects.
# ---------------------------------------------------------------------------
def jpeg_dimensions(data: bytes) -> tuple[int, int]:
    if len(data) < 4 or data[0:2] != b"\xFF\xD8":
        raise ValueError("not a JPEG file")
    index = 2
    while index + 8 < len(data):
        if data[index] != 0xFF:
            index += 1
            continue
        marker = data[index + 1]
        index += 2
        if marker in {0xD8, 0xD9}:
            continue
        if index + 2 > len(data):
            break
        segment_length = int.from_bytes(data[index : index + 2], "big")
        if segment_length < 2 or index + segment_length > len(data):
            break
        if marker in {0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF}:
            height = int.from_bytes(data[index + 3 : index + 5], "big")
            width = int.from_bytes(data[index + 5 : index + 7], "big")
            return width, height
        index += segment_length
    raise ValueError("could not read JPEG dimensions")


def load_fixture_payloads(fixture_root: Path, limit: int) -> list[dict]:
    """Pre-encode each available fixture image into a scan payload TEMPLATE.

    Per request we only swap scanID/capturedAt, so the heavy base64 work happens
    once and the backend never dedupes (every scanID is unique)."""
    templates: list[dict] = []
    candidates = sorted(p for p in fixture_root.iterdir() if p.is_dir()) if fixture_root.is_dir() else []
    for fixture_dir in candidates:
        for image_name in ("06_ocr_input_normalized.jpg", "runtime_normalized.jpg"):
            image_path = fixture_dir / image_name
            if not image_path.is_file():
                continue
            data = image_path.read_bytes()
            try:
                width, height = jpeg_dimensions(data)
            except ValueError:
                continue
            templates.append(
                {
                    "image": {"jpegBase64": base64.b64encode(data).decode("ascii"), "width": width, "height": height},
                    "clientContext": {
                        "platform": "load_test",
                        "appVersion": "loadtest",
                        "buildNumber": "0",
                        "localeIdentifier": "en_US",
                        "timeZoneIdentifier": "America/Los_Angeles",
                    },
                    "recognizedTokens": [],
                    "collectorNumber": None,
                    "setHintTokens": [],
                    "setBadgeHint": None,
                    "promoCodeHint": None,
                    "slabGrader": None,
                    "slabGrade": None,
                    "slabCertNumber": None,
                    "slabBarcodePayloads": [],
                    "slabGraderConfidence": None,
                    "slabGradeConfidence": None,
                    "slabCertConfidence": None,
                    "slabCardNumberRaw": None,
                    "slabParsedLabelText": [],
                    "slabClassifierReasons": [],
                    "slabRecommendedLookupPath": None,
                    "resolverModeHint": "raw_card",
                    "rawResolverMode": "visual",
                    "cropConfidence": 1,
                    "warnings": [],
                    "ocrAnalysis": None,
                }
            )
            if len(templates) >= limit:
                return templates
            break
    return templates


def scan_payload(template: dict) -> dict:
    return {**template, "scanID": str(uuid.uuid4()), "capturedAt": now_iso()}


# ---------------------------------------------------------------------------
# HTTP + auth
# ---------------------------------------------------------------------------
def timed_request(method: str, url: str, *, headers: dict, payload: dict | None = None, timeout: float) -> tuple[float, int]:
    """Return (latency_seconds, status_code). status 0 == transport error."""
    body = json.dumps(payload).encode("utf-8") if payload is not None else None
    req_headers = dict(headers)
    if body is not None:
        req_headers.setdefault("Content-Type", "application/json")
    request = urllib.request.Request(url, data=body, headers=req_headers, method=method.upper())
    started = time.perf_counter()
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            response.read()
            return time.perf_counter() - started, response.status
    except urllib.error.HTTPError as error:
        error.read()
        return time.perf_counter() - started, error.code
    except (urllib.error.URLError, TimeoutError, OSError):
        return time.perf_counter() - started, 0


def authenticate(environment: str, supabase_url: str, anon_key: str) -> str:
    token = env(f"SPOTLIGHT_{environment.upper()}_SMOKE_BEARER_TOKEN")
    if token:
        return token
    email = env(f"SPOTLIGHT_{environment.upper()}_SMOKE_EMAIL")
    password = env(f"SPOTLIGHT_{environment.upper()}_SMOKE_PASSWORD")
    if not email or not password:
        sys.exit(
            f"Missing auth. Set SPOTLIGHT_{environment.upper()}_SMOKE_BEARER_TOKEN, "
            f"or SPOTLIGHT_{environment.upper()}_SMOKE_EMAIL + _SMOKE_PASSWORD."
        )
    body = json.dumps({"email": email, "password": password}).encode("utf-8")
    request = urllib.request.Request(
        f"{supabase_url.rstrip('/')}/auth/v1/token?grant_type=password",
        data=body,
        headers={"apikey": anon_key, "Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=20.0) as response:
        token = str(json.loads(response.read().decode("utf-8")).get("access_token") or "").strip()
    if not token:
        sys.exit("Supabase auth did not return an access_token.")
    return token


# ---------------------------------------------------------------------------
# Reporting
# ---------------------------------------------------------------------------
def percentile(values: list[float], pct: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    rank = min(len(ordered) - 1, int(round((pct / 100.0) * (len(ordered) - 1))))
    return ordered[rank]


def report(label: str, latencies: list[float], errors: int, wall_seconds: float) -> None:
    total = len(latencies) + errors
    ok = len(latencies)
    ms = [v * 1000 for v in latencies]
    print(f"\n=== {label} ===")
    print(f"  requests: {total}   ok: {ok}   errors: {errors} ({(errors / total * 100) if total else 0:.1f}%)")
    print(f"  throughput: {total / wall_seconds:.1f} req/s over {wall_seconds:.1f}s")
    if ms:
        print(
            f"  latency ms — p50 {percentile(ms, 50):.0f}  p95 {percentile(ms, 95):.0f}  "
            f"p99 {percentile(ms, 99):.0f}  max {max(ms):.0f}  mean {statistics.mean(ms):.0f}"
        )
        p95 = percentile(ms, 95)
        verdict = "PASS (<3s)" if p95 < 3000 else "SLOW (>=3s) — bigger machine / fewer concurrent"
        print(f"  p95 verdict: {verdict}")


# ---------------------------------------------------------------------------
# Load phases
# ---------------------------------------------------------------------------
def run_scan_load(base_url: str, token: str, templates: list[dict], concurrency: int, duration: float, timeout: float):
    auth = {"Authorization": f"Bearer {token}"}
    url = f"{base_url.rstrip('/')}/api/v1/scan/visual-match"
    latencies: list[float] = []
    errors = 0
    deadline = time.perf_counter() + duration
    started = time.perf_counter()

    def worker() -> tuple[list[float], int]:
        local: list[float] = []
        local_err = 0
        while time.perf_counter() < deadline:
            latency, status = timed_request("POST", url, headers=auth, payload=scan_payload(random.choice(templates)), timeout=timeout)
            if 200 <= status < 300:
                local.append(latency)
            else:
                local_err += 1
        return local, local_err

    with ThreadPoolExecutor(max_workers=concurrency) as pool:
        for future in as_completed([pool.submit(worker) for _ in range(concurrency)]):
            local, local_err = future.result()
            latencies.extend(local)
            errors += local_err
    report(f"SCAN load — {concurrency} concurrent for {duration:.0f}s", latencies, errors, time.perf_counter() - started)


def run_onboarding_burst(base_url: str, token: str, concurrency: int, timeout: float):
    base = base_url.rstrip("/")
    auth = {"Authorization": f"Bearer {token}"}
    tz = "America/Los_Angeles"
    # The endpoints a fresh user's first screens hit (from the smoke flow).
    sequence = [
        ("health", "GET", f"{base}/api/v1/health", {}),
        ("deck/entries", "GET", f"{base}/api/v1/deck/entries", auth),
        ("portfolio/history", "GET", f"{base}/api/v1/portfolio/history?range=7D&timeZone={tz}", auth),
        ("cards/search", "GET", f"{base}/api/v1/cards/search?q=Pikachu&limit=10", auth),
    ]
    per_endpoint: dict[str, list[float]] = {name: [] for name, *_ in sequence}
    errors = 0
    started = time.perf_counter()

    def onboard_once() -> tuple[dict[str, list[float]], int]:
        local = {name: [] for name, *_ in sequence}
        local_err = 0
        for name, method, url, headers in sequence:
            latency, status = timed_request(method, url, headers=headers, timeout=timeout)
            if 200 <= status < 300:
                local[name].append(latency)
            else:
                local_err += 1
        return local, local_err

    with ThreadPoolExecutor(max_workers=concurrency) as pool:
        for future in as_completed([pool.submit(onboard_once) for _ in range(concurrency)]):
            local, local_err = future.result()
            for name, vals in local.items():
                per_endpoint[name].extend(vals)
            errors += local_err
    wall = time.perf_counter() - started
    print(f"\n=== ONBOARDING burst — {concurrency} concurrent users ===")
    for name, vals in per_endpoint.items():
        report(f"  {name}", vals, 0, wall)
    if errors:
        print(f"  (onboarding errors: {errors})")


def main() -> None:
    parser = argparse.ArgumentParser(description="Concurrent load test for the Spotlight backend.")
    parser.add_argument("--mode", choices=("scan", "onboard", "mixed"), default="mixed")
    parser.add_argument("--concurrency", type=int, default=50)
    parser.add_argument("--duration", type=float, default=30.0, help="seconds of sustained scan load")
    parser.add_argument("--timeout", type=float, default=60.0)
    parser.add_argument("--environment", default="staging")
    parser.add_argument("--base-url", default=env("SPOTLIGHT_LOADTEST_BASE_URL", "EXPO_PUBLIC_SPOTLIGHT_API_BASE_URL"))
    parser.add_argument("--supabase-url", default=env("SPOTLIGHT_LOADTEST_SUPABASE_URL", "EXPO_PUBLIC_SPOTLIGHT_SUPABASE_URL"))
    parser.add_argument("--anon-key", default=env("SPOTLIGHT_LOADTEST_SUPABASE_ANON_KEY", "EXPO_PUBLIC_SPOTLIGHT_SUPABASE_ANON_KEY"))
    parser.add_argument("--fixtures", default=str(DEFAULT_FIXTURE_ROOT))
    parser.add_argument("--max-fixtures", type=int, default=12)
    args = parser.parse_args()

    if not args.base_url:
        sys.exit("Missing --base-url (or SPOTLIGHT_LOADTEST_BASE_URL).")
    if not args.supabase_url or not args.anon_key:
        sys.exit("Missing --supabase-url / --anon-key (or SPOTLIGHT_LOADTEST_SUPABASE_URL / _ANON_KEY).")

    print(f"Target: {args.base_url}  mode={args.mode}  concurrency={args.concurrency}")
    token = authenticate(args.environment, args.supabase_url, args.anon_key)
    print("Authenticated test user ✓")

    templates: list[dict] = []
    if args.mode in ("scan", "mixed"):
        templates = load_fixture_payloads(Path(args.fixtures), args.max_fixtures)
        if not templates:
            sys.exit(f"No usable scan fixtures under {args.fixtures}")
        print(f"Loaded {len(templates)} scan fixture(s)")

    if args.mode in ("onboard", "mixed"):
        run_onboarding_burst(args.base_url, token, args.concurrency, args.timeout)
    if args.mode in ("scan", "mixed"):
        run_scan_load(args.base_url, token, templates, args.concurrency, args.duration, args.timeout)

    print("\nReminder: scans persisted under the test user — purge after. Resize VM per docs/show-prep-ops-checklist.md.")


if __name__ == "__main__":
    main()
