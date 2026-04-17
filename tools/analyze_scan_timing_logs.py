#!/usr/bin/env python3

import argparse
import ast
import json
import re
import statistics
import sys
from dataclasses import dataclass, field
from typing import Dict, List, Optional


UUID_RE = re.compile(
    r"\b[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\b"
)


@dataclass
class ScanRecord:
    scan_id: str
    used_fallback: Optional[bool] = None
    geometry_kind: Optional[str] = None
    crop_confidence: Optional[float] = None
    target_selection_ms: Optional[float] = None
    tap_to_ocr_start_ms: Optional[float] = None
    ocr_total_ms: Optional[float] = None
    ocr_stage1_broad_ms: Optional[float] = None
    ocr_stage1_tight_ms: Optional[float] = None
    ocr_stage2_ms: Optional[float] = None
    ocr_synthesis_ms: Optional[float] = None
    stage2_skip_wide: Optional[bool] = None
    stage2_candidate_passes: List[str] = field(default_factory=list)
    stage2_executed_passes: List[str] = field(default_factory=list)
    stage2_lowered_ms: Optional[float] = None
    stage2_remaining_ms: Optional[float] = None
    stage2_decision_reasons: List[str] = field(default_factory=list)
    title_primary: Optional[str] = None
    collector_exact: Optional[str] = None
    collector_partial: Optional[str] = None
    visual_roundtrip_ms: Optional[float] = None
    visual_server_ms: Optional[float] = None
    visual_transport_ms: Optional[float] = None
    wait_after_ocr_ms: Optional[float] = None
    resolution_roundtrip_ms: Optional[float] = None
    resolution_server_ms: Optional[float] = None
    resolution_transport_ms: Optional[float] = None
    backend_match_completed_ms: Optional[float] = None
    visual_phase_available: Optional[bool] = None

    def approx_total_ms(self) -> Optional[float]:
        parts = [
            self.tap_to_ocr_start_ms,
            self.ocr_total_ms,
            self.backend_match_completed_ms,
        ]
        if all(part is not None for part in parts):
            return sum(parts)  # type: ignore[arg-type]
        if self.tap_to_ocr_start_ms is not None and self.ocr_total_ms is not None:
            trailing = 0.0
            if self.wait_after_ocr_ms is not None:
                trailing += self.wait_after_ocr_ms
            if self.resolution_roundtrip_ms is not None:
                trailing += self.resolution_roundtrip_ms
            return self.tap_to_ocr_start_ms + self.ocr_total_ms + trailing
        return None

    def context_bucket(self) -> str:
        if self.used_fallback:
            if self.stage2_candidate_passes and "12_raw_header_wide_lowered" in self.stage2_candidate_passes:
                if self.stage2_skip_wide is True:
                    return "fallback_skip"
                if self.stage2_skip_wide is False:
                    return "fallback_full_wide"
            return "fallback_other"
        return "normal"

    def dominant_bottleneck(self) -> str:
        sequential = {
            "pre_ocr_start": self.tap_to_ocr_start_ms or 0.0,
            "ocr_total": self.ocr_total_ms or 0.0,
            "visual_wait_after_ocr": self.wait_after_ocr_ms or 0.0,
            "rerank_roundtrip": self.resolution_roundtrip_ms or 0.0,
        }
        primary = max(sequential, key=sequential.get)

        if primary == "ocr_total":
            ocr_parts = {
                "ocr_stage1_broad": self.ocr_stage1_broad_ms or 0.0,
                "ocr_stage1_tight": self.ocr_stage1_tight_ms or 0.0,
                "ocr_stage2_wide": self._stage2_wide_ms(),
                "ocr_stage2_lowered": self._stage2_lowered_only_ms(),
                "ocr_synthesis": self.ocr_synthesis_ms or 0.0,
            }
            return max(ocr_parts, key=ocr_parts.get)

        if primary == "rerank_roundtrip":
            if (self.resolution_server_ms or 0.0) >= (self.resolution_transport_ms or 0.0):
                return "rerank_backend"
            return "rerank_transport"

        return primary

    def summary_bucket(self) -> str:
        return f"{self.context_bucket()}:{self.dominant_bottleneck()}"

    def _stage2_wide_ms(self) -> float:
        if "12_raw_header_wide" in self.stage2_executed_passes:
            return self.stage2_remaining_ms or self.ocr_stage2_ms or 0.0
        if self.stage2_candidate_passes == ["12_raw_header_wide"]:
            return self.ocr_stage2_ms or 0.0
        return 0.0

    def _stage2_lowered_only_ms(self) -> float:
        if (
            self.stage2_skip_wide is True
            and self.stage2_executed_passes == ["12_raw_header_wide_lowered"]
        ):
            return self.stage2_lowered_ms or self.ocr_stage2_ms or 0.0
        return 0.0


