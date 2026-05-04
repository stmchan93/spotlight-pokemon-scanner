#!/usr/bin/env python3
from __future__ import annotations

import argparse
import base64
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Sequence

try:
    from tools.mobile_env_resolver import parse_dotenv, resolve_mobile_env_values
except ModuleNotFoundError:  # pragma: no cover - direct script execution path
    from mobile_env_resolver import parse_dotenv, resolve_mobile_env_values


class ReleaseGateError(RuntimeError):
    pass


DEFAULT_SMOKE_FIXTURE_DIR = "qa/raw-footer-layout-check/pikachu-vmax-swsh286"


@dataclass
class CommandStepSummary:
    name: str
    status: str
    duration_seconds: float
    command: list[str] | None = None
    details: dict[str, Any] = field(default_factory=dict)


@dataclass
class ReleaseGateSummary:
    environment: str
    mobile_action: str
    started_at: str
    finished_at: str | None = None
    status: str = "running"
    steps: list[CommandStepSummary] = field(default_factory=list)
    summary_path: str | None = None


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run the staged release gate: checks, audit, backend deploy, staging smoke, optional iOS build/release."
    )
    parser.add_argument("--environment", default="staging", choices=("staging", "production"))
    parser.add_argument("--backend-secrets-file")
    parser.add_argument("--mobile-env-file")
    parser.add_argument("--mobile-action", default="none", choices=("none", "build", "release"))
    parser.add_argument("--skip-check", action="store_true")
    parser.add_argument("--skip-audit", action="store_true")
    parser.add_argument("--skip-deploy", action="store_true")
    parser.add_argument("--skip-smoke", action="store_true")
    parser.add_argument("--smoke-mode", default="full", choices=("read-only", "full"))
    parser.add_argument("--summary-dir")
    parser.add_argument("--smoke-query")
    parser.add_argument("--smoke-fixture-dir")
    return parser.parse_args(argv)


def repo_root() -> Path:
    return Path(__file__).resolve().parents[1]


def parse_required_dotenv(path: Path) -> dict[str, str]:
    resolved_path = path.expanduser().resolve()
    if not resolved_path.exists():
        raise FileNotFoundError(f"Missing env file: {resolved_path}")
    return parse_dotenv(resolved_path)


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def summary_dir_path(explicit: str | None) -> Path:
    if explicit:
        return Path(explicit).expanduser()
    return Path(tempfile.gettempdir()) / "spotlight-release-gates"


def build_deploy_command(environment: str, backend_secrets_file: str | None) -> list[str]:
    command = ["bash", "tools/deploy_backend.sh", environment]
    if backend_secrets_file:
        command.append(backend_secrets_file)
    return command


def build_mobile_command(environment: str, mobile_action: str) -> list[str]:
    if mobile_action not in {"build", "release"}:
        raise ReleaseGateError(f"Unsupported mobile action: {mobile_action}")
    return ["bash", "tools/run_mobile_eas.sh", environment, mobile_action, "ios", environment]


def build_smoke_reset_command(environment: str) -> list[str] | None:
    if environment != "staging":
        return None
    return ["python3", "tools/reset_staging_smoke_fixture.py"]


def resolve_mobile_env_values_for_gate(root: Path, environment: str, override: str | None) -> dict[str, str]:
    if override:
        return parse_required_dotenv(Path(override))
    return resolve_mobile_env_values(root, environment, environment)


def resolve_smoke_env_value(environment: str, suffix: str) -> str | None:
    env_name = f"SPOTLIGHT_{environment.upper()}_SMOKE_{suffix}"
    generic_name = f"SPOTLIGHT_SMOKE_{suffix}"
    value = str(os.environ.get(env_name) or "").strip()
    if value:
        return value
    generic = str(os.environ.get(generic_name) or "").strip()
    return generic or None


def normalize_card_number(value: str | None) -> str:
    return str(value or "").strip().lstrip("#").upper()


def normalize_card_name(value: str | None) -> str:
    return " ".join(str(value or "").strip().casefold().split())


