#!/usr/bin/env python3
"""A/B the watermark-domain-gap remedies against real card photos.

Scrydex's One Piece and Gundam reference art carries a semi-transparent white
"SAMPLE" stamp; a physical card does not. The visual index is built from that art
and queried with photos, so the stamp sits on exactly one side of the comparison.
Measured on `onepiece~OP05-119`, same index, same card:

    watermarked query (TCGplayer art) -> rank 1
    real card photographed (eBay)     -> rank ~30, then out of the top 30

`backend/reference_image_transforms.py` offers three ways to make the two sides
agree. This harness scores them the only way that settles it — rank of the true
card for real, unwatermarked query images:

    baseline  today's index, untransformed query
    A         index rebuilt with strip_watermark; untransformed query
    B         today's index; apply_watermark on the query   (no rebuild)
    C         index rebuilt with mask_watermark; mask_watermark on the query

Arms A and C rebuild an index from the cached reference images under a clearly
non-`active` artifact name, so nothing the running backend loads is disturbed.

Guards worth keeping in mind when reading the output:

  * The clean-game control (`--game lorcana` / `riftbound`) must NOT improve.
    Those games have no stamp; `--mask-report` shows what the transforms even do
    to their pixels, and a transform that is a near no-op cannot move retrieval.
  * The watermarked TCGplayer query is the known-good control (rank 1 today).
    Arm A is EXPECTED to make it worse — the index no longer carries the stamp
    the query still has. That is correct behaviour, not a regression.
  * Query images must be real photographs or real unwatermarked scans. A
    synthetic capture derived from the same reference image the index was built
    from proves nothing here.

Usage
-----
    python tools/eval_watermark_transform_arms.py \
        --game onepiece \
        --query /path/clean-op05-119.jpg=onepiece~OP05-119 \
        --query /path/tcg-527024.jpg=onepiece~OP05-119 \
        --arms baseline,B

    python tools/eval_watermark_transform_arms.py \
        --game onepiece --fixtures qa/watermark-fixtures.json --arms baseline,A,B,C
"""
from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image

REPO_ROOT = Path(__file__).resolve().parent.parent
BACKEND_ROOT = REPO_ROOT / "backend"
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from raw_visual_model import (  # noqa: E402
    RawVisualFrozenEncoder,
    load_projection_adapter,
    project_embeddings_numpy,
    resolve_torch_device,
)
from reference_image_transforms import (  # noqa: E402
    WatermarkMask,
    apply_watermark,
    estimate_watermark_mask,
    load_mask,
    mask_watermark,
    save_mask,
    strip_watermark,
)

INDEX_DIR = BACKEND_ROOT / "data" / "visual-index"
DEFAULT_MODEL_ID = "google/siglip2-base-patch16-384"

# (reference transform, query transform). None means "leave the image alone".
ARMS: dict[str, tuple[str | None, str | None]] = {
    "baseline": (None, None),
    "A": ("strip", None),
    "B": (None, "apply"),
    "C": ("mask", "mask"),
}

REFERENCE_TRANSFORMS = {"strip": strip_watermark, "mask": mask_watermark}
QUERY_TRANSFORMS = {"apply": apply_watermark, "mask": mask_watermark}


@dataclass(frozen=True)
class Fixture:
    image_path: Path
    provider_card_id: str
    label: str


