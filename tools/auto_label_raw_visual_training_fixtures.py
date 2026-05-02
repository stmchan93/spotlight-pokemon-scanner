#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
import sys
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from raw_visual_dataset_paths import (
    default_raw_visual_train_auto_label_summary_path,
    default_raw_visual_train_root,
)


def repo_root() -> Path:
    return Path(__file__).resolve().parent.parent


ROOT = repo_root()
BACKEND_ROOT = ROOT / "backend"
if not (BACKEND_ROOT / "server.py").exists():
    BACKEND_ROOT = ROOT
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from catalog_tools import build_raw_evidence, finalize_raw_decision, rank_visual_hybrid_candidates, score_raw_signals  # noqa: E402
from raw_visual_matcher import RawVisualMatcher  # noqa: E402


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text())


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n")


def normalize_token(value: str | None) -> str:
    return re.sub(r"[^a-z0-9]+", "", str(value or "").lower())


def truth_key(card_name: str, collector_number: str, set_code: str | None) -> str:
    return f"{card_name.strip()}|{collector_number.strip()}|{(set_code or '').strip()}"


def whole_card_text(runtime_summary: dict[str, Any]) -> str:
    seen: set[str] = set()
    texts: list[str] = []
    for pass_summary in runtime_summary.get("passSummaries") or []:
        text = str(pass_summary.get("text") or "").strip()
        if not text or text in seen:
            continue
        seen.add(text)
        texts.append(text)
    return " ".join(texts)


def build_payload(fixture_name: str, normalized_image_path: Path, runtime_summary: dict[str, Any]) -> dict[str, Any]:
    raw_evidence = {
        "collectorNumberExact": runtime_summary.get("collectorNumber"),
        "collectorNumberPartial": None,
        "setHints": list(runtime_summary.get("setHintTokens") or []),
        "titleTextPrimary": runtime_summary.get("titleTextPrimary"),
        "footerBandText": next(
            (
                str(pass_summary.get("text") or "").strip()
                for pass_summary in runtime_summary.get("passSummaries") or []
                if str(pass_summary.get("kind") or "").strip() == "footer_band_wide"
            ),
            "",
        ),
        "wholeCardText": whole_card_text(runtime_summary),
        "titleConfidence": {
            "score": float(runtime_summary.get("titleConfidenceScore") or 0.0),
        },
        "collectorConfidence": {
            "score": float(runtime_summary.get("collectorConfidenceScore") or 0.0),
        },
        "setConfidence": {
            "score": float(runtime_summary.get("setConfidenceScore") or 0.0),
        },
    }

    return {
        "scanID": fixture_name,
        "resolverModeHint": "raw_card",
        "normalizedImagePath": str(normalized_image_path),
        "collectorNumber": runtime_summary.get("collectorNumber"),
        "setHintTokens": list(runtime_summary.get("setHintTokens") or []),
        "ocrAnalysis": {
            "rawEvidence": raw_evidence,
            "normalizedTarget": {
                "usedFallback": bool(runtime_summary.get("ocrUsedFallback") or False),
                "targetQuality": {
                    "overallScore": float(runtime_summary.get("ocrTargetQualityScore") or 0.0),
                },
            },
        },
    }


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


def slugify_card_name(value: str) -> str:
    value = value.lower().replace("&", " and ")
    value = value.replace("'", "")
    value = re.sub(r"[^a-z0-9]+", "-", value)
    return re.sub(r"-{2,}", "-", value).strip("-")


def collector_slug(value: str) -> str:
    cleaned = value.lower().replace("/", "-")
    cleaned = re.sub(r"[^a-z0-9-]+", "-", cleaned)
    return re.sub(r"-{2,}", "-", cleaned).strip("-")


def preferred_set_code(card: dict[str, Any]) -> str | None:
    set_code = str(card.get("setPtcgoCode") or "").strip()
    if set_code:
        return set_code
    set_id = str(card.get("setID") or "").strip()
    return set_id or None


def fixture_truth_payload(card: dict[str, Any]) -> dict[str, Any]:
    set_code = preferred_set_code(card)
    return {
        "cardName": str(card.get("name") or "").strip(),
        "collectorNumber": str(card.get("number") or "").strip(),
        "setCode": set_code,
    }


def load_truth_keys_from_truths(root: Path) -> set[str]:
    keys: set[str] = set()
    if not root.exists():
        return keys
    for truth_path in root.rglob("truth.json"):
        data = load_json(truth_path)
        keys.add(
            truth_key(
                str(data.get("cardName") or ""),
                str(data.get("collectorNumber") or ""),
                str(data.get("setCode") or "") if data.get("setCode") is not None else None,
            )
        )
    return keys


