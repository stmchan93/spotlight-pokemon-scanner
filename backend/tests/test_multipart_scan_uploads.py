from __future__ import annotations

import base64
import contextlib
import io
import json
import os
import sys
import tempfile
import unittest
from http import HTTPStatus
from pathlib import Path
from unittest.mock import Mock

BACKEND_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_ROOT.parent

if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from catalog_tools import apply_schema, connect  # noqa: E402
from request_auth import RequestIdentity  # noqa: E402
from scan_artifact_store import SCAN_ARTIFACTS_ROOT_ENV, SCAN_ARTIFACTS_STORAGE_ENV  # noqa: E402
import server as server_module  # noqa: E402
from server import SpotlightRequestHandler, SpotlightScanService  # noqa: E402

BOUNDARY = "spotlight-test-boundary-7d1a"

# JPEG-ish binary payloads: include CRLF/dash bytes to prove the boundary
# parser does not corrupt or truncate binary content.
NORMALIZED_JPEG_BYTES = b"\xff\xd8\xff\xe0norm\r\n--not-a-boundary--\r\nalized\x00\xff\xd9"
SOURCE_JPEG_BYTES = b"\xff\xd8\xff\xe0source\r\nimage\x00binary\xff\xd9"


def build_multipart_body(
    parts: list[tuple[str, bytes, bool]],
    *,
    boundary: str = BOUNDARY,
    include_close_delimiter: bool = True,
) -> bytes:
    """parts: (name, content, is_file) tuples in the multipart order."""
    chunks: list[bytes] = []
    for name, content, is_file in parts:
        chunks.append(b"--" + boundary.encode("ascii") + b"\r\n")
        if is_file:
            chunks.append(
                (
                    f'Content-Disposition: form-data; name="{name}"; filename="{name}.jpg"\r\n'
                    "Content-Type: image/jpeg\r\n\r\n"
                ).encode("ascii")
            )
        else:
            chunks.append(
                f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode("ascii")
            )
        chunks.append(content)
        chunks.append(b"\r\n")
    if include_close_delimiter:
        chunks.append(b"--" + boundary.encode("ascii") + b"--\r\n")
    return b"".join(chunks)


def make_post_handler(
    path: str,
    *,
    body: bytes,
    content_type: str,
    service: object,
    identity: RequestIdentity,
) -> tuple[SpotlightRequestHandler, dict[str, object]]:
    handler = SpotlightRequestHandler.__new__(SpotlightRequestHandler)
    handler.path = path
    handler.service = service
    handler.headers = {
        "Content-Type": content_type,
        "Content-Length": str(len(body)),
    }
    handler.rfile = io.BytesIO(body)
    handler._require_request_identity = lambda: identity  # type: ignore[method-assign]
    captured: dict[str, object] = {}

    def write_json(status: HTTPStatus, payload: dict[str, object]) -> None:
        captured["status"] = status
        captured["payload"] = payload

    handler._write_json = write_json  # type: ignore[method-assign]
    return handler, captured


class MultipartHelpersTests(unittest.TestCase):
    def test_multipart_boundary_extraction(self) -> None:
        self.assertEqual(
            server_module._multipart_boundary("multipart/form-data; boundary=abc123"),
            "abc123",
        )
        self.assertEqual(
            server_module._multipart_boundary('multipart/form-data; boundary="quoted-b"'),
            "quoted-b",
        )
        self.assertEqual(
            server_module._multipart_boundary(
                "multipart/form-data; charset=utf-8; boundary=later"
            ),
            "later",
        )
        self.assertIsNone(server_module._multipart_boundary("multipart/form-data"))
        self.assertIsNone(server_module._multipart_boundary("application/json"))

    def test_parse_multipart_preserves_binary_bytes_exactly(self) -> None:
        body = build_multipart_body(
            [
                ("payload", b'{"scanID":"scan-1"}', False),
                ("normalized_image", NORMALIZED_JPEG_BYTES, True),
                ("source_image", SOURCE_JPEG_BYTES, True),
            ]
        )
        parts = server_module._parse_multipart_form_data(body, BOUNDARY)
        self.assertIsNotNone(parts)
        assert parts is not None
        self.assertEqual(parts["payload"], b'{"scanID":"scan-1"}')
        self.assertEqual(parts["normalized_image"], NORMALIZED_JPEG_BYTES)
        self.assertEqual(parts["source_image"], SOURCE_JPEG_BYTES)

    def test_parse_multipart_rejects_missing_close_delimiter(self) -> None:
        body = build_multipart_body(
            [("payload", b"{}", False)], include_close_delimiter=False
        )
        self.assertIsNone(server_module._parse_multipart_form_data(body, BOUNDARY))

    def test_parse_multipart_rejects_garbage(self) -> None:
        self.assertIsNone(
            server_module._parse_multipart_form_data(b"this is not multipart", BOUNDARY)
        )