@dataclass
class ArmIndex:
    """One arm's gallery: adapter-projected embeddings plus their card ids."""

    name: str
    matrix: np.ndarray
    card_ids: list[str]
    npz_path: Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--game", default="onepiece")
    parser.add_argument(
        "--query",
        action="append",
        default=[],
        metavar="PATH=PROVIDER_CARD_ID",
        help="An ad-hoc query image and the card it really is. Repeatable.",
    )
    parser.add_argument(
        "--fixtures",
        type=Path,
        default=None,
        help="JSON or JSONL of {imagePath, providerCardId, label?} records.",
    )
    parser.add_argument("--arms", default="baseline,A,B,C")
    parser.add_argument("--model-id", default=DEFAULT_MODEL_ID)
    parser.add_argument("--device", default="auto", choices=["auto", "cpu", "mps"])
    parser.add_argument("--batch-size", type=int, default=32)
    parser.add_argument("--top-k", type=int, default=5, help="How many top hits to print per query.")
    parser.add_argument("--mask-sample", type=int, default=400, help="Reference images used to fit the mask.")
    parser.add_argument("--refit-mask", action="store_true")
    parser.add_argument(
        "--mask-from-pair",
        default=None,
        metavar="CLEAN_IMAGE_PATH=PROVIDER_CARD_ID",
        help="Solve the overlay exactly from one aligned clean/stamped pair instead of estimating it "
        "across many cards. This is the ORACLE mask: it bounds how well any of these arms could ever "
        "do, so a null result under it is a null result for the whole approach.",
    )
    parser.add_argument(
        "--mask-report",
        action="store_true",
        help="Print how much each transform actually changes this game's pixels, then exit. "
        "The cheap clean-game control: a near-zero delta cannot move retrieval.",
    )
    parser.add_argument("--rebuild-index", action="store_true", help="Re-embed arm A/C galleries even if cached.")
    parser.add_argument("--json-out", type=Path, default=None)
    return parser.parse_args()


def load_fixtures(args: argparse.Namespace) -> list[Fixture]:
    fixtures: list[Fixture] = []
    for spec in args.query:
        if "=" not in spec:
            raise SystemExit(f"--query needs PATH=PROVIDER_CARD_ID, got {spec!r}")
        raw_path, card_id = spec.rsplit("=", 1)
        path = Path(raw_path).expanduser()
        fixtures.append(Fixture(image_path=path, provider_card_id=card_id.strip(), label=path.name))

    if args.fixtures:
        text = args.fixtures.read_text()
        records: list[dict[str, Any]]
        stripped = text.lstrip()
        if stripped.startswith("["):
            records = json.loads(text)
        elif stripped.startswith("{") and "\n" not in stripped.strip():
            records = [json.loads(text)]
        else:
            payload = json.loads(text) if stripped.startswith("{") else None
            if isinstance(payload, dict) and isinstance(payload.get("fixtures"), list):
                records = payload["fixtures"]
            else:
                records = [json.loads(line) for line in text.splitlines() if line.strip()]
        for record in records:
            raw_path = record.get("imagePath") or record.get("path") or record.get("image")
            card_id = record.get("providerCardId") or record.get("cardId") or record.get("trueCardId")
            if not raw_path or not card_id:
                raise SystemExit(f"Fixture record missing imagePath/providerCardId: {record!r}")
            path = Path(str(raw_path)).expanduser()
            if not path.is_absolute():
                path = (args.fixtures.parent / path).resolve()
            fixtures.append(
                Fixture(image_path=path, provider_card_id=str(card_id), label=str(record.get("label") or path.name))
            )

    missing = [str(fixture.image_path) for fixture in fixtures if not fixture.image_path.exists()]
    if missing:
        raise SystemExit("Missing query images:\n  " + "\n  ".join(missing))
    return fixtures


def source_manifest_path(game: str) -> Path:
    return INDEX_DIR / f"visual_index_active_{game}_manifest.json"


def source_npz_path(game: str, model_id: str) -> Path:
    return INDEX_DIR / f"visual_index_active_{game}_{model_id.split('/')[-1].lower()}.npz"


def reference_cache_dir(game: str) -> Path:
    return INDEX_DIR / ".cache" / f"reference_images_{game}"


