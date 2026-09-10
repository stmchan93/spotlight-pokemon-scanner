"""POST /api/v1/scan/binder-page/prepare — the streamed binder lane.

The page JPEG is uploaded ONCE and split into nine pocket crops stored in an
owner-scoped in-memory token store. The client then issues nine ordinary
single visual-match calls whose ``binderPage`` reference injects the stored
pocket bytes, so each pocket flows through the exact single-scan path (its own
scan_events row, candidates, confidence).
"""

from __future__ import annotations

import base64
import contextlib
import io
import sys
import tempfile
import unittest
from http import HTTPStatus
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from PIL import Image

BACKEND_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_ROOT.parent

if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from catalog_tools import apply_schema, connect, upsert_catalog_card  # noqa: E402
from request_auth import RequestIdentity  # noqa: E402
import server as server_module  # noqa: E402
from server import (  # noqa: E402
    BinderPageTokenError,
    SpotlightRequestHandler,
    SpotlightScanService,
)
# Reuse the single-endpoint fixture builders so these tests exercise the exact
# same payload shape as the single visual-match lane.
try:
    from backend.tests.test_scan_two_phase_phase8 import catalog_card, raw_payload  # noqa: E402
except ImportError:  # direct invocation from backend/tests
    if str(BACKEND_ROOT / "tests") not in sys.path:
        sys.path.insert(0, str(BACKEND_ROOT / "tests"))
    from test_scan_two_phase_phase8 import catalog_card, raw_payload  # noqa: E402


def _fake_match(card_id: str, similarity: float = 0.91) -> SimpleNamespace:
    return SimpleNamespace(
        row_index=0,
        similarity=similarity,
        entry={
            "providerCardId": card_id,
            "name": "Charizard ex",
            "collectorNumber": "223/197",
            "setId": "obf",
            "setName": "Obsidian Flames",
            "setSeries": "Scarlet & Violet",
            "setPtcgoCode": "OBF",
            "sourceProvider": "scrydex",
            "sourceRecordID": card_id,
            "imageUrl": f"https://images.example/{card_id}-large.png",
            "language": "English",
        },
    )


def _cell_color(row: int, column: int) -> tuple[int, int, int]:
    return (row * 80 + 10, column * 80 + 10, 40)


