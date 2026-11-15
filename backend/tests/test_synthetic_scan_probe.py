"""Synthetic end-to-end scan probe (health check): the server's gated
no-persistence lane on /api/v1/scan/visual-match, and the probe script."""
from __future__ import annotations

import base64
import contextlib
import io
import json
import os
import sys
import tempfile
import threading
import unittest
from http import HTTPStatus
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

BACKEND_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_ROOT.parent

if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))
if str(BACKEND_ROOT / "tests") not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT / "tests"))

from catalog_tools import apply_schema, connect, upsert_catalog_card  # noqa: E402
import server as server_module  # noqa: E402
import synthetic_scan_probe as probe  # noqa: E402
from request_auth import RequestIdentity  # noqa: E402
from server import SpotlightRequestHandler, SpotlightScanService  # noqa: E402
from test_scan_two_phase_phase8 import catalog_card, raw_payload  # type: ignore  # noqa: E402

TOKEN = "probe-token-123"
PATH = "/api/v1/scan/visual-match"


def _handler(
    *,
    headers: dict[str, str],
    client_ip: str = "127.0.0.1",
    payload: dict[str, object] | None = None,
) -> tuple[SpotlightRequestHandler, Mock, dict[str, object]]:
    body = json.dumps(payload if payload is not None else {"scanID": "synthetic-1"}).encode("utf-8")
    handler = SpotlightRequestHandler.__new__(SpotlightRequestHandler)
    handler.path = PATH
    handler.client_address = (client_ip, 54321)
    handler.headers = {"Content-Type": "application/json", "Content-Length": str(len(body)), **headers}
    handler.rfile = io.BytesIO(body)
    service = Mock()
    service.request_identity_context.return_value = contextlib.nullcontext()
    service.synthetic_visual_match_scan.return_value = {"synthetic": True, "topCandidates": []}
    service.visual_match_scan.return_value = {"normal": True}
    handler.service = service
    handler._require_request_identity = Mock(  # type: ignore[method-assign]
        return_value=RequestIdentity(user_id="real-user", auth_source="test")
    )
    captured: dict[str, object] = {}

    def write_json(status: HTTPStatus, response: dict[str, object]) -> None:
        captured["status"] = status
        captured["payload"] = response

    handler._write_json = write_json  # type: ignore[method-assign]
    return handler, service, captured