def candidate_matches_truth(candidate: dict[str, Any], *, truth_name: str, truth_number: str) -> bool:
    return (
        normalize_card_name(candidate.get("name")) == normalize_card_name(truth_name)
        and normalize_card_number(candidate.get("number")) == normalize_card_number(truth_number)
    )


def build_default_smoke_query(truth_name: str, truth_number: str) -> str:
    if normalize_card_number(truth_number):
        return f"{truth_name} {truth_number}"
    return truth_name


def extract_deck_entries(payload: Any) -> list[dict[str, Any]]:
    if isinstance(payload, list):
        return [entry for entry in payload if isinstance(entry, dict)]
    if isinstance(payload, dict) and isinstance(payload.get("entries"), list):
        return [entry for entry in payload["entries"] if isinstance(entry, dict)]
    return []


def deck_entry_card_id(entry: dict[str, Any]) -> str:
    nested_card = entry.get("card") if isinstance(entry.get("card"), dict) else {}
    return str(
        entry.get("cardID")
        or entry.get("cardId")
        or nested_card.get("cardID")
        or nested_card.get("cardId")
        or nested_card.get("id")
        or ""
    ).strip()


def deck_quantity_for(entries: list[dict[str, Any]], *, card_id: str, condition_code: str | None) -> int:
    total = 0
    target_condition = str(condition_code or "").strip().lower()
    for entry in entries:
        if deck_entry_card_id(entry) != card_id:
            continue
        entry_condition = str(entry.get("condition") or "").strip().lower()
        if entry_condition != target_condition:
            continue
        try:
            total += int(entry.get("quantity") or 0)
        except (TypeError, ValueError):
            continue
    return total


def jpeg_dimensions(path: Path) -> tuple[int, int]:
    data = path.read_bytes()
    if len(data) < 4 or data[0:2] != b"\xFF\xD8":
        raise ReleaseGateError(f"{path} is not a JPEG file.")
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
        if marker in {
            0xC0,
            0xC1,
            0xC2,
            0xC3,
            0xC5,
            0xC6,
            0xC7,
            0xC9,
            0xCA,
            0xCB,
            0xCD,
            0xCE,
            0xCF,
        }:
            height = int.from_bytes(data[index + 3 : index + 5], "big")
            width = int.from_bytes(data[index + 5 : index + 7], "big")
            return width, height
        index += segment_length
    raise ReleaseGateError(f"Could not read JPEG dimensions from {path}.")


def load_scan_fixture(root: Path, override: str | None) -> tuple[Path, dict[str, str]]:
    fixture_dir = Path(override).expanduser() if override else root / DEFAULT_SMOKE_FIXTURE_DIR
    if not fixture_dir.is_absolute():
        fixture_dir = (root / fixture_dir).resolve()
    truth_path = fixture_dir / "truth.json"
    if not truth_path.is_file():
        raise ReleaseGateError(f"Missing smoke fixture truth file: {truth_path}")
    truth_payload = json.loads(truth_path.read_text(encoding="utf-8"))
    truth_name = str(truth_payload.get("cardName") or "").strip()
    truth_number = str(truth_payload.get("collectorNumber") or "").strip()
    if not truth_name or not truth_number:
        raise ReleaseGateError(f"Smoke fixture truth file is missing cardName/collectorNumber: {truth_path}")

    for candidate_name in ("06_ocr_input_normalized.jpg", "runtime_normalized.jpg"):
        image_path = fixture_dir / candidate_name
        if image_path.is_file():
            return image_path, {"cardName": truth_name, "collectorNumber": truth_number}
    raise ReleaseGateError(f"Missing smoke fixture image in {fixture_dir}")


def request_json(
    method: str,
    url: str,
    *,
    payload: dict[str, Any] | None = None,
    headers: dict[str, str] | None = None,
    timeout_seconds: float = 30.0,
) -> Any:
    encoded_payload = None
    request_headers = dict(headers or {})
    if payload is not None:
        encoded_payload = json.dumps(payload).encode("utf-8")
        request_headers.setdefault("Content-Type", "application/json")
    request = urllib.request.Request(url, data=encoded_payload, headers=request_headers, method=method.upper())
    try:
        with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
            body = response.read().decode("utf-8")
            return json.loads(body) if body else {}
    except urllib.error.HTTPError as error:
        body = error.read().decode("utf-8", errors="replace")
        raise ReleaseGateError(f"{method.upper()} {url} failed with HTTP {error.code}: {body}") from error
    except urllib.error.URLError as error:
        raise ReleaseGateError(f"{method.upper()} {url} failed: {error}") from error


