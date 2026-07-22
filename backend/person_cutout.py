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


def extract_person_cutout_png(jpeg_bytes: bytes) -> bytes | None:
    """Person cutout of the selfie as PNG-with-alpha bytes, or None.

    Best-effort by design: any failure (missing model, decode error, inference
    error) returns None and the app falls back to the plain crossfade morph.
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

        # Model forward: 320x320, ImageNet-normalized, NCHW.
        resized = source.resize((_MODEL_INPUT_SIDE, _MODEL_INPUT_SIDE), Image.LANCZOS)
        array = np.asarray(resized, dtype=np.float32) / 255.0
        array = (array - np.array([0.485, 0.456, 0.406], dtype=np.float32)) / np.array(
            [0.229, 0.224, 0.225], dtype=np.float32
        )
        tensor = array.transpose(2, 0, 1)[np.newaxis, ...]
        input_name = session.get_inputs()[0].name
        prediction = session.run(None, {input_name: tensor})[0][0][0]

        # Min-max normalize the saliency map into a soft alpha matte.
        minimum = float(prediction.min())
        maximum = float(prediction.max())
        if maximum - minimum < 1e-6:
            return None
        matte = ((prediction - minimum) / (maximum - minimum) * 255.0).astype(np.uint8)

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
        return buffer.getvalue()
    except Exception:  # noqa: BLE001
        logger.exception("person_cutout: extraction failed")
        return None
