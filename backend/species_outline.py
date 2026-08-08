"""Silhouette outline points for the "Who's That Pokemon" reveal.

The app's reveal animation flies the face-mesh landmarks measured on the user
outward and settles them into the shape of the matched species, which then
fills to the classic black silhouette. React Native has no pixel access
(no Skia dependency here), so the outline has to be measured on the backend
from the official artwork's alpha channel and shipped as points.

Method: alpha centroid + evenly spaced radial rays. For each of N angles we
walk outward and keep the FURTHEST sample still inside the silhouette, which
traces the outer boundary and steps over the transparent gaps between limbs
instead of stopping at the first one. The result is angularly ordered and
roughly evenly distributed around the shape — exactly what a scattered point
cloud needs to animate into something recognizable. It under-resolves deep
concavities (the notch between Charizard's wings reads as a chord, not a
notch); a true contour trace would need OpenCV or scikit-image, neither of
which is a dependency, and the extra fidelity buys nothing for a point-cloud
morph that is in motion the whole time it is on screen.

Only public artwork is touched here. No selfie bytes ever reach this module.
"""

from __future__ import annotations

import io
import json
import logging
import math
import threading
from pathlib import Path
from typing import Any

from whos_that_share_card import artwork_cache_dir, fetch_official_artwork

logger = logging.getLogger(__name__)

# Number of rays / returned points. 48 keeps the payload tiny (~1 KB) while
# still reading as a silhouette once the client connects the dots.
OUTLINE_POINT_COUNT = 48
# Alpha (0..255) above which an artwork pixel counts as part of the creature.
_ALPHA_THRESHOLD = 128
# Below this share of the frame the artwork is empty/degenerate, not a shape.
_MIN_ALPHA_COVERAGE = 0.005
# A ray that finds nothing is dropped; too many misses means the shape is junk.
_MIN_HIT_RATIO = 0.5
# Short leash on the cache-miss download: the reveal is better off without an
# outline than the request is with a stalled artwork fetch.
_ARTWORK_FETCH_TIMEOUT_SECONDS = 5
# Sibling of the artwork cache (same dataset-root convention as the share card).
_OUTLINE_CACHE_SUFFIX = ".outline.json"
_OUTLINE_CACHE_VERSION = 1

# Process-level memo in front of the disk cache: the outline is deterministic
# per pokedex id, so the same species never gets recomputed in a warm process.
_memo_lock = threading.Lock()
_memo: dict[int, list[dict[str, float]] | None] = {}


def _outline_cache_path(pokedex_id: int, dataset_root: Path) -> Path:
    return artwork_cache_dir(dataset_root) / f"{int(pokedex_id)}{_OUTLINE_CACHE_SUFFIX}"


def _read_cached_outline(path: Path) -> list[dict[str, float]] | None:
    try:
        if not path.exists():
            return None
        document = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(document, dict):
            return None
        if int(document.get("version") or 0) != _OUTLINE_CACHE_VERSION:
            return None
        points = document.get("points")
        if not isinstance(points, list) or not points:
            return None
        return [
            {"x": float(point["x"]), "y": float(point["y"])}
            for point in points
            if isinstance(point, dict) and "x" in point and "y" in point
        ] or None
    except Exception:  # noqa: BLE001 — a corrupt cache just means recompute
        logger.warning("species_outline: unreadable outline cache at %s", path)
        return None


def _write_cached_outline(path: Path, points: list[dict[str, float]]) -> None:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps({"version": _OUTLINE_CACHE_VERSION, "points": points}),
            encoding="utf-8",
        )
    except Exception:  # noqa: BLE001 — caching is an optimization, not a contract
        logger.warning("species_outline: could not write outline cache at %s", path)


def _alpha_from_artwork(artwork_bytes: bytes) -> Any | None:
    """Alpha channel of the artwork as a 2D array, or None when it has none.

    A silhouette needs real transparency; an artwork stored without an alpha
    band would ray-cast to the frame rectangle, which is worse than omitting
    the outline entirely.
    """
    import numpy as np  # noqa: PLC0415
    from PIL import Image  # noqa: PLC0415

    with Image.open(io.BytesIO(artwork_bytes)) as decoded:
        has_alpha = "A" in decoded.getbands() or (
            decoded.mode == "P" and "transparency" in decoded.info
        )
        if not has_alpha:
            logger.info("species_outline: artwork has no alpha channel")
            return None
        return np.asarray(decoded.convert("RGBA").getchannel("A"))


