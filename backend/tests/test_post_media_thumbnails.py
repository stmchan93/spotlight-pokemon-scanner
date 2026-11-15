from __future__ import annotations

import io
import sys
import unittest
from http import HTTPStatus
from pathlib import Path
from unittest.mock import Mock

BACKEND_ROOT = Path(__file__).resolve().parents[1]
TESTS_ROOT = Path(__file__).resolve().parent

for root in (BACKEND_ROOT, TESTS_ROOT):
    if str(root) not in sys.path:
        sys.path.insert(0, str(root))

from PIL import Image  # noqa: E402

import post_media_thumbnails  # noqa: E402
from post_media_thumbnails import (  # noqa: E402
    PostMediaThumbnailCache,
    parse_thumb_width,
    resize_post_media,
)
from request_auth import RequestIdentity  # noqa: E402
from test_post_media_serving import (  # noqa: E402
    AUTHOR_USER_ID,
    STORAGE_PATH,
    VALID_MEDIA_ID,
    make_post_media_get_handler,
)


def _jpeg(width: int, height: int) -> bytes:
    out = io.BytesIO()
    Image.new("RGB", (width, height), (200, 40, 90)).save(out, format="JPEG")
    return out.getvalue()


ORIGINAL = _jpeg(1080, 1440)


class ParseThumbWidthTests(unittest.TestCase):
    def test_snaps_up_to_allowlist_and_clamps(self) -> None:
        self.assertEqual(parse_thumb_width("144"), 160)
        self.assertEqual(parse_thumb_width("160"), 160)
        self.assertEqual(parse_thumb_width("161"), 320)
        self.assertEqual(parse_thumb_width("360"), 480)
        self.assertEqual(parse_thumb_width("5000"), 640)

    def test_invalid_means_original(self) -> None:
        for raw in [None, "", "abc", "0", "-5", "1.5"]:
            self.assertIsNone(parse_thumb_width(raw), raw)


class ResizeTests(unittest.TestCase):
    def test_keeps_aspect_ratio_as_jpeg(self) -> None:
        body = resize_post_media(ORIGINAL, 320)
        assert body is not None
        with Image.open(io.BytesIO(body)) as image:
            self.assertEqual(image.format, "JPEG")
            self.assertEqual(image.size, (320, 427))

    def test_never_upscales(self) -> None:
        body = resize_post_media(_jpeg(100, 200), 640)
        assert body is not None
        with Image.open(io.BytesIO(body)) as image:
            self.assertEqual(image.size, (100, 200))

    def test_undecodable_bytes_return_none(self) -> None:
        self.assertIsNone(resize_post_media(b"not an image", 160))


class CacheTests(unittest.TestCase):
    def test_lru_evicts_oldest_over_budget(self) -> None:
        cache = PostMediaThumbnailCache(budget_bytes=10)
        cache.put("a", 160, b"12345")
        cache.put("b", 160, b"12345")
        self.assertIsNotNone(cache.get("a", 160))  # a is now most recent
        cache.put("c", 160, b"12345")
        self.assertIsNone(cache.get("b", 160))
        self.assertEqual(cache.get("a", 160), b"12345")
        self.assertEqual(cache.get("c", 160), b"12345")

    def test_width_is_part_of_the_key(self) -> None:
        cache = PostMediaThumbnailCache()
        cache.put("a", 160, b"small")
        self.assertIsNone(cache.get("a", 320))


class ThumbnailEndpointTests(unittest.TestCase):
    def setUp(self) -> None:
        post_media_thumbnails.post_media_thumbnail_cache.clear()

    def _handler(self, path: str, store: Mock, *, authorized: bool = True):
        service = Mock()
        service.post_media_store = store
        handler, captured = make_post_media_get_handler(path=path, service=service)
        handler._require_request_identity = lambda: RequestIdentity(  # type: ignore[method-assign]
            user_id=AUTHOR_USER_ID, auth_source="test"
        )
        row = {"storage_path": STORAGE_PATH, "moderation_status": "approved"}
        handler._fetch_authorized_post_media_row = (  # type: ignore[method-assign]
            lambda media_id, caller: row if authorized else None
        )
        return handler, captured

    def test_width_serves_resized_jpeg_and_caches_it(self) -> None:
        store = Mock()
        store.read_bytes.return_value = ORIGINAL
        path = f"/api/v1/post-media/{VALID_MEDIA_ID}?w=144"

        handler, first = self._handler(path, store)
        handler.do_GET()
        self.assertEqual(first["status"], HTTPStatus.OK)
        self.assertEqual(first["content_type"], "image/jpeg")
        with Image.open(io.BytesIO(first["body"])) as image:  # type: ignore[arg-type]
            self.assertEqual(image.width, 160)

        # Repeat request (incl. the client's retry cache-buster) never re-reads
        # the bucket.
        handler, second = self._handler(f"{path}&retry=1", store)
        handler.do_GET()
        self.assertEqual(second["body"], first["body"])
        store.read_bytes.assert_called_once_with(STORAGE_PATH)

    def test_cache_hit_still_requires_authorization(self) -> None:
        store = Mock()
        store.read_bytes.return_value = ORIGINAL
        path = f"/api/v1/post-media/{VALID_MEDIA_ID}?w=160"
        handler, _ = self._handler(path, store)
        handler.do_GET()

        handler, captured = self._handler(path, store, authorized=False)
        handler.do_GET()
        self.assertEqual(captured["status"], HTTPStatus.NOT_FOUND)
        self.assertNotIn("body", captured)

    def test_no_width_serves_original(self) -> None:
        store = Mock()
        store.read_bytes.return_value = ORIGINAL
        handler, captured = self._handler(f"/api/v1/post-media/{VALID_MEDIA_ID}", store)
        handler.do_GET()
        self.assertEqual(captured["body"], ORIGINAL)

    def test_undecodable_original_falls_back_to_original_bytes(self) -> None:
        store = Mock()
        store.read_bytes.return_value = b"\xff\xd8junk"
        handler, captured = self._handler(
            f"/api/v1/post-media/{VALID_MEDIA_ID}?w=320", store
        )
        handler.do_GET()
        self.assertEqual(captured["status"], HTTPStatus.OK)
        self.assertEqual(captured["body"], b"\xff\xd8junk")


if __name__ == "__main__":
    unittest.main()
