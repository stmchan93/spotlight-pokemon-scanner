"""Booth admin routes + post-show recap selection (Supabase mocked, no network)."""

from __future__ import annotations

import io
import json
import os
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from http import HTTPStatus
from pathlib import Path
from typing import Any
from unittest import mock

BACKEND_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_ROOT.parent
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

import booth_admin  # noqa: E402
import send_booth_recaps  # noqa: E402
import spotlight_events  # noqa: E402
from catalog_tools import apply_schema, connect  # noqa: E402
from server import SpotlightRequestHandler, SpotlightScanService  # noqa: E402

TOKEN = "test-ops-token"


def _event(**overrides: Any) -> dict[str, Any]:
    row: dict[str, Any] = {
        "id": "hawaii-2026-12",
        "title": "Spotlight at the Hawaii Convention Center",
        "shortTitle": "Spotlight Hawaii",
        "venue": "Hawaii Convention Center",
        "city": "Honolulu, HI",
        "address": "1801 Kalakaua Ave, Honolulu, HI 96815",
        "startDate": "2026-12-13",
        "endDate": "2026-12-14",
        "timezone": "Pacific/Honolulu",
        "categories": ["Pokemon"],
    }
    row.update(overrides)
    return row


def _overview_row(vendor_id: str, **overrides: Any) -> dict[str, Any]:
    row = {
        "vendor_id": vendor_id, "event_id": "hawaii-2026-12", "user_id": f"user-{vendor_id}", "handle": vendor_id,
        "claimed_at": "2026-12-06T20:00:00+00:00", "report_count": 0, "card_opens": 10, "instagram_taps": 2,
        "message_starts": 1, "post_views": 30, "post_count": 2,
    }
    row.update(overrides)
    return row


