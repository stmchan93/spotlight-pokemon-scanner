"""Per-game reference-image transforms, and the watermark estimation behind them.

Why this module exists
----------------------
Scrydex serves Bandai's official product art for One Piece and Gundam, and that
art carries a semi-transparent white "SAMPLE" stamp. A physical card does not.
The visual index is built from the reference art and queried with a photo, so the
stamp sits on exactly ONE side of the comparison — and that is enough to sink
retrieval. Measured on `onepiece~OP05-119`, same index, same card:

    watermarked query (TCGplayer art) -> rank 1, similarity 0.8987
    real card photographed            -> rank 30, then not in the top 30 at all

Nothing about the index, the ids or the ranking is wrong. The two sides simply do
not live in the same visual domain.

The stamp is recoverable because it is a FIXED alpha mask at a FIXED position:
every card is blended with the same overlay. Where the overlay is opaque the art
underneath is gone, but the measured alpha is ~0.44 (One Piece) and ~0.25
(Gundam), so most of the signal survives and can be divided back out.

Three ways to make the two sides agree, all built on the same estimated mask:

    strip_watermark()  remove the stamp from the reference  (rebuild the index)
    apply_watermark()  add the stamp to the query           (no rebuild needed)
    mask_watermark()   neutralise the region on both sides  (no reconstruction)

Deliberately NOT in `synthetic_capture.DEGRADATIONS`: that registry is
auto-enrolled into the combined "realistic" preset by its tests, and a cleanup
step has no business being applied as a capture degradation. An *additive*
stamp belongs there; removal does not.

Estimation
----------
For a fixed overlay, each output pixel is

    out = (1 - a) * art + 255 * a

so across many cards the stamped pixels have their variance SHRUNK by (1 - a)
and their mean pulled toward white. Assuming the underlying art's variance is
spatially smooth — true enough over a card face — a local baseline recovers it:

    a = 1 - std_observed / std_baseline

That is what `estimate_watermark_mask` fits. Masks are stored in normalized
coordinates because reference images are not one size (600x838 and 640x894 both
occur within One Piece), and are resampled to whatever image they are applied to.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

# The grid masks are fitted and stored on. Card art is ~0.716 aspect; this is
# fine enough to hold glyph edges and small enough to fit quickly.
MASK_GRID_SIZE = (320, 447)  # (width, height)

# Below this the fit is indistinguishable from art noise, and forcing it to zero
# keeps `strip_watermark` from amplifying noise across the whole card.
MIN_SIGNIFICANT_ALPHA = 0.05

# strip_watermark divides by (1 - a). Near a = 1 the art underneath is genuinely
# gone and the division explodes, so the recoverable range is capped.
MAX_INVERTIBLE_ALPHA = 0.85


@dataclass(frozen=True)
class WatermarkMask:
    """A fitted overlay: per-pixel alpha on a normalized grid, plus provenance."""

    game: str
    alpha: np.ndarray  # (h, w) float32 in [0, 1]
    sample_size: int
    source: str = "estimated"

    @property
    def coverage(self) -> float:
        """Fraction of the card carrying a significant stamp."""
        return float((self.alpha >= MIN_SIGNIFICANT_ALPHA).mean())

    @property
    def peak_alpha(self) -> float:
        return float(self.alpha.max())

    @property
    def mean_alpha_where_present(self) -> float:
        present = self.alpha[self.alpha >= MIN_SIGNIFICANT_ALPHA]
        return float(present.mean()) if present.size else 0.0


def _luminance_stack(paths: list[Path], grid: tuple[int, int]) -> np.ndarray:
    frames = []
    for path in paths:
        with Image.open(path) as handle:
            frames.append(
                np.asarray(handle.convert("L").resize(grid, Image.BILINEAR), dtype=np.float32)
            )
    return np.stack(frames)


def estimate_watermark_mask(
    image_paths: list[Path],
    *,
    game: str,
    grid: tuple[int, int] = MASK_GRID_SIZE,
    baseline_radius: int = 24,
) -> WatermarkMask:
    """Fit the overlay's alpha from a sample of that game's reference images.

    Needs enough cards that the art averages out — the stamp is the only thing
    every card shares. Below ~50 the fit starts tracking whatever the sampled art
    happens to have in common.
    """
    if len(image_paths) < 2:
        raise ValueError("Need at least 2 images to estimate a watermark mask")

    stack = _luminance_stack(image_paths, grid)
    observed_std = stack.std(axis=0)

    # What the variance WOULD be here without a stamp. A wide median blur is the
    # right baseline: it ignores the stamp (a minority of any large neighbourhood)
    # while still tracking real structure like a text box or a name plate, which
    # are genuinely low-variance and must NOT be read as watermark.
    baseline = np.asarray(
        Image.fromarray(observed_std.astype(np.float32), mode="F").filter(
            ImageFilter.MedianFilter(size=_odd(baseline_radius))
        ),
        dtype=np.float32,
    )

    with np.errstate(divide="ignore", invalid="ignore"):
        alpha = 1.0 - np.divide(observed_std, baseline, out=np.ones_like(observed_std), where=baseline > 1e-3)
    alpha = np.clip(alpha, 0.0, 1.0)

    # The stamp is WHITE: a low-variance region that is not also brighter than its
    # surroundings is structure, not overlay. This is what keeps Lorcana's text
    # box and One Piece's name plate out of the mask.
    mean_frame = stack.mean(axis=0)
    mean_baseline = np.asarray(
        Image.fromarray(mean_frame, mode="F").filter(ImageFilter.MedianFilter(size=_odd(baseline_radius))),
        dtype=np.float32,
    )
    alpha[mean_frame <= mean_baseline] = 0.0

    # Soften glyph edges so the transforms don't leave a hard rim. PIL's Gaussian
    # rejects mode "F", so this is a small separable box blur.
    alpha = _box_blur(alpha, radius=1)
    alpha[alpha < MIN_SIGNIFICANT_ALPHA] = 0.0
    return WatermarkMask(game=game, alpha=alpha.astype(np.float32), sample_size=len(image_paths))


def _odd(value: int) -> int:
    return value if value % 2 else value + 1


def _box_blur(array: np.ndarray, *, radius: int) -> np.ndarray:
    """Separable box blur with edge replication. Small, and avoids a scipy dep."""
    if radius <= 0:
        return array
    width = 2 * radius + 1
    padded = np.pad(array, radius, mode="edge")
    cumulative = np.cumsum(padded, axis=0)
    rows = (cumulative[width - 1 :] - np.concatenate([np.zeros((1, padded.shape[1]), np.float32), cumulative[: -width]])) / width
    cumulative = np.cumsum(rows, axis=1)
    blurred = (cumulative[:, width - 1 :] - np.concatenate([np.zeros((rows.shape[0], 1), np.float32), cumulative[:, : -width]], axis=1)) / width
    return blurred.astype(np.float32)


def _alpha_for_image(mask: WatermarkMask, size: tuple[int, int]) -> np.ndarray:
    """Resample the normalized mask onto one image's pixel grid."""
    resized = Image.fromarray(mask.alpha, mode="F").resize(size, Image.BILINEAR)
    return np.asarray(resized, dtype=np.float32)[:, :, None]


