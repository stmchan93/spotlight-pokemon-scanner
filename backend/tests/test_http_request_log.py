"""Per-request `http_request` access-log line (SpotlightRequestHandler)."""
from __future__ import annotations

import contextlib
import io
import json
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

import server as server_module  # noqa: E402
from server import SpotlightRequestHandler  # noqa: E402


class _BrokenWriter(io.BytesIO):
    """Accepts the header flush, then fails like a socket whose peer hung up."""

    def __init__(self, *, fail_on_write: int = 2) -> None:
        super().__init__()
        self._writes = 0
        self._fail_on_write = fail_on_write

    def write(self, data: bytes) -> int:  # type: ignore[override]
        self._writes += 1
        if self._writes >= self._fail_on_write:
            raise BrokenPipeError("client went away")
        return super().write(data)


def make_handler(
    method: str,
    path: str,
    *,
    service: object,
    body: bytes = b"",
    headers: dict[str, str] | None = None,
    wfile: io.BytesIO | None = None,
) -> SpotlightRequestHandler:
    handler = SpotlightRequestHandler.__new__(SpotlightRequestHandler)
    handler.command = method
    handler.path = path
    handler.request_version = "HTTP/1.1"
    handler.requestline = f"{method} {path} HTTP/1.1"
    handler.client_address = ("127.0.0.1", 50000)
    handler.service = service  # type: ignore[assignment]
    merged = {"Content-Length": str(len(body))}
    merged.update(headers or {})
    handler.headers = merged  # type: ignore[assignment]
    handler.rfile = io.BytesIO(body)
    handler.wfile = wfile if wfile is not None else io.BytesIO()
    return handler


def run_and_capture(handler: SpotlightRequestHandler, method: str) -> tuple[list[dict], BaseException | None]:
    stdout = io.StringIO()
    raised: BaseException | None = None
    with contextlib.redirect_stdout(stdout):
        try:
            getattr(handler, f"do_{method}")()
        except BaseException as error:  # noqa: BLE001 - asserting propagation
            raised = error
    lines = []
    for line in stdout.getvalue().splitlines():
        try:
            record = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(record, dict) and record.get("event") == "http_request":
            lines.append(record)
    return lines, raised


