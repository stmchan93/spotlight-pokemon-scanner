"""POST /api/v1/scan/visual-match-batch — the binder-page lane.

One request carries up to nine pocket items. The handler holds ONE inference
slot for the whole page, the service runs one batched encoder prepare, and each
item then goes through the exact single-scan path (its own scan_events row,
candidates, confidence). A failing item reports an ``error`` entry instead of
sinking the page.
"""

from __future__ import annotations

import contextlib
import sys
import tempfile
import threading
import unittest
from http import HTTPStatus
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

BACKEND_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_ROOT.parent

if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from catalog_tools import apply_schema, connect, upsert_catalog_card  # noqa: E402
import server as server_module  # noqa: E402
from server import SpotlightRequestHandler, SpotlightScanService  # noqa: E402
# Reuse the single-endpoint fixture builders so the batch tests exercise the
# exact same payload shape.
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


class FakeBatchVisualMatcher:
    """match_payload + prepare_queries_batch, recording how each was called."""

    def __init__(self, *, fail_scan_ids: set[str] | None = None) -> None:
        self.match_calls: list[dict[str, object]] = []
        self.prepare_calls = 0
        self.fail_scan_ids = fail_scan_ids or set()

    def prewarm(self):
        return {"available": True, "prewarmed": True}

    def prepare_queries_batch(self, payloads, **_kwargs):
        self.prepare_calls += 1
        prepared = [SimpleNamespace(kind="prepared", scanID=p.get("scanID")) for p in payloads]
        return prepared, {"batchEncoderForwardMs": 120.0, "batchEncoderMs": 130.0}

    def match_payload(self, payload, *, top_k: int = 10, prepared=None, **_kwargs):  # noqa: ARG002
        self.match_calls.append({"scanID": payload.get("scanID"), "prepared": prepared})
        if str(payload.get("scanID")) in self.fail_scan_ids:
            raise RuntimeError("pocket exploded")
        return (
            [_fake_match("obf-223")],
            {"source": "fake", "timings": {"embeddingMs": 1.0}},
        )


def _batch_payload(scan_ids: list[str]) -> dict[str, object]:
    base = raw_payload(scan_id="unused")
    shared = {key: value for key, value in base.items() if key not in ("scanID", "image")}
    shared["items"] = [
        {
            "scanID": scan_id,
            "pocketIndex": index,
            "image": {"jpegBase64": "dGVzdA==", "width": 630, "height": 880},
        }
        for index, scan_id in enumerate(scan_ids)
    ]
    return shared


class VisualMatchBatchServiceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.database_path = Path(self.tempdir.name) / "visual-batch.sqlite"
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

    def tearDown(self) -> None:
        self.service.connection.close()
        self.tempdir.cleanup()

    def test_batch_runs_one_prepare_and_one_scan_event_per_item(self) -> None:
        matcher = FakeBatchVisualMatcher()
        self.service._raw_visual_matcher = matcher

        scan_ids = ["scan-batch-0", "scan-batch-1", "scan-batch-2"]
        response = self.service.visual_match_scan_batch(_batch_payload(scan_ids))

        self.assertEqual(matcher.prepare_calls, 1)
        self.assertEqual(len(matcher.match_calls), 3)
        # Every per-item match reused its batched prepared query.
        for call in matcher.match_calls:
            self.assertIsNotNone(call["prepared"])
        self.assertEqual(response["itemCount"], 3)
        results = response["results"]
        self.assertEqual([result["pocketIndex"] for result in results], [0, 1, 2])
        for scan_id, result in zip(scan_ids, results, strict=True):
            # Exact single visual-match response shape per item.
            self.assertEqual(result["scanID"], scan_id)
            self.assertTrue(result["isProvisional"])
            self.assertEqual(result["matchingStage"], "visual")
            self.assertEqual(result["topCandidates"][0]["candidate"]["id"], "obf-223")
            self.assertIn(result["reviewDisposition"], ("ready", "needs_review"))
            # And its own scan_events row, keyed by its own scanID.
            row = self.service.connection.execute(
                "SELECT predicted_card_id FROM scan_events WHERE scan_id = ? LIMIT 1",
                (scan_id,),
            ).fetchone()
            self.assertIsNotNone(row)
            self.assertEqual(row["predicted_card_id"], "obf-223")
        # Batch timing debug is surfaced for the page.
        timing = response["backendTimingDebug"]
        self.assertEqual(timing["batchEncoderForwardMs"], 120.0)
        self.assertEqual(len(timing["items"]), 3)
        self.assertGreaterEqual(timing["batchTotalMs"], 0.0)

    def test_page_image_mode_crops_nine_pockets_server_side(self) -> None:
        """Page-image mode: ONE page JPEG in, nine 630x880 pocket crops made
        HERE, each landing in its item's image.jpegBase64."""
        import base64 as _b64
        import io as _io

        from PIL import Image as _Image

        matcher = FakeBatchVisualMatcher()
        decoded_images: list[tuple[int, int]] = []
        original_match = matcher.match_payload

        def capturing_match(payload, **kwargs):
            image_b64 = str((payload.get("image") or {}).get("jpegBase64") or "")
            with _Image.open(_io.BytesIO(_b64.b64decode(image_b64))) as decoded:
                decoded_images.append(decoded.size)
            return original_match(payload, **kwargs)

        matcher.match_payload = capturing_match  # type: ignore[method-assign]
        self.service._raw_visual_matcher = matcher

        # A 3x3 page whose cells are distinct solid colors, so a wrong crop
        # would decode but the size assertion pins the resize contract.
        page = _Image.new("RGB", (1890, 2640))
        for row in range(3):
            for column in range(3):
                cell = _Image.new("RGB", (630, 880), color=(row * 80 + 10, column * 80 + 10, 40))
                page.paste(cell, (column * 630, row * 880))
        buffer = _io.BytesIO()
        page.save(buffer, format="JPEG", quality=90)

        scan_ids = [f"scan-page-{index}" for index in range(9)]
        payload = _batch_payload(scan_ids)
        for item in payload["items"]:  # type: ignore[union-attr]
            item["image"] = {"width": 630, "height": 880}  # no bytes: server crops
        payload["pageImage"] = {
            "jpegBase64": _b64.b64encode(buffer.getvalue()).decode("ascii"),
            "width": 1890,
            "height": 2640,
        }

        response = self.service.visual_match_scan_batch(payload)

        self.assertEqual(response["itemCount"], 9)
        self.assertEqual(len(decoded_images), 9)
        for size in decoded_images:
            self.assertEqual(size, (630, 880))
        for scan_id, result in zip(scan_ids, response["results"], strict=True):
            self.assertEqual(result["scanID"], scan_id)
            self.assertEqual(result["topCandidates"][0]["candidate"]["id"], "obf-223")

    def test_page_image_mode_rejects_undecodable_page(self) -> None:
        matcher = FakeBatchVisualMatcher()
        self.service._raw_visual_matcher = matcher
        payload = _batch_payload(["scan-page-bad"])
        payload["items"][0]["image"] = {"width": 630, "height": 880}  # type: ignore[index]
        payload["pageImage"] = {"jpegBase64": "bm90LWEtanBlZw==", "width": 10, "height": 10}
        with self.assertRaises(ValueError):
            self.service.visual_match_scan_batch(payload)

    def test_item_failure_does_not_fail_the_batch(self) -> None:
        matcher = FakeBatchVisualMatcher(fail_scan_ids={"scan-batch-bad"})
        self.service._raw_visual_matcher = matcher

        response = self.service.visual_match_scan_batch(
            _batch_payload(["scan-batch-ok", "scan-batch-bad", "scan-batch-ok2"])
        )

        results = response["results"]
        self.assertEqual(len(results), 3)
        # match_payload raising inside the single path yields the single path's
        # unavailable response (not a batch-level error): the item still answers.
        self.assertEqual(results[0]["topCandidates"][0]["candidate"]["id"], "obf-223")
        self.assertEqual(results[1]["resolverPath"], "visual_only_unavailable")
        self.assertEqual(results[1]["pocketIndex"], 1)
        self.assertEqual(results[2]["topCandidates"][0]["candidate"]["id"], "obf-223")

    def test_prepare_failure_falls_back_to_per_item_encoding(self) -> None:
        matcher = FakeBatchVisualMatcher()

        def broken_prepare(payloads, **_kwargs):  # noqa: ARG001
            raise RuntimeError("encoder OOM")

        matcher.prepare_queries_batch = broken_prepare  # type: ignore[method-assign]
        self.service._raw_visual_matcher = matcher

        response = self.service.visual_match_scan_batch(_batch_payload(["scan-a", "scan-b"]))

        self.assertEqual(len(response["results"]), 2)
        for call in matcher.match_calls:
            self.assertIsNone(call["prepared"])
        self.assertEqual(
            response["backendTimingDebug"]["batchPrepareError"], "encoder OOM"
        )
        self.assertEqual(
            response["results"][0]["topCandidates"][0]["candidate"]["id"], "obf-223"
        )

    def test_batch_works_with_matcher_lacking_prepare_support(self) -> None:
        matcher = FakeBatchVisualMatcher()
        del FakeBatchVisualMatcher.prepare_queries_batch  # simulate an older matcher
        try:
            self.service._raw_visual_matcher = matcher
            response = self.service.visual_match_scan_batch(_batch_payload(["scan-x"]))
            self.assertEqual(len(response["results"]), 1)
            self.assertIsNone(matcher.match_calls[0]["prepared"])
        finally:
            FakeBatchVisualMatcher.prepare_queries_batch = (
                lambda self, payloads, **kwargs: (
                    [SimpleNamespace(kind="prepared", scanID=p.get("scanID")) for p in payloads],
                    {"batchEncoderForwardMs": 120.0, "batchEncoderMs": 130.0},
                )
            )

    def test_batch_validation(self) -> None:
        with self.assertRaisesRegex(ValueError, "items is required"):
            self.service.visual_match_scan_batch({"resolverModeHint": "raw_card"})
        with self.assertRaisesRegex(ValueError, "at most 9"):
            self.service.visual_match_scan_batch(_batch_payload([f"scan-{i}" for i in range(10)]))
        payload = _batch_payload(["scan-1"])
        payload["resolverModeHint"] = "psa_slab"
        with self.assertRaisesRegex(ValueError, "raw cards only"):
            self.service.visual_match_scan_batch(payload)
        missing_id = _batch_payload(["scan-1"])
        missing_id["items"][0]["scanID"] = ""  # type: ignore[index]
        with self.assertRaisesRegex(ValueError, r"items\[0\].scanID is required"):
            self.service.visual_match_scan_batch(missing_id)