def load_truth_keys_from_provider_manifest(manifest_path: Path) -> set[str]:
    if not manifest_path.exists():
        return set()
    payload = load_json(manifest_path)
    entries = payload.get("entries") or []
    return {
        str(entry.get("truthKey") or "")
        for entry in entries
        if isinstance(entry, dict) and str(entry.get("truthKey") or "").strip()
    }


def load_provider_ids_from_manifest(manifest_path: Path) -> set[str]:
    if not manifest_path.exists():
        return set()
    payload = load_json(manifest_path)
    entries = payload.get("entries") or []
    return {
        str(entry.get("providerCardId") or "")
        for entry in entries
        if isinstance(entry, dict) and str(entry.get("providerCardId") or "").strip()
    }


def load_provider_ids_from_reviews(root: Path) -> set[str]:
    ids: set[str] = set()
    if not root.exists():
        return ids
    for review_path in root.rglob("auto_label_review.json"):
        payload = load_json(review_path)
        if payload.get("autoAccepted") is True:
            provider_card_id = str((payload.get("proposedTruth") or {}).get("providerCardId") or "").strip()
            if provider_card_id:
                ids.add(provider_card_id)
    return ids


def ensure_unique_fixture_name(root: Path, desired_name: str, *, current_dir: Path) -> Path:
    candidate = root / desired_name
    if candidate == current_dir:
        return current_dir
    if not candidate.exists():
        return candidate
    index = 2
    while True:
        retry = root / f"{desired_name}-{index}"
        if retry == current_dir or not retry.exists():
            return retry
        index += 1


@dataclass
class Proposal:
    fixture_dir: Path
    fixture_name: str
    import_metadata: dict[str, Any]
    runtime_summary: dict[str, Any]
    visual_top_id: str | None
    visual_top_similarity: float
    visual_runner_up_similarity: float
    hybrid_top_id: str | None
    confidence: str
    confidence_percent: float
    review_disposition: str
    top_candidates: list[dict[str, Any]]
    reasons: list[str]
    proposed_truth: dict[str, Any] | None
    provider_card_id: str | None
    truth_key_value: str | None
    exact_hash_overlaps: list[str]
    overlap_test_set: bool = False
    overlap_existing_training: bool = False
    duplicate_within_batch: bool = False
    is_batch_primary: bool = True
    auto_accepted: bool = False


def summarize_match(match: Any) -> dict[str, Any]:
    card = match.card
    return {
        "providerCardId": str(card.get("id") or ""),
        "name": str(card.get("name") or ""),
        "collectorNumber": str(card.get("number") or ""),
        "setCode": preferred_set_code(card),
        "setName": str(card.get("setName") or ""),
        "visualSimilarity": round(float(card.get("_visualSimilarity") or 0.0), 6),
        "visualScore": round(match.retrieval_score, 4),
        "ocrScore": round(match.resolution_score, 4),
        "finalScore": round(match.final_total, 4),
        "reasons": list(match.reasons),
    }


