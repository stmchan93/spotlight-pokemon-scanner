#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Bucket repeated raw scan attempts by likely failure mode using backend structured logs "
            "and optional frontend ScanDebugExports artifacts."
        )
    )
    parser.add_argument(
        "--backend-log",
        type=Path,
        required=True,
        help="Path to a backend stdout/stderr log file containing structured JSON scan events.",
    )
    parser.add_argument(
        "--scan-debug-root",
        type=Path,
        default=None,
        help="Optional path to iOS ScanDebugExports root (contains per-scan UUID folders).",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("scan_retry_triage_summary.json"),
        help="Where to write the triage summary JSON.",
    )
    parser.add_argument(
        "--group-window-seconds",
        type=int,
        default=180,
        help="Max time gap for grouping repeated attempts of the same card-like fingerprint.",
    )
    return parser.parse_args()


def parse_iso8601(value: str | None) -> datetime | None:
    if not value:
        return None
    text = value.strip()
    if not text:
        return None
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        return datetime.fromisoformat(text)
    except ValueError:
        return None


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def load_json(path: Path) -> dict[str, Any] | None:
    try:
        payload = json.loads(path.read_text())
    except Exception:
        return None
    return payload if isinstance(payload, dict) else None


def slug(value: str) -> str:
    value = value.strip().lower()
    value = re.sub(r"[^a-z0-9]+", "-", value)
    return value.strip("-")


def first_non_empty(*values: Any) -> str | None:
    for value in values:
        text = str(value or "").strip()
        if text:
            return text
    return None