class MultipartVisualMatchRouteTests(unittest.TestCase):
    """Multipart visual-match must dispatch the exact payload dict the JSON
    path produces, through the same service method."""

    def _json_equivalent_payload(self) -> dict[str, object]:
        return {
            "scanID": "scan-mp-1",
            "capturedAt": "2026-07-18T00:00:00Z",
            "cardLanguage": "english",
            "image": {
                "jpegBase64": base64.b64encode(NORMALIZED_JPEG_BYTES).decode("ascii"),
                "width": 630,
                "height": 880,
            },
        }

    def _multipart_payload_part(self) -> dict[str, object]:
        # Identical to the JSON body EXCEPT image.jpegBase64 is omitted.
        payload = self._json_equivalent_payload()
        payload["image"] = {"width": 630, "height": 880}
        return payload

    def _dispatch(self, *, body: bytes, content_type: str) -> tuple[Mock, dict[str, object]]:
        service = Mock()
        service.request_identity_context.return_value = contextlib.nullcontext()
        service.visual_match_scan.return_value = {"stage": "visual"}
        handler, captured = make_post_handler(
            "/api/v1/scan/visual-match",
            body=body,
            content_type=content_type,
            service=service,
            identity=RequestIdentity(user_id="mp-user", auth_source="test"),
        )
        handler.do_POST()
        return service, captured

    def test_multipart_visual_match_dispatches_same_payload_as_json(self) -> None:
        json_body = json.dumps(self._json_equivalent_payload()).encode("utf-8")
        json_service, json_captured = self._dispatch(
            body=json_body, content_type="application/json"
        )
        json_service.visual_match_scan.assert_called_once()
        json_dispatched = json_service.visual_match_scan.call_args.args[0]

        multipart_body = build_multipart_body(
            [
                ("payload", json.dumps(self._multipart_payload_part()).encode("utf-8"), False),
                ("normalized_image", NORMALIZED_JPEG_BYTES, True),
            ]
        )
        mp_service, mp_captured = self._dispatch(
            body=multipart_body,
            content_type=f"multipart/form-data; boundary={BOUNDARY}",
        )
        mp_service.visual_match_scan.assert_called_once()
        mp_dispatched = mp_service.visual_match_scan.call_args.args[0]

        self.assertEqual(mp_dispatched, json_dispatched)
        self.assertEqual(mp_captured["status"], HTTPStatus.OK)
        self.assertEqual(mp_captured["payload"], json_captured["payload"])

    def test_multipart_without_image_part_dispatches_payload_without_base64(self) -> None:
        # Missing image part is NOT a transport-level 400: the payload reaches
        # the service exactly as a JSON body missing its base64 would, so the
        # endpoint's own missing-image behavior stays identical.
        multipart_body = build_multipart_body(
            [("payload", json.dumps(self._multipart_payload_part()).encode("utf-8"), False)]
        )
        service, captured = self._dispatch(
            body=multipart_body,
            content_type=f"multipart/form-data; boundary={BOUNDARY}",
        )
        service.visual_match_scan.assert_called_once()
        dispatched = service.visual_match_scan.call_args.args[0]
        self.assertNotIn("jpegBase64", dispatched["image"])
        self.assertEqual(captured["status"], HTTPStatus.OK)

    def test_multipart_missing_payload_part_returns_400(self) -> None:
        multipart_body = build_multipart_body(
            [("normalized_image", NORMALIZED_JPEG_BYTES, True)]
        )
        service, captured = self._dispatch(
            body=multipart_body,
            content_type=f"multipart/form-data; boundary={BOUNDARY}",
        )
        service.visual_match_scan.assert_not_called()
        self.assertEqual(captured["status"], HTTPStatus.BAD_REQUEST)
        self.assertEqual(
            captured["payload"], {"error": "multipart payload part is required"}
        )

    def test_multipart_malformed_payload_json_returns_400(self) -> None:
        multipart_body = build_multipart_body(
            [
                ("payload", b"{not-json", False),
                ("normalized_image", NORMALIZED_JPEG_BYTES, True),
            ]
        )
        service, captured = self._dispatch(
            body=multipart_body,
            content_type=f"multipart/form-data; boundary={BOUNDARY}",
        )
        service.visual_match_scan.assert_not_called()
        self.assertEqual(captured["status"], HTTPStatus.BAD_REQUEST)
        self.assertEqual(
            captured["payload"], {"error": "multipart payload part must be valid JSON"}
        )

    def test_multipart_non_object_payload_returns_400(self) -> None:
        multipart_body = build_multipart_body([("payload", b'["list"]', False)])
        service, captured = self._dispatch(
            body=multipart_body,
            content_type=f"multipart/form-data; boundary={BOUNDARY}",
        )
        service.visual_match_scan.assert_not_called()
        self.assertEqual(captured["status"], HTTPStatus.BAD_REQUEST)
        self.assertEqual(
            captured["payload"], {"error": "multipart payload part must be a JSON object"}
        )

    def test_multipart_missing_boundary_returns_400(self) -> None:
        service, captured = self._dispatch(
            body=b"irrelevant", content_type="multipart/form-data"
        )
        service.visual_match_scan.assert_not_called()
        self.assertEqual(captured["status"], HTTPStatus.BAD_REQUEST)
        self.assertEqual(captured["payload"], {"error": "multipart boundary is missing"})

    def test_multipart_truncated_body_returns_400(self) -> None:
        service, captured = self._dispatch(
            body=b"--" + BOUNDARY.encode("ascii") + b"\r\ntruncated",
            content_type=f"multipart/form-data; boundary={BOUNDARY}",
        )
        service.visual_match_scan.assert_not_called()
        self.assertEqual(captured["status"], HTTPStatus.BAD_REQUEST)
        self.assertEqual(captured["payload"], {"error": "multipart body is malformed"})

    def test_multipart_on_non_scan_path_still_uses_json_reader(self) -> None:
        # Multipart is scoped to the two scan endpoints; any other endpoint
        # keeps the untouched JSON reader (and thus rejects a multipart body).
        service = Mock()
        service.request_identity_context.return_value = contextlib.nullcontext()
        body = build_multipart_body([("payload", b"{}", False)])
        handler, captured = make_post_handler(
            "/api/v1/scan/feedback",
            body=body,
            content_type=f"multipart/form-data; boundary={BOUNDARY}",
            service=service,
            identity=RequestIdentity(user_id="mp-user", auth_source="test"),
        )
        handler.do_POST()
        self.assertEqual(captured["status"], HTTPStatus.BAD_REQUEST)
        self.assertEqual(captured["payload"], {"error": "Invalid JSON body"})