class HttpRequestLogTests(unittest.TestCase):
    def setUp(self) -> None:
        patcher = patch.dict(os.environ, {}, clear=False)
        patcher.start()
        self.addCleanup(patcher.stop)
        os.environ.pop(server_module.HTTP_SLOW_REQUEST_MS_ENV, None)
        os.environ.pop(server_module.HTTP_LOG_HEALTH_ENV, None)

    def test_ok_request_emits_one_info_line(self) -> None:
        service = Mock()
        service.provider_status.return_value = {"providers": []}
        handler = make_handler(
            "GET",
            "/api/v1/ops/provider-status?token=secret",
            service=service,
            headers={"X-Forwarded-For": "203.0.113.77, 10.0.0.1"},
        )
        lines, raised = run_and_capture(handler, "GET")
        self.assertIsNone(raised)
        self.assertEqual(len(lines), 1)
        line = lines[0]
        self.assertEqual(line["severity"], "INFO")
        self.assertEqual(line["method"], "GET")
        self.assertEqual(line["route"], "/api/v1/ops/provider-status")
        self.assertEqual(line["status"], 200)
        self.assertEqual(line["outcome"], "ok")
        self.assertEqual(line["clientIp"], "203.0.113.0/24")
        self.assertGreater(line["responseBytes"], 0)
        self.assertIsInstance(line["totalMs"], float)
        self.assertNotIn("secret", json.dumps(line))

    def test_unknown_route_is_client_error(self) -> None:
        handler = make_handler("GET", "/api/v1/definitely-not-a-route", service=Mock())
        lines, raised = run_and_capture(handler, "GET")
        self.assertIsNone(raised)
        self.assertEqual(len(lines), 1)
        self.assertEqual(lines[0]["status"], 404)
        self.assertEqual(lines[0]["outcome"], "client_error")
        self.assertEqual(lines[0]["severity"], "INFO")

    def test_unhandled_exception_logs_500_and_reraises(self) -> None:
        service = Mock()
        service.provider_status.side_effect = RuntimeError("db exploded")
        handler = make_handler("GET", "/api/v1/ops/provider-status", service=service)
        lines, raised = run_and_capture(handler, "GET")
        self.assertIsInstance(raised, RuntimeError)
        self.assertEqual(len(lines), 1)
        line = lines[0]
        self.assertEqual(line["status"], 500)
        self.assertEqual(line["outcome"], "exception")
        self.assertEqual(line["errorType"], "RuntimeError")
        self.assertEqual(line["severity"], "WARNING")

    def test_client_disconnect_during_response_write(self) -> None:
        service = Mock()
        service.provider_status.return_value = {"providers": []}
        handler = make_handler(
            "GET", "/api/v1/ops/provider-status", service=service, wfile=_BrokenWriter()
        )
        lines, raised = run_and_capture(handler, "GET")
        self.assertIsNone(raised)
        self.assertEqual(len(lines), 1)
        self.assertEqual(lines[0]["outcome"], "client_disconnected")
        self.assertEqual(lines[0]["status"], 200)

    def test_client_disconnect_during_header_flush_reraises(self) -> None:
        service = Mock()
        service.provider_status.return_value = {"providers": []}
        handler = make_handler(
            "GET",
            "/api/v1/ops/provider-status",
            service=service,
            wfile=_BrokenWriter(fail_on_write=1),
        )
        lines, raised = run_and_capture(handler, "GET")
        self.assertIsInstance(raised, BrokenPipeError)
        self.assertEqual(len(lines), 1)
        self.assertEqual(lines[0]["outcome"], "client_disconnected")
        self.assertEqual(lines[0]["errorType"], "BrokenPipeError")

    def test_malformed_multipart_scan_is_body_rejected(self) -> None:
        body = b"--wrong-boundary\r\ngarbage with no parts\r\n"
        handler = make_handler(
            "POST",
            "/api/v1/scan/visual-match",
            service=Mock(),
            body=body,
            headers={"Content-Type": "multipart/form-data; boundary=expected-boundary"},
        )
        lines, raised = run_and_capture(handler, "POST")
        self.assertIsNone(raised)
        self.assertEqual(len(lines), 1)
        line = lines[0]
        self.assertEqual(line["status"], 400)
        self.assertEqual(line["outcome"], "body_rejected")
        self.assertEqual(line["reason"], "multipart body is malformed")
        self.assertEqual(line["requestBytes"], len(body))
        self.assertIn("bodyReadMs", line)

    def test_invalid_json_body_is_body_rejected(self) -> None:
        handler = make_handler(
            "POST",
            "/api/v1/scan/visual-match",
            service=Mock(),
            body=b"{not json",
            headers={"Content-Type": "application/json"},
        )
        lines, _ = run_and_capture(handler, "POST")
        self.assertEqual(lines[0]["outcome"], "body_rejected")
        self.assertEqual(lines[0]["reason"], "Invalid JSON body")

    def test_scan_id_captured_from_json_body(self) -> None:
        handler = make_handler(
            "POST",
            "/api/v1/scan/visual-match",
            service=Mock(),
            body=json.dumps({"scanID": "scan-abc"}).encode(),
            headers={"Content-Type": "application/json"},
        )
        # Auth fails (Mock authenticator → 401 path or similar); scanID must still be on the line.
        handler._require_request_identity = lambda: None  # type: ignore[method-assign]
        lines, _ = run_and_capture(handler, "POST")
        self.assertEqual(len(lines), 1)
        self.assertEqual(lines[0]["scanID"], "scan-abc")

    def test_slow_request_is_warning(self) -> None:
        os.environ[server_module.HTTP_SLOW_REQUEST_MS_ENV] = "0.000001"
        handler = make_handler("GET", "/api/v1/definitely-not-a-route", service=Mock())
        lines, _ = run_and_capture(handler, "GET")
        self.assertEqual(lines[0]["severity"], "WARNING")
        self.assertTrue(lines[0]["slow"])

    def test_fast_healthy_health_check_is_not_logged(self) -> None:
        service = Mock()
        service.health.return_value = {"status": "ok"}
        handler = make_handler("GET", "/api/v1/health", service=service)
        lines, _ = run_and_capture(handler, "GET")
        self.assertEqual(lines, [])
        os.environ[server_module.HTTP_LOG_HEALTH_ENV] = "1"
        handler = make_handler("GET", "/api/v1/health", service=service)
        lines, _ = run_and_capture(handler, "GET")
        self.assertEqual(len(lines), 1)


class HttpRouteHelpersTests(unittest.TestCase):
    def test_route_normalization_collapses_ids(self) -> None:
        normalize = server_module._normalize_http_route
        self.assertEqual(normalize("/api/v1/scan/visual-match?x=1"), "/api/v1/scan/visual-match")
        self.assertEqual(normalize("/api/v1/cards/sv3pt5-151/price-trends"), "/api/v1/cards/:id/price-trends")
        self.assertEqual(normalize("/api/v1/cards/search"), "/api/v1/cards/search")
        self.assertEqual(normalize("/api/v1/events/honolulu-show/booths"), "/api/v1/events/:id/booths")
        self.assertEqual(
            normalize("/api/v1/scan/1b4e28ba-2fa1-11d2-883f-0016d3cca427/candidates"),
            "/api/v1/scan/:id/candidates",
        )
        self.assertEqual(normalize("/api/v1/portfolio/sales/batch"), "/api/v1/portfolio/sales/batch")
        self.assertEqual(normalize("/wp-login.php"), "/:id")

    def test_client_ip_prefix(self) -> None:
        prefix = server_module._http_client_ip_prefix
        self.assertEqual(prefix({"X-Forwarded-For": "198.51.100.9"}, ("127.0.0.1", 1)), "198.51.100.0/24")
        self.assertEqual(prefix({}, ("127.0.0.1", 1)), "127.0.0.0/24")
        self.assertEqual(prefix({"X-Forwarded-For": "2001:db8:abcd:12::1"}, None), "2001:db8:abcd::/48")
        self.assertEqual(prefix({"X-Forwarded-For": "not-an-ip"}, None), "invalid")


if __name__ == "__main__":
    unittest.main()