class VisualMatchBatchRouteTests(unittest.TestCase):
    """Route dispatch + one-semaphore-slot-per-page behavior."""

    @staticmethod
    def _batch_handler(captured: dict[str, object], body: dict[str, object]) -> SpotlightRequestHandler:
        handler = SpotlightRequestHandler.__new__(SpotlightRequestHandler)
        handler.path = "/api/v1/scan/visual-match-batch"
        handler.service = Mock()
        handler.service.request_identity_context.return_value = contextlib.nullcontext()
        handler.service.visual_match_scan_batch.return_value = {"results": []}

        def write_json(status: HTTPStatus, payload: dict[str, object]) -> None:
            captured["status"] = status
            captured["payload"] = payload

        handler._read_json_body = lambda: body  # type: ignore[method-assign]
        handler._require_request_identity = lambda: object()  # type: ignore[method-assign]
        handler._write_json = write_json  # type: ignore[method-assign]
        return handler

    def test_route_dispatches_to_batch_service_method(self) -> None:
        captured: dict[str, object] = {}
        body = {"items": [{"scanID": "scan-batch"}]}
        handler = self._batch_handler(captured, body)
        handler.do_POST()

        handler.service.visual_match_scan_batch.assert_called_once_with(body)
        self.assertEqual(captured["status"], HTTPStatus.OK)
        self.assertEqual(captured["payload"], {"results": []})

    def test_route_returns_400_on_value_error(self) -> None:
        captured: dict[str, object] = {}
        handler = self._batch_handler(captured, {})
        handler.service.visual_match_scan_batch.side_effect = ValueError("items is required")
        handler.do_POST()
        self.assertEqual(captured["status"], HTTPStatus.BAD_REQUEST)
        self.assertEqual(captured["payload"], {"error": "items is required"})

    def test_route_holds_one_inference_slot_and_releases_it(self) -> None:
        original_sem = server_module._scan_inference_semaphore
        sem = threading.BoundedSemaphore(1)
        server_module._scan_inference_semaphore = sem
        try:
            captured: dict[str, object] = {}
            handler = self._batch_handler(captured, {"items": [{"scanID": "s"}]})
            in_flight_free_slots: list[bool] = []

            def record_slot_state(payload):  # noqa: ARG001
                # While the batch runs, the ONLY slot must be taken.
                acquired = sem.acquire(blocking=False)
                in_flight_free_slots.append(acquired)
                if acquired:
                    sem.release()
                return {"results": []}

            handler.service.visual_match_scan_batch.side_effect = record_slot_state
            handler.do_POST()
            self.assertEqual(captured["status"], HTTPStatus.OK)
            self.assertEqual(in_flight_free_slots, [False])
            # Released after the response: the slot is free again.
            self.assertTrue(sem.acquire(blocking=False))
            sem.release()
        finally:
            server_module._scan_inference_semaphore = original_sem

    def test_route_returns_503_without_running_batch_when_no_slot_frees(self) -> None:
        original_sem = server_module._scan_inference_semaphore
        original_timeout = server_module.SCAN_INFERENCE_ACQUIRE_TIMEOUT_S
        server_module._scan_inference_semaphore = threading.BoundedSemaphore(1)
        server_module.SCAN_INFERENCE_ACQUIRE_TIMEOUT_S = 0.05
        try:
            self.assertTrue(server_module._scan_inference_semaphore.acquire(blocking=False))
            captured: dict[str, object] = {}
            handler = self._batch_handler(captured, {"items": [{"scanID": "s"}]})
            handler.do_POST()
            self.assertEqual(captured["status"], HTTPStatus.SERVICE_UNAVAILABLE)
            self.assertEqual(captured["payload"]["errorType"], "ScannerBusy")  # type: ignore[index]
            handler.service.visual_match_scan_batch.assert_not_called()
        finally:
            server_module._scan_inference_semaphore = original_sem
            server_module.SCAN_INFERENCE_ACQUIRE_TIMEOUT_S = original_timeout