def get_record(records: Dict[str, ScanRecord], scan_id: str) -> ScanRecord:
    if scan_id not in records:
        records[scan_id] = ScanRecord(scan_id=scan_id)
    return records[scan_id]


def extract_scan_id_from_line(line: str) -> Optional[str]:
    explicit_patterns = [
        r"scanID=([0-9A-Fa-f-]{36})",
        r"scan=([0-9A-Fa-f-]{36})",
        r"ScanDebugExports/([0-9A-Fa-f-]{36})",
    ]
    for pattern in explicit_patterns:
        match = re.search(pattern, line)
        if match:
            return match.group(1)
    return None


def parse_list_field(value: str) -> List[str]:
    try:
        parsed = ast.literal_eval(value)
        if isinstance(parsed, list):
            return [str(item) for item in parsed]
    except (SyntaxError, ValueError):
        pass
    return []


def parse_ocr_perf_line(line: str, record: ScanRecord) -> None:
    for key, attr in [
        ("targetSelectionMs", "target_selection_ms"),
        ("stage1BroadMs", "ocr_stage1_broad_ms"),
        ("stage1TightMs", "ocr_stage1_tight_ms"),
        ("stage2Ms", "ocr_stage2_ms"),
        ("synthesisMs", "ocr_synthesis_ms"),
        ("totalMs", "ocr_total_ms"),
    ]:
        match = re.search(rf"{key}=([0-9.]+)", line)
        if match:
            setattr(record, attr, float(match.group(1)))

    skip_match = re.search(r"stage2SkipWideHeader=(yes|no|n/a)", line)
    if skip_match:
        record.stage2_skip_wide = {
            "yes": True,
            "no": False,
            "n/a": None,
        }[skip_match.group(1)]

    for key, attr in [
        ("stage2CandidatePasses", "stage2_candidate_passes"),
        ("stage2ExecutedPasses", "stage2_executed_passes"),
    ]:
        match = re.search(rf"{key}=(\[[^\]]*\])", line)
        if match:
            setattr(record, attr, parse_list_field(match.group(1)))

    for key, attr in [
        ("stage2LoweredMs", "stage2_lowered_ms"),
        ("stage2RemainingMs", "stage2_remaining_ms"),
    ]:
        match = re.search(rf"{key}=([0-9.]+|n/a)", line)
        if match and match.group(1) != "n/a":
            setattr(record, attr, float(match.group(1)))


def parse_match_split_line(line: str, record: ScanRecord) -> None:
    mapping = {
        "waitAfterOCRMs": "wait_after_ocr_ms",
        "visualRoundTripMs": "visual_roundtrip_ms",
        "visualServerMs": "visual_server_ms",
        "visualTransportMs": "visual_transport_ms",
        "resolutionRoundTripMs": "resolution_roundtrip_ms",
        "resolutionServerMs": "resolution_server_ms",
        "resolutionTransportMs": "resolution_transport_ms",
    }
    for key, attr in mapping.items():
        match = re.search(rf"{key}=([0-9.]+)", line)
        if match:
            setattr(record, attr, float(match.group(1)))