class SyntheticScanRouteGateTests(unittest.TestCase):
    def setUp(self) -> None:
        patcher = patch.dict(os.environ, {server_module.SYNTHETIC_SCAN_TOKEN_ENV: TOKEN})
        patcher.start()
        self.addCleanup(patcher.stop)

    def _assert_rejected(self, handler, service, captured) -> None:
        handler.do_POST()
        self.assertEqual(captured["status"], HTTPStatus.FORBIDDEN)
        service.synthetic_visual_match_scan.assert_not_called()
        # Never falls through to the normal, logged scan lane.
        service.visual_match_scan.assert_not_called()

    def test_valid_loopback_probe_takes_synthetic_lane_without_user_auth(self) -> None:
        handler, service, captured = _handler(headers={server_module.SYNTHETIC_SCAN_HEADER: TOKEN})
        handler.do_POST()
        self.assertEqual(captured["status"], HTTPStatus.OK)
        self.assertEqual(captured["payload"], {"synthetic": True, "topCandidates": []})
        service.synthetic_visual_match_scan.assert_called_once()
        service.visual_match_scan.assert_not_called()
        handler._require_request_identity.assert_not_called()
        identity = service.request_identity_context.call_args.args[0]
        self.assertEqual(identity.user_id, server_module.SYNTHETIC_SCAN_USER_ID)
        self.assertEqual(server_module._scan_inference_slots_held(), 0)

    def test_ipv6_loopback_is_accepted(self) -> None:
        handler, service, captured = _handler(
            headers={server_module.SYNTHETIC_SCAN_HEADER: TOKEN}, client_ip="::1"
        )
        handler.do_POST()
        self.assertEqual(captured["status"], HTTPStatus.OK)

    def test_wrong_token_is_rejected(self) -> None:
        self._assert_rejected(*_handler(headers={server_module.SYNTHETIC_SCAN_HEADER: "nope"}))

    def test_empty_token_is_rejected(self) -> None:
        self._assert_rejected(*_handler(headers={server_module.SYNTHETIC_SCAN_HEADER: ""}))

    def test_unconfigured_token_disables_the_lane(self) -> None:
        with patch.dict(os.environ, {server_module.SYNTHETIC_SCAN_TOKEN_ENV: ""}):
            self._assert_rejected(*_handler(headers={server_module.SYNTHETIC_SCAN_HEADER: ""}))
        os.environ.pop(server_module.SYNTHETIC_SCAN_TOKEN_ENV, None)
        self._assert_rejected(*_handler(headers={server_module.SYNTHETIC_SCAN_HEADER: TOKEN}))

    def test_non_loopback_client_is_rejected(self) -> None:
        self._assert_rejected(
            *_handler(headers={server_module.SYNTHETIC_SCAN_HEADER: TOKEN}, client_ip="10.128.0.5")
        )

    def test_proxied_request_is_rejected_even_from_loopback(self) -> None:
        # Caddy connects from 127.0.0.1 but always adds X-Forwarded-*.
        for header in ("X-Forwarded-For", "X-Forwarded-Host", "Forwarded", "X-Real-IP"):
            with self.subTest(header=header):
                self._assert_rejected(
                    *_handler(
                        headers={server_module.SYNTHETIC_SCAN_HEADER: TOKEN, header: "203.0.113.9"}
                    )
                )

    def test_missing_scan_id_is_400(self) -> None:
        handler, service, captured = _handler(
            headers={server_module.SYNTHETIC_SCAN_HEADER: TOKEN}, payload={"image": {}}
        )
        handler.do_POST()
        self.assertEqual(captured["status"], HTTPStatus.BAD_REQUEST)
        service.synthetic_visual_match_scan.assert_not_called()

    def test_service_failure_is_500_and_releases_slot(self) -> None:
        handler, service, captured = _handler(headers={server_module.SYNTHETIC_SCAN_HEADER: TOKEN})
        service.synthetic_visual_match_scan.side_effect = RuntimeError("encoder down")
        with contextlib.redirect_stderr(io.StringIO()):
            handler.do_POST()
        self.assertEqual(captured["status"], HTTPStatus.INTERNAL_SERVER_ERROR)
        self.assertEqual(server_module._scan_inference_slots_held(), 0)

    def test_request_without_header_takes_normal_lane_unchanged(self) -> None:
        handler, service, captured = _handler(headers={})
        handler.do_POST()
        self.assertEqual(captured["payload"], {"normal": True})
        service.visual_match_scan.assert_called_once_with({"scanID": "synthetic-1"})
        service.synthetic_visual_match_scan.assert_not_called()


def _match(card_id: str, similarity: float) -> SimpleNamespace:
    return SimpleNamespace(
        row_index=0,
        similarity=similarity,
        entry={
            "providerCardId": card_id,
            "name": f"Card {card_id}",
            "collectorNumber": f"{card_id}/000",
            "setId": "set",
            "setName": "Probe Set",
            "setSeries": "Test Series",
            "setPtcgoCode": "PRB",
            "sourceProvider": "scrydex",
            "sourceRecordID": card_id,
            "imageUrl": f"https://images.example/{card_id}.png",
            "language": "English",
        },
    )