class VisualMatchBatchMultipartTests(unittest.TestCase):
    def test_multipart_injection_maps_indexed_parts_onto_items(self) -> None:
        payload: dict[str, object] = {
            "items": [
                {"scanID": "scan-0", "image": {"width": 630, "height": 880}},
                {"scanID": "scan-1"},
            ]
        }
        server_module._inject_multipart_scan_images(
            server_module.SCAN_VISUAL_MATCH_BATCH_PATH,
            payload,
            {
                "normalized_image_0": b"\xff\xd8jpeg-zero\xff\xd9",
                "normalized_image_1": b"\xff\xd8jpeg-one\xff\xd9",
            },
        )
        items = payload["items"]
        import base64 as base64_module

        self.assertEqual(
            items[0]["image"]["jpegBase64"],  # type: ignore[index]
            base64_module.b64encode(b"\xff\xd8jpeg-zero\xff\xd9").decode("ascii"),
        )
        # Item without an image dict gets one created for it.
        self.assertEqual(
            items[1]["image"]["jpegBase64"],  # type: ignore[index]
            base64_module.b64encode(b"\xff\xd8jpeg-one\xff\xd9").decode("ascii"),
        )

    def test_batch_path_is_registered_for_multipart_and_large_bodies(self) -> None:
        self.assertIn(
            server_module.SCAN_VISUAL_MATCH_BATCH_PATH, server_module.MULTIPART_SCAN_PATHS
        )
        self.assertTrue(
            server_module._is_large_image_upload_path(server_module.SCAN_VISUAL_MATCH_BATCH_PATH)
        )


if __name__ == "__main__":
    unittest.main()