def parse_gate_line(line: str, record: ScanRecord) -> None:
    skip_match = re.search(r"skipWideHeader=(yes|no)", line)
    if skip_match:
        record.stage2_skip_wide = skip_match.group(1) == "yes"

    reason_match = re.search(r"reasons=(\[[^\]]*\])", line)
    if reason_match:
        record.stage2_decision_reasons = parse_list_field(reason_match.group(1))

    title_match = re.search(r'title="([^"]*)"', line)
    if title_match:
        record.title_primary = title_match.group(1)

    collector_match = re.search(r'collectorExact="([^"]*)"', line)
    if collector_match:
        record.collector_exact = collector_match.group(1) or None

    for key, attr in [
        ("candidatePasses", "stage2_candidate_passes"),
        ("executedPasses", "stage2_executed_passes"),
    ]:
        match = re.search(rf"{key}=(\[[^\]]*\])", line)
        if match:
            setattr(record, attr, parse_list_field(match.group(1)))

    for key, attr in [
        ("loweredMs", "stage2_lowered_ms"),
        ("remainingMs", "stage2_remaining_ms"),
    ]:
        match = re.search(rf"{key}=([0-9.]+|n/a)", line)
        if match and match.group(1) != "n/a":
            setattr(record, attr, float(match.group(1)))


def parse_json_line(obj: dict, record: ScanRecord) -> None:
    event = obj.get("event")
    if event == "scan_match_request":
        if obj.get("normalizedGeometryKind"):
            record.geometry_kind = obj.get("normalizedGeometryKind")
        if obj.get("normalizedUsedFallback") is not None:
            record.used_fallback = obj.get("normalizedUsedFallback")
        if obj.get("cropConfidence") is not None:
            record.crop_confidence = float(obj["cropConfidence"])
        raw_evidence = obj.get("rawEvidence") or {}
        if raw_evidence.get("titleTextPrimary"):
            record.title_primary = raw_evidence["titleTextPrimary"]
        if raw_evidence.get("collectorNumberExact"):
            record.collector_exact = raw_evidence["collectorNumberExact"]
        if raw_evidence.get("collectorNumberPartial"):
            record.collector_partial = raw_evidence["collectorNumberPartial"]
    elif event == "scan_match":
        if obj.get("cropConfidence") is not None:
            record.crop_confidence = float(obj["cropConfidence"])


def render(records: List[ScanRecord]) -> str:
    lines: List[str] = []
    approx_totals = [record.approx_total_ms() for record in records if record.approx_total_ms() is not None]
    ocr_totals = [record.ocr_total_ms for record in records if record.ocr_total_ms is not None]
    rerank_roundtrips = [
        record.resolution_roundtrip_ms
        for record in records
        if record.resolution_roundtrip_ms is not None
    ]

    if approx_totals:
        lines.append(f"Scans: {len(records)}")
        lines.append(f"Average approx total: {statistics.mean(approx_totals):.1f}ms")
    else:
        lines.append(f"Scans: {len(records)}")
        lines.append("Average approx total: n/a")

    if ocr_totals:
        lines.append(f"Average OCR total: {statistics.mean(ocr_totals):.1f}ms")
    if rerank_roundtrips:
        lines.append(f"Average rerank round-trip: {statistics.mean(rerank_roundtrips):.1f}ms")

    bucket_counts: Dict[str, int] = {}
    for record in records:
        bucket_counts[record.summary_bucket()] = bucket_counts.get(record.summary_bucket(), 0) + 1

    lines.append("")
    lines.append("Buckets:")
    for bucket, count in sorted(bucket_counts.items()):
        lines.append(f"- {bucket}: {count}")

    lines.append("")
    lines.append(
        "scan_id | context | bottleneck | approx_total_ms | ocr_ms | stage2_ms | gate | visual_rt | rerank_rt | notes"
    )
    lines.append("--- | --- | --- | ---: | ---: | ---: | --- | ---: | ---: | ---")

    for record in records:
        notes: List[str] = []
        if record.stage2_decision_reasons:
            notes.append(",".join(record.stage2_decision_reasons))
        if record.title_primary:
            notes.append(f"title={record.title_primary}")
        lines.append(
            " | ".join(
                [
                    record.scan_id,
                    record.context_bucket(),
                    record.dominant_bottleneck(),
                    format_ms(record.approx_total_ms()),
                    format_ms(record.ocr_total_ms),
                    format_ms(record.ocr_stage2_ms),
                    gate_label(record),
                    format_ms(record.visual_roundtrip_ms),
                    format_ms(record.resolution_roundtrip_ms),
                    "; ".join(notes) or "-",
                ]
            )
        )
    return "\n".join(lines)


