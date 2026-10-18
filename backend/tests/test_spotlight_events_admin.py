"""Events admin: browser edits layered over the shipped events file (no network)."""

from __future__ import annotations

import io
import json
import os
import sys
import tempfile
import unittest
from http import HTTPStatus
from pathlib import Path
from typing import Any
from unittest import mock

BACKEND_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_ROOT.parent
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

import spotlight_events  # noqa: E402
import spotlight_events_admin  # noqa: E402
from catalog_tools import apply_schema, connect  # noqa: E402
from server import SpotlightRequestHandler, SpotlightScanService  # noqa: E402

TOKEN = "test-ops-token"


def _event(**overrides: Any) -> dict[str, Any]:
    row: dict[str, Any] = {
        "id": "ontario-2026-08",
        "title": "Spotlight at the Ontario Convention Center",
        "shortTitle": "Spotlight Ontario",
        "venue": "Ontario Convention Center",
        "city": "Ontario, CA",
        "address": "2000 E Convention Center Way, Ontario, CA 91764",
        "latitude": 34.0672,
        "longitude": -117.597,
        "startDate": "2026-08-22",
        "endDate": "2026-08-23",
        "timezone": "America/Los_Angeles",
        "openTime": "11:00",
        "closeTime": "17:00",
        "tableCount": 275,
        "categories": ["Pokemon"],
        "about": None,
        "flyer": None,
        "ticketUrl": None,
        "shareUrl": None,
        "featured": True,
        "accentColor": None,
    }
    row.update(overrides)
    return row


def _jpeg(width: int = 1080, height: int = 1350) -> bytes:
    from PIL import Image

    out = io.BytesIO()
    Image.new("RGB", (width, height), (200, 30, 120)).save(out, format="PNG")
    return out.getvalue()