@dataclass
class ScanTriageRecord:
    scan_id: str
    captured_at: datetime | None
    request_event: dict[str, Any] | None
    resolution_event: dict[str, Any] | None
    response_event: dict[str, Any] | None
    error_event: dict[str, Any] | None
    frontend_request: dict[str, Any] | None
    frontend_response: dict[str, Any] | None
    frontend_error: dict[str, Any] | None
    frontend_ocr_summary: dict[str, Any] | None
    selection_manifest: dict[str, Any] | None
    artifact_dir: Path | None

    def best_candidate_id(self) -> str | None:
        response = self.response_event or {}
        top_candidate = response.get("topCandidate") or {}
        return first_non_empty(
            top_candidate.get("id"),
            ((self.frontend_response or {}).get("topCandidates") or [{}])[0].get("id")
            if (self.frontend_response or {}).get("topCandidates")
            else None,
        )

    def fingerprint(self) -> str:
        request = self.request_event or {}
        frontend_request = self.frontend_request or {}
        frontend_ocr = self.frontend_ocr_summary or {}
        raw_evidence = (request.get("rawEvidence") or {}) if isinstance(request, dict) else {}
        collector = first_non_empty(
            request.get("collectorNumber"),
            frontend_request.get("collectorNumber"),
            frontend_ocr.get("collectorNumber"),
            raw_evidence.get("collectorNumberExact"),
            raw_evidence.get("collectorNumberPartial"),
        )
        set_hints = (
            request.get("setHintTokens")
            or frontend_request.get("setHintTokens")
            or frontend_ocr.get("setHintTokens")
            or raw_evidence.get("setHints")
            or []
        )
        if isinstance(set_hints, list):
            set_hint = first_non_empty(*set_hints)
        else:
            set_hint = first_non_empty(set_hints)
        title = first_non_empty(
            frontend_request.get("titleTextPrimary"),
            ((frontend_ocr.get("rawEvidence") or {}) if isinstance(frontend_ocr, dict) else {}).get("titleTextPrimary"),
            raw_evidence.get("titleTextPrimary"),
            raw_evidence.get("titleTextSecondary"),
        )
        candidate = self.best_candidate_id()
        if collector and set_hint:
            return f"collector:{collector.lower()}|set:{set_hint.lower()}"
        if collector and title:
            return f"collector:{collector.lower()}|title:{slug(title)}"
        if title and set_hint:
            return f"title:{slug(title)}|set:{set_hint.lower()}"
        if candidate:
            return f"candidate:{candidate.lower()}"
        return f"scan:{self.scan_id.lower()}"

    def derived_summary(self) -> dict[str, Any]:
        request = self.request_event or {}
        response = self.response_event or {}
        resolution = self.resolution_event or {}
        frontend_ocr = self.frontend_ocr_summary or {}
        frontend_response = self.frontend_response or {}
        frontend_request = self.frontend_request or {}
        selection = self.selection_manifest or {}

        raw_request = request.get("rawEvidence") or {}
        raw_frontend = frontend_ocr.get("rawEvidence") or {}
        warnings = list(request.get("warnings") or []) + list(frontend_request.get("warnings") or []) + list(frontend_ocr.get("warnings") or [])
        ambiguity_flags = list(response.get("ambiguityFlags") or []) + list(frontend_response.get("ambiguityFlags") or [])
        top_matches = list(resolution.get("topMatches") or [])
        top1 = top_matches[0] if top_matches else {}
        top2 = top_matches[1] if len(top_matches) > 1 else {}
        top1_final = float(top1.get("finalScore") or 0.0)
        top2_final = float(top2.get("finalScore") or 0.0)
        final_margin = top1_final - top2_final

        target_quality = frontend_ocr.get("targetQualityScore")
        used_fallback = frontend_ocr.get("usedFallback")
        if used_fallback is None:
            used_fallback = bool(selection.get("fallbackReason"))
        should_retry_still = bool(frontend_ocr.get("shouldRetryWithStillPhoto") or False)
        collector = first_non_empty(
            request.get("collectorNumber"),
            frontend_request.get("collectorNumber"),
            frontend_ocr.get("collectorNumber"),
            raw_request.get("collectorNumberExact"),
            raw_frontend.get("collectorNumberExact"),
            raw_request.get("collectorNumberPartial"),
            raw_frontend.get("collectorNumberPartial"),
        )
        title = first_non_empty(
            raw_request.get("titleTextPrimary"),
            raw_frontend.get("titleTextPrimary"),
            frontend_request.get("titleTextPrimary"),
        )
        set_hints = request.get("setHintTokens") or frontend_request.get("setHintTokens") or frontend_ocr.get("setHintTokens") or []
        overall_signal = float(((resolution.get("signals") or {}).get("overall")) or 0.0)

        buckets: list[str] = []
        if self.error_event or self.frontend_error:
            buckets.append("backend_error")
        if used_fallback:
            buckets.append("frontend_fallback_crop")
        if target_quality is not None and float(target_quality) < 0.78:
            buckets.append("frontend_low_target_quality")
        if should_retry_still:
            buckets.append("frontend_still_photo_recommended")
        if not collector:
            buckets.append("ocr_missing_collector")
        if not title:
            buckets.append("ocr_missing_title")
        if not set_hints:
            buckets.append("ocr_missing_set_hint")
        if overall_signal <= 0.0:
            buckets.append("no_usable_ocr_signal")
        if final_margin < 8.0 and len(top_matches) >= 2:
            buckets.append("backend_shortlist_ambiguous")
        if any("Top matches are close together" in flag for flag in ambiguity_flags):
            buckets.append("backend_shortlist_ambiguous")
        if any("Footer collector OCR is weak" in flag for flag in ambiguity_flags):
            buckets.append("ocr_footer_weak")
        if any("Set hints are weak" in flag for flag in ambiguity_flags):
            buckets.append("ocr_set_weak")
        if response.get("reviewDisposition") == "unsupported":
            buckets.append("unsupported_result")
        if response.get("reviewDisposition") == "needs_review":
            buckets.append("review_required")

        bucket_order = [
            "backend_error",
            "frontend_low_target_quality",
            "frontend_fallback_crop",
            "frontend_still_photo_recommended",
            "no_usable_ocr_signal",
            "ocr_missing_collector",
            "ocr_missing_title",
            "ocr_missing_set_hint",
            "ocr_footer_weak",
            "ocr_set_weak",
            "backend_shortlist_ambiguous",
            "review_required",
            "unsupported_result",
        ]
        dominant_bucket = next((bucket for bucket in bucket_order if bucket in buckets), "clean_or_unclear")

        return {
            "scanID": self.scan_id,
            "capturedAt": self.captured_at.isoformat().replace("+00:00", "Z") if self.captured_at else None,
            "fingerprint": self.fingerprint(),
            "artifactDir": str(self.artifact_dir) if self.artifact_dir else None,
            "bestCandidateID": self.best_candidate_id(),
            "confidence": response.get("confidence") or frontend_response.get("confidence"),
            "reviewDisposition": response.get("reviewDisposition") or frontend_response.get("reviewDisposition"),
            "resolverPath": response.get("resolverPath") or frontend_response.get("resolverPath"),
            "collectorNumber": collector,
            "setHintTokens": list(set_hints) if isinstance(set_hints, list) else [str(set_hints)],
            "titleTextPrimary": title,
            "targetQualityScore": target_quality,
            "usedFallback": bool(used_fallback),
            "shouldRetryWithStillPhoto": should_retry_still,
            "overallSignal": overall_signal,
            "ambiguityFlags": ambiguity_flags,
            "warnings": warnings,
            "top1FinalScore": top1_final if top_matches else None,
            "top2FinalScore": top2_final if len(top_matches) >= 2 else None,
            "top1Top2Margin": final_margin if len(top_matches) >= 2 else None,
            "backendErrorType": (self.error_event or self.frontend_error or {}).get("errorType"),
            "backendErrorText": (self.error_event or self.frontend_error or {}).get("errorText")
            or (self.frontend_error or {}).get("message"),
            "buckets": sorted(set(buckets)),
            "dominantBucket": dominant_bucket,
        }


