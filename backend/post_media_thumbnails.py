"""Resized post-media thumbnails for ``GET /api/v1/post-media/<id>?w=<n>``.

Small surfaces (booth strips, the event "From the floor" row) only need a few
hundred pixels, so the proxy can serve a downscaled JPEG instead of the ~1080px
original. Widths snap to a short allowlist so the cache stays bounded and a
caller cannot ask for arbitrary resize work.

The cache holds resized bytes only, keyed by ``(storage_path, width)``. Post
media is immutable once written (a new image is a new object key), so entries
never go stale. The cache sits AFTER the per-request authorization check: a hit
skips the bucket read and the resize, never the visibility rule.
"""

from __future__ import annotations

import io
import threading
from collections import OrderedDict

POST_MEDIA_THUMB_WIDTHS: tuple[int, ...] = (160, 320, 480, 640)

# ~25-60KB per 320-640px JPEG, so a few hundred recent thumbnails.
_DEFAULT_CACHE_BUDGET_BYTES = 32 * 1024 * 1024
_JPEG_QUALITY = 82


def parse_thumb_width(raw: str | None) -> int | None:
    """``?w=`` → the smallest allowlisted width that covers it, else ``None``.

    ``None`` (absent, non-numeric, non-positive) means "serve the original".
    Anything above the largest width clamps to it.
    """
    try:
        requested = int(str(raw or "").strip())
    except ValueError:
        return None
    if requested <= 0:
        return None
    for width in POST_MEDIA_THUMB_WIDTHS:
        if requested <= width:
            return width
    return POST_MEDIA_THUMB_WIDTHS[-1]


def resize_post_media(image_bytes: bytes, width: int) -> bytes | None:
    """Downscale to ``width`` (aspect kept, never upscaled) as JPEG.

    ``None`` when the bytes don't decode, so the caller can fall back to the
    original instead of failing the request.
    """
    from PIL import Image, ImageOps  # local import: only this lane needs PIL

    try:
        with Image.open(io.BytesIO(image_bytes)) as decoded:
            image = ImageOps.exif_transpose(decoded)
            if image.mode != "RGB":
                image = image.convert("RGB")
            if image.width > width:
                height = max(1, round(image.height * width / image.width))
                image = image.resize((width, height), Image.Resampling.LANCZOS)
            out = io.BytesIO()
            image.save(out, format="JPEG", quality=_JPEG_QUALITY, optimize=True)
            return out.getvalue()
    except Exception:  # noqa: BLE001 - undecodable bytes → serve the original
        return None


class PostMediaThumbnailCache:
    """Thread-safe LRU of resized bytes, bounded by total size."""

    def __init__(self, budget_bytes: int = _DEFAULT_CACHE_BUDGET_BYTES) -> None:
        self._budget = max(0, int(budget_bytes))
        self._entries: OrderedDict[tuple[str, int], bytes] = OrderedDict()
        self._size = 0
        self._lock = threading.Lock()

    def get(self, storage_path: str, width: int) -> bytes | None:
        key = (storage_path, width)
        with self._lock:
            body = self._entries.get(key)
            if body is not None:
                self._entries.move_to_end(key)
            return body

    def put(self, storage_path: str, width: int, body: bytes) -> None:
        if len(body) > self._budget:
            return
        key = (storage_path, width)
        with self._lock:
            previous = self._entries.pop(key, None)
            if previous is not None:
                self._size -= len(previous)
            self._entries[key] = body
            self._size += len(body)
            while self._size > self._budget and self._entries:
                _, evicted = self._entries.popitem(last=False)
                self._size -= len(evicted)

    def clear(self) -> None:
        with self._lock:
            self._entries.clear()
            self._size = 0


post_media_thumbnail_cache = PostMediaThumbnailCache()