def resolve_mask(game: str, *, sample_size: int, refit: bool) -> WatermarkMask:
    """Fit (and cache) the game's overlay from its cached reference images."""
    mask_path = INDEX_DIR / f"watermark_mask_{game}.npz"
    if mask_path.exists() and not refit:
        return load_mask(mask_path, game=game)

    cache_dir = reference_cache_dir(game)
    paths = sorted(cache_dir.glob("*.png")) + sorted(cache_dir.glob("*.jpg"))
    if not paths:
        raise SystemExit(f"No cached reference images under {cache_dir}")
    # Even stride, so the sample spans every set rather than one alphabetical corner.
    stride = max(1, len(paths) // max(1, sample_size))
    sampled = paths[::stride][:sample_size]
    print(f"[mask] fitting {game} from {len(sampled)} reference images...", flush=True)
    mask = estimate_watermark_mask(sampled, game=game)
    save_mask(mask, mask_path)
    print(
        f"[mask] {game}: coverage={mask.coverage:.4f} peak={mask.peak_alpha:.3f} "
        f"meanAlphaWherePresent={mask.mean_alpha_where_present:.3f} -> {mask_path}",
        flush=True,
    )
    return mask


def oracle_mask_from_pair(game: str, spec: str) -> WatermarkMask:
    """Solve the overlay exactly, from one clean image and its stamped reference.

    Both come from the same Bandai art at the same size, so they are pixel-aligned
    and the blend inverts directly:

        reference = (1 - a) * clean + 255 * a   ->   a = (reference - clean) / (255 - clean)

    Where `clean` is already near-white the denominator vanishes and alpha is
    unrecoverable, so those pixels are dropped and the rest carries the fit.
    """
    if "=" not in spec:
        raise SystemExit(f"--mask-from-pair needs PATH=PROVIDER_CARD_ID, got {spec!r}")
    raw_path, card_id = spec.rsplit("=", 1)
    reference_path = reference_cache_dir(game) / f"{card_id.strip()}.png"
    if not reference_path.exists():
        raise SystemExit(f"No cached reference at {reference_path}")

    from reference_image_transforms import MASK_GRID_SIZE, MIN_SIGNIFICANT_ALPHA, _box_blur

    with Image.open(Path(raw_path).expanduser()) as handle:
        clean = np.asarray(handle.convert("RGB").resize(MASK_GRID_SIZE, Image.BILINEAR), dtype=np.float32)
    with Image.open(reference_path) as handle:
        stamped = np.asarray(handle.convert("RGB").resize(MASK_GRID_SIZE, Image.BILINEAR), dtype=np.float32)

    headroom = 255.0 - clean
    alpha_rgb = np.divide(stamped - clean, headroom, out=np.zeros_like(clean), where=headroom > 12.0)
    alpha = np.clip(np.median(alpha_rgb, axis=2), 0.0, 1.0)
    alpha = _box_blur(alpha.astype(np.float32), radius=1)
    alpha[alpha < MIN_SIGNIFICANT_ALPHA] = 0.0
    return WatermarkMask(game=game, alpha=alpha.astype(np.float32), sample_size=1, source="oracle-pair")


def print_mask_report(game: str, mask: WatermarkMask, *, sample: int = 12) -> None:
    """Clean-game control: how much do these transforms move this game's pixels?"""
    cache_dir = reference_cache_dir(game)
    paths = sorted(cache_dir.glob("*.png"))[:sample]
    rows = []
    for path in paths:
        with Image.open(path) as handle:
            original = np.asarray(handle.convert("RGB"), dtype=np.float32)
            image = handle.convert("RGB")
            rows.append(
                (
                    float(np.abs(np.asarray(strip_watermark(image, mask), dtype=np.float32) - original).mean()),
                    float(np.abs(np.asarray(apply_watermark(image, mask), dtype=np.float32) - original).mean()),
                    float(np.abs(np.asarray(mask_watermark(image, mask), dtype=np.float32) - original).mean()),
                )
            )
    deltas = np.asarray(rows, dtype=np.float32).mean(axis=0) if rows else np.zeros(3)
    print(f"\nMask report — {game}")
    print(f"  coverage             {mask.coverage:.4f}")
    print(f"  peak alpha           {mask.peak_alpha:.3f}")
    print(f"  mean alpha (present) {mask.mean_alpha_where_present:.3f}")
    print(f"  mean |delta| /255 over {len(rows)} reference images:")
    print(f"    strip_watermark  {deltas[0]:.3f}")
    print(f"    apply_watermark  {deltas[1]:.3f}")
    print(f"    mask_watermark   {deltas[2]:.3f}")


def build_arm_index(
    *,
    arm: str,
    game: str,
    manifest: dict[str, Any],
    reference_transform: str | None,
    mask: WatermarkMask,
    encoder: RawVisualFrozenEncoder,
    adapter,
    device,
    batch_size: int,
    rebuild: bool,
) -> ArmIndex:
    """Load the arm's gallery, re-embedding from the reference cache if needed."""
    entries = manifest["entries"]
    card_ids = [str(entry.get("providerCardId") or "") for entry in entries]

    if reference_transform is None:
        npz_path = source_npz_path(game, str(manifest.get("modelId") or DEFAULT_MODEL_ID))
        matrix = np.asarray(np.load(npz_path)["embeddings"], dtype=np.float32)
        if matrix.shape[0] != len(entries):
            raise SystemExit(f"{npz_path} has {matrix.shape[0]} rows but the manifest has {len(entries)}")
        return ArmIndex(name=arm, matrix=matrix, card_ids=card_ids, npz_path=npz_path)

    model_slug = str(manifest.get("modelId") or DEFAULT_MODEL_ID).split("/")[-1].lower()
    # Mask provenance is in the filename: an estimated-mask gallery and an
    # oracle-mask gallery are different artifacts and must not share a cache slot.
    mask_tag = "" if mask.source == "estimated" else f"-{mask.source}"
    npz_path = INDEX_DIR / f"visual_index_wm-{reference_transform}{mask_tag}_{game}_{model_slug}.npz"
    if npz_path.exists() and not rebuild:
        matrix = np.asarray(np.load(npz_path)["embeddings"], dtype=np.float32)
        if matrix.shape[0] == len(entries):
            print(f"[arm {arm}] reusing {npz_path.name}", flush=True)
            return ArmIndex(name=arm, matrix=matrix, card_ids=card_ids, npz_path=npz_path)
        print(f"[arm {arm}] cached index row count mismatch; rebuilding", flush=True)

    transform = REFERENCE_TRANSFORMS[reference_transform]
    print(f"[arm {arm}] re-embedding {len(entries)} references under {reference_transform}_watermark...", flush=True)
    chunks: list[np.ndarray] = []
    for start in range(0, len(entries), batch_size):
        batch = entries[start : start + batch_size]
        images = []
        try:
            for entry in batch:
                with Image.open(Path(str(entry["referenceImagePath"]))) as handle:
                    images.append(transform(handle.convert("RGB"), mask))
            embeddings = encoder.embed_images(images, batch_size=len(images))
        finally:
            for image in images:
                image.close()
        if adapter is not None:
            embeddings = project_embeddings_numpy(adapter, embeddings, device=device, batch_size=len(embeddings))
        chunks.append(np.asarray(embeddings, dtype=np.float32))
        done = min(start + batch_size, len(entries))
        if done % (batch_size * 20) < batch_size or done == len(entries):
            print(f"  {done}/{len(entries)}", flush=True)

    matrix = np.concatenate(chunks, axis=0).astype(np.float32)
    np.savez_compressed(npz_path, embeddings=matrix)
    manifest_out = npz_path.with_name(f"visual_index_wm-{reference_transform}{mask_tag}_{game}_manifest.json")
    manifest_out.write_text(
        json.dumps(
            {
                **{key: value for key, value in manifest.items() if key != "entries"},
                "artifactVersion": f"wm-{reference_transform}{mask_tag}-{game}",
                "referenceTransform": f"{reference_transform}_watermark",
                "watermarkMask": {
                    "game": mask.game,
                    "source": mask.source,
                    "sampleSize": mask.sample_size,
                    "coverage": round(mask.coverage, 4),
                    "peakAlpha": round(mask.peak_alpha, 4),
                },
                "reencodedFrom": str(source_manifest_path(game)),
                "entries": manifest["entries"],
            },
            indent=2,
        )
        + "\n"
    )
    print(f"[arm {arm}] wrote {npz_path}", flush=True)
    return ArmIndex(name=arm, matrix=matrix, card_ids=card_ids, npz_path=npz_path)


def embed_queries(
    fixtures: list[Fixture],
    *,
    query_transform: str | None,
    mask: WatermarkMask,
    encoder: RawVisualFrozenEncoder,
    adapter,
    device,
) -> np.ndarray:
    images = []
    try:
        for fixture in fixtures:
            with Image.open(fixture.image_path) as handle:
                image = handle.convert("RGB")
            images.append(QUERY_TRANSFORMS[query_transform](image, mask) if query_transform else image)
        embeddings = encoder.embed_images(images, batch_size=max(1, len(images)))
    finally:
        for image in images:
            image.close()
    if adapter is not None:
        embeddings = project_embeddings_numpy(adapter, embeddings, device=device, batch_size=max(1, len(embeddings)))
    return np.asarray(embeddings, dtype=np.float32)


def score_query(index: ArmIndex, query: np.ndarray, true_card_id: str, top_k: int) -> dict[str, Any]:
    norm = float(np.linalg.norm(query))
    if norm == 0:
        raise ValueError("Query embedding has zero norm")
    scores = index.matrix @ (query / norm)

    true_rows = [row for row, card_id in enumerate(index.card_ids) if card_id == true_card_id]
    if not true_rows:
        raise SystemExit(f"{true_card_id} is not in the {index.name} gallery")
    true_score = float(max(scores[row] for row in true_rows))
    # Rank over the WHOLE gallery, not a truncated top-k, so a miss still has a number.
    rank = int((scores > true_score).sum()) + 1

    order = np.argsort(scores)[::-1][:top_k]
    return {
        "rank": rank,
        "trueSimilarity": round(true_score, 4),
        "top1CardId": index.card_ids[int(order[0])],
        "top1Similarity": round(float(scores[order[0]]), 4),
        "topHits": [
            {"cardId": index.card_ids[int(row)], "similarity": round(float(scores[row]), 4)} for row in order
        ],
    }


def main() -> None:
    args = parse_args()
    game = args.game.strip().lower()
    if args.mask_from_pair:
        mask = oracle_mask_from_pair(game, args.mask_from_pair)
        print(
            f"[mask] oracle from pair: coverage={mask.coverage:.4f} peak={mask.peak_alpha:.3f} "
            f"meanAlphaWherePresent={mask.mean_alpha_where_present:.3f}",
            flush=True,
        )
    else:
        mask = resolve_mask(game, sample_size=args.mask_sample, refit=args.refit_mask)

    if args.mask_report:
        print_mask_report(game, mask)
        return

    fixtures = load_fixtures(args)
    if not fixtures:
        raise SystemExit("No queries. Pass --query PATH=CARD_ID or --fixtures FILE.")

    arm_names = [name.strip() for name in args.arms.split(",") if name.strip()]
    unknown = [name for name in arm_names if name not in ARMS]
    if unknown:
        raise SystemExit(f"Unknown arms {unknown}; expected any of {list(ARMS)}")

    manifest = json.loads(source_manifest_path(game).read_text())
    device = resolve_torch_device(args.device)
    encoder = RawVisualFrozenEncoder(model_id=args.model_id, device=args.device)

    # The active index is adapter-projected, so every arm must be too or the
    # numbers are not comparable.
    adapter = None
    adapter_path = manifest.get("adapterCheckpointPath")
    if adapter_path and Path(adapter_path).exists():
        adapter = load_projection_adapter(Path(adapter_path), embedding_dim=encoder.embedding_dim, device=device)
        print(f"[setup] adapter {adapter_path}", flush=True)
    else:
        print(f"[setup] WARNING: no adapter at {adapter_path!r}; arms are base-embedding only", flush=True)

    results: dict[str, list[dict[str, Any]]] = {}
    for arm in arm_names:
        reference_transform, query_transform = ARMS[arm]
        index = build_arm_index(
            arm=arm,
            game=game,
            manifest=manifest,
            reference_transform=reference_transform,
            mask=mask,
            encoder=encoder,
            adapter=adapter,
            device=device,
            batch_size=args.batch_size,
            rebuild=args.rebuild_index,
        )
        queries = embed_queries(
            fixtures,
            query_transform=query_transform,
            mask=mask,
            encoder=encoder,
            adapter=adapter,
            device=device,
        )
        results[arm] = [
            {
                "label": fixture.label,
                "imagePath": str(fixture.image_path),
                "trueCardId": fixture.provider_card_id,
                **score_query(index, queries[position], fixture.provider_card_id, args.top_k),
            }
            for position, fixture in enumerate(fixtures)
        ]

    report_summary(game, mask, fixtures, arm_names, results, len(manifest["entries"]))

    if args.json_out:
        args.json_out.parent.mkdir(parents=True, exist_ok=True)
        args.json_out.write_text(
            json.dumps(
                {
                    "game": game,
                    "galleryCount": len(manifest["entries"]),
                    "modelId": args.model_id,
                    "mask": {
                        "sampleSize": mask.sample_size,
                        "coverage": round(mask.coverage, 4),
                        "peakAlpha": round(mask.peak_alpha, 4),
                    },
                    "arms": results,
                },
                indent=2,
            )
            + "\n"
        )
        print(f"\nWrote {args.json_out}")


def report_summary(
    game: str,
    mask: WatermarkMask,
    fixtures: list[Fixture],
    arm_names: list[str],
    results: dict[str, list[dict[str, Any]]],
    gallery_count: int,
) -> None:
    print(f"\n=== {game} — {len(fixtures)} queries against {gallery_count} gallery entries ===")
    print(
        f"mask source={mask.source} coverage={mask.coverage:.4f} peak={mask.peak_alpha:.3f} "
        f"meanAlpha={mask.mean_alpha_where_present:.3f} sample={mask.sample_size}\n"
    )

    label_width = max(len(fixture.label) for fixture in fixtures)
    header = f"{'query':<{label_width}}  " + "  ".join(f"{arm:>16}" for arm in arm_names)
    print(header)
    print("-" * len(header))
    for position, fixture in enumerate(fixtures):
        cells = []
        for arm in arm_names:
            row = results[arm][position]
            cells.append(f"{('#' + str(row['rank'])):>5} {row['trueSimilarity']:.4f}".rjust(16))
        print(f"{fixture.label:<{label_width}}  " + "  ".join(cells))

    print("\naggregate")
    print(f"{'arm':<10}{'top1':>8}{'top5':>8}{'top10':>8}{'medRank':>9}{'MRR':>8}")
    for arm in arm_names:
        ranks = np.asarray([row["rank"] for row in results[arm]], dtype=np.float64)
        print(
            f"{arm:<10}{(ranks == 1).mean():>8.3f}{(ranks <= 5).mean():>8.3f}"
            f"{(ranks <= 10).mean():>8.3f}{np.median(ranks):>9.1f}{(1.0 / ranks).mean():>8.3f}"
        )

    print("\ntop-1 hit per query")
    for position, fixture in enumerate(fixtures):
        print(f"  {fixture.label} (true {fixture.provider_card_id})")
        for arm in arm_names:
            row = results[arm][position]
            print(f"    {arm:<9} -> {row['top1CardId']:<24} {row['top1Similarity']:.4f}")


if __name__ == "__main__":
    main()