def parse_backend_events(path: Path) -> dict[str, dict[str, Any]]:
    scan_events: dict[str, dict[str, Any]] = defaultdict(dict)
    for raw_line in path.read_text(errors="replace").splitlines():
        line = raw_line.strip()
        if not line.startswith("{") or not line.endswith("}"):
            continue
        try:
            payload = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(payload, dict):
            continue
        scan_id = str(payload.get("scanID") or "").strip()
        if not scan_id:
            continue
        event = str(payload.get("event") or "").strip()
        entry = scan_events[scan_id]
        if event == "scan_match_request":
            entry["request_event"] = payload
        elif event == "scan_match_raw_resolution":
            entry["resolution_event"] = payload
        elif event == "scan_match":
            entry["response_event"] = payload
        elif event == "scan_match_error":
            entry["error_event"] = payload
    return scan_events


def parse_frontend_artifacts(root: Path | None) -> dict[str, dict[str, Any]]:
    if root is None or not root.exists():
        return {}
    output: dict[str, dict[str, Any]] = {}
    for directory in sorted(root.iterdir()):
        if not directory.is_dir():
            continue
        scan_id = directory.name.strip()
        output[scan_id] = {
            "artifact_dir": directory,
            "frontend_request": unwrap_payload(load_json(directory / "frontend_backend_request.json")),
            "frontend_response": unwrap_payload(load_json(directory / "frontend_backend_response.json")),
            "frontend_error": unwrap_payload(load_json(directory / "frontend_backend_error.json")),
            "frontend_ocr_summary": unwrap_payload(load_json(directory / "frontend_ocr_summary.json")),
            "selection_manifest": load_json(directory / "selection_manifest.json"),
        }
    return output


def unwrap_payload(payload: dict[str, Any] | None) -> dict[str, Any] | None:
    if not payload:
        return None
    inner = payload.get("payload")
    return inner if isinstance(inner, dict) else payload


def build_records(
    backend_events: dict[str, dict[str, Any]],
    frontend_artifacts: dict[str, dict[str, Any]],
) -> list[ScanTriageRecord]:
    scan_ids = sorted(set(backend_events) | set(frontend_artifacts))
    records: list[ScanTriageRecord] = []
    for scan_id in scan_ids:
        backend = backend_events.get(scan_id, {})
        frontend = frontend_artifacts.get(scan_id, {})
        captured_at = None
        for payload in (
            backend.get("request_event"),
            backend.get("response_event"),
            frontend.get("frontend_request"),
            frontend.get("frontend_response"),
        ):
            if isinstance(payload, dict):
                captured_at = parse_iso8601(str(payload.get("capturedAt") or ""))
                if captured_at is not None:
                    break
        records.append(
            ScanTriageRecord(
                scan_id=scan_id,
                captured_at=captured_at,
                request_event=backend.get("request_event"),
                resolution_event=backend.get("resolution_event"),
                response_event=backend.get("response_event"),
                error_event=backend.get("error_event"),
                frontend_request=frontend.get("frontend_request"),
                frontend_response=frontend.get("frontend_response"),
                frontend_error=frontend.get("frontend_error"),
                frontend_ocr_summary=frontend.get("frontend_ocr_summary"),
                selection_manifest=frontend.get("selection_manifest"),
                artifact_dir=frontend.get("artifact_dir"),
            )
        )
    records.sort(key=lambda item: item.captured_at or datetime.min.replace(tzinfo=timezone.utc))
    return records