def gate_label(record: ScanRecord) -> str:
    if record.stage2_skip_wide is True:
        return "skip"
    if record.stage2_skip_wide is False:
        return "ran"
    return "n/a"


def format_ms(value: Optional[float]) -> str:
    if value is None:
        return "n/a"
    return f"{value:.1f}"


def main() -> int:
    parser = argparse.ArgumentParser(description="Analyze Spotlight scan timing logs.")
    parser.add_argument("paths", nargs="*", help="Optional log file paths. Reads stdin if omitted.")
    args = parser.parse_args()

    if args.paths:
        chunks = []
        for path in args.paths:
            with open(path, "r", encoding="utf-8") as handle:
                chunks.append(handle.read())
        text = "\n".join(chunks)
    else:
        text = sys.stdin.read()

    records: Dict[str, ScanRecord] = {}
    active_scan_id: Optional[str] = None

    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line:
            continue

        if line.startswith("{") and '"scanID"' in line:
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                obj = None
            if obj:
                scan_id = obj.get("scanID")
                if scan_id:
                    active_scan_id = scan_id
                    parse_json_line(obj, get_record(records, scan_id))
                continue

        scan_id = extract_scan_id_from_line(line)
        if scan_id:
            active_scan_id = scan_id

        if not active_scan_id:
            continue

        record = get_record(records, active_scan_id)

        if "Starting visual phase:" in line:
            match = re.search(r"targetSelectionMs=([0-9.]+)", line)
            if match:
                record.target_selection_ms = float(match.group(1))
            crop_match = re.search(r"crop=([0-9.]+)", line)
            if crop_match:
                record.crop_confidence = float(crop_match.group(1))

        if "Tap to OCR start:" in line:
            match = re.search(r"Tap to OCR start: ([0-9.]+)ms", line)
            if match:
                record.tap_to_ocr_start_ms = float(match.group(1))

        if "Vision analysis completed in" in line:
            match = re.search(r"Vision analysis completed in ([0-9.]+)ms", line)
            if match:
                record.ocr_total_ms = float(match.group(1))

        if "Backend match completed in" in line:
            match = re.search(r"Backend match completed in ([0-9.]+)ms", line)
            if match:
                record.backend_match_completed_ms = float(match.group(1))

        if "[OCR GATE]" in line:
            parse_gate_line(line, record)

        if "[OCR PERF]" in line and "targetSelectionMs=" in line:
            parse_ocr_perf_line(line, record)

        if "[OCR PERF] stage2DecisionReasons=" in line:
            reason_match = re.search(r"stage2DecisionReasons=(\[[^\]]*\])", line)
            if reason_match:
                record.stage2_decision_reasons = parse_list_field(reason_match.group(1))

        if "[MATCH] Split timings:" in line:
            parse_match_split_line(line, record)

        if "[MATCH] Visual phase outcome:" in line:
            duration_match = re.search(r"durationMs=([0-9.]+)", line)
            if duration_match:
                record.visual_roundtrip_ms = float(duration_match.group(1))
            available_match = re.search(r"available=(yes|no)", line)
            if available_match:
                record.visual_phase_available = available_match.group(1) == "yes"

        if "[OCR] Target:" in line:
            geometry_match = re.search(r"geometry=([A-Za-z_]+)", line)
            if geometry_match:
                record.geometry_kind = geometry_match.group(1)
            fallback_match = re.search(r"fallback=(yes|no)", line)
            if fallback_match:
                record.used_fallback = fallback_match.group(1) == "yes"

        if "[OCR] Raw evidence:" in line:
            title_match = re.search(r'title="([^"]*)"', line)
            if title_match:
                record.title_primary = title_match.group(1)
            exact_match = re.search(r'collectorExact="([^"]*)"', line)
            if exact_match:
                record.collector_exact = exact_match.group(1) or None
            partial_match = re.search(r'collectorPartial="([^"]*)"', line)
            if partial_match:
                record.collector_partial = partial_match.group(1) or None

    if not records:
        print("No scan records found.", file=sys.stderr)
        return 1

    ordered = sorted(records.values(), key=lambda record: record.scan_id)
    print(render(ordered))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
