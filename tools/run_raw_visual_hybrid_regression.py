#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def repo_root() -> Path:
    return Path(__file__).resolve().parent.parent


ROOT = repo_root()
BACKEND_ROOT = ROOT / "backend"
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from catalog_tools import build_raw_evidence, finalize_raw_decision, rank_visual_hybrid_candidates, score_raw_signals  # noqa: E402
from raw_visual_matcher import RawVisualMatcher  # noqa: E402


def load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text())


def rate(numerator: int, denominator: int) -> float:
    if denominator <= 0:
        return 0.0
    return numerator / denominator


def fixture_truth_key(truth: dict[str, Any]) -> str:
    card_name = str(truth.get("cardName") or "").strip()
    collector_number = str(truth.get("collectorNumber") or "").strip()
    set_code = str(truth.get("setCode") or "").strip()
    return f"{card_name}|{collector_number}|{set_code}"


def load_provider_truth_map(manifest_path: Path) -> dict[str, dict[str, Any]]:
    manifest = load_json(manifest_path)
    entries = manifest.get("entries") or []
    return {
        str(entry.get("truthKey") or ""): entry
        for entry in entries
        if isinstance(entry, dict) and str(entry.get("truthKey") or "").strip()
    }


def first_pass_text(debug_summary: dict[str, Any], kind: str) -> str:
    for item in debug_summary.get("passSummaries") or []:
        if str(item.get("kind") or "").strip() == kind:
            return str(item.get("text") or "").strip()
    return ""


def whole_card_text(debug_summary: dict[str, Any]) -> str:
    texts: list[str] = []
    seen: set[str] = set()
    for item in debug_summary.get("passSummaries") or []:
        text = str(item.get("text") or "").strip()
        if not text or text in seen:
            continue
        seen.add(text)
        texts.append(text)
    return " ".join(texts)


def build_fixture_payload(fixture_name: str, normalized_image_path: Path, regression_result: dict[str, Any]) -> dict[str, Any]:
    ocr = regression_result.get("ocr") or {}
    debug = regression_result.get("debug") or {}

    raw_evidence: dict[str, Any] = {
        "collectorNumberExact": ocr.get("collectorNumberExact"),
        "collectorNumberPartial": ocr.get("collectorNumberPartial"),
        "setHints": list(ocr.get("setHintTokens") or []),
        "titleTextPrimary": ocr.get("titleTextPrimary"),
        "footerBandText": first_pass_text(debug, "footer_band_wide"),
        "wholeCardText": whole_card_text(debug),
        "titleConfidence": {
            "score": float(ocr.get("titleConfidenceScore") or 0.0),
        },
        "collectorConfidence": {
            "score": float(ocr.get("collectorConfidenceScore") or 0.0),
        },
        "setConfidence": {
            "score": float(ocr.get("setConfidenceScore") or 0.0),
        },
    }
    if ocr.get("promoCodeHint"):
        raw_evidence["promoCodeHint"] = ocr.get("promoCodeHint")

    payload = {
        "scanID": fixture_name,
        "resolverModeHint": "raw_card",
        "normalizedImagePath": str(normalized_image_path),
        "collectorNumber": ocr.get("collectorNumberExact"),
        "setHintTokens": list(ocr.get("setHintTokens") or []),
        "cropConfidence": float(ocr.get("cropConfidence") or 0.0),
        "ocrAnalysis": {
            "rawEvidence": raw_evidence,
            "normalizedTarget": {
                "usedFallback": bool(debug.get("usedFallback") or False),
                "targetQuality": {
                    "overallScore": float(debug.get("targetQualityScore") or 0.0),
                },
            },
        },
    }
    return payload


def visual_candidate_stub(match: Any) -> dict[str, Any]:
    image_url = match.entry.get("imageUrl")
    return {
        "id": str(match.entry.get("providerCardId") or ""),
        "name": str(match.entry.get("name") or ""),
        "titleAliases": list(match.entry.get("titleAliases") or []),
        "setName": str(match.entry.get("setName") or ""),
        "number": str(match.entry.get("collectorNumber") or ""),
        "rarity": "Unknown",
        "variant": "Raw",
        "language": str(match.entry.get("language") or "Unknown"),
        "imageSmallURL": image_url,
        "imageURL": image_url,
        "sourceProvider": str(match.entry.get("sourceProvider") or "scrydex"),
        "sourceRecordID": str(match.entry.get("sourceRecordID") or match.entry.get("providerCardId") or ""),
        "setID": match.entry.get("setId"),
        "setSeries": match.entry.get("setSeries"),
        "setPtcgoCode": match.entry.get("setPtcgoCode"),
        "sourcePayload": match.entry.get("sourcePayload") or {},
        "_visualSimilarity": float(match.similarity),
    }