def build_attempt_groups(records: list[ScanTriageRecord], *, window_seconds: int) -> list[dict[str, Any]]:
    groups: list[dict[str, Any]] = []
    active_by_fingerprint: dict[str, dict[str, Any]] = {}

    for record in records:
        summary = record.derived_summary()
        fingerprint = summary["fingerprint"]
        captured_at = record.captured_at
        existing = active_by_fingerprint.get(fingerprint)
        if (
            existing is None
            or captured_at is None
            or existing["lastCapturedAt"] is None
            or (captured_at - existing["lastCapturedAt"]).total_seconds() > window_seconds
        ):
            existing = {
                "fingerprint": fingerprint,
                "attempts": [],
                "lastCapturedAt": captured_at,
            }
            groups.append(existing)
            active_by_fingerprint[fingerprint] = existing
        existing["attempts"].append(summary)
        existing["lastCapturedAt"] = captured_at

    output_groups: list[dict[str, Any]] = []
    for group in groups:
        attempts = group["attempts"]
        counter = Counter(bucket for attempt in attempts for bucket in attempt["buckets"])
        best_candidates = [attempt["bestCandidateID"] for attempt in attempts if attempt.get("bestCandidateID")]
        confidences = [attempt["confidence"] for attempt in attempts if attempt.get("confidence")]
        output_groups.append(
            {
                "fingerprint": group["fingerprint"],
                "attemptCount": len(attempts),
                "scanIDs": [attempt["scanID"] for attempt in attempts],
                "collectorNumbers": sorted({attempt["collectorNumber"] for attempt in attempts if attempt.get("collectorNumber")}),
                "bestCandidateIDs": best_candidates,
                "confidenceSequence": confidences,
                "dominantBuckets": [name for name, _ in counter.most_common(5)],
                "bucketCounts": dict(counter),
                "retryLikelyHelped": len(best_candidates) >= 2 and len(set(best_candidates)) > 1,
                "attempts": attempts,
            }
        )
    return output_groups


def build_summary(records: list[ScanTriageRecord], groups: list[dict[str, Any]]) -> dict[str, Any]:
    summaries = [record.derived_summary() for record in records]
    bucket_counter = Counter(bucket for summary in summaries for bucket in summary["buckets"])
    dominant_counter = Counter(summary["dominantBucket"] for summary in summaries)
    retry_groups = [group for group in groups if group["attemptCount"] >= 2]
    return {
        "generatedAt": utc_now_iso(),
        "scanCount": len(records),
        "groupCount": len(groups),
        "retryGroupCount": len(retry_groups),
        "bucketCounts": dict(bucket_counter),
        "dominantBucketCounts": dict(dominant_counter),
        "topRetryGroups": retry_groups[:20],
        "scans": summaries,
    }


def print_console_summary(summary: dict[str, Any]) -> None:
    print(f"Scans: {summary['scanCount']}")
    print(f"Groups: {summary['groupCount']}")
    print(f"Retry groups: {summary['retryGroupCount']}")
    print("Top dominant buckets:")
    for name, count in sorted(summary["dominantBucketCounts"].items(), key=lambda item: (-item[1], item[0])):
        print(f"  - {name}: {count}")
    print("Top raw buckets:")
    for name, count in sorted(summary["bucketCounts"].items(), key=lambda item: (-item[1], item[0]))[:10]:
        print(f"  - {name}: {count}")
    print("Retry groups needing inspection:")
    for group in summary["topRetryGroups"][:10]:
        print(
            "  - "
            f"{group['fingerprint']} "
            f"attempts={group['attemptCount']} "
            f"buckets={group['dominantBuckets'][:3]} "
            f"candidates={group['bestCandidateIDs'][:3]}"
        )


def main() -> int:
    args = parse_args()
    backend_events = parse_backend_events(args.backend_log.resolve())
    frontend_artifacts = parse_frontend_artifacts(args.scan_debug_root.resolve() if args.scan_debug_root else None)
    records = build_records(backend_events, frontend_artifacts)
    groups = build_attempt_groups(records, window_seconds=args.group_window_seconds)
    summary = build_summary(records, groups)
    output_path = args.output.resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(summary, indent=2) + "\n")
    print(f"Wrote triage summary to {output_path}")
    print_console_summary(summary)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
