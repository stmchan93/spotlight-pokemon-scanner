"""On-VM person segmentation for the "Who's That Pokemon" morph.

Extracts a person cutout (PNG with alpha) from the selfie so the app's morph
animation can literally grab the user's outline and dissolve THEM into the
matched species — instead of crossfading two unrelated rectangles.

Implementation: U^2-Netp (the 4.7 MB "portable" U-2-Net salient-object model)
run directly through onnxruntime — both onnxruntime and Pillow are already VM
dependencies for the scanner, so this adds zero new packages. The model file
is fetched lazily on first use and cached next to the other model artifacts.

HARD PRIVACY RULE (same as the rest of the whos-that lane): selfie bytes live
in memory only for the lifetime of the request. Never write them to disk, a
database, or logs. The only disk artifact is the public model file itself.
"""

from __future__ import annotations

import io
import logging
import threading
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

# Official rembg model mirror (stable release asset, versioned tag).
_MODEL_URL = "https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2netp.onnx"
_MODEL_FILENAME = "u2netp.onnx"
# U^2-Net's fixed input resolution.
_MODEL_INPUT_SIDE = 320
# Longest side of the returned cutout — big enough for a full-screen morph
# layer, small enough that the base64 payload stays a few hundred KB.
_CUTOUT_MAX_SIDE = 512

# --- Geometry tuning (see person_geometry_from_mask) -------------------------
# Alpha (0..255) above which a matte pixel counts as "person".
_ALPHA_THRESHOLD = 128
# A row/column is only part of the body once it carries this fraction of the
# busiest row/column — kills the salt-and-pepper speckle u2netp leaves in
# corners, which would otherwise blow the bbox out to the whole frame.
_SPECKLE_FRACTION = 0.02
# ...and never fewer than this many pixels, so the fraction can't round down to
# "one stray pixel counts" on a narrow subject.
_MIN_LINE_PIXELS = 2
# Below this share of the frame the matte is noise, not a person.
_MIN_MASK_COVERAGE = 0.002
# Top slice of the person bbox used to measure the head's reference width.
_HEAD_REFERENCE_BAND = 0.12
# A row this much wider than the head reference is shoulders, not head.
_SHOULDER_WIDEN_FACTOR = 1.6
# Only look for shoulders in the top part of the person bbox.
_SHOULDER_SEARCH_LIMIT = 0.6
# Head height / head width for an adult head including hair (anthropometric).
_HEAD_ASPECT = 1.35

_session_lock = threading.Lock()
_session: Any | None = None
_session_failed = False


def _model_path() -> Path:
    return Path(__file__).resolve().parent / "models" / _MODEL_FILENAME


def _ensure_model_file() -> Path | None:
    path = _model_path()
    if path.exists() and path.stat().st_size > 1_000_000:
        return path
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_suffix(".onnx.download")
    try:
        logger.info("person_cutout: downloading %s to %s", _MODEL_URL, path)
        with urllib.request.urlopen(_MODEL_URL, timeout=30) as response:
            tmp_path.write_bytes(response.read())
        tmp_path.rename(path)
        return path
    except Exception:  # noqa: BLE001 — cutouts are best-effort garnish
        logger.exception("person_cutout: model download failed")
        tmp_path.unlink(missing_ok=True)
        return None


def _get_session() -> Any | None:
    """Lazy singleton onnxruntime session; None (sticky) when unavailable."""
    global _session, _session_failed
    if _session is not None or _session_failed:
        return _session
    with _session_lock:
        if _session is not None or _session_failed:
            return _session
        try:
            import onnxruntime  # noqa: PLC0415 — heavy import stays lazy

            path = _ensure_model_file()
            if path is None:
                _session_failed = True
                return None
            _session = onnxruntime.InferenceSession(
                str(path), providers=["CPUExecutionProvider"]
            )
        except Exception:  # noqa: BLE001
            logger.exception("person_cutout: session init failed")
            _session_failed = True
            return None
    return _session


@dataclass(frozen=True)
class PersonCutout:
    """One segmentation pass, two products.

    `png_bytes`  — the RGBA cutout for the morph layer.
    `person_bounds` / `head_box` — normalized 0..1 boxes in ORIGINAL SELFIE
    space (see person_geometry_from_mask). Either may be None when the matte is
    too noisy/empty to place a body; `png_bytes` is always present.
    """

    png_bytes: bytes
    person_bounds: dict[str, float] | None
    head_box: dict[str, float] | None


def _normalized_box(
    left: float,
    top: float,
    width: float,
    height: float,
    mask_width: int,
    mask_height: int,
) -> dict[str, float]:
    """MASK space (pixel cols/rows) -> NORMALIZED ORIGINAL-IMAGE space (0..1).

    The mask is a whole-frame square resize of the selfie, so a column index
    divided by the mask width is exactly the same fraction-across-the-image as
    the corresponding original pixel column divided by the original width. The
    square resize distorts aspect, but NOT normalized position — which is why
    the original pixel dimensions are needed only where a real-world aspect
    ratio is involved (the head-height fallback), never here.
    """
    x = min(max(left / mask_width, 0.0), 1.0)
    y = min(max(top / mask_height, 0.0), 1.0)
    w = min(max(width / mask_width, 0.0), 1.0 - x)
    h = min(max(height / mask_height, 0.0), 1.0 - y)
    return {
        "x": round(x, 4),
        "y": round(y, 4),
        "width": round(w, 4),
        "height": round(h, 4),
    }