def summarize_hybrid_match(match: Any) -> dict[str, Any]:
    return {
        "providerCardId": str(match.card.get("id") or ""),
        "name": str(match.card.get("name") or ""),
        "collectorNumber": str(match.card.get("number") or ""),
        "setName": str(match.card.get("setName") or ""),
        "visualScore": round(match.retrieval_score / 100.0, 6),
        "ocrScore": round(match.resolution_score / 100.0, 6),
        "finalScore": round(match.final_total / 100.0, 6),
        "reasons": list(match.reasons),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Run visual-only vs hybrid regression on raw footer fixtures.")
    parser.add_argument(
        "--fixture-root",
        default=str(ROOT / "qa" / "raw-footer-layout-check"),
        help="Path to the raw footer layout fixture root.",
    )
    parser.add_argument(
        "--provider-manifest",
        default=str(ROOT / "qa" / "raw-footer-layout-check" / "provider_reference_manifest.json"),
        help="Path to the provider reference manifest.",
    )
    parser.add_argument(
        "--output",
        default=str(ROOT / "qa" / "raw-footer-layout-check" / "raw_visual_hybrid_regression_scorecard.json"),
        help="Path to write the scorecard JSON.",
    )
    parser.add_argument(
        "--top-k",
        type=int,
        default=10,
        help="How many visual candidates to retrieve before hybrid reranking.",
    )
    args = parser.parse_args()

    fixture_root = Path(args.fixture_root)
    provider_manifest_path = Path(args.provider_manifest)
    output_path = Path(args.output)

    provider_truth_map = load_provider_truth_map(provider_manifest_path)
    matcher = RawVisualMatcher(repo_root=ROOT)

    entries: list[dict[str, Any]] = []
    supported_fixture_count = 0
    unsupported_fixture_count = 0
    visual_top1_pass_count = 0
    visual_top5_contains_truth_count = 0
    visual_top10_contains_truth_count = 0
    hybrid_top1_pass_count = 0
    hybrid_top5_contains_truth_count = 0

    fixture_directories = sorted(
        path
        for path in fixture_root.iterdir()
        if path.is_dir() and not path.name.startswith(".")
    )

    for directory in fixture_directories:
        truth_path = directory / "truth.json"
        normalized_path = directory / "runtime_normalized.jpg"
        regression_path = directory / "raw_ocr_regression_result.json"
        if not truth_path.exists() or not normalized_path.exists() or not regression_path.exists():
            continue

        truth = load_json(truth_path)
        regression_result = load_json(regression_path)
        truth_key = fixture_truth_key(truth)
        provider_mapping = provider_truth_map.get(truth_key)
        if not provider_mapping or not provider_mapping.get("providerSupported"):
            unsupported_fixture_count += 1
            entries.append(
                {
                    "fixtureName": directory.name,
                    "providerSupported": False,
                    "truth": truth,
                    "reason": "No provider-supported mapping was available for this truth key.",
                }
            )
            continue

        supported_fixture_count += 1
        expected_provider_card_id = str(provider_mapping.get("providerCardId") or "")
        payload = build_fixture_payload(directory.name, normalized_path, regression_result)
        evidence = build_raw_evidence(payload)
        signals = score_raw_signals(evidence)
        visual_matches, visual_debug = matcher.match_payload(payload, top_k=args.top_k)
        visual_top_ids = [str(match.entry.get("providerCardId") or "") for match in visual_matches]
        visual_top1_pass = bool(visual_top_ids[:1] and visual_top_ids[0] == expected_provider_card_id)
        visual_top5_contains_truth = expected_provider_card_id in visual_top_ids[:5]
        visual_top10_contains_truth = expected_provider_card_id in visual_top_ids[: args.top_k]

        if visual_top1_pass:
            visual_top1_pass_count += 1
        if visual_top5_contains_truth:
            visual_top5_contains_truth_count += 1
        if visual_top10_contains_truth:
            visual_top10_contains_truth_count += 1

        visual_candidates = [visual_candidate_stub(match) for match in visual_matches]
        ranked_matches, weights = rank_visual_hybrid_candidates(visual_candidates, evidence, signals)
        decision = finalize_raw_decision(ranked_matches, evidence, signals)
        hybrid_top_ids = [str(match.card.get("id") or "") for match in ranked_matches]
        hybrid_top1_pass = bool(hybrid_top_ids[:1] and hybrid_top_ids[0] == expected_provider_card_id)
        hybrid_top5_contains_truth = expected_provider_card_id in hybrid_top_ids[:5]

        if hybrid_top1_pass:
            hybrid_top1_pass_count += 1
        if hybrid_top5_contains_truth:
            hybrid_top5_contains_truth_count += 1

        entries.append(
            {
                "fixtureName": directory.name,
                "providerSupported": True,
                "truth": {
                    **truth,
                    "providerCardId": expected_provider_card_id,
                },
                "ocrEvidence": {
                    "collectorNumberExact": (payload.get("ocrAnalysis") or {}).get("rawEvidence", {}).get("collectorNumberExact"),
                    "collectorNumberPartial": (payload.get("ocrAnalysis") or {}).get("rawEvidence", {}).get("collectorNumberPartial"),
                    "setHintTokens": list((payload.get("ocrAnalysis") or {}).get("rawEvidence", {}).get("setHints") or []),
                    "titleTextPrimary": (payload.get("ocrAnalysis") or {}).get("rawEvidence", {}).get("titleTextPrimary"),
                    "titleConfidenceScore": (payload.get("ocrAnalysis") or {}).get("rawEvidence", {}).get("titleConfidence", {}).get("score"),
                    "collectorConfidenceScore": (payload.get("ocrAnalysis") or {}).get("rawEvidence", {}).get("collectorConfidence", {}).get("score"),
                    "setConfidenceScore": (payload.get("ocrAnalysis") or {}).get("rawEvidence", {}).get("setConfidence", {}).get("score"),
                    "usedFallbackNormalization": (payload.get("ocrAnalysis") or {}).get("normalizedTarget", {}).get("usedFallback"),
                    "targetQualityScore": (((payload.get("ocrAnalysis") or {}).get("normalizedTarget") or {}).get("targetQuality") or {}).get("overallScore"),
                },
                "signals": {
                    "title": signals.title_signal,
                    "collector": signals.collector_signal,
                    "set": signals.set_signal,
                    "footer": signals.footer_signal,
                    "overall": signals.overall_signal,
                },
                "visual": {
                    "top1Pass": visual_top1_pass,
                    "top5ContainsTruth": visual_top5_contains_truth,
                    "top10ContainsTruth": visual_top10_contains_truth,
                    "topCandidates": [
                        {
                            "providerCardId": str(match.entry.get("providerCardId") or ""),
                            "name": str(match.entry.get("name") or ""),
                            "collectorNumber": str(match.entry.get("collectorNumber") or ""),
                            "setName": str(match.entry.get("setName") or ""),
                            "similarity": round(float(match.similarity), 6),
                        }
                        for match in visual_matches[: args.top_k]
                    ],
                    "debug": visual_debug,
                },
                "hybrid": {
                    "top1Pass": hybrid_top1_pass,
                    "top5ContainsTruth": hybrid_top5_contains_truth,
                    "confidence": decision.confidence,
                    "confidencePercent": decision.confidence_percent,
                    "reviewDisposition": decision.review_disposition,
                    "reviewReason": decision.review_reason,
                    "visualWeight": weights["visualWeight"],
                    "ocrWeight": weights["ocrWeight"],
                    "topCandidates": [summarize_hybrid_match(match) for match in ranked_matches[:5]],
                },
            }
        )

    scorecard = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "modelId": matcher.model_id,
        "visualTopK": args.top_k,
        "providerSupportedFixtureCount": supported_fixture_count,
        "providerUnsupportedFixtureCount": unsupported_fixture_count,
        "visualTop1PassCount": visual_top1_pass_count,
        "visualTop5ContainsTruthCount": visual_top5_contains_truth_count,
        "visualTop10ContainsTruthCount": visual_top10_contains_truth_count,
        "hybridTop1PassCount": hybrid_top1_pass_count,
        "hybridTop5ContainsTruthCount": hybrid_top5_contains_truth_count,
        "visualTop1PassRate": rate(visual_top1_pass_count, supported_fixture_count),
        "visualTop5ContainsTruthRate": rate(visual_top5_contains_truth_count, supported_fixture_count),
        "visualTop10ContainsTruthRate": rate(visual_top10_contains_truth_count, supported_fixture_count),
        "hybridTop1PassRate": rate(hybrid_top1_pass_count, supported_fixture_count),
        "hybridTop5ContainsTruthRate": rate(hybrid_top5_contains_truth_count, supported_fixture_count),
        "entries": entries,
    }

    output_path.write_text(json.dumps(scorecard, indent=2))
    print(f"Wrote raw visual hybrid regression scorecard to {output_path}")
    print(f"Provider-supported fixtures: {supported_fixture_count}")
    print(f"Provider-unsupported fixtures: {unsupported_fixture_count}")
    print(f"Visual top-1: {visual_top1_pass_count}/{supported_fixture_count} ({rate(visual_top1_pass_count, supported_fixture_count):.1%})")
    print(f"Visual top-{min(5, args.top_k)} contains truth: {visual_top5_contains_truth_count}/{supported_fixture_count} ({rate(visual_top5_contains_truth_count, supported_fixture_count):.1%})")
    print(f"Visual top-{args.top_k} contains truth: {visual_top10_contains_truth_count}/{supported_fixture_count} ({rate(visual_top10_contains_truth_count, supported_fixture_count):.1%})")
    print(f"Hybrid top-1: {hybrid_top1_pass_count}/{supported_fixture_count} ({rate(hybrid_top1_pass_count, supported_fixture_count):.1%})")
    print(f"Hybrid top-5 contains truth: {hybrid_top5_contains_truth_count}/{supported_fixture_count} ({rate(hybrid_top5_contains_truth_count, supported_fixture_count):.1%})")


if __name__ == "__main__":
    main()