class SyntheticScanServiceTests(unittest.TestCase):
    PERSISTED_TABLES = ("scan_events", "scan_prediction_candidates", "scan_price_observations")

    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        database_path = Path(self.tempdir.name) / "synthetic.sqlite"
        connection = connect(database_path)
        apply_schema(connection, BACKEND_ROOT / "schema.sql")
        self.card_ids = [f"probe-{i:02d}" for i in range(12)]
        for card_id in self.card_ids:
            # No price: a normal scan with live pricing on would refresh it.
            upsert_catalog_card(
                connection,
                catalog_card(card_id=card_id, name=f"Card {card_id}", set_name="Probe Set",
                             number=f"{card_id}/000", set_id="set"),
                REPO_ROOT,
                "2026-04-09T04:00:00Z",
                refresh_embeddings=False,
            )
        connection.commit()
        connection.close()
        self.service = SpotlightScanService(database_path, REPO_ROOT)
        matches = [_match(card_id, 0.9 - 0.01 * i) for i, card_id in enumerate(self.card_ids)]

        class FakeVisualMatcher:
            def prewarm(self):
                return {"available": True, "prewarmed": True}

            def match_payload(self, payload, *, top_k: int = 10):  # noqa: ARG002
                return list(matches[:top_k]), {"source": "fake", "timings": {}}

        self.service._raw_visual_matcher = FakeVisualMatcher()  # noqa: SLF001
        self.identity = RequestIdentity(user_id=server_module.SYNTHETIC_SCAN_USER_ID, auth_source="synthetic_probe")

    def tearDown(self) -> None:
        self.service.connection.close()
        self.tempdir.cleanup()

    def _row_counts(self) -> dict[str, int]:
        return {
            table: self.service.connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
            for table in self.PERSISTED_TABLES
        }

    def test_synthetic_scan_returns_candidates_and_persists_nothing(self) -> None:
        with contextlib.redirect_stdout(io.StringIO()) as logs, self.service.request_identity_context(self.identity):
            response = self.service.synthetic_visual_match_scan(raw_payload(scan_id="synthetic-a"))
        self.assertTrue(response["synthetic"])
        self.assertEqual(response["topCandidates"][0]["candidate"]["id"], "probe-00")
        self.assertEqual(len(response["topCandidates"]), 10)
        self.assertEqual(self._row_counts(), {table: 0 for table in self.PERSISTED_TABLES})
        self.assertIsNone(self.service._pending_visual_scan("synthetic-a"))  # noqa: SLF001
        events = [json.loads(line).get("event") for line in logs.getvalue().splitlines() if line.startswith("{")]
        self.assertIn("synthetic_scan_probe", events)
        self.assertNotIn("scan_match_request", events)
        self.assertNotIn("scan_match", events)

    def test_normal_scan_still_persists(self) -> None:
        # Control for the test above: the normal lane is untouched.
        with contextlib.redirect_stdout(io.StringIO()):
            self.service.visual_match_scan(raw_payload(scan_id="normal-a"))
        counts = self._row_counts()
        self.assertEqual(counts["scan_events"], 1)
        self.assertGreater(counts["scan_prediction_candidates"], 0)

    def test_synthetic_scan_never_refreshes_provider_pricing(self) -> None:
        self.service.set_live_pricing_mode(enabled=True)
        with patch.object(
            self.service, "_refresh_card_pricing_for_context", return_value=None
        ) as refresh, contextlib.redirect_stdout(io.StringIO()):
            self.service.synthetic_visual_match_scan(raw_payload(scan_id="synthetic-b"))
            refresh.assert_not_called()
            self.assertFalse(self.service._synthetic_scan_active())  # noqa: SLF001
            self.assertTrue(self.service._live_scrydex_pricing_refresh_allowed())  # noqa: SLF001
            # Control: the same setup DOES refresh on a normal scan.
            self.service.visual_match_scan(raw_payload(scan_id="normal-b"))
            refresh.assert_called()

    def test_synthetic_flag_is_thread_local(self) -> None:
        seen: dict[str, bool] = {}
        self.service._thread_local.synthetic_scan = True  # noqa: SLF001
        try:
            worker = threading.Thread(
                target=lambda: seen.setdefault("other", self.service._synthetic_scan_active())  # noqa: SLF001
            )
            worker.start()
            worker.join()
        finally:
            self.service._thread_local.synthetic_scan = False  # noqa: SLF001
        self.assertFalse(seen["other"])

    def test_matcher_failure_raises_instead_of_degrading(self) -> None:
        def boom(payload, *, top_k: int = 10):  # noqa: ARG001
            raise RuntimeError("index missing")

        self.service._raw_visual_matcher.match_payload = boom  # noqa: SLF001
        with self.assertRaises(RuntimeError):
            self.service.synthetic_visual_match_scan(raw_payload(scan_id="synthetic-c"))
        self.assertFalse(self.service._synthetic_scan_active())  # noqa: SLF001
        self.assertEqual(self._row_counts()["scan_events"], 0)

    def test_binder_page_payload_is_rejected(self) -> None:
        payload = raw_payload(scan_id="synthetic-d")
        payload["binderPage"] = {"pageToken": "x", "pocketIndex": 0}
        with self.assertRaises(ValueError):
            self.service.synthetic_visual_match_scan(payload)