def strip_watermark(image: Image.Image, mask: WatermarkMask) -> Image.Image:
    """Arm A — undo the blend, so a reference looks like a real card.

    Inverts `out = (1-a)*art + 255a`. Alpha is capped at MAX_INVERTIBLE_ALPHA:
    past that the art underneath is genuinely gone and dividing by (1-a) only
    amplifies whatever noise is left.
    """
    array = np.asarray(image.convert("RGB"), dtype=np.float32)
    alpha = np.clip(_alpha_for_image(mask, image.size), 0.0, MAX_INVERTIBLE_ALPHA)
    recovered = (array - 255.0 * alpha) / np.maximum(1.0 - alpha, 1e-3)
    return Image.fromarray(np.clip(recovered, 0.0, 255.0).astype(np.uint8), mode="RGB")


def apply_watermark(image: Image.Image, mask: WatermarkMask) -> Image.Image:
    """Arm B — stamp a query so it matches an index that is already stamped.

    The cheap arm: it needs no index rebuild, because the existing embeddings
    already carry the overlay.
    """
    array = np.asarray(image.convert("RGB"), dtype=np.float32)
    alpha = _alpha_for_image(mask, image.size)
    blended = (1.0 - alpha) * array + 255.0 * alpha
    return Image.fromarray(np.clip(blended, 0.0, 255.0).astype(np.uint8), mode="RGB")


def mask_watermark(image: Image.Image, mask: WatermarkMask, *, fill: int = 128) -> Image.Image:
    """Arm C — neutralise the stamped region rather than reconstruct it.

    Applied to BOTH sides. No reconstruction error, at the cost of discarding
    whatever is under the stamp.
    """
    array = np.asarray(image.convert("RGB"), dtype=np.float32)
    alpha = _alpha_for_image(mask, image.size)
    hard = (alpha >= MIN_SIGNIFICANT_ALPHA).astype(np.float32)
    return Image.fromarray(
        np.clip(array * (1.0 - hard) + float(fill) * hard, 0.0, 255.0).astype(np.uint8), mode="RGB"
    )


def save_mask(mask: WatermarkMask, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(path, alpha=mask.alpha)
    path.with_suffix(".json").write_text(
        json.dumps(
            {
                "game": mask.game,
                "source": mask.source,
                "sampleSize": mask.sample_size,
                "gridSize": [mask.alpha.shape[1], mask.alpha.shape[0]],
                "coverage": round(mask.coverage, 4),
                "peakAlpha": round(mask.peak_alpha, 4),
                "meanAlphaWherePresent": round(mask.mean_alpha_where_present, 4),
            },
            indent=2,
        )
        + "\n"
    )


def load_mask(path: Path, *, game: str) -> WatermarkMask:
    payload = np.load(path)
    metadata_path = path.with_suffix(".json")
    metadata = json.loads(metadata_path.read_text()) if metadata_path.exists() else {}
    return WatermarkMask(
        game=str(metadata.get("game") or game),
        alpha=payload["alpha"].astype(np.float32),
        sample_size=int(metadata.get("sampleSize") or 0),
        source=str(metadata.get("source") or "estimated"),
    )