def _trimmed_span(counts: Any) -> tuple[int, int] | None:
    """First/last index of `counts` that carries more than speckle, or None."""
    import numpy as np  # noqa: PLC0415

    if counts.size == 0:
        return None
    peak = int(counts.max())
    if peak <= 0:
        return None
    threshold = min(peak, max(_MIN_LINE_PIXELS, int(round(_SPECKLE_FRACTION * peak))))
    index = np.flatnonzero(counts >= threshold)
    if index.size == 0:
        return None
    return int(index[0]), int(index[-1])


def person_geometry_from_mask(
    mask: Any, source_width: int, source_height: int
) -> tuple[dict[str, float] | None, dict[str, float] | None]:
    """Person bbox + estimated head box from an alpha matte.

    COORDINATE SPACES (the easy thing to get subtly wrong):
      * `mask` is in MASK space — a 2D uint8 alpha map covering the WHOLE
        frame (u2netp's 320x320 square resize of the selfie).
      * `source_width` / `source_height` are the ORIGINAL selfie pixel dims.
        They are used only to undo the square resize's aspect distortion when
        converting a measured head WIDTH into an estimated head HEIGHT.
      * Both returned boxes are NORMALIZED 0..1 against the ORIGINAL selfie —
        not pixels, and not relative to the returned cutout PNG (which is a
        downscale of that same frame, so the fractions hold for it too). The
        client can multiply them straight through by its display rect.
        No EXIF transpose is applied anywhere in this module, so the boxes
        match the raw decoded orientation of the selfie the client sent.

    HEAD-BOX HEURISTIC: measure the mask's horizontal extent per row. Take the
    median extent over the top `_HEAD_REFERENCE_BAND` of the person bbox as the
    head width (median, not max, so a stray hair wisp or antenna doesn't win).
    Walk down; the first row wider than `_SHOULDER_WIDEN_FACTOR` x that width
    is the shoulder line, and the head ends one row above it. If no such
    widening exists in the top `_SHOULDER_SEARCH_LIMIT` of the body (tight
    head-only crops, hooded/long-haired subjects whose silhouette never steps
    out), fall back to head_height = head_width * _HEAD_ASPECT converted
    through the original image aspect; and only if that measured width is
    itself unusable, to the classic ~1/7-of-body-height rule.

    KNOWN FAILURE MODES (all degrade to a plausible box, never an exception):
      * A hand/arm raised beside the face inflates the reference width, so the
        shoulder test trips late and the head box runs long.
      * Long hair, hoods, and hats are inside the silhouette, so the box covers
        hair-plus-face rather than the skull. That is what we want for a mesh
        that locks onto the visible head, but it sits low for big hair.
      * u2netp is a SALIENT-object model, not a person detector: a held card,
        a pet, or a high-contrast background object can own the matte, and the
        boxes then describe that object.
      * A reclining subject, or a landscape selfie whose EXIF rotation we do
        not apply, breaks the "head is at the top" assumption outright.
      * Two people merge into one bbox; the head box lands on whoever is
        topmost, or between them.
    """
    try:
        import numpy as np  # noqa: PLC0415

        array = np.asarray(mask)
        if array.ndim != 2 or array.size == 0:
            return None, None
        if source_width <= 0 or source_height <= 0:
            return None, None

        binary = array >= _ALPHA_THRESHOLD
        mask_height, mask_width = int(binary.shape[0]), int(binary.shape[1])
        if int(binary.sum()) < max(1, int(_MIN_MASK_COVERAGE * binary.size)):
            return None, None

        # Tight bbox, with speckle-only rows/columns trimmed off.
        row_span = _trimmed_span(binary.sum(axis=1))
        col_span = _trimmed_span(binary.sum(axis=0))
        if row_span is None or col_span is None:
            return None, None
        top, bottom = row_span
        left, right = col_span
        person_height = bottom - top + 1
        person_width = right - left + 1
        if person_height <= 0 or person_width <= 0:
            return None, None
        person_bounds = _normalized_box(
            left, top, person_width, person_height, mask_width, mask_height
        )

        # Per-row horizontal extent (first..last person pixel in that row),
        # measured inside the trimmed bbox so leftover speckle columns outside
        # the body can't fake a wide row.
        body = binary[:, left : right + 1]
        first_col = np.argmax(body, axis=1)
        last_col = body.shape[1] - 1 - np.argmax(body[:, ::-1], axis=1)
        extents = np.where(body.any(axis=1), last_col - first_col + 1, 0)

        band = max(1, int(round(person_height * _HEAD_REFERENCE_BAND)))
        band_rows = extents[top : min(top + band, bottom + 1)]
        band_rows = band_rows[band_rows > 0]
        head_width_ref = float(np.median(band_rows)) if band_rows.size else 0.0

        shoulder_row: int | None = None
        if head_width_ref > 0:
            search_end = min(
                bottom + 1, top + max(1, int(round(person_height * _SHOULDER_SEARCH_LIMIT)))
            )
            for row in range(min(top + band, search_end), search_end):
                if extents[row] > head_width_ref * _SHOULDER_WIDEN_FACTOR:
                    shoulder_row = row
                    break

        if shoulder_row is not None:
            head_bottom = shoulder_row - 1
        elif head_width_ref > 0:
            # Aspect care: head_width_ref is in mask columns. Convert to a
            # normalized width, apply the real-world head aspect in ORIGINAL
            # pixel space, then convert the resulting normalized height back
            # into mask rows. Skipping the source_width/source_height term
            # here would silently stretch the head box on non-square selfies.
            head_width_norm = head_width_ref / mask_width
            head_height_norm = head_width_norm * (source_width / source_height) * _HEAD_ASPECT
            head_bottom = top + max(1, int(round(head_height_norm * mask_height))) - 1
        else:
            head_bottom = top + max(1, int(round(person_height / 7.0))) - 1
        head_bottom = max(top, min(head_bottom, bottom))

        # Horizontal extent of the head band only (a tilted head shifts off the
        # body's centre line), speckle-trimmed the same way as the body bbox.
        head_span = _trimmed_span(binary[top : head_bottom + 1].sum(axis=0))
        if head_span is None:
            head_left, head_right = left, right
        else:
            head_left = max(left, head_span[0])
            head_right = min(right, head_span[1])
        if head_right < head_left:
            head_left, head_right = left, right

        head_box = _normalized_box(
            head_left,
            top,
            head_right - head_left + 1,
            head_bottom - top + 1,
            mask_width,
            mask_height,
        )
        return person_bounds, head_box
    except Exception:  # noqa: BLE001 — geometry is best-effort garnish too
        logger.exception("person_cutout: geometry failed")
        return None, None