def authenticate_smoke_user(*, supabase_url: str, anon_key: str, environment: str) -> str:
    token_override = resolve_smoke_env_value(environment, "BEARER_TOKEN")
    if token_override:
        return token_override

    email = resolve_smoke_env_value(environment, "EMAIL")
    password = resolve_smoke_env_value(environment, "PASSWORD")
    if not email or not password:
        raise ReleaseGateError(
            "Missing smoke user credentials. Set either "
            f"SPOTLIGHT_{environment.upper()}_SMOKE_BEARER_TOKEN or "
            f"SPOTLIGHT_{environment.upper()}_SMOKE_EMAIL / SPOTLIGHT_{environment.upper()}_SMOKE_PASSWORD."
        )

    payload = {"email": email, "password": password}
    response = request_json(
        "POST",
        f"{supabase_url.rstrip('/')}/auth/v1/token?grant_type=password",
        payload=payload,
        headers={"apikey": anon_key},
        timeout_seconds=20.0,
    )
    access_token = str(response.get("access_token") or "").strip()
    if not access_token:
        raise ReleaseGateError("Supabase auth response did not include access_token.")
    return access_token


def run_subprocess_step(
    summary: ReleaseGateSummary,
    *,
    name: str,
    command: list[str],
    cwd: Path,
) -> None:
    print(f"\n== {name} ==")
    started = time.perf_counter()
    try:
        subprocess.run(command, cwd=cwd, check=True)
    except subprocess.CalledProcessError as error:
        duration = time.perf_counter() - started
        summary.steps.append(
            CommandStepSummary(
                name=name,
                status="failed",
                duration_seconds=round(duration, 2),
                command=command,
                details={"returncode": error.returncode},
            )
        )
        raise ReleaseGateError(f"{name} failed with exit code {error.returncode}.") from error
    duration = time.perf_counter() - started
    summary.steps.append(
        CommandStepSummary(
            name=name,
            status="passed",
            duration_seconds=round(duration, 2),
            command=command,
        )
    )