def outline_points_from_alpha(alpha: Any) -> list[dict[str, float]] | None:
    """Ordered silhouette points from an alpha channel array.

    COORDINATE SPACE: `alpha` is a 2D array indexed [row, col] over the WHOLE
    artwork image. The returned points are NORMALIZED 0..1 against THAT
    artwork image — x = col / artwork_width, y = row / artwork_height, origin
    top-left, y increasing downward. They are NOT in selfie space, NOT in
    share-card space, and NOT pixels; the client maps them onto whatever rect
    it draws the species into.

    ORDER: angle 0 points at +x (right of the centroid) and angles increase
    toward +y, which is DOWN in image space — so the points run clockwise
    on screen, starting at 3 o'clock. Ordering is stable, which is what lets
    the client animate landmarks into neighbouring outline slots.

    Returns None for an empty/degenerate mask rather than raising.
    """
    try:
        import numpy as np  # noqa: PLC0415

        array = np.asarray(alpha)
        if array.ndim != 2 or array.size == 0:
            return None
        height, width = int(array.shape[0]), int(array.shape[1])
        if height < 2 or width < 2:
            return None

        inside = array >= _ALPHA_THRESHOLD
        if int(inside.sum()) < max(1, int(_MIN_ALPHA_COVERAGE * inside.size)):
            return None

        rows, cols = np.nonzero(inside)
        centre_x = float(cols.mean())
        centre_y = float(rows.mean())

        # Sample every ray at 1-px steps out to the far corner of the frame.
        max_radius = int(math.ceil(math.hypot(width, height)))
        radii = np.arange(0.0, float(max_radius) + 1.0, 1.0)
        angles = np.linspace(0.0, 2.0 * math.pi, OUTLINE_POINT_COUNT, endpoint=False)
        sample_x = centre_x + np.cos(angles)[:, None] * radii[None, :]
        sample_y = centre_y + np.sin(angles)[:, None] * radii[None, :]
        in_frame = (
            (sample_x >= 0.0)
            & (sample_x <= width - 1)
            & (sample_y >= 0.0)
            & (sample_y <= height - 1)
        )
        sample_cols = np.clip(np.rint(sample_x).astype(int), 0, width - 1)
        sample_rows = np.clip(np.rint(sample_y).astype(int), 0, height - 1)
        hits = inside[sample_rows, sample_cols] & in_frame

        # Furthest hit per ray = outer boundary (interior gaps are stepped over).
        any_hit = hits.any(axis=1)
        if int(any_hit.sum()) < max(3, int(_MIN_HIT_RATIO * OUTLINE_POINT_COUNT)):
            return None
        last_hit = hits.shape[1] - 1 - np.argmax(hits[:, ::-1], axis=1)

        points: list[dict[str, float]] = []
        for index in range(OUTLINE_POINT_COUNT):
            if not bool(any_hit[index]):
                continue
            edge = int(last_hit[index])
            x = min(max(float(sample_x[index, edge]), 0.0), float(width - 1))
            y = min(max(float(sample_y[index, edge]), 0.0), float(height - 1))
            points.append({"x": round(x / width, 4), "y": round(y / height, 4)})
        return points or None
    except Exception:  # noqa: BLE001 — outlines are best-effort garnish
        logger.exception("species_outline: point extraction failed")
        return None


def species_outline(pokedex_id: int, *, dataset_root: Path) -> list[dict[str, float]] | None:
    """Ordered, normalized outline points for a species, or None.

    Cached twice over: an in-process memo (including negative results, so a
    404'd species is not re-fetched every request) in front of a JSON file
    beside the artwork PNG the share card already caches.

    Best-effort by design: fetch failure, artwork without an alpha channel, or
    a degenerate mask all return None and the client falls back. Never raises.
    """
    try:
        key = int(pokedex_id)
    except (TypeError, ValueError):
        return None
    if key < 1:
        return None

    with _memo_lock:
        if key in _memo:
            return _memo[key]

    points: list[dict[str, float]] | None = None
    try:
        root = Path(dataset_root)
        cache_path = _outline_cache_path(key, root)
        points = _read_cached_outline(cache_path)
        if points is None:
            artwork_bytes = fetch_official_artwork(
                key, dataset_root=root, timeout=_ARTWORK_FETCH_TIMEOUT_SECONDS
            )
            alpha = _alpha_from_artwork(artwork_bytes)
            points = outline_points_from_alpha(alpha) if alpha is not None else None
            if points:
                _write_cached_outline(cache_path, points)
    except Exception as exc:  # noqa: BLE001 — outlines are best-effort garnish
        # Memoized below, so a dead/404 species logs once per process, not once
        # per request. No traceback: offline/404 is an expected outcome here.
        logger.warning("species_outline: outline unavailable for %s (%r)", pokedex_id, exc)
        points = None

    with _memo_lock:
        _memo[key] = points
    return points