def _texture_cell(cell: Image.Image) -> None:
    """Paint fine stripes around the cell's border band so it carries card-like
    edge energy (the empty-pocket gate keys on edges); the centre stays the
    solid identity colour the pocket-order tests sample."""
    width, height = cell.size
    band_x, band_y = width // 6, height // 6
    px = cell.load()
    for y in range(height):
        for x in range(width):
            in_band = x < band_x or x >= width - band_x or y < band_y or y >= height - band_y
            if in_band and ((x // 6) + (y // 6)) % 2 == 0:
                px[x, y] = (255, 255, 255)


def _color_page_jpeg(
    columns: int = 3,
    rows: int = 3,
    *,
    sideways: bool = False,
    empty_cells: frozenset[int] = frozenset(),
) -> bytes:
    """A page whose cells are distinct solid colors (with a striped border band
    so they read as "a card" to the empty-pocket gate), so a sampled centre
    pixel identifies which cell a pocket crop came from. `sideways` lays each
    cell out landscape (the card on its side) and paints a dark band along
    the cell's LEFT edge — where the card's top is when the binder is turned
    with card tops to the left — so a test can check the crop was stood
    upright. `empty_cells` (row-major indexes) are left FLAT: an empty pocket."""
    cell_w, cell_h = (880, 630) if sideways else (630, 880)
    page = Image.new("RGB", (cell_w * columns, cell_h * rows))
    for row in range(rows):
        for column in range(columns):
            cell = Image.new("RGB", (cell_w, cell_h), color=_cell_color(row, column))
            if row * columns + column not in empty_cells:
                _texture_cell(cell)
            if sideways:
                cell.paste(Image.new("RGB", (cell_w // 8, cell_h), color=(0, 0, 0)), (0, 0))
            page.paste(cell, (column * cell_w, row * cell_h))
    buffer = io.BytesIO()
    page.save(buffer, format="JPEG", quality=90)
    return buffer.getvalue()


class CapturingVisualMatcher:
    """Decodes each query image and records its size + center-pixel color."""

    def __init__(self) -> None:
        self.decoded: list[dict[str, object]] = []

    def prewarm(self):
        return {"available": True, "prewarmed": True}

    def match_payload(self, payload, *, top_k: int = 10, prepared=None, **_kwargs):  # noqa: ARG002
        image_b64 = str((payload.get("image") or {}).get("jpegBase64") or "")
        with Image.open(io.BytesIO(base64.b64decode(image_b64))) as decoded:
            rgb = decoded.convert("RGB")
            self.decoded.append(
                {
                    "scanID": payload.get("scanID"),
                    "size": rgb.size,
                    "centerColor": rgb.getpixel((rgb.size[0] // 2, rgb.size[1] // 2)),
                }
            )
        return (
            [_fake_match("obf-223")],
            {"source": "fake", "timings": {"embeddingMs": 1.0}},
        )


class BinderPageStoreTestCase(unittest.TestCase):
    """Shared DB fixture + a clean binder-page store per test."""

    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.database_path = Path(self.tempdir.name) / "binder-prepare.sqlite"
        connection = connect(self.database_path)
        apply_schema(connection, BACKEND_ROOT / "schema.sql")
        upsert_catalog_card(
            connection,
            catalog_card(
                card_id="obf-223",
                name="Charizard ex",
                set_name="Obsidian Flames",
                number="223/197",
                set_id="obf",
                market_price=42.0,
            ),
            REPO_ROOT,
            "2026-04-09T04:00:00Z",
            refresh_embeddings=False,
        )
        connection.commit()
        connection.close()
        self.service = SpotlightScanService(self.database_path, REPO_ROOT)
        server_module._binder_page_store.clear()

    def tearDown(self) -> None:
        server_module._binder_page_store.clear()
        self.service.connection.close()
        self.tempdir.cleanup()


class BinderPagePrepareServiceTests(BinderPageStoreTestCase):
    def test_prepare_stores_nine_630x880_pockets_and_returns_token(self) -> None:
        response = self.service.prepare_binder_page(
            {
                "pageImage": {
                    "jpegBase64": base64.b64encode(_color_page_jpeg()).decode("ascii"),
                    "width": 1890,
                    "height": 2640,
                }
            }
        )

        self.assertEqual(response["pocketCount"], 9)
        self.assertEqual(response["expiresInSeconds"], 600)
        token = response["pageToken"]
        entry = server_module._binder_page_store[token]
        # Owner-scoped under whatever fallback identity the test env resolves.
        self.assertEqual(entry["owner_user_id"], self.service._current_owner_user_id())
        self.assertTrue(entry["owner_user_id"])
        self.assertEqual(len(entry["pockets"]), 9)
        for pocket_jpeg in entry["pockets"]:
            with Image.open(io.BytesIO(pocket_jpeg)) as decoded:
                self.assertEqual(decoded.size, (630, 880))

    def test_prepare_honours_a_3x4_layout(self) -> None:
        response = self.service.prepare_binder_page(
            {
                "pageImage": {"jpegBase64": base64.b64encode(_color_page_jpeg(3, 4)).decode("ascii")},
                "binderLayout": {"columns": 3, "rows": 4, "cropRotationDegrees": 0},
            }
        )
        self.assertEqual(response["pocketCount"], 12)
        pockets = server_module._binder_page_store[response["pageToken"]]["pockets"]
        self.assertEqual(len(pockets), 12)
        # Row-major reading order: pocket 9 is row 3, column 0.
        with Image.open(io.BytesIO(pockets[9])) as decoded:
            self.assertEqual(decoded.size, (630, 880))
            center = decoded.getpixel((315, 440))
            for channel, expected in zip(center, _cell_color(3, 0), strict=True):
                self.assertLess(abs(channel - expected), 30)

    def test_prepare_stands_sideways_pockets_upright(self) -> None:
        # 18-card layout: an open binder turned so card tops point LEFT. Each
        # landscape cell carries a dark band on its left edge (the card top);
        # after the clockwise quarter turn that band must sit along the TOP.
        response = self.service.prepare_binder_page(
            {
                "pageImage": {"jpegBase64": base64.b64encode(_color_page_jpeg(3, 6, sideways=True)).decode("ascii")},
                "binderLayout": {"columns": 3, "rows": 6, "cropRotationDegrees": 90},
            }
        )
        self.assertEqual(response["pocketCount"], 18)
        pockets = server_module._binder_page_store[response["pageToken"]]["pockets"]
        with Image.open(io.BytesIO(pockets[17])) as decoded:
            self.assertEqual(decoded.size, (630, 880))
            top_band = decoded.getpixel((315, 20))
            self.assertTrue(all(channel < 40 for channel in top_band), top_band)
        # Reading order survives the rotate: pocket 5 is row 1, column 2
        # (rows past 2 overflow the 8-bit cell palette, so sample a low row).
        with Image.open(io.BytesIO(pockets[5])) as decoded:
            body = decoded.getpixel((315, 600))
            for channel, expected in zip(body, _cell_color(1, 2), strict=True):
                self.assertLess(abs(channel - expected), 30)

    def test_prepare_flags_flat_pockets_as_empty(self) -> None:
        # Pockets 4 and 8 are flat colour (an empty sleeve / page background);
        # the rest carry card-like edges. Only the flat ones are reported.
        response = self.service.prepare_binder_page(
            {"pageImage": {"jpegBase64": base64.b64encode(
                _color_page_jpeg(empty_cells=frozenset({4, 8}))).decode("ascii")}}
        )
        self.assertEqual(response["emptyPocketIndexes"], [4, 8])
        self.assertEqual(response["pocketCount"], 9)
        # The store still holds all nine so a stale client asking for an
        # empty pocket gets an image, not an error.
        self.assertEqual(len(server_module._binder_page_store[response["pageToken"]]["pockets"]), 9)

    def test_empty_rule_matches_the_first_real_page(self) -> None:
        # Energies logged from the first real staging page with one empty
        # sleeve (2026-09-10): the empty pocket scored ~6 against cards at
        # 17–29. Below the 8.0 absolute cap AND under 45% of the page median.
        with patch.object(
            server_module, "_pocket_edge_energy",
            side_effect=[18.22, 20.17, 17.17, 22.87, 25.56, 21.57, 21.31, 5.71, 22.22],
        ):
            empty, _ = server_module._binder_empty_pocket_indexes([b""] * 9)
        self.assertEqual(empty, [7])

    def test_empty_rule_keeps_a_dim_card_on_a_uniformly_dim_page(self) -> None:
        # Every pocket weak (bad light): nothing is under 45% of the median,
        # so nothing is skipped — only a truly flat crop (< 3) would be.
        with patch.object(
            server_module, "_pocket_edge_energy",
            side_effect=[6.0, 6.5, 7.0, 6.2, 5.9, 7.5, 6.8, 6.1, 2.4],
        ):
            empty, _ = server_module._binder_empty_pocket_indexes([b""] * 9)
        self.assertEqual(empty, [8])

    def test_edge_energy_separates_flat_from_textured(self) -> None:
        flat = Image.new("RGB", (630, 880), color=(200, 200, 200))
        textured = Image.new("RGB", (630, 880), color=(200, 200, 200))
        _texture_cell(textured)
        buffers = []
        for image in (flat, textured):
            buffer = io.BytesIO()
            image.save(buffer, format="JPEG", quality=85)
            buffers.append(buffer.getvalue())
        flat_energy = server_module._pocket_edge_energy(buffers[0])
        textured_energy = server_module._pocket_edge_energy(buffers[1])
        self.assertLess(flat_energy, server_module.BINDER_EMPTY_POCKET_EDGE_ENERGY_MAX)
        self.assertGreater(textured_energy, server_module.BINDER_EMPTY_POCKET_EDGE_ENERGY_MAX)

    def test_prepare_rejects_bad_layouts(self) -> None:
        page = {"jpegBase64": base64.b64encode(_color_page_jpeg()).decode("ascii")}
        with self.assertRaisesRegex(ValueError, "at most 18 pockets"):
            self.service.prepare_binder_page({"pageImage": page, "binderLayout": {"columns": 6, "rows": 6}})
        with self.assertRaisesRegex(ValueError, "0 or 90"):
            self.service.prepare_binder_page(
                {"pageImage": page, "binderLayout": {"columns": 3, "rows": 3, "cropRotationDegrees": 45}}
            )

    def test_prepare_rejects_undecodable_page(self) -> None:
        with self.assertRaisesRegex(ValueError, "pageImage could not be decoded"):
            self.service.prepare_binder_page(
                {"pageImage": {"jpegBase64": "bm90LWEtanBlZw==", "width": 10, "height": 10}}
            )
        self.assertEqual(server_module._binder_page_store, {})

    def test_prepare_requires_page_image(self) -> None:
        with self.assertRaisesRegex(ValueError, "pageImage.jpegBase64 is required"):
            self.service.prepare_binder_page({})

    def test_prepare_prunes_expired_and_evicts_oldest_at_cap(self) -> None:
        from time import monotonic

        now = monotonic()
        # One expired entry plus a full cap of live ones, oldest first.
        server_module._binder_page_store["expired"] = {
            "owner_user_id": "local-dev-user",
            "created_at": now - 601.0,
            "pockets": [b"x"],
        }
        for index in range(server_module.BINDER_PAGE_STORE_MAX_ENTRIES):
            server_module._binder_page_store[f"live-{index}"] = {
                "owner_user_id": "local-dev-user",
                "created_at": now - 500.0 + index,
                "pockets": [b"x"],
            }

        response = self.service.prepare_binder_page(
            {"pageImage": {"jpegBase64": base64.b64encode(_color_page_jpeg()).decode("ascii")}}
        )

        store = server_module._binder_page_store
        self.assertNotIn("expired", store)
        self.assertNotIn("live-0", store)  # oldest live entry evicted for room
        self.assertIn("live-1", store)
        self.assertIn(response["pageToken"], store)
        self.assertEqual(len(store), server_module.BINDER_PAGE_STORE_MAX_ENTRIES)


class BinderPocketReferenceTests(BinderPageStoreTestCase):
    """visual_match_scan with a binderPage reference instead of image bytes."""

    def _prepare_page(self) -> str:
        response = self.service.prepare_binder_page(
            {"pageImage": {"jpegBase64": base64.b64encode(_color_page_jpeg()).decode("ascii")}}
        )
        return response["pageToken"]

    def _reference_payload(self, token: str, pocket_index: int, scan_id: str) -> dict[str, object]:
        payload = raw_payload(scan_id=scan_id, jpeg_base64=None)
        payload["binderPage"] = {"pageToken": token, "pocketIndex": pocket_index}
        return payload

    def test_reference_injects_the_correct_pocket_per_index(self) -> None:
        matcher = CapturingVisualMatcher()
        self.service._raw_visual_matcher = matcher
        token = self._prepare_page()

        for pocket_index in range(9):
            scan_id = f"scan-pocket-{pocket_index}"
            response = self.service.visual_match_scan(
                self._reference_payload(token, pocket_index, scan_id)
            )
            # Exact single visual-match behavior: candidates + its own scan_events row.
            self.assertEqual(response["scanID"], scan_id)
            self.assertEqual(response["topCandidates"][0]["candidate"]["id"], "obf-223")
            row = self.service.connection.execute(
                "SELECT predicted_card_id FROM scan_events WHERE scan_id = ? LIMIT 1",
                (scan_id,),
            ).fetchone()
            self.assertIsNotNone(row)
            self.assertEqual(row["predicted_card_id"], "obf-223")

        self.assertEqual(len(matcher.decoded), 9)
        for pocket_index, decoded in enumerate(matcher.decoded):
            self.assertEqual(decoded["size"], (630, 880))
            expected = _cell_color(pocket_index // 3, pocket_index % 3)
            for channel, expected_channel in zip(decoded["centerColor"], expected, strict=True):
                # JPEG round-trips shift colors a little; cells differ by 80/channel.
                self.assertLess(abs(channel - expected_channel), 30)

    def test_unknown_token_raises_binder_page_token_error(self) -> None:
        self.service._raw_visual_matcher = CapturingVisualMatcher()
        with self.assertRaises(BinderPageTokenError):
            self.service.visual_match_scan(
                self._reference_payload("deadbeef", 0, "scan-unknown-token")
            )

    def test_foreign_owner_token_raises_binder_page_token_error(self) -> None:
        matcher = CapturingVisualMatcher()
        self.service._raw_visual_matcher = matcher
        owner_a = RequestIdentity(user_id="owner-a", auth_source="test")
        owner_b = RequestIdentity(user_id="owner-b", auth_source="test")
        with self.service.request_identity_context(owner_a):
            token = self._prepare_page()
        with self.service.request_identity_context(owner_b):
            with self.assertRaises(BinderPageTokenError):
                self.service.visual_match_scan(
                    self._reference_payload(token, 0, "scan-foreign-owner")
                )
        # The rightful owner can still use the token (not consumed on failure).
        with self.service.request_identity_context(owner_a):
            response = self.service.visual_match_scan(
                self._reference_payload(token, 0, "scan-rightful-owner")
            )
        self.assertEqual(response["topCandidates"][0]["candidate"]["id"], "obf-223")

    def test_expired_token_raises_binder_page_token_error(self) -> None:
        self.service._raw_visual_matcher = CapturingVisualMatcher()
        token = self._prepare_page()
        server_module._binder_page_store[token]["created_at"] -= 601.0
        with self.assertRaises(BinderPageTokenError):
            self.service.visual_match_scan(self._reference_payload(token, 0, "scan-expired"))

    def test_bad_pocket_index_raises_binder_page_token_error(self) -> None:
        self.service._raw_visual_matcher = CapturingVisualMatcher()
        token = self._prepare_page()
        for bad_index in (-1, 9, "3", None, True):
            payload = raw_payload(scan_id="scan-bad-index", jpeg_base64=None)
            payload["binderPage"] = {"pageToken": token, "pocketIndex": bad_index}
            with self.assertRaises(BinderPageTokenError):
                self.service.visual_match_scan(payload)

    def test_explicit_image_bytes_win_over_reference(self) -> None:
        matcher = CapturingVisualMatcher()
        # A real JPEG in image.jpegBase64 means the (bogus) reference is ignored.
        pocket = Image.new("RGB", (630, 880), color=(1, 2, 3))
        buffer = io.BytesIO()
        pocket.save(buffer, format="JPEG")
        self.service._raw_visual_matcher = matcher
        payload = raw_payload(
            scan_id="scan-inline-bytes",
            jpeg_base64=base64.b64encode(buffer.getvalue()).decode("ascii"),
        )
        payload["binderPage"] = {"pageToken": "bogus", "pocketIndex": 0}
        response = self.service.visual_match_scan(payload)
        self.assertEqual(response["topCandidates"][0]["candidate"]["id"], "obf-223")
        self.assertEqual(matcher.decoded[0]["size"], (630, 880))


class BinderPagePrepareRouteTests(unittest.TestCase):
    """Route dispatch + error envelopes, mirroring the batch route tests."""

    @staticmethod
    def _handler(
        captured: dict[str, object], body: dict[str, object], path: str
    ) -> SpotlightRequestHandler:
        handler = SpotlightRequestHandler.__new__(SpotlightRequestHandler)
        handler.path = path
        handler.service = Mock()
        handler.service.request_identity_context.return_value = contextlib.nullcontext()

        def write_json(status: HTTPStatus, payload: dict[str, object]) -> None:
            captured["status"] = status
            captured["payload"] = payload

        handler._read_json_body = lambda: body  # type: ignore[method-assign]
        handler._require_request_identity = lambda: object()  # type: ignore[method-assign]
        handler._write_json = write_json  # type: ignore[method-assign]
        return handler

    def test_prepare_route_dispatches_to_service(self) -> None:
        captured: dict[str, object] = {}
        body = {"pageImage": {"jpegBase64": "dGVzdA==", "width": 1890, "height": 2640}}
        handler = self._handler(captured, body, server_module.BINDER_PAGE_PREPARE_PATH)
        handler.service.prepare_binder_page.return_value = {
            "pageToken": "abc123",
            "pocketCount": 9,
            "expiresInSeconds": 600,
        }
        handler.do_POST()

        handler.service.prepare_binder_page.assert_called_once_with(body)
        self.assertEqual(captured["status"], HTTPStatus.OK)
        self.assertEqual(
            captured["payload"],
            {"pageToken": "abc123", "pocketCount": 9, "expiresInSeconds": 600},
        )

    def test_prepare_route_maps_value_error_to_binder_page_invalid(self) -> None:
        captured: dict[str, object] = {}
        handler = self._handler(captured, {}, server_module.BINDER_PAGE_PREPARE_PATH)
        handler.service.prepare_binder_page.side_effect = ValueError(
            "pageImage.jpegBase64 is required"
        )
        handler.do_POST()
        self.assertEqual(captured["status"], HTTPStatus.BAD_REQUEST)
        self.assertEqual(
            captured["payload"],
            {"error": "pageImage.jpegBase64 is required", "errorType": "BinderPageInvalid"},
        )

    def test_prepare_route_requires_identity(self) -> None:
        captured: dict[str, object] = {}
        handler = self._handler(captured, {}, server_module.BINDER_PAGE_PREPARE_PATH)
        handler._require_request_identity = lambda: None  # type: ignore[method-assign]
        handler.do_POST()
        handler.service.prepare_binder_page.assert_not_called()

    def test_visual_match_route_maps_token_error_to_400(self) -> None:
        captured: dict[str, object] = {}
        body = {
            "scanID": "scan-route-ref",
            "binderPage": {"pageToken": "deadbeef", "pocketIndex": 0},
        }
        handler = self._handler(captured, body, "/api/v1/scan/visual-match")
        handler.service.visual_match_scan.side_effect = BinderPageTokenError(
            "binderPage.pageToken is unknown or expired"
        )
        handler.do_POST()
        self.assertEqual(captured["status"], HTTPStatus.BAD_REQUEST)
        self.assertEqual(
            captured["payload"],
            {
                "error": "binderPage.pageToken is unknown or expired",
                "errorType": "BinderPageTokenUnknown",
            },
        )


class BinderPagePrepareMultipartTests(unittest.TestCase):
    def test_multipart_injection_maps_page_image_part(self) -> None:
        payload: dict[str, object] = {"image": {"width": 1890, "height": 2640}}
        server_module._inject_multipart_scan_images(
            server_module.BINDER_PAGE_PREPARE_PATH,
            payload,
            {"page_image": b"\xff\xd8page-jpeg\xff\xd9"},
        )
        self.assertEqual(
            payload["pageImage"]["jpegBase64"],  # type: ignore[index]
            base64.b64encode(b"\xff\xd8page-jpeg\xff\xd9").decode("ascii"),
        )

    def test_prepare_path_is_registered_for_multipart(self) -> None:
        self.assertIn(
            server_module.BINDER_PAGE_PREPARE_PATH, server_module.MULTIPART_SCAN_PATHS
        )


if __name__ == "__main__":
    unittest.main()
