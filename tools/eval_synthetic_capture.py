#!/usr/bin/env python3
"""Synthetic capture-degradation harness.

Produces a DIRECTIONAL top-1/top-5 retrieval number for any game whose visual
index exists but for which we have no real photographed cards. See the module
docstring of ``backend/synthetic_capture.py`` and the caveat block printed by
``--help`` for what this does and does not measure.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image


REPO_ROOT = Path(__file__).resolve().parent.parent
BACKEND_ROOT = REPO_ROOT / "backend"
if not (BACKEND_ROOT / "server.py").exists():
    BACKEND_ROOT = REPO_ROOT
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from raw_visual_index import RawVisualIndex  # noqa: E402
from raw_visual_model import (  # noqa: E402
    DEFAULT_VISUAL_MODEL_ID,
    RawVisualFrozenEncoder,
    load_projection_adapter,
    project_embeddings_numpy,
    resolve_torch_device,
)
from synthetic_capture import (  # noqa: E402
    CAVEAT_HEADLINE,
    CAVEAT_LINES,
    DEGRADATION_ORDER,
    apply_condition,
    build_conditions,
    caveat_block,
    derive_seed,
)


IMAGE_SUFFIXES = (".png", ".jpg", ".jpeg", ".webp")
NEAR_TIE_MARGIN = 0.01


def utc_now_iso() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def rate(numerator: int, denominator: int) -> float:
    if denominator <= 0:
        return 0.0
    return numerator / denominator


def read_manifest_header(manifest_path: Path, *, max_bytes: int = 2_000_000) -> dict[str, Any]:
    """Read the manifest's scalar header without parsing all entries.

    Index manifests written by ``tools/build_raw_visual_index.py`` always put
    ``entries`` last, so the prefix before it is a complete JSON object once the
    trailing comma is dropped and the brace is closed. This keeps us from
    holding a second copy of a 40 MB manifest in memory alongside the one
    ``RawVisualIndex`` owns. Any parse trouble degrades to an empty header, in
    which case ``--model-id`` must be passed explicitly.
    """
    try:
        with manifest_path.open("r", encoding="utf-8") as handle:
            chunk = handle.read(max_bytes)
        marker = chunk.find('"entries"')
        if marker == -1:
            return json.loads(chunk)
        prefix = chunk[:marker].rstrip().rstrip(",")
        return json.loads(prefix + "}")
    except (OSError, ValueError):
        return {}


def resolve_reference_image_path(entry: dict[str, Any], image_roots: list[Path]) -> Path | None:
    card_id = str(entry.get("providerCardId") or "").strip()
    for root in image_roots:
        for suffix in IMAGE_SUFFIXES:
            candidate = root / f"{card_id}{suffix}"
            if candidate.exists():
                return candidate
    declared = str(entry.get("referenceImagePath") or "").strip()
    if declared:
        candidate = Path(declared)
        if candidate.exists():
            return candidate
    return None


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="eval_synthetic_capture.py",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        description=(
            "Simulate phone-capture degradation of each card's OWN reference image, query the\n"
            "visual index with it, and score whether the correct card returns at rank 1.\n"
            "Built for games with zero real photos and zero API credits.\n\n"
            + caveat_block()
        ),
        epilog=(
            "Examples\n"
            "--------\n"
            "  # quick smoke run against the Pokemon index\n"
            "  python tools/eval_synthetic_capture.py \\\n"
            "      --game pokemon --limit 20 --seed 20260814 \\\n"
            "      --index-npz  backend/data/visual-index/visual_index_active_siglip2-base-patch16-384.npz \\\n"
            "      --index-manifest backend/data/visual-index/visual_index_active_manifest.json\n\n"
            "  # only the two degradations you care about, dumping the images for eyeballing\n"
            "  python tools/eval_synthetic_capture.py --game one_piece --limit 50 \\\n"
            "      --conditions clean,glare,realistic --save-samples /tmp/synthetic-capture \\\n"
            "      --index-npz ... --index-manifest ...\n"
        ),
    )
    parser.add_argument(
        "--index-npz",
        type=Path,
        required=True,
        help="Visual index NPZ (embeddings matrix) to query.",
    )
    parser.add_argument(
        "--index-manifest",
        type=Path,
        required=True,
        help="Visual index manifest JSON matching --index-npz.",
    )
    parser.add_argument(
        "--game",
        default="unknown",
        help="Label for this index in the report (e.g. pokemon, one_piece, lorcana).",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=50,
        help="How many cards to sample. 0 means every card in the index (hours - do not do this casually).",
    )
    parser.add_argument(
        "--seed",
        type=int,
        default=20260814,
        help="Seed for card sampling and every degradation. Same seed => byte-identical run.",
    )
    parser.add_argument(
        "--conditions",
        default="",
        help=(
            "Comma-separated subset of conditions to run. Default is all of: "
            "clean," + ",".join(DEGRADATION_ORDER) + ",realistic"
        ),
    )
    parser.add_argument(
        "--strength-scale",
        type=float,
        default=1.0,
        help="Global multiplier on every degradation strength. 1.0 is the calibrated default.",
    )
    parser.add_argument(
        "--image-root",
        type=Path,
        action="append",
        dest="image_roots",
        default=None,
        help=(
            "Directory of reference images named <providerCardId>.<ext>. Repeatable. "
            "Falls back to each manifest entry's referenceImagePath."
        ),
    )
    parser.add_argument(
        "--model-id",
        default="",
        help="Encoder model id. Defaults to the manifest's modelId, then to the repo default.",
    )
    parser.add_argument(
        "--adapter-checkpoint",
        type=Path,
        default=None,
        help="Projection adapter to apply to queries. Defaults to the manifest's adapterCheckpointPath if present.",
    )
    parser.add_argument(
        "--no-adapter",
        action="store_true",
        help="Do not apply any projection adapter, even if the manifest declares one.",
    )
    parser.add_argument(
        "--device",
        default="auto",
        choices=["auto", "cpu", "mps"],
        help="Torch device for embedding.",
    )
    parser.add_argument(
        "--top-k",
        type=int,
        default=10,
        help="Candidate depth fetched per query.",
    )
    parser.add_argument(
        "--embedding-batch-size",
        type=int,
        default=8,
        help="Images per encoder batch.",
    )
    parser.add_argument(
        "--save-samples",
        type=Path,
        default=None,
        help="Optional directory to write the degraded query images to, for eyeballing.",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=None,
        help="Optional path for the JSON scorecard.",
    )
    return parser


def select_conditions(requested: str, scale: float) -> list:
    all_conditions = build_conditions(scale=scale)
    if not requested.strip():
        return all_conditions
    wanted = [name.strip() for name in requested.split(",") if name.strip()]
    by_name = {condition.name: condition for condition in all_conditions}
    unknown = [name for name in wanted if name not in by_name]
    if unknown:
        raise SystemExit(
            f"Unknown condition(s): {', '.join(unknown)}. Known: {', '.join(by_name)}"
        )
    return [by_name[name] for name in wanted]


def main() -> int:
    args = build_parser().parse_args()

    index_npz_path = args.index_npz.resolve()
    index_manifest_path = args.index_manifest.resolve()
    if not index_npz_path.exists() or not index_manifest_path.exists():
        raise SystemExit(f"Index not found: {index_npz_path} / {index_manifest_path}")

    conditions = select_conditions(args.conditions, args.strength_scale)
    header = read_manifest_header(index_manifest_path)
    model_id = (args.model_id or str(header.get("modelId") or "") or DEFAULT_VISUAL_MODEL_ID).strip()

    adapter_path: Path | None = None
    if not args.no_adapter:
        if args.adapter_checkpoint is not None:
            adapter_path = args.adapter_checkpoint.resolve()
            if not adapter_path.exists():
                raise SystemExit(f"Adapter checkpoint not found: {adapter_path}")
        else:
            declared = str(header.get("adapterCheckpointPath") or "").strip()
            if declared and Path(declared).exists():
                adapter_path = Path(declared)

    index = RawVisualIndex(npz_path=index_npz_path, manifest_path=index_manifest_path)
    index.load()
    entries = index.entries
    matrix = index.matrix
    denylist = index.denylist_ids

    image_roots = [path.resolve() for path in (args.image_roots or [])]
    candidates: list[int] = []
    for row_index, entry in enumerate(entries):
        card_id = str(entry.get("providerCardId") or "").strip()
        if not card_id or card_id in denylist:
            continue
        candidates.append(row_index)

    if not candidates:
        raise SystemExit("Index has no usable (non-denylisted) entries.")

    sample_rng = np.random.default_rng(derive_seed(args.seed, "sample", args.game, len(candidates)))
    order = sample_rng.permutation(len(candidates))

    # Walk the shuffled order and keep the first `limit` rows whose reference
    # image is actually on disk, so a partially-cached image dir degrades to a
    # smaller sample instead of failing.
    selected: list[tuple[int, Path]] = []
    missing_image_count = 0
    target = len(candidates) if args.limit <= 0 else args.limit
    for position in order:
        row_index = candidates[int(position)]
        image_path = resolve_reference_image_path(entries[row_index], image_roots)
        if image_path is None:
            missing_image_count += 1
            continue
        selected.append((row_index, image_path))
        if len(selected) >= target:
            break

    if not selected:
        raise SystemExit(
            "No reference images could be resolved. Pass --image-root pointing at a directory "
            "of <providerCardId>.<ext> files, or rebuild the index so manifest entries carry "
            "referenceImagePath."
        )

    device = resolve_torch_device(args.device)
    encoder = RawVisualFrozenEncoder(model_id=model_id, device=args.device)
    adapter = None
    if adapter_path is not None:
        adapter = load_projection_adapter(adapter_path, embedding_dim=encoder.embedding_dim, device=device)

    if args.save_samples is not None:
        args.save_samples.mkdir(parents=True, exist_ok=True)

    condition_names = [condition.name for condition in conditions]
    totals: dict[str, dict[str, Any]] = {
        name: {
            "queryCount": 0,
            "top1Count": 0,
            "top5Count": 0,
            "missTopKCount": 0,
            "nearTieMissCount": 0,
            "truthSimilaritySum": 0.0,
            "top1SimilaritySum": 0.0,
            "truthRankSumWhenFound": 0,
            "truthRankFoundCount": 0,
        }
        for name in condition_names
    }
    card_records: list[dict[str, Any]] = []

    print(f"[eval] game={args.game} index={index_npz_path.name} entries={len(entries)}", flush=True)
    print(f"[eval] model={model_id} device={device} adapter={adapter_path or 'none'}", flush=True)
    print(f"[eval] sampling {len(selected)} cards x {len(conditions)} conditions (seed={args.seed})", flush=True)

    for sample_index, (row_index, image_path) in enumerate(selected, start=1):
        entry = entries[row_index]
        truth_card_id = str(entry.get("providerCardId") or "")
        with Image.open(image_path) as opened:
            source_image = opened.convert("RGB")

        variants = [
            apply_condition(source_image, condition, seed=args.seed, key=truth_card_id)
            for condition in conditions
        ]
        if args.save_samples is not None:
            for condition, variant in zip(conditions, variants):
                safe_id = truth_card_id.replace("/", "_")
                variant.save(args.save_samples / f"{safe_id}__{condition.name}.jpg", quality=92)

        embeddings = encoder.embed_images(variants, batch_size=max(1, args.embedding_batch_size))
        if adapter is not None:
            embeddings = project_embeddings_numpy(adapter, embeddings, device=device)

        per_condition: dict[str, Any] = {}
        for condition, embedding in zip(conditions, embeddings):
            matches = index.search(embedding, top_k=max(5, args.top_k))
            match_ids = [str(match.entry.get("providerCardId") or "") for match in matches]
            truth_rank = match_ids.index(truth_card_id) + 1 if truth_card_id in match_ids else None

            normalized = np.asarray(embedding, dtype=np.float32)
            norm = float(np.linalg.norm(normalized))
            if norm > 0:
                normalized = normalized / norm
            truth_similarity = float(np.dot(matrix[row_index], normalized))
            top1_similarity = float(matches[0].similarity) if matches else 0.0

            bucket = totals[condition.name]
            bucket["queryCount"] += 1
            bucket["truthSimilaritySum"] += truth_similarity
            bucket["top1SimilaritySum"] += top1_similarity
            if truth_rank == 1:
                bucket["top1Count"] += 1
            if truth_rank is not None and truth_rank <= 5:
                bucket["top5Count"] += 1
            if truth_rank is None:
                bucket["missTopKCount"] += 1
            else:
                bucket["truthRankSumWhenFound"] += truth_rank
                bucket["truthRankFoundCount"] += 1
            if truth_rank != 1 and truth_similarity >= top1_similarity - NEAR_TIE_MARGIN:
                bucket["nearTieMissCount"] += 1

            per_condition[condition.name] = {
                "truthRank": truth_rank,
                "truthSimilarity": round(truth_similarity, 6),
                "top1CardId": match_ids[0] if match_ids else None,
                "top1Similarity": round(top1_similarity, 6),
            }

        card_records.append(
            {
                "rowIndex": row_index,
                "providerCardId": truth_card_id,
                "name": entry.get("name"),
                "setId": entry.get("setId"),
                "referenceImagePath": str(image_path),
                "conditions": per_condition,
            }
        )
        if sample_index % 10 == 0 or sample_index == len(selected):
            print(f"[eval] {sample_index}/{len(selected)} cards embedded", flush=True)

    condition_reports = []
    for condition in conditions:
        bucket = totals[condition.name]
        query_count = bucket["queryCount"]
        condition_reports.append(
            {
                "condition": condition.name,
                "description": condition.description,
                "strengths": {name: round(value, 4) for name, value in condition.strengths.items()},
                "queryCount": query_count,
                "top1Count": bucket["top1Count"],
                "top1Rate": rate(bucket["top1Count"], query_count),
                "top5Count": bucket["top5Count"],
                "top5Rate": rate(bucket["top5Count"], query_count),
                "missTopKCount": bucket["missTopKCount"],
                "nearTieMissCount": bucket["nearTieMissCount"],
                "meanTruthSimilarity": round(bucket["truthSimilaritySum"] / query_count, 6) if query_count else 0.0,
                "meanTop1Similarity": round(bucket["top1SimilaritySum"] / query_count, 6) if query_count else 0.0,
                "meanTruthRankWhenFound": (
                    round(bucket["truthRankSumWhenFound"] / bucket["truthRankFoundCount"], 3)
                    if bucket["truthRankFoundCount"]
                    else None
                ),
            }
        )

    scorecard = {
        "generatedAt": utc_now_iso(),
        "interpretation": {
            "headline": CAVEAT_HEADLINE,
            "caveats": list(CAVEAT_LINES),
        },
        "game": args.game,
        "seed": args.seed,
        "strengthScale": args.strength_scale,
        "indexNpzPath": str(index_npz_path),
        "indexManifestPath": str(index_manifest_path),
        "indexEntryCount": len(entries),
        "denylistedEntryCount": len(denylist),
        "modelId": model_id,
        "adapterCheckpointPath": str(adapter_path) if adapter_path else None,
        "device": str(device),
        "topK": args.top_k,
        "sampledCardCount": len(selected),
        "skippedMissingImageCount": missing_image_count,
        "conditions": condition_reports,
        "cards": card_records,
    }

    print()
    print(caveat_block())
    print()
    print(
        f"game={args.game}  cards={len(selected)}  gallery={len(entries)}  "
        f"model={model_id}  seed={args.seed}  scale={args.strength_scale}"
    )
    if missing_image_count:
        print(f"note: skipped {missing_image_count} entries with no reference image on disk")
    print()
    header_row = (
        f"{'condition':<14}{'n':>5}{'top-1':>16}{'top-5':>16}"
        f"{'miss@k':>9}{'near-tie':>10}{'truth sim':>12}"
    )
    print(header_row)
    print("-" * len(header_row))
    for report in condition_reports:
        print(
            f"{report['condition']:<14}"
            f"{report['queryCount']:>5}"
            f"{report['top1Count']:>7} ({report['top1Rate']:>6.1%})"
            f"{report['top5Count']:>7} ({report['top5Rate']:>6.1%})"
            f"{report['missTopKCount']:>9}"
            f"{report['nearTieMissCount']:>10}"
            f"{report['meanTruthSimilarity']:>12.4f}"
        )
    print()

    degradation_reports = [report for report in condition_reports if report["condition"] not in {"clean", "realistic"}]
    if degradation_reports:
        worst = min(degradation_reports, key=lambda report: report["top1Rate"])
        print(f"worst single degradation: {worst['condition']} ({worst['description']}) at {worst['top1Rate']:.1%} top-1")
    clean_report = next((report for report in condition_reports if report["condition"] == "clean"), None)
    realistic_report = next((report for report in condition_reports if report["condition"] == "realistic"), None)
    if clean_report and realistic_report:
        drop = clean_report["top1Rate"] - realistic_report["top1Rate"]
        print(
            f"clean -> realistic top-1 drop: {drop:.1%} "
            f"({clean_report['top1Rate']:.1%} -> {realistic_report['top1Rate']:.1%})"
        )
    print()
    print("Reminder: the numbers above are a synthetic floor, not scanner accuracy.")

    if args.output is not None:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(scorecard, indent=2) + "\n")
        print(f"Wrote scorecard to {args.output.resolve()}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