def build_scan_payload(image_path: Path) -> dict[str, Any]:
    width, height = jpeg_dimensions(image_path)
    encoded = base64.b64encode(image_path.read_bytes()).decode("ascii")
    return {
        "scanID": str(uuid.uuid4()),
        "capturedAt": now_iso(),
        "clientContext": {
            "platform": "release_gate",
            "appVersion": os.environ.get("GITHUB_SHA", "0")[:12] or "0",
            "buildNumber": os.environ.get("GITHUB_RUN_NUMBER", "0") or "0",
            "localeIdentifier": "en_US",
            "timeZoneIdentifier": "America/Los_Angeles",
        },
        "image": {
            "jpegBase64": encoded,
            "width": width,
            "height": height,
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


def parse_search_results(payload: Any) -> list[dict[str, Any]]:
    if isinstance(payload, dict) and isinstance(payload.get("results"), list):
        return [entry for entry in payload["results"] if isinstance(entry, dict)]
    return []


def find_exact_search_result(results: list[dict[str, Any]], *, truth_name: str, truth_number: str) -> dict[str, Any] | None:
    for result in results:
        if candidate_matches_truth(result, truth_name=truth_name, truth_number=truth_number):
            return result
    return None


def parse_scan_candidates(payload: Any) -> list[dict[str, Any]]:
    top_candidates = payload.get("topCandidates") if isinstance(payload, dict) else None
    if not isinstance(top_candidates, list):
        return []
    parsed: list[dict[str, Any]] = []
    for entry in top_candidates:
        if not isinstance(entry, dict):
            continue
        candidate = entry.get("candidate")
        if not isinstance(candidate, dict):
            continue
        parsed.append(
            {
                "rank": entry.get("rank"),
                "id": candidate.get("id"),
                "name": candidate.get("name"),
                "number": candidate.get("number"),
            }
        )
    return parsed


def find_truth_scan_candidate(candidates: list[dict[str, Any]], *, truth_name: str, truth_number: str) -> dict[str, Any] | None:
    for candidate in candidates:
        if candidate_matches_truth(candidate, truth_name=truth_name, truth_number=truth_number):
            return candidate
    return None


def authorized_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def run_staging_smoke(
    *,
    root: Path,
    environment: str,
    mobile_env_values: dict[str, str],
    smoke_mode: str,
    smoke_query_override: str | None,
    smoke_fixture_override: str | None,
) -> dict[str, Any]:
    env_values = mobile_env_values
    base_url = str(env_values.get("EXPO_PUBLIC_SPOTLIGHT_API_BASE_URL") or "").strip().rstrip("/")
    supabase_url = str(env_values.get("EXPO_PUBLIC_SPOTLIGHT_SUPABASE_URL") or "").strip().rstrip("/")
    anon_key = str(env_values.get("EXPO_PUBLIC_SPOTLIGHT_SUPABASE_ANON_KEY") or "").strip()
    if not base_url or not supabase_url or not anon_key:
        raise ReleaseGateError(
            "Resolved staging mobile env must define EXPO_PUBLIC_SPOTLIGHT_API_BASE_URL, EXPO_PUBLIC_SPOTLIGHT_SUPABASE_URL, and EXPO_PUBLIC_SPOTLIGHT_SUPABASE_ANON_KEY."
        )

    access_token = authenticate_smoke_user(
        supabase_url=supabase_url,
        anon_key=anon_key,
        environment=environment,
    )
    auth_headers = authorized_headers(access_token)

    fixture_path, truth = load_scan_fixture(root, smoke_fixture_override)
    smoke_query = smoke_query_override or resolve_smoke_env_value(environment, "CARD_QUERY") or build_default_smoke_query(
        truth["cardName"],
        truth["collectorNumber"],
    )

    smoke_summary: dict[str, Any] = {
        "baseUrl": base_url,
        "fixturePath": str(fixture_path),
        "searchQuery": smoke_query,
        "truth": truth,
    }

    health = request_json("GET", f"{base_url}/api/v1/health")
    if str(health.get("status") or "").strip().lower() != "ok":
        raise ReleaseGateError(f"Health check did not return status=ok: {health}")
    smoke_summary["health"] = {"status": health.get("status")}

    provider_status = request_json("GET", f"{base_url}/api/v1/ops/provider-status")
    smoke_summary["providerStatus"] = {
        "manualMirrorEnabled": provider_status.get("manualScrydexMirrorEnabled"),
        "livePricingEnabled": provider_status.get("livePricingEnabled"),
    }

    deck_entries_before_payload = request_json("GET", f"{base_url}/api/v1/deck/entries", headers=auth_headers)
    deck_entries_before = extract_deck_entries(deck_entries_before_payload)
    smoke_summary["inventoryBeforeCount"] = len(deck_entries_before)

    history = request_json(
        "GET",
        f"{base_url}/api/v1/portfolio/history?{urllib.parse.urlencode({'range': '7D', 'timeZone': 'America/Los_Angeles'})}",
        headers=auth_headers,
    )
    ledger = request_json(
        "GET",
        f"{base_url}/api/v1/portfolio/ledger?{urllib.parse.urlencode({'range': 'ALL', 'timeZone': 'America/Los_Angeles', 'limit': '50', 'offset': '0'})}",
        headers=auth_headers,
    )
    smoke_summary["portfolio"] = {
        "historyPoints": len(history.get("points") or []),
        "ledgerTransactions": len(ledger.get("transactions") or []),
    }

    search_payload = request_json(
        "GET",
        f"{base_url}/api/v1/cards/search?{urllib.parse.urlencode({'q': smoke_query, 'limit': '10'})}",
        headers=auth_headers,
    )
    search_results = parse_search_results(search_payload)
    if not search_results:
        raise ReleaseGateError(f"Catalog search returned no results for smoke query '{smoke_query}'.")
    exact_search_result = find_exact_search_result(
        search_results,
        truth_name=truth["cardName"],
        truth_number=truth["collectorNumber"],
    )
    if exact_search_result is None:
        raise ReleaseGateError(
            f"Catalog search did not return the expected card for '{smoke_query}'. Expected {truth['cardName']} #{truth['collectorNumber']}."
        )
    smoke_summary["search"] = {
        "resultCount": len(search_results),
        "matchedCardID": exact_search_result.get("id"),
    }

    if smoke_mode == "read-only":
        return smoke_summary

    condition_code = "near_mint"
    exact_card_id = str(exact_search_result.get("id") or "").strip()
    if not exact_card_id:
        raise ReleaseGateError("Exact smoke search result is missing an id.")

    manual_before_quantity = deck_quantity_for(deck_entries_before, card_id=exact_card_id, condition_code=condition_code)
    manual_add_payload = {
        "cardID": exact_card_id,
        "slabContext": None,
        "variantName": None,
        "condition": condition_code,
        "quantity": 1,
        "sourceScanID": None,
        "selectionSource": "manual_search",
        "selectedRank": None,
        "wasTopPrediction": None,
        "addedAt": now_iso(),
    }
    manual_add_response = request_json(
        "POST",
        f"{base_url}/api/v1/deck/entries",
        payload=manual_add_payload,
        headers=auth_headers,
    )
    deck_entries_after_manual = extract_deck_entries(
        request_json("GET", f"{base_url}/api/v1/deck/entries", headers=auth_headers)
    )
    manual_after_quantity = deck_quantity_for(
        deck_entries_after_manual,
        card_id=exact_card_id,
        condition_code=condition_code,
    )
    if manual_after_quantity != manual_before_quantity + 1:
        raise ReleaseGateError(
            f"Manual add smoke failed: expected quantity {manual_before_quantity + 1}, got {manual_after_quantity} for card {exact_card_id}."
        )
    smoke_summary["manualAdd"] = {
        "deckEntryID": manual_add_response.get("deckEntryID"),
        "quantityBefore": manual_before_quantity,
        "quantityAfter": manual_after_quantity,
    }

    scan_payload = build_scan_payload(fixture_path)
    scan_response = request_json(
        "POST",
        f"{base_url}/api/v1/scan/visual-match",
        payload=scan_payload,
        headers=auth_headers,
        timeout_seconds=60.0,
    )
    scan_id = str(scan_response.get("scanID") or "").strip()
    candidates = parse_scan_candidates(scan_response)
    if not scan_id:
        raise ReleaseGateError("Scan smoke failed: response did not include scanID.")
    if not candidates:
        raise ReleaseGateError("Scan smoke failed: response did not include top candidates.")
    truth_candidate = find_truth_scan_candidate(
        candidates,
        truth_name=truth["cardName"],
        truth_number=truth["collectorNumber"],
    )
    if truth_candidate is None:
        raise ReleaseGateError(
            f"Scan smoke failed: expected truth card {truth['cardName']} #{truth['collectorNumber']} was not present in top candidates."
        )
    truth_candidate_id = str(truth_candidate.get("id") or "").strip()
    truth_candidate_rank = truth_candidate.get("rank")
    if not truth_candidate_id:
        raise ReleaseGateError("Scan smoke failed: truth candidate is missing card id.")
    scan_before_quantity = deck_quantity_for(
        deck_entries_after_manual,
        card_id=truth_candidate_id,
        condition_code=condition_code,
    )
    scan_add_response = request_json(
        "POST",
        f"{base_url}/api/v1/deck/entries",
        payload={
            "cardID": truth_candidate_id,
            "slabContext": None,
            "variantName": None,
            "condition": condition_code,
            "quantity": 1,
            "sourceScanID": scan_id,
            "selectionSource": "top" if truth_candidate_rank == 1 else "alternate",
            "selectedRank": truth_candidate_rank,
            "wasTopPrediction": truth_candidate_rank == 1,
            "addedAt": now_iso(),
        },
        headers=auth_headers,
    )
    deck_entries_after_scan = extract_deck_entries(
        request_json("GET", f"{base_url}/api/v1/deck/entries", headers=auth_headers)
    )
    scan_after_quantity = deck_quantity_for(
        deck_entries_after_scan,
        card_id=truth_candidate_id,
        condition_code=condition_code,
    )
    if scan_after_quantity != scan_before_quantity + 1:
        raise ReleaseGateError(
            f"Scan add smoke failed: expected quantity {scan_before_quantity + 1}, got {scan_after_quantity} for card {truth_candidate_id}."
        )
    smoke_summary["scan"] = {
        "scanID": scan_id,
        "candidateCount": len(candidates),
        "matchedCardID": truth_candidate_id,
        "matchedRank": truth_candidate_rank,
        "deckEntryID": scan_add_response.get("deckEntryID"),
        "quantityBefore": scan_before_quantity,
        "quantityAfter": scan_after_quantity,
    }
    return smoke_summary


def write_summary(summary: ReleaseGateSummary, target_dir: Path) -> Path:
    target_dir.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    summary_path = target_dir / f"release-gate-{summary.environment}-{timestamp}.json"
    summary.summary_path = str(summary_path)
    summary_path.write_text(json.dumps(asdict(summary), indent=2), encoding="utf-8")
    return summary_path


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    root = repo_root()
    summary = ReleaseGateSummary(
        environment=args.environment,
        mobile_action=args.mobile_action,
        started_at=now_iso(),
    )
    target_summary_dir = summary_dir_path(args.summary_dir)

    try:
        if not args.skip_check:
            run_subprocess_step(
                summary,
                name="release:check",
                command=["pnpm", "release:check"],
                cwd=root,
            )

        if not args.skip_audit:
            audit_command = ["python3", "tools/audit_release_config.py", "--environment", args.environment]
            if args.backend_secrets_file:
                audit_command.extend(["--backend-secrets-file", args.backend_secrets_file])
            run_subprocess_step(
                summary,
                name=f"release:audit:{args.environment}",
                command=audit_command,
                cwd=root,
            )

        if not args.skip_deploy:
            run_subprocess_step(
                summary,
                name=f"deploy:{args.environment}",
                command=build_deploy_command(args.environment, args.backend_secrets_file),
                cwd=root,
            )

        if not args.skip_smoke:
            smoke_reset_command = build_smoke_reset_command(args.environment)
            if smoke_reset_command is not None and args.smoke_mode == "full":
                run_subprocess_step(
                    summary,
                    name=f"smoke:reset:{args.environment}",
                    command=smoke_reset_command,
                    cwd=root,
                )
            started = time.perf_counter()
            smoke_summary = run_staging_smoke(
                root=root,
                environment=args.environment,
                mobile_env_values=resolve_mobile_env_values_for_gate(root, args.environment, args.mobile_env_file),
                smoke_mode=args.smoke_mode,
                smoke_query_override=args.smoke_query,
                smoke_fixture_override=args.smoke_fixture_dir,
            )
            duration = time.perf_counter() - started
            summary.steps.append(
                CommandStepSummary(
                    name=f"smoke:{args.environment}",
                    status="passed",
                    duration_seconds=round(duration, 2),
                    details=smoke_summary,
                )
            )
            print("\n== smoke passed ==")
            print(json.dumps(smoke_summary, indent=2))

        if args.mobile_action != "none":
            mobile_script = f"mobile:{args.mobile_action}:ios:{args.environment}"
            run_subprocess_step(
                summary,
                name=mobile_script,
                command=build_mobile_command(args.environment, args.mobile_action),
                cwd=root,
            )

        summary.status = "passed"
        return 0
    except ReleaseGateError as error:
        summary.status = "failed"
        print(f"\nRelease gate failed: {error}", file=sys.stderr)
        return 1
    finally:
        summary.finished_at = now_iso()
        summary_path = write_summary(summary, target_summary_dir)
        print(f"\nRelease gate summary: {summary_path}")


if __name__ == "__main__":
    raise SystemExit(main())