class MultipartScanArtifactsTests(unittest.TestCase):
    """Multipart scan-artifacts must store byte-identical artifacts to the
    JSON path, through the real service and filesystem artifact store."""

    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.database_path = Path(self.tempdir.name) / "multipart.sqlite"
        self.artifact_root = Path(self.tempdir.name) / "artifact-root"
        self.previous_artifact_root = os.environ.get(SCAN_ARTIFACTS_ROOT_ENV)
        self.previous_artifact_storage = os.environ.get(SCAN_ARTIFACTS_STORAGE_ENV)
        self.previous_artifact_uploads_enabled = os.environ.get(
            "SPOTLIGHT_SCAN_ARTIFACT_UPLOADS_ENABLED"
        )
        os.environ[SCAN_ARTIFACTS_ROOT_ENV] = str(self.artifact_root)
        os.environ["SPOTLIGHT_SCAN_ARTIFACT_UPLOADS_ENABLED"] = "1"
        connection = connect(self.database_path)
        apply_schema(connection, BACKEND_ROOT / "schema.sql")
        connection.close()
        self.service = SpotlightScanService(self.database_path, REPO_ROOT)
        self.identity = RequestIdentity(user_id="mp-artifact-user", auth_source="test")

    def tearDown(self) -> None:
        self.service.connection.close()
        if self.previous_artifact_root is None:
            os.environ.pop(SCAN_ARTIFACTS_ROOT_ENV, None)
        else:
            os.environ[SCAN_ARTIFACTS_ROOT_ENV] = self.previous_artifact_root
        if self.previous_artifact_storage is None:
            os.environ.pop(SCAN_ARTIFACTS_STORAGE_ENV, None)
        else:
            os.environ[SCAN_ARTIFACTS_STORAGE_ENV] = self.previous_artifact_storage
        if self.previous_artifact_uploads_enabled is None:
            os.environ.pop("SPOTLIGHT_SCAN_ARTIFACT_UPLOADS_ENABLED", None)
        else:
            os.environ["SPOTLIGHT_SCAN_ARTIFACT_UPLOADS_ENABLED"] = (
                self.previous_artifact_uploads_enabled
            )
        self.tempdir.cleanup()

    def _artifact_row(self, scan_id: str):
        return self.service.connection.execute(
            """
            SELECT source_object_path, normalized_object_path, upload_status,
                   capture_source, camera_zoom_factor,
                   source_width, source_height, normalized_width, normalized_height
            FROM scan_artifacts
            WHERE scan_id = ?
            LIMIT 1
            """,
            (scan_id,),
        ).fetchone()

    def _base_payload(self, scan_id: str) -> dict[str, object]:
        return {
            "scanID": scan_id,
            "captureSource": "live_scan",
            "cameraZoomFactor": 1.5,
            "submittedAt": "2026-07-18T20:00:00+00:00",
        }

    def _post(self, *, body: bytes, content_type: str) -> dict[str, object]:
        handler, captured = make_post_handler(
            "/api/v1/scan-artifacts",
            body=body,
            content_type=content_type,
            service=self.service,
            identity=self.identity,
        )
        handler.do_POST()
        return captured

    def test_multipart_stores_same_artifacts_as_json(self) -> None:
        json_payload = self._base_payload("scan-json-1")
        json_payload["sourceImage"] = {
            "jpegBase64": base64.b64encode(SOURCE_JPEG_BYTES).decode("ascii"),
            "width": 640,
            "height": 960,
        }
        json_payload["normalizedImage"] = {
            "jpegBase64": base64.b64encode(NORMALIZED_JPEG_BYTES).decode("ascii"),
            "width": 630,
            "height": 880,
        }
        json_captured = self._post(
            body=json.dumps(json_payload).encode("utf-8"),
            content_type="application/json",
        )
        self.assertEqual(json_captured["status"], HTTPStatus.ACCEPTED)

        multipart_payload = self._base_payload("scan-mp-1")
        multipart_payload["sourceImage"] = {"width": 640, "height": 960}
        multipart_payload["normalizedImage"] = {"width": 630, "height": 880}
        multipart_body = build_multipart_body(
            [
                ("payload", json.dumps(multipart_payload).encode("utf-8"), False),
                ("normalized_image", NORMALIZED_JPEG_BYTES, True),
                ("source_image", SOURCE_JPEG_BYTES, True),
            ]
        )
        mp_captured = self._post(
            body=multipart_body,
            content_type=f"multipart/form-data; boundary={BOUNDARY}",
        )
        self.assertEqual(mp_captured["status"], HTTPStatus.ACCEPTED)

        json_row = self._artifact_row("scan-json-1")
        mp_row = self._artifact_row("scan-mp-1")
        self.assertIsNotNone(json_row)
        self.assertIsNotNone(mp_row)
        assert json_row is not None and mp_row is not None

        # Byte-identical stored artifacts.
        self.assertEqual(
            (self.artifact_root / mp_row["normalized_object_path"]).read_bytes(),
            NORMALIZED_JPEG_BYTES,
        )
        self.assertEqual(
            (self.artifact_root / mp_row["source_object_path"]).read_bytes(),
            SOURCE_JPEG_BYTES,
        )
        self.assertEqual(
            (self.artifact_root / mp_row["normalized_object_path"]).read_bytes(),
            (self.artifact_root / json_row["normalized_object_path"]).read_bytes(),
        )
        self.assertEqual(
            (self.artifact_root / mp_row["source_object_path"]).read_bytes(),
            (self.artifact_root / json_row["source_object_path"]).read_bytes(),
        )

        # Identical metadata rows (paths differ only by scan id).
        for column in (
            "upload_status",
            "capture_source",
            "camera_zoom_factor",
            "source_width",
            "source_height",
            "normalized_width",
            "normalized_height",
        ):
            self.assertEqual(mp_row[column], json_row[column])

        # Identical response envelope (modulo the scan id).
        json_response = dict(json_captured["payload"])
        mp_response = dict(mp_captured["payload"])
        for response, scan_id in ((json_response, "scan-json-1"), (mp_response, "scan-mp-1")):
            self.assertEqual(response.pop("scanID"), scan_id)
            for key in ("sourceObjectPath", "normalizedObjectPath", "artifactsJsonObjectPath"):
                if isinstance(response.get(key), str):
                    response[key] = response[key].replace(scan_id, "<scan>")
        self.assertEqual(mp_response, json_response)

    def test_multipart_without_source_image_stores_normalized_only(self) -> None:
        multipart_payload = self._base_payload("scan-mp-normonly")
        multipart_payload["sourceImage"] = None
        multipart_payload["normalizedImage"] = {"width": 630, "height": 880}
        multipart_body = build_multipart_body(
            [
                ("payload", json.dumps(multipart_payload).encode("utf-8"), False),
                ("normalized_image", NORMALIZED_JPEG_BYTES, True),
            ]
        )
        captured = self._post(
            body=multipart_body,
            content_type=f"multipart/form-data; boundary={BOUNDARY}",
        )
        self.assertEqual(captured["status"], HTTPStatus.ACCEPTED)
        row = self._artifact_row("scan-mp-normonly")
        self.assertIsNotNone(row)
        assert row is not None
        self.assertEqual(row["upload_status"], "normalized_only")
        self.assertIsNone(row["source_object_path"])
        self.assertEqual(
            (self.artifact_root / row["normalized_object_path"]).read_bytes(),
            NORMALIZED_JPEG_BYTES,
        )

    def test_multipart_missing_normalized_image_matches_json_error(self) -> None:
        # No normalized_image part and no base64: same 400 the JSON path
        # returns when normalizedImage is absent.
        multipart_payload = self._base_payload("scan-mp-missing-norm")
        multipart_body = build_multipart_body(
            [("payload", json.dumps(multipart_payload).encode("utf-8"), False)]
        )
        captured = self._post(
            body=multipart_body,
            content_type=f"multipart/form-data; boundary={BOUNDARY}",
        )
        self.assertEqual(captured["status"], HTTPStatus.BAD_REQUEST)
        self.assertEqual(
            captured["payload"], {"error": "normalizedImage must be an object"}
        )

    def test_multipart_missing_payload_part_returns_400(self) -> None:
        multipart_body = build_multipart_body(
            [("normalized_image", NORMALIZED_JPEG_BYTES, True)]
        )
        captured = self._post(
            body=multipart_body,
            content_type=f"multipart/form-data; boundary={BOUNDARY}",
        )
        self.assertEqual(captured["status"], HTTPStatus.BAD_REQUEST)
        self.assertEqual(
            captured["payload"], {"error": "multipart payload part is required"}
        )

    def test_json_body_path_unchanged_for_scan_artifacts(self) -> None:
        # Regression guard: a plain JSON request still works end-to-end.
        json_payload = self._base_payload("scan-json-only")
        json_payload["normalizedImage"] = {
            "jpegBase64": base64.b64encode(NORMALIZED_JPEG_BYTES).decode("ascii"),
            "width": 630,
            "height": 880,
        }
        captured = self._post(
            body=json.dumps(json_payload).encode("utf-8"),
            content_type="application/json",
        )
        self.assertEqual(captured["status"], HTTPStatus.ACCEPTED)
        row = self._artifact_row("scan-json-only")
        self.assertIsNotNone(row)
        assert row is not None
        self.assertEqual(
            (self.artifact_root / row["normalized_object_path"]).read_bytes(),
            NORMALIZED_JPEG_BYTES,
        )


if __name__ == "__main__":
    unittest.main()