def should_auto_accept(
    proposal: Proposal,
    *,
    min_confidence_percent: float,
    min_visual_similarity: float,
    min_visual_margin: float,
) -> bool:
    if not proposal.proposed_truth or not proposal.provider_card_id:
        return False
    if proposal.overlap_test_set or proposal.overlap_existing_training:
        return False
    if proposal.exact_hash_overlaps:
        return False
    if proposal.duplicate_within_batch and not proposal.is_batch_primary:
        return False
    if proposal.review_disposition != "ready":
        return False
    if proposal.confidence_percent < min_confidence_percent:
        return False
    if proposal.hybrid_top_id != proposal.visual_top_id:
        return False

    corroborated = any(
        reason in {"collector_exact", "collector_partial", "title_overlap", "set_overlap", "footer_support"}
        for reason in proposal.reasons
    )
    if corroborated:
        return True

    visual_margin = proposal.visual_top_similarity - proposal.visual_runner_up_similarity
    return (
        proposal.visual_top_similarity >= min_visual_similarity
        and visual_margin >= min_visual_margin
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="Auto-label imported raw visual training fixtures conservatively.")
    parser.add_argument("--fixture-root", default=str(default_raw_visual_train_root()))
    parser.add_argument(
        "--heldout-root",
        default="qa/raw-footer-layout-check",
        help="Held-out evaluation root to protect from overlap.",
    )
    parser.add_argument(
        "--heldout-provider-manifest",
        default="qa/raw-footer-layout-check/provider_reference_manifest.json",
    )
    parser.add_argument("--top-k", type=int, default=10)
    parser.add_argument("--min-confidence-percent", type=float, default=72.0)
    parser.add_argument("--min-visual-similarity", type=float, default=0.84)
    parser.add_argument("--min-visual-margin", type=float, default=0.02)
    parser.add_argument(
        "--summary-output",
        default=str(default_raw_visual_train_auto_label_summary_path()),
    )
    args = parser.parse_args()

    fixture_root = Path(args.fixture_root).expanduser().resolve()
    heldout_root = Path(args.heldout_root).expanduser().resolve()
    heldout_provider_manifest = Path(args.heldout_provider_manifest).expanduser().resolve()
    summary_output = Path(args.summary_output).expanduser().resolve()

    matcher = RawVisualMatcher(repo_root=ROOT)
    if not matcher.is_available():
        raise SystemExit("Visual index artifacts are not available.")

    heldout_truth_keys = load_truth_keys_from_provider_manifest(heldout_provider_manifest) | load_truth_keys_from_truths(heldout_root)
    heldout_provider_ids = load_provider_ids_from_manifest(heldout_provider_manifest)

    existing_training_truth_keys = load_truth_keys_from_truths(fixture_root)
    existing_training_provider_ids = load_provider_ids_from_reviews(fixture_root)

    proposals: list[Proposal] = []

    fixture_directories = sorted(
        path
        for path in fixture_root.iterdir()
        if path.is_dir() and not path.name.startswith(".")
    )
    for fixture_dir in fixture_directories:
        normalized_path = fixture_dir / "runtime_normalized.jpg"
        runtime_summary_path = fixture_dir / "runtime_selection_summary.json"
        import_metadata_path = fixture_dir / "import_metadata.json"
        if not normalized_path.exists() or not runtime_summary_path.exists():
            continue

        runtime_summary = load_json(runtime_summary_path)
        import_metadata = load_json(import_metadata_path) if import_metadata_path.exists() else {}
        payload = build_payload(fixture_dir.name, normalized_path, runtime_summary)
        evidence = build_raw_evidence(payload)
        signals = score_raw_signals(evidence)
        visual_matches, _ = matcher.match_payload(payload, top_k=args.top_k)
        visual_candidates = [visual_candidate_stub(match) for match in visual_matches]
        ranked_matches, _ = rank_visual_hybrid_candidates(visual_candidates, evidence, signals)
        decision = finalize_raw_decision(ranked_matches, evidence, signals)

        visual_top_id = str(visual_candidates[0].get("id") or "") if visual_candidates else None
        visual_top_similarity = float(visual_candidates[0].get("_visualSimilarity") or 0.0) if visual_candidates else 0.0
        visual_runner_up_similarity = float(visual_candidates[1].get("_visualSimilarity") or 0.0) if len(visual_candidates) > 1 else 0.0
        hybrid_top = ranked_matches[0] if ranked_matches else None
        hybrid_top_id = str(hybrid_top.card.get("id") or "") if hybrid_top else None
        proposed_truth = fixture_truth_payload(hybrid_top.card) if hybrid_top else None
        provider_card_id = str((proposed_truth or {}).get("providerCardId") or hybrid_top_id or "").strip() or None
        if proposed_truth and provider_card_id:
            proposed_truth["providerCardId"] = provider_card_id
        truth_key_value = None
        if proposed_truth:
            truth_key_value = truth_key(
                str(proposed_truth.get("cardName") or ""),
                str(proposed_truth.get("collectorNumber") or ""),
                str(proposed_truth.get("setCode") or "") if proposed_truth.get("setCode") is not None else None,
            )

        reasons = list(hybrid_top.reasons) if hybrid_top else []
        proposals.append(
            Proposal(
                fixture_dir=fixture_dir,
                fixture_name=fixture_dir.name,
                import_metadata=import_metadata,
                runtime_summary=runtime_summary,
                visual_top_id=visual_top_id,
                visual_top_similarity=visual_top_similarity,
                visual_runner_up_similarity=visual_runner_up_similarity,
                hybrid_top_id=hybrid_top_id,
                confidence=decision.confidence,
                confidence_percent=float(decision.confidence_percent),
                review_disposition=decision.review_disposition,
                top_candidates=[summarize_match(match) for match in ranked_matches[:5]],
                reasons=reasons,
                proposed_truth=proposed_truth,
                provider_card_id=provider_card_id,
                truth_key_value=truth_key_value,
                exact_hash_overlaps=list(import_metadata.get("exactImageHashOverlaps") or []),
            )
        )

    provider_groups: dict[str, list[Proposal]] = defaultdict(list)
    for proposal in proposals:
        if proposal.provider_card_id:
            provider_groups[proposal.provider_card_id].append(proposal)

    for grouped in provider_groups.values():
        grouped.sort(
            key=lambda proposal: (
                -proposal.confidence_percent,
                -proposal.visual_top_similarity,
                proposal.fixture_name,
            )
        )
        if len(grouped) > 1:
            for index, proposal in enumerate(grouped):
                proposal.duplicate_within_batch = True
                proposal.is_batch_primary = index == 0

    accepted_count = 0
    excluded_overlap_count = 0
    uncertain_count = 0
    summary_entries: list[dict[str, Any]] = []

    for proposal in proposals:
        proposal.overlap_test_set = bool(
            (proposal.provider_card_id and proposal.provider_card_id in heldout_provider_ids)
            or (proposal.truth_key_value and proposal.truth_key_value in heldout_truth_keys)
        )
        proposal.overlap_existing_training = bool(
            (proposal.provider_card_id and proposal.provider_card_id in existing_training_provider_ids)
            or (proposal.truth_key_value and proposal.truth_key_value in existing_training_truth_keys)
        )
        proposal.auto_accepted = should_auto_accept(
            proposal,
            min_confidence_percent=args.min_confidence_percent,
            min_visual_similarity=args.min_visual_similarity,
            min_visual_margin=args.min_visual_margin,
        )

        if proposal.auto_accepted and proposal.proposed_truth:
            desired_name = f"{slugify_card_name(str(proposal.proposed_truth['cardName']))}-{collector_slug(str(proposal.proposed_truth['collectorNumber']))}-best"
            target_dir = ensure_unique_fixture_name(fixture_root, desired_name, current_dir=proposal.fixture_dir)
            if target_dir != proposal.fixture_dir:
                proposal.fixture_dir.rename(target_dir)
                proposal.fixture_dir = target_dir
                proposal.fixture_name = target_dir.name
            truth_payload = {
                "cardName": proposal.proposed_truth["cardName"],
                "collectorNumber": proposal.proposed_truth["collectorNumber"],
                "setCode": proposal.proposed_truth.get("setCode"),
            }
            write_json(proposal.fixture_dir / "truth.json", truth_payload)
            accepted_count += 1
            existing_training_truth_keys.add(proposal.truth_key_value or "")
            if proposal.provider_card_id:
                existing_training_provider_ids.add(proposal.provider_card_id)
        else:
            if proposal.overlap_test_set or proposal.overlap_existing_training or proposal.exact_hash_overlaps:
                excluded_overlap_count += 1
            else:
                uncertain_count += 1

        review_payload = {
            "generatedAt": utc_now_iso(),
            "fixtureName": proposal.fixture_name,
            "fixturePath": str(proposal.fixture_dir),
            "autoAccepted": proposal.auto_accepted,
            "confidence": proposal.confidence,
            "confidencePercent": proposal.confidence_percent,
            "reviewDisposition": proposal.review_disposition,
            "visualTopId": proposal.visual_top_id,
            "hybridTopId": proposal.hybrid_top_id,
            "visualTopSimilarity": round(proposal.visual_top_similarity, 6),
            "visualRunnerUpSimilarity": round(proposal.visual_runner_up_similarity, 6),
            "reasons": proposal.reasons,
            "proposedTruth": proposal.proposed_truth,
            "overlapFlags": {
                "heldoutTruthOrProviderOverlap": proposal.overlap_test_set,
                "existingTrainingOverlap": proposal.overlap_existing_training,
                "exactImageHashOverlap": bool(proposal.exact_hash_overlaps),
                "duplicateWithinBatch": proposal.duplicate_within_batch,
                "isBatchPrimary": proposal.is_batch_primary,
            },
            "exactImageHashOverlaps": proposal.exact_hash_overlaps,
            "topCandidates": proposal.top_candidates,
        }
        write_json(proposal.fixture_dir / "auto_label_review.json", review_payload)
        summary_entries.append(review_payload)

    summary = {
        "generatedAt": utc_now_iso(),
        "fixtureRoot": str(fixture_root),
        "fixtureCount": len(proposals),
        "acceptedCount": accepted_count,
        "excludedOverlapCount": excluded_overlap_count,
        "uncertainCount": uncertain_count,
        "entries": summary_entries,
    }
    write_json(summary_output, summary)
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