class BoothAdminRouteTests(unittest.TestCase):
    def setUp(self) -> None:
        spotlight_events.clear_cache()
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        root = Path(self.tempdir.name)
        database_path = root / "events.sqlite"
        connection = connect(database_path)
        apply_schema(connection, BACKEND_ROOT / "schema.sql")
        connection.close()
        env = mock.patch.dict(
            os.environ,
            {
                "SPOTLIGHT_PAYLOAD_CACHE_DIR": "",
                "SPOTLIGHT_OPS_REFRESH_TOKEN": TOKEN,
                "SUPABASE_URL": "https://example.supabase.co",
                "SUPABASE_SERVICE_ROLE_KEY": "service-key",
            },
        )
        env.start()
        self.addCleanup(env.stop)
        self.service = SpotlightScanService(database_path, REPO_ROOT)
        self.addCleanup(lambda: self.service.connection.close())
        self.addCleanup(lambda: spotlight_events.configure_admin(None))
        events_path = root / "spotlight_events.json"
        events_path.write_text(json.dumps({"events": [_event()]}), encoding="utf-8")
        maps_dir = root / "maps"
        maps_dir.mkdir()
        (maps_dir / "floor.png").write_bytes(b"png")
        (maps_dir / "hawaii-2026-12.json").write_text(
            json.dumps(
                {
                    "imageFile": "floor.png", "imageWidth": 10, "imageHeight": 10, "tables": [], "tags": [],
                    "vendors": [
                        {"id": "island-slabs", "name": "Island Slabs", "location": "C4", "tableIds": ["C4"], "tags": []},
                        {"id": "808-cardtel", "name": "808 Cardtel", "location": "A1", "tableIds": ["A1"], "tags": []},
                    ],
                }
            ),
            encoding="utf-8",
        )
        for name, value in (("EVENTS_PATH", events_path), ("FLYERS_DIR", root / "flyers"), ("MAPS_DIR", maps_dir)):
            patcher = mock.patch.object(spotlight_events, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def _call(self, method: str, path: str, *, token: str | None = TOKEN) -> tuple[HTTPStatus, Any]:
        handler = SpotlightRequestHandler.__new__(SpotlightRequestHandler)
        handler.path = path
        handler.headers = {"Content-Length": "0", "Content-Type": "application/json"}
        if token is not None:
            handler.headers["X-Ops-Token"] = token
        handler.rfile = io.BytesIO(b"")
        handler.service = self.service
        writes: list[tuple[HTTPStatus, Any]] = []
        handler._write_json = lambda status, payload: writes.append((status, payload))  # type: ignore[method-assign]
        getattr(handler, f"do_{method}")()
        self.assertEqual(len(writes), 1, writes)
        return writes[0]

    def test_routes_need_the_ops_token(self) -> None:
        with mock.patch.object(booth_admin, "_rest") as rest:
            status, _ = self._call("GET", "/api/v1/admin/events/hawaii-2026-12/booths", token="wrong")
            self.assertEqual(status, HTTPStatus.UNAUTHORIZED)
            status, _ = self._call("POST", "/api/v1/admin/events/hawaii-2026-12/booths/island-slabs/unclaim", token=None)
            self.assertEqual(status, HTTPStatus.UNAUTHORIZED)
            status, _ = self._call("POST", "/api/v1/admin/events/hawaii-2026-12/booth-recaps", token="wrong")
            self.assertEqual(status, HTTPStatus.UNAUTHORIZED)
        rest.assert_not_called()

    def test_booths_lists_only_this_shows_vendors(self) -> None:
        rows = [
            _overview_row("island-slabs", report_count=2),
            _overview_row("808-cardtel"),
            _overview_row("someone-at-another-show", event_id="ontario-2026-08"),
        ]
        with mock.patch.object(booth_admin, "_rest", return_value=rows) as rest:
            status, payload = self._call("GET", "/api/v1/admin/events/hawaii-2026-12/booths")
        self.assertEqual(status, HTTPStatus.OK)
        rest.assert_called_once_with("POST", "rpc/booth_admin_overview", {"p_event_id": "hawaii-2026-12"})
        booths = payload["booths"]
        # Reported claims first, then by name.
        self.assertEqual([b["vendorId"] for b in booths], ["island-slabs", "808-cardtel"])
        self.assertEqual(booths[0]["vendorName"], "Island Slabs")
        self.assertEqual(booths[0]["reports"], 2)
        self.assertEqual(
            {k: booths[1][k] for k in ("views", "instagramTaps", "messages", "postViews", "posts")},
            {"views": 10, "instagramTaps": 2, "messages": 1, "postViews": 30, "posts": 2},
        )

    def test_unknown_event_is_404(self) -> None:
        with mock.patch.object(booth_admin, "_rest") as rest:
            status, _ = self._call("GET", "/api/v1/admin/events/nope/booths")
            self.assertEqual(status, HTTPStatus.NOT_FOUND)
            status, _ = self._call("POST", "/api/v1/admin/events/nope/booth-recaps")
            self.assertEqual(status, HTTPStatus.NOT_FOUND)
        rest.assert_not_called()

    def test_unclaim_patches_the_active_claim_with_the_service_role(self) -> None:
        with mock.patch.object(booth_admin, "_rest", return_value=[{"id": "claim-1"}]) as rest:
            status, payload = self._call("POST", "/api/v1/admin/events/hawaii-2026-12/booths/island-slabs/unclaim")
        self.assertEqual(status, HTTPStatus.OK)
        self.assertEqual(payload, {"vendorId": "island-slabs", "revoked": 1})
        method, path, body = rest.call_args.args
        self.assertEqual(method, "PATCH")
        self.assertEqual(path, "booth_claims?vendor_id=eq.island-slabs&revoked_at=is.null")
        self.assertIn("revoked_at", body)

    def test_send_recaps_uses_the_short_title(self) -> None:
        with mock.patch.object(booth_admin, "_rest", return_value=3) as rest:
            status, payload = self._call("POST", "/api/v1/admin/events/hawaii-2026-12/booth-recaps")
        self.assertEqual((status, payload), (HTTPStatus.OK, {"sent": 3}))
        rest.assert_called_once_with(
            "POST", "rpc/send_booth_recaps", {"p_event_id": "hawaii-2026-12", "p_event_name": "Spotlight Hawaii"}
        )

    def test_supabase_failure_is_a_bad_gateway(self) -> None:
        with mock.patch.object(booth_admin, "_rest", side_effect=booth_admin.BoothAdminError("supabase 500: boom")):
            status, payload = self._call("GET", "/api/v1/admin/events/hawaii-2026-12/booths")
        self.assertEqual(status, HTTPStatus.BAD_GATEWAY)
        self.assertIn("boom", payload["error"])


class RestCallTests(unittest.TestCase):
    def test_sends_service_role_headers(self) -> None:
        captured: dict[str, Any] = {}

        class _Response(io.BytesIO):
            def __enter__(self):  # noqa: ANN204
                return self

            def __exit__(self, *exc: object) -> None:
                return None

        def fake_urlopen(request: Any, timeout: int) -> _Response:
            captured["url"] = request.full_url
            captured["method"] = request.get_method()
            captured["headers"] = dict(request.header_items())
            captured["body"] = json.loads(request.data)
            return _Response(b"2")

        env = {"SUPABASE_URL": "https://example.supabase.co/", "SUPABASE_SERVICE_ROLE_KEY": "service-key"}
        with mock.patch.dict(os.environ, env), mock.patch.object(booth_admin, "urlopen", fake_urlopen):
            self.assertEqual(booth_admin.send_recaps("hawaii-2026-12", "Spotlight Hawaii"), 2)
        self.assertEqual(captured["url"], "https://example.supabase.co/rest/v1/rpc/send_booth_recaps")
        self.assertEqual(captured["method"], "POST")
        self.assertEqual(captured["headers"]["Authorization"], "Bearer service-key")
        self.assertEqual(captured["headers"]["Apikey"], "service-key")
        self.assertEqual(captured["body"], {"p_event_id": "hawaii-2026-12", "p_event_name": "Spotlight Hawaii"})

    def test_unconfigured_raises(self) -> None:
        with mock.patch.dict(os.environ, {"SUPABASE_URL": "", "SUPABASE_SERVICE_ROLE_KEY": "",
                                          "EXPO_PUBLIC_SPOTLIGHT_SUPABASE_URL": "", "SPOTLIGHT_SUPABASE_URL": "",
                                          "SPOTLIGHT_SUPABASE_SERVICE_ROLE_KEY": ""}):
            with self.assertRaises(booth_admin.BoothAdminError):
                booth_admin.send_recaps("x", "y")


class RecapSelectionTests(unittest.TestCase):
    def test_picks_shows_that_ended_yesterday_in_their_own_timezone(self) -> None:
        hawaii = _event()
        ontario = _event(id="ontario-2026-12", endDate="2026-12-14", timezone="America/Los_Angeles")
        later = _event(id="later", endDate="2026-12-20")
        # 2026-12-15 09:00 UTC = 12-14 23:00 in Honolulu (show still on its last day)
        # but 12-15 01:00 in Los Angeles (ended yesterday).
        moment = datetime(2026, 12, 15, 9, 0, tzinfo=timezone.utc)
        due = booth_admin.events_ended_yesterday([hawaii, ontario, later], moment)
        self.assertEqual([e["id"] for e in due], ["ontario-2026-12"])
        # Next morning both are due.
        due = booth_admin.events_ended_yesterday([hawaii, ontario, later], datetime(2026, 12, 15, 18, 20, tzinfo=timezone.utc))
        self.assertEqual([e["id"] for e in due], ["hawaii-2026-12", "ontario-2026-12"])

    def test_lookback_covers_a_missed_tick_but_not_old_shows(self) -> None:
        show = _event(timezone="UTC")
        self.assertEqual(len(booth_admin.events_ended_yesterday([show], datetime(2026, 12, 17, 12, tzinfo=timezone.utc))), 1)
        self.assertEqual(booth_admin.events_ended_yesterday([show], datetime(2026, 12, 18, 12, tzinfo=timezone.utc)), [])

    def test_job_sends_per_due_show_and_survives_a_failure(self) -> None:
        shows = [_event(), _event(id="ontario-2026-12", shortTitle="Spotlight Ontario")]

        def fake_send(event_id: str, name: str) -> int:
            if event_id == "hawaii-2026-12":
                raise booth_admin.BoothAdminError("supabase 500")
            return 4

        with mock.patch.object(booth_admin, "recap_due_events", return_value=shows), \
                mock.patch.object(booth_admin, "send_recaps", side_effect=fake_send) as send:
            self.assertEqual(send_booth_recaps.run(), 4)
        self.assertEqual(
            [c.args for c in send.call_args_list],
            [("hawaii-2026-12", "Spotlight Hawaii"), ("ontario-2026-12", "Spotlight Ontario")],
        )

    def test_dry_run_sends_nothing(self) -> None:
        with mock.patch.object(booth_admin, "recap_due_events", return_value=[_event()]), \
                mock.patch.object(booth_admin, "send_recaps") as send:
            self.assertEqual(send_booth_recaps.run(dry_run=True), 0)
        send.assert_not_called()

    def test_main_without_credentials_is_a_quiet_no_op(self) -> None:
        with mock.patch.object(booth_admin, "configured", return_value=False), \
                mock.patch.object(send_booth_recaps, "run") as run:
            self.assertEqual(send_booth_recaps.main([]), 0)
        run.assert_not_called()


if __name__ == "__main__":
    unittest.main()