class SyntheticScanProbeScriptTests(unittest.TestCase):
    def test_fixture_is_bundled_and_small(self) -> None:
        self.assertTrue(probe.FIXTURE_PATH.is_file())
        self.assertTrue(probe.FIXTURE_PATH.is_relative_to(BACKEND_ROOT))
        self.assertLess(probe.FIXTURE_PATH.stat().st_size, 200_000)

    def test_multipart_body_round_trips_through_server_parser(self) -> None:
        image_bytes = probe.FIXTURE_PATH.read_bytes()
        boundary = "probe-boundary-1"
        body = probe.build_multipart_body(probe.build_match_payload("synthetic-x"), image_bytes, boundary)
        parts = server_module._parse_multipart_form_data(body, boundary)
        self.assertIsNotNone(parts)
        payload = json.loads(parts["payload"])
        server_module._inject_multipart_scan_images(PATH, payload, parts)
        self.assertEqual(payload["scanID"], "synthetic-x")
        self.assertEqual(payload["game"], "pokemon")
        self.assertEqual(base64.b64decode(payload["image"]["jpegBase64"]), image_bytes)

    def _response(self, ids: list[str], *, synthetic: bool = True) -> dict[str, object]:
        return {
            "synthetic": synthetic,
            "topCandidates": [{"rank": i + 1, "candidate": {"id": cid}} for i, cid in enumerate(ids)],
        }

    def test_evaluate_passes_when_expected_card_in_top_k(self) -> None:
        ok, detail = probe.evaluate_response(self._response(["a", "b", probe.EXPECTED_CARD_ID]))
        self.assertTrue(ok)
        self.assertIn("rank=3", detail)

    def test_evaluate_fails_when_expected_card_below_top_k(self) -> None:
        ids = ["a", "b", "c", "d", "e", probe.EXPECTED_CARD_ID]
        self.assertFalse(probe.evaluate_response(self._response(ids))[0])
        self.assertFalse(probe.evaluate_response(self._response([]))[0])

    def test_evaluate_fails_when_server_did_not_honor_synthetic_lane(self) -> None:
        ok, _ = probe.evaluate_response(self._response([probe.EXPECTED_CARD_ID], synthetic=False))
        self.assertFalse(ok)

    def test_rate_limit_state(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            state = Path(tmp) / "last-ok"
            self.assertFalse(probe.recently_passed(state, 10_000.0, 900))
            state.write_text("10000\n")
            self.assertTrue(probe.recently_passed(state, 10_000.0 + 899, 900))
            self.assertFalse(probe.recently_passed(state, 10_000.0 + 901, 900))
            state.write_text("garbage")
            self.assertFalse(probe.recently_passed(state, 10_000.0, 900))

    def test_main_skips_without_token(self) -> None:
        with patch.dict(os.environ, {probe.SYNTHETIC_SCAN_TOKEN_ENV: ""}), patch.object(
            probe, "run_probe"
        ) as run, contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(probe.main([]), 0)
        run.assert_not_called()

    def test_main_records_state_only_on_success(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            state = Path(tmp) / "last-ok"
            args = ["--state-file", str(state)]
            with patch.dict(os.environ, {probe.SYNTHETIC_SCAN_TOKEN_ENV: TOKEN}), contextlib.redirect_stdout(
                io.StringIO()
            ), contextlib.redirect_stderr(io.StringIO()):
                with patch.object(probe, "run_probe", return_value=(False, "HTTP 503")):
                    self.assertEqual(probe.main(args), 1)
                self.assertFalse(state.exists())
                with patch.object(probe, "run_probe", return_value=(True, "ok")) as run:
                    self.assertEqual(probe.main(args), 0)
                    self.assertTrue(state.exists())
                    # Within the interval: skipped, no scan.
                    self.assertEqual(probe.main(args), 0)
                    self.assertEqual(run.call_count, 1)


if __name__ == "__main__":
    unittest.main()
