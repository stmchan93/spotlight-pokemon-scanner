#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

import numpy as np


REPO_ROOT = Path(__file__).resolve().parent.parent
BACKEND_ROOT = REPO_ROOT / "backend"
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from catalog_tools import build_raw_evidence, finalize_raw_decision, rank_visual_hybrid_candidates, score_raw_signals  # noqa: E402
from raw_visual_model import DEFAULT_VISUAL_MODEL_ID, RawVisualFrozenEncoder, load_projection_adapter, project_embeddings_numpy, resolve_torch_device  # noqa: E402


def utc_now_iso() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


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
    if not manifest_path.exists():
        return {}
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

    return {
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


def whole_card_text_from_runtime_summary(runtime_summary: dict[str, Any]) -> str:
    texts: list[str] = []
    seen: set[str] = set()
    for pass_summary in runtime_summary.get("passSummaries") or []:
        text = str(pass_summary.get("text") or "").strip()
        if not text or text in seen:
            continue
        seen.add(text)
        texts.append(text)
    return " ".join(texts)


def build_fixture_payload_from_runtime_summary(
    fixture_name: str,
    normalized_image_path: Path,
    runtime_summary: dict[str, Any],
) -> dict[str, Any]:
    raw_evidence: dict[str, Any] = {
        "collectorNumberExact": runtime_summary.get("collectorNumber"),
        "collectorNumberPartial": runtime_summary.get("collectorNumberPartial"),
        "setHints": list(runtime_summary.get("setHintTokens") or []),
        "titleTextPrimary": runtime_summary.get("titleTextPrimary"),
        "footerBandText": " ".join(
            str(pass_summary.get("text") or "").strip()
            for pass_summary in runtime_summary.get("passSummaries") or []
            if str(pass_summary.get("kind") or "").strip() == "footer_band_wide"
            and str(pass_summary.get("text") or "").strip()
        ),
        "wholeCardText": whole_card_text_from_runtime_summary(runtime_summary),
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
        "cropConfidence": float(runtime_summary.get("cropConfidence") or 0.0),
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


def load_label_status_provider_mapping(directory: Path) -> dict[str, Any] | None:
    label_status_path = directory / "label_status.json"
    if not label_status_path.exists():
        return None
    payload = load_json(label_status_path)
    provider_mapping = payload.get("providerMapping")
    if not isinstance(provider_mapping, dict):
        return None
    provider_card_id = str(provider_mapping.get("providerCardId") or "").strip()
    if not provider_card_id:
        return None
    return provider_mapping


def resolve_expected_provider_card_id(
    *,
    directory: Path,
    truth: dict[str, Any],
    provider_truth_map: dict[str, dict[str, Any]],
) -> tuple[str | None, str]:
    provider_mapping = provider_truth_map.get(fixture_truth_key(truth))
    if provider_mapping:
        provider_card_id = str(provider_mapping.get("providerCardId") or "").strip()
        if provider_card_id:
            return provider_card_id, "provider_manifest"

    label_status_mapping = load_label_status_provider_mapping(directory)
    if label_status_mapping:
        return str(label_status_mapping.get("providerCardId") or "").strip(), "label_status"
    return None, "unmapped"


def visual_candidate_stub(entry: dict[str, Any], similarity: float) -> dict[str, Any]:
    image_url = entry.get("imageUrl")
    return {
        "id": str(entry.get("providerCardId") or ""),
        "name": str(entry.get("name") or ""),
        "titleAliases": list(entry.get("titleAliases") or []),
        "setName": str(entry.get("setName") or ""),
        "number": str(entry.get("collectorNumber") or ""),
        "rarity": "Unknown",
        "variant": "Raw",
        "language": str(entry.get("language") or "Unknown"),
        "imageSmallURL": image_url,
        "imageURL": image_url,
        "sourceProvider": str(entry.get("sourceProvider") or "scrydex"),
        "sourceRecordID": str(entry.get("sourceRecordID") or entry.get("providerCardId") or ""),
        "setID": entry.get("setId"),
        "setSeries": entry.get("setSeries"),
        "setPtcgoCode": entry.get("setPtcgoCode"),
        "sourcePayload": entry.get("sourcePayload") or {},
        "_visualSimilarity": float(similarity),
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


def search_topk(query_vector: np.ndarray, matrix: np.ndarray, top_k: int) -> list[tuple[int, float]]:
    sanitized_query = np.nan_to_num(query_vector.astype(np.float64), nan=0.0, posinf=0.0, neginf=0.0)
    sanitized_matrix = np.nan_to_num(matrix.astype(np.float64), nan=0.0, posinf=0.0, neginf=0.0)
    scores = np.sum(sanitized_matrix * sanitized_query[None, :], axis=1, dtype=np.float64)
    if top_k >= len(scores):
        top_indices = np.argsort(scores)[::-1]
    else:
        top_indices = np.argpartition(scores, -top_k)[-top_k:]
        top_indices = top_indices[np.argsort(scores[top_indices])[::-1]]
    return [(int(index), float(scores[index])) for index in top_indices]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Evaluate a trained raw visual adapter on the held-out raw suite.")
    parser.add_argument(
        "--adapter-checkpoint",
        type=Path,
        required=True,
        help="Path to the trained adapter checkpoint (.pt).",
    )
    parser.add_argument(
        "--fixture-root",
        type=Path,
        action="append",
        dest="fixture_roots",
        default=None,
        help="Fixture root to evaluate. Repeat this flag to aggregate multiple roots.",
    )
    parser.add_argument(
        "--provider-manifest",
        type=Path,
        default=Path("qa/raw-footer-layout-check/provider_reference_manifest.json"),
        help="Held-out provider reference manifest.",
    )
    parser.add_argument(
        "--index-npz",
        type=Path,
        default=Path("backend/data/visual-index/visual_index_active_clip-vit-base-patch32.npz"),
        help="Base visual index NPZ path.",
    )
    parser.add_argument(
        "--index-manifest",
        type=Path,
        default=Path("backend/data/visual-index/visual_index_active_manifest.json"),
        help="Base visual index manifest path.",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("qa/raw-footer-layout-check/raw_visual_adapter_eval_scorecard.json"),
        help="Where to write the adapter evaluation scorecard.",
    )
    parser.add_argument(
        "--model-id",
        default=DEFAULT_VISUAL_MODEL_ID,
        help="Frozen CLIP model id used to produce the base embeddings.",
    )
    parser.add_argument(
        "--device",
        default="auto",
        choices=["auto", "cpu", "mps"],
        help="Torch device for query embedding + adapter projection.",
    )
    parser.add_argument(
        "--embedding-batch-size",
        type=int,
        default=16,
        help="Batch size for query embedding extraction.",
    )
    parser.add_argument(
        "--projection-batch-size",
        type=int,
        default=1024,
        help="Batch size when projecting base embeddings through the adapter.",
    )
    parser.add_argument(
        "--top-k",
        type=int,
        default=10,
        help="How many visual candidates to keep before hybrid reranking.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()

    fixture_roots = [path.resolve() for path in (args.fixture_roots or [Path("qa/raw-footer-layout-check")])]
    provider_manifest_path = args.provider_manifest.resolve()
    index_npz_path = args.index_npz.resolve()
    index_manifest_path = args.index_manifest.resolve()
    output_path = args.output.resolve()

    provider_truth_map = load_provider_truth_map(provider_manifest_path)
    index_manifest = load_json(index_manifest_path)
    index_rows = [entry for entry in index_manifest.get("entries", []) if isinstance(entry, dict)]
    base_matrix = np.asarray(np.load(index_npz_path)["embeddings"], dtype=np.float32)
    if base_matrix.ndim != 2 or base_matrix.shape[0] != len(index_rows):
        raise SystemExit("Visual index NPZ/manifest mismatch.")

    device = resolve_torch_device(args.device)
    encoder = RawVisualFrozenEncoder(model_id=args.model_id, device=args.device)
    adapter = load_projection_adapter(
        args.adapter_checkpoint.resolve(),
        embedding_dim=encoder.embedding_dim,
        device=device,
    )
    projected_matrix = project_embeddings_numpy(
        adapter,
        base_matrix,
        device=device,
        batch_size=args.projection_batch_size,
    )

    fixture_directories = []
    for fixture_root in fixture_roots:
        if not fixture_root.exists():
            continue
        fixture_directories.extend(truth_path.parent for truth_path in fixture_root.rglob("truth.json"))
    fixture_directories = sorted({path.resolve() for path in fixture_directories}, key=lambda path: (str(path.parent), path.name))

    entries: list[dict[str, Any]] = []
    supported_fixture_count = 0
    unsupported_fixture_count = 0
    visual_top1_pass_count = 0
    visual_top5_contains_truth_count = 0
    visual_top10_contains_truth_count = 0
    hybrid_top1_pass_count = 0
    hybrid_top5_contains_truth_count = 0

    for directory in fixture_directories:
        truth_path = directory / "truth.json"
        normalized_path = directory / "runtime_normalized.jpg"
        regression_path = directory / "raw_ocr_regression_result.json"
        runtime_summary_path = directory / "runtime_selection_summary.json"
        if not truth_path.exists() or not normalized_path.exists():
            continue

        truth = load_json(truth_path)
        expected_provider_card_id, mapping_source = resolve_expected_provider_card_id(
            directory=directory,
            truth=truth,
            provider_truth_map=provider_truth_map,
        )
        if not expected_provider_card_id:
            unsupported_fixture_count += 1
            entries.append(
                {
                    "fixtureName": directory.name,
                    "providerSupported": False,
                    "truth": truth,
                    "mappingSource": mapping_source,
                    "reason": "No provider-supported mapping was available for this truth key.",
                }
            )
            continue

        if regression_path.exists():
            regression_result = load_json(regression_path)
            payload = build_fixture_payload(directory.name, normalized_path, regression_result)
            ocrArtifactSource = "raw_ocr_regression_result"
        elif runtime_summary_path.exists():
            runtime_summary = load_json(runtime_summary_path)
            payload = build_fixture_payload_from_runtime_summary(directory.name, normalized_path, runtime_summary)
            ocrArtifactSource = "runtime_selection_summary"
        else:
            unsupported_fixture_count += 1
            entries.append(
                {
                    "fixtureName": directory.name,
                    "providerSupported": False,
                    "truth": truth,
                    "mappingSource": mapping_source,
                    "reason": "No OCR/runtime artifact was available for this fixture.",
                }
            )
            continue
        supported_fixture_count += 1
        query_embedding = encoder.embed_image_paths([normalized_path], batch_size=args.embedding_batch_size)
        projected_query = project_embeddings_numpy(
            adapter,
            query_embedding,
            device=device,
            batch_size=args.projection_batch_size,
        )[0]
        top_matches = search_topk(projected_query, projected_matrix, args.top_k)
        visual_top_ids = [str(index_rows[row_index].get("providerCardId") or "") for row_index, _ in top_matches]
        visual_top1_pass = bool(visual_top_ids[:1] and visual_top_ids[0] == expected_provider_card_id)
        visual_top5_contains_truth = expected_provider_card_id in visual_top_ids[:5]
        visual_top10_contains_truth = expected_provider_card_id in visual_top_ids[: args.top_k]

        if visual_top1_pass:
            visual_top1_pass_count += 1
        if visual_top5_contains_truth:
            visual_top5_contains_truth_count += 1
        if visual_top10_contains_truth:
            visual_top10_contains_truth_count += 1

        evidence = build_raw_evidence(payload)
        signals = score_raw_signals(evidence)
        visual_candidates = [
            visual_candidate_stub(index_rows[row_index], similarity)
            for row_index, similarity in top_matches
        ]
        ranked_matches, weights = rank_visual_hybrid_candidates(visual_candidates, evidence, signals)
        decision = finalize_raw_decision(ranked_matches, evidence, signals)
        hybrid_top_ids = [str(match.card.get("id") or "") for match in ranked_matches]
        hybrid_top1_pass = bool(hybrid_top_ids[:1] and hybrid_top_ids[0] == expected_provider_card_id)
        hybrid_top5_contains_truth = expected_provider_card_id in hybrid_top_ids[:5]

        if hybrid_top1_pass:
            hybrid_top1_pass_count += 1
        if hybrid_top5_contains_truth:
            hybrid_top5_contains_truth_count += 1

        candidate_summaries = []
        for rank, (row_index, similarity) in enumerate(top_matches[: args.top_k], start=1):
            row = index_rows[row_index]
            provider_card_id = str(row.get("providerCardId") or "")
            candidate_summaries.append(
                {
                    "rank": rank,
                    "providerCardId": provider_card_id,
                    "providerName": row.get("name"),
                    "providerCollectorNumber": row.get("collectorNumber"),
                    "providerSetId": row.get("setId"),
                    "providerSetPtcgoCode": row.get("setPtcgoCode"),
                    "providerSetName": row.get("setName"),
                    "similarity": round(float(similarity), 6),
                    "isTruth": provider_card_id == expected_provider_card_id,
                }
            )

        entries.append(
            {
                "fixtureName": directory.name,
                "fixtureRoot": str(directory.parent.resolve()),
                "providerSupported": True,
                "mappingSource": mapping_source,
                "ocrArtifactSource": ocrArtifactSource,
                "truth": {
                    **truth,
                    "providerCardId": expected_provider_card_id,
                },
                "visual": {
                    "top1Pass": visual_top1_pass,
                    "top5ContainsTruth": visual_top5_contains_truth,
                    "top10ContainsTruth": visual_top10_contains_truth,
                    "candidateSummaries": candidate_summaries,
                },
                "hybrid": {
                    "top1Pass": hybrid_top1_pass,
                    "top5ContainsTruth": hybrid_top5_contains_truth,
                    "decision": {
                        "bestCandidateId": decision.selected_card_id,
                        "resolverPath": decision.resolver_path,
                        "confidence": decision.confidence,
                        "confidencePercent": round(float(decision.confidence_percent), 6),
                        "reviewDisposition": decision.review_disposition,
                        "reviewReason": decision.review_reason,
                    },
                    "candidateSummaries": [summarize_hybrid_match(match) for match in ranked_matches[:5]],
                    "weights": weights,
                },
            }
        )

    scorecard = {
        "generatedAt": utc_now_iso(),
        "adapterCheckpointPath": str(args.adapter_checkpoint.resolve()),
        "fixtureRoots": [str(path) for path in fixture_roots],
        "modelId": args.model_id,
        "embeddingDimension": encoder.embedding_dim,
        "indexNpzPath": str(index_npz_path),
        "indexManifestPath": str(index_manifest_path),
        "topK": args.top_k,
        "providerSupportedFixtureCount": supported_fixture_count,
        "providerUnsupportedFixtureCount": unsupported_fixture_count,
        "visualTop1PassCount": visual_top1_pass_count,
        "visualTop5ContainsTruthCount": visual_top5_contains_truth_count,
        "visualTop10ContainsTruthCount": visual_top10_contains_truth_count,
        "visualTop1PassRate": rate(visual_top1_pass_count, supported_fixture_count),
        "visualTop5ContainsTruthRate": rate(visual_top5_contains_truth_count, supported_fixture_count),
        "visualTop10ContainsTruthRate": rate(visual_top10_contains_truth_count, supported_fixture_count),
        "hybridTop1PassCount": hybrid_top1_pass_count,
        "hybridTop5ContainsTruthCount": hybrid_top5_contains_truth_count,
        "hybridTop1PassRate": rate(hybrid_top1_pass_count, supported_fixture_count),
        "hybridTop5ContainsTruthRate": rate(hybrid_top5_contains_truth_count, supported_fixture_count),
        "mappingSourceCounts": {
            "provider_manifest": sum(1 for entry in entries if entry.get("mappingSource") == "provider_manifest"),
            "label_status": sum(1 for entry in entries if entry.get("mappingSource") == "label_status"),
            "unmapped": sum(1 for entry in entries if entry.get("mappingSource") == "unmapped"),
        },
        "ocrArtifactSourceCounts": {
            "raw_ocr_regression_result": sum(1 for entry in entries if entry.get("ocrArtifactSource") == "raw_ocr_regression_result"),
            "runtime_selection_summary": sum(1 for entry in entries if entry.get("ocrArtifactSource") == "runtime_selection_summary"),
        },
        "entries": entries,
    }

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(scorecard, indent=2) + "\n")
    print(f"Wrote adapter evaluation scorecard to {output_path}")
    print(
        "Visual top-1: "
        f"{visual_top1_pass_count}/{supported_fixture_count} "
        f"({rate(visual_top1_pass_count, supported_fixture_count):.1%})"
    )
    print(
        "Visual top-10 contains-truth: "
        f"{visual_top10_contains_truth_count}/{supported_fixture_count} "
        f"({rate(visual_top10_contains_truth_count, supported_fixture_count):.1%})"
    )
    print(
        "Hybrid top-1: "
        f"{hybrid_top1_pass_count}/{supported_fixture_count} "
        f"({rate(hybrid_top1_pass_count, supported_fixture_count):.1%})"
    )


if __name__ == "__main__":
    main()