def extract_person_cutout(jpeg_bytes: bytes) -> PersonCutout | None:
    """Segment the selfie once; return the cutout PNG plus its geometry.

    Best-effort by design: any failure (missing model, decode error, inference
    error) returns None and the app falls back to the plain crossfade morph
    with proportional placement. Never raises into the request path.

    HARD PRIVACY RULE: nothing here touches disk except the public model file.
    """
    if not jpeg_bytes:
        return None
    session = _get_session()
    if session is None:
        return None
    try:
        import numpy as np  # noqa: PLC0415
        from PIL import Image  # noqa: PLC0415

        with Image.open(io.BytesIO(jpeg_bytes)) as decoded:
            source = decoded.convert("RGB")
            source.load()
        # ORIGINAL selfie pixel dims — the reference frame every normalized
        # coordinate below is expressed against. Captured before any resize.
        source_width, source_height = source.size

        # Model forward: 320x320, ImageNet-normalized, NCHW.
        resized = source.resize((_MODEL_INPUT_SIDE, _MODEL_INPUT_SIDE), Image.LANCZOS)
        array = np.asarray(resized, dtype=np.float32) / 255.0
        array = (array - np.array([0.485, 0.456, 0.406], dtype=np.float32)) / np.array(
            [0.229, 0.224, 0.225], dtype=np.float32
        )
        tensor = array.transpose(2, 0, 1)[np.newaxis, ...]
        input_name = session.get_inputs()[0].name
        prediction = session.run(None, {input_name: tensor})[0][0][0]

        # Min-max normalize the saliency map into a soft alpha matte. This is
        # the single mask both the PNG and the geometry are derived from.
        minimum = float(prediction.min())
        maximum = float(prediction.max())
        if maximum - minimum < 1e-6:
            return None
        matte = ((prediction - minimum) / (maximum - minimum) * 255.0).astype(np.uint8)

        person_bounds, head_box = person_geometry_from_mask(
            matte, source_width, source_height
        )

        # Downscale the photo for the cutout payload, then apply the matte.
        scale = _CUTOUT_MAX_SIDE / max(source.size)
        if scale < 1.0:
            cutout_size = (
                max(1, round(source.size[0] * scale)),
                max(1, round(source.size[1] * scale)),
            )
            source = source.resize(cutout_size, Image.LANCZOS)
        alpha = Image.fromarray(matte, mode="L").resize(source.size, Image.LANCZOS)
        cutout = source.convert("RGBA")
        cutout.putalpha(alpha)

        buffer = io.BytesIO()
        cutout.save(buffer, format="PNG", optimize=True)
        return PersonCutout(
            png_bytes=buffer.getvalue(),
            person_bounds=person_bounds,
            head_box=head_box,
        )
    except Exception:  # noqa: BLE001
        logger.exception("person_cutout: extraction failed")
        return None


def extract_person_cutout_png(jpeg_bytes: bytes) -> bytes | None:
    """Person cutout of the selfie as PNG-with-alpha bytes, or None.

    Thin wrapper kept for callers that only want the pixels; the geometry is
    computed either way and is essentially free next to the model forward.
    """
    result = extract_person_cutout(jpeg_bytes)
    return result.png_bytes if result is not None else None