class EventsAdminTests(unittest.TestCase):
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
            os.environ, {"SPOTLIGHT_PAYLOAD_CACHE_DIR": "", "SPOTLIGHT_OPS_REFRESH_TOKEN": TOKEN}
        )
        env.start()
        self.addCleanup(env.stop)
        self.service = SpotlightScanService(database_path, REPO_ROOT)
        self.addCleanup(lambda: self.service.connection.close())
        self.addCleanup(lambda: spotlight_events.configure_admin(None))
        events_path = root / "spotlight_events.json"
        events_path.write_text(json.dumps({"events": [_event()]}), encoding="utf-8")
        for name, value in (("EVENTS_PATH", events_path), ("FLYERS_DIR", root / "flyers"), ("MAPS_DIR", root / "maps")):
            patcher = mock.patch.object(spotlight_events, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def _call(self, method: str, path: str, body: bytes = b"", *, token: str | None = TOKEN,
              content_type: str = "application/json") -> tuple[str, Any]:
        handler = SpotlightRequestHandler.__new__(SpotlightRequestHandler)
        handler.path = path
        handler.headers = {"Content-Length": str(len(body)), "Content-Type": content_type}
        if token is not None:
            handler.headers["X-Ops-Token"] = token
        handler.rfile = io.BytesIO(body)
        handler.service = self.service
        writes: list[tuple[str, Any]] = []
        handler._write_json = lambda status, payload: writes.append(("json", (status, payload)))  # type: ignore[method-assign]
        handler._write_public_image = lambda data, **kw: writes.append(("image", (data, kw)))  # type: ignore[method-assign]
        handler._write_html = lambda status, html: writes.append(("html", (status, html)))  # type: ignore[method-assign]
        getattr(handler, f"do_{method}")()
        self.assertEqual(len(writes), 1, writes)
        return writes[0]

    def _post(self, path: str, payload: Any) -> tuple[str, Any]:
        return self._call("POST", path, json.dumps(payload).encode())

    def _feed(self) -> dict[str, dict[str, Any]]:
        self.service.events_admin._cached = None
        return {item["id"]: item for item in spotlight_events.build_events_payload()["items"]}

    def test_token_required_and_admin_off_without_one(self) -> None:
        kind, (status, _) = self._call("GET", "/api/v1/admin/events", token="wrong")
        self.assertEqual(status, HTTPStatus.UNAUTHORIZED)
        with mock.patch.dict(os.environ, {"SPOTLIGHT_OPS_REFRESH_TOKEN": ""}):
            kind, (status, _) = self._call("GET", "/api/v1/admin/events")
        self.assertEqual(status, HTTPStatus.SERVICE_UNAVAILABLE)
        kind, (status, html) = self._call("GET", "/admin/events", token=None)
        self.assertEqual((kind, status), ("html", HTTPStatus.OK))
        self.assertIn("Spotlight Events", html)

    def test_add_edit_hide_reset(self) -> None:
        new = _event(id="seattle-2026-12", title="Spotlight at Seattle Center", city="Seattle, WA",
                     startDate="2026-12-12", endDate="2026-12-13")
        kind, (status, _) = self._post("/api/v1/admin/events", new)
        self.assertEqual(status, HTTPStatus.OK)
        self.assertIn("seattle-2026-12", self._feed())

        edited = _event(title="Spotlight Ontario — moved", tableCount=300)
        self._post("/api/v1/admin/events", edited)
        self.assertEqual(self._feed()["ontario-2026-08"]["tableCount"], 300)

        kind, (status, listing) = self._call("GET", "/api/v1/admin/events")
        sources = {row["id"]: row["source"] for row in listing["events"]}
        self.assertEqual(sources, {"ontario-2026-08": "both", "seattle-2026-12": "admin"})

        self._post("/api/v1/admin/events/ontario-2026-08/visibility", {"hidden": True})
        self.assertNotIn("ontario-2026-08", self._feed())
        self._post("/api/v1/admin/events/ontario-2026-08/visibility", {"hidden": False})
        self.assertIn("ontario-2026-08", self._feed())

        self._call("DELETE", "/api/v1/admin/events/ontario-2026-08")
        self.assertEqual(self._feed()["ontario-2026-08"]["tableCount"], 275)

    def test_invalid_event_is_rejected_and_never_stored(self) -> None:
        kind, (status, payload) = self._post("/api/v1/admin/events", _event(id="Bad Id"))
        self.assertEqual(status, HTTPStatus.BAD_REQUEST)
        self.assertIn("id", payload["error"])
        self.assertEqual(set(self._feed()), {"ontario-2026-08"})

    def test_hiding_a_file_event_does_not_pin_its_contents(self) -> None:
        self._post("/api/v1/admin/events/ontario-2026-08/visibility", {"hidden": True})
        self._post("/api/v1/admin/events/ontario-2026-08/visibility", {"hidden": False})
        self.assertEqual(self._feed()["ontario-2026-08"]["title"], "Spotlight at the Ontario Convention Center")

    def test_flyer_upload_is_resized_served_and_versioned(self) -> None:
        kind, (status, payload) = self._call(
            "POST", "/api/v1/admin/events/ontario-2026-08/flyer", _jpeg(), content_type="image/png"
        )
        self.assertEqual(status, HTTPStatus.OK, payload)
        url = self._feed()["ontario-2026-08"]["flyerUrl"]
        self.assertRegex(url, r"^/api/v1/events/ontario-2026-08/flyer\?v=\d+$")
        kind, (data, kw) = self._call("GET", "/api/v1/events/ontario-2026-08/flyer", token=None)
        self.assertEqual((kind, kw["content_type"]), ("image", "image/jpeg"))
        from PIL import Image

        with Image.open(io.BytesIO(data)) as image:
            self.assertEqual(image.size, (720, 900))

        kind, (status, _) = self._call(
            "POST", "/api/v1/admin/events/ontario-2026-08/flyer", b"not an image", content_type="image/png"
        )
        self.assertEqual(status, HTTPStatus.BAD_REQUEST)
        kind, (status, _) = self._call("POST", "/api/v1/admin/events/nope/flyer", _jpeg(), content_type="image/png")
        self.assertEqual(status, HTTPStatus.NOT_FOUND)


if __name__ == "__main__":
    unittest.main()
