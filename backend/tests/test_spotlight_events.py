"""spotlight_events: hand-maintained Spotlight shows → Events feed + flyer route (no network)."""

from __future__ import annotations

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

import spotlight_events  # noqa: E402
from catalog_tools import apply_schema, connect  # noqa: E402
from server import SpotlightRequestHandler, SpotlightScanService  # noqa: E402

ITEM_KEYS = {
    "id", "title", "shortTitle", "venue", "city", "address", "latitude", "longitude",
    "startDate", "endDate", "timezone", "openTime", "closeTime", "tableCount", "categories",
    "about", "flyerUrl", "ticketUrl", "shareUrl", "featured", "accentColor", "status", "floorMapUrl",
}
PNG_BYTES = b"\x89PNG\r\n\x1a\nfake"


def _map_doc(**overrides: Any) -> dict[str, Any]:
    doc: dict[str, Any] = {
        "eventId": "ignored-on-the-wire",
        "imageFile": "ontario-2026-08.png",
        "imageWidth": 1600,
        "imageHeight": 3000,
        "tables": [{"id": "C1", "block": "C", "number": 1, "x": 0.1, "y": 0.2, "width": 0.01, "height": 0.02}],
        "vendors": [{"id": "main-street", "name": "Main Street", "location": "C1", "tableIds": ["C1"],
                     "tags": ["Pokémon"], "instagram": "mainstreet"}],
        "tags": ["Pokémon"],
        "updatedAt": "2026-10-15T00:00:00Z",
    }
    doc.update(overrides)
    return doc


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
        "categories": ["Pokemon", "Lorcana"],
        "about": None,
        "flyer": "ontario-2026-08.png",
        "ticketUrl": None,
        "shareUrl": None,
        "featured": True,
        "accentColor": "#FFB000",
    }
    row.update(overrides)
    return row


def _utc(*args: int) -> datetime:
    return datetime(*args, tzinfo=timezone.utc)


class SpotlightEventsTests(unittest.TestCase):
    def setUp(self) -> None:
        spotlight_events.clear_cache()
        self.addCleanup(spotlight_events.clear_cache)
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        root = Path(self.tempdir.name)
        self.events_path = root / "spotlight_events.json"
        self.flyers_dir = root / "flyers"
        self.flyers_dir.mkdir()
        self.maps_dir = root / "maps"
        self.maps_dir.mkdir()

    def _write(self, rows: list[Any]) -> None:
        spotlight_events.clear_cache()
        self.events_path.write_text(json.dumps({"_note": "x", "events": rows}), encoding="utf-8")

    def _build(self, now: datetime) -> dict[str, Any]:
        return spotlight_events.build_events_payload(
            now=now, events_path=self.events_path, flyers_dir=self.flyers_dir, maps_dir=self.maps_dir
        )

    def test_seed_file_is_valid(self) -> None:
        raw = json.loads(spotlight_events.EVENTS_PATH.read_text(encoding="utf-8"))
        events = spotlight_events.load_events()
        self.assertEqual(len(events), len(raw["events"]))
        self.assertEqual([e["id"] for e in events], ["ontario-2026-08", "hawaii-2026-10"])

    def test_invalid_rows_are_skipped_and_logged(self) -> None:
        bad = {
            "bad date": _event(id="a", startDate="2026-02-30"),
            "date format": _event(id="b", startDate="2026/08/22"),
            "end before start": _event(id="c", endDate="2026-08-21"),
            "bad tz": _event(id="d", timezone="Mars/Olympus"),
            "http url": _event(id="e", ticketUrl="http://example.com/t"),
            "not url": _event(id="f", shareUrl="spotlight"),
            "bad color": _event(id="g", accentColor="#FFB00"),
            "bad id": _event(id="Bad_ID"),
            "missing venue": _event(id="h", venue=""),
            "bad time": _event(id="i", openTime="25:00"),
            "flyer traversal": _event(id="j", flyer="../secret.png"),
            "flyer ext": _event(id="k", flyer="notes.txt"),
            "featured str": _event(id="l", featured="yes"),
            "half coords": _event(id="m", longitude=None),
            "not object": "nope",
        }
        good = _event(id="ok")
        duplicate = _event(id="ok", title="Second copy")
        self._write([good, *bad.values(), duplicate])
        with self.assertLogs("spotlight.spotlight_events", level="WARNING") as logs:
            events = spotlight_events.load_events(self.events_path)
        self.assertEqual([e["id"] for e in events], ["ok"])
        self.assertEqual(events[0]["title"], good["title"])  # first wins
        self.assertEqual(len(logs.output), len(bad) + 1)
        self.assertTrue(any("duplicate id" in line for line in logs.output))

    def test_defaults_and_short_title_fallback(self) -> None:
        row = _event(id="min")
        for field in ("shortTitle", "categories", "featured"):
            row.pop(field)
        self._write([row])
        (item,) = self._build(_utc(2026, 1, 1))["items"]
        self.assertEqual(item["shortTitle"], row["title"])
        self.assertEqual(item["categories"], [])
        self.assertIs(item["featured"], False)

    def test_status_and_order(self) -> None:
        self._write([
            _event(id="past-old", startDate="2026-01-10", endDate="2026-01-11"),
            _event(id="upcoming-late", startDate="2026-12-01", endDate="2026-12-02"),
            _event(id="live-now", startDate="2026-10-07", endDate="2026-10-09"),
            _event(id="past-recent", startDate="2026-08-22", endDate="2026-08-23"),
            _event(id="upcoming-soon", startDate="2026-10-24", endDate="2026-10-25"),
        ])
        items = self._build(_utc(2026, 10, 8, 20))["items"]
        self.assertEqual(
            [(i["id"], i["status"]) for i in items],
            [
                ("live-now", "live"),
                ("upcoming-soon", "upcoming"),
                ("upcoming-late", "upcoming"),
                ("past-recent", "past"),
                ("past-old", "past"),
            ],
        )

    def test_status_uses_event_timezone(self) -> None:
        self._write([
            _event(id="hawaii", timezone="Pacific/Honolulu", startDate="2026-10-24", endDate="2026-10-25"),
        ])
        # 2026-10-24 08:00 UTC is still 10-23 22:00 in Honolulu (UTC-10).
        self.assertEqual(self._build(_utc(2026, 10, 24, 8))["items"][0]["status"], "upcoming")
        self.assertEqual(self._build(_utc(2026, 10, 24, 10))["items"][0]["status"], "live")
        # 10-26 09:00 UTC = 10-25 23:00 Honolulu: still the last day.
        self.assertEqual(self._build(_utc(2026, 10, 26, 9))["items"][0]["status"], "live")
        self.assertEqual(self._build(_utc(2026, 10, 26, 10))["items"][0]["status"], "past")

    def test_flyer_url_only_when_file_exists(self) -> None:
        self._write([_event(id="with-file", flyer="a.png"), _event(id="no-file", flyer="b.png"),
                     _event(id="no-flyer", flyer=None)])
        (self.flyers_dir / "a.png").write_bytes(PNG_BYTES)
        items = {i["id"]: i for i in self._build(_utc(2026, 1, 1))["items"]}
        self.assertEqual(items["with-file"]["flyerUrl"], "/api/v1/events/with-file/flyer")
        self.assertIsNone(items["no-file"]["flyerUrl"])
        self.assertIsNone(items["no-flyer"]["flyerUrl"])
        for item in items.values():
            self.assertEqual(set(item), ITEM_KEYS)
        found = spotlight_events.flyer_file("with-file", events_path=self.events_path, flyers_dir=self.flyers_dir)
        self.assertEqual(found, ((self.flyers_dir / "a.png").resolve(), "image/png"))
        for event_id in ("no-file", "no-flyer", "unknown", "../with-file"):
            self.assertIsNone(
                spotlight_events.flyer_file(event_id, events_path=self.events_path, flyers_dir=self.flyers_dir)
            )

    def test_floor_map_only_when_document_and_image_exist(self) -> None:
        self._write([_event(id="mapped"), _event(id="no-image"), _event(id="bad-json"), _event(id="no-map")])
        (self.maps_dir / "mapped.json").write_text(json.dumps(_map_doc(imageFile="mapped.png")), encoding="utf-8")
        (self.maps_dir / "mapped.png").write_bytes(PNG_BYTES)
        (self.maps_dir / "no-image.json").write_text(json.dumps(_map_doc(imageFile="gone.png")), encoding="utf-8")
        (self.maps_dir / "bad-json.json").write_text("{nope", encoding="utf-8")
        items = {i["id"]: i for i in self._build(_utc(2026, 1, 1))["items"]}
        self.assertEqual(items["mapped"]["floorMapUrl"], "/api/v1/events/mapped/map")
        for event_id in ("no-image", "bad-json", "no-map"):
            self.assertIsNone(items[event_id]["floorMapUrl"])

        kwargs = {"events_path": self.events_path, "maps_dir": self.maps_dir}
        payload = spotlight_events.floor_map_payload("mapped", **kwargs)
        assert payload is not None
        self.assertNotIn("imageFile", payload)
        self.assertEqual(payload["eventId"], "mapped")
        self.assertEqual(payload["imageUrl"], "/api/v1/events/mapped/map-image")
        self.assertEqual(payload["vendors"][0]["tableIds"], ["C1"])
        self.assertEqual(
            spotlight_events.floor_map_image_file("mapped", **kwargs), (self.maps_dir / "mapped.png").resolve()
        )
        for event_id in ("no-image", "bad-json", "no-map", "unknown", "../mapped"):
            self.assertIsNone(spotlight_events.floor_map_payload(event_id, **kwargs))
            self.assertIsNone(spotlight_events.floor_map_image_file(event_id, **kwargs))

    def test_floor_map_image_name_cannot_escape_the_maps_dir(self) -> None:
        self._write([_event(id="sneaky")])
        (self.maps_dir / "sneaky.json").write_text(
            json.dumps(_map_doc(imageFile="../spotlight_events.json")), encoding="utf-8"
        )
        self.assertIsNone(
            spotlight_events.floor_map_payload("sneaky", events_path=self.events_path, maps_dir=self.maps_dir)
        )

    def test_reloads_when_file_changes(self) -> None:
        self._write([_event(id="one")])
        self.assertEqual(len(spotlight_events.load_events(self.events_path)), 1)
        self.events_path.write_text(json.dumps({"events": [_event(id="one"), _event(id="two")]}), encoding="utf-8")
        stat = self.events_path.stat()
        os.utime(self.events_path, (stat.st_atime, stat.st_mtime + 5))
        self.assertEqual(len(spotlight_events.load_events(self.events_path)), 2)


class SpotlightEventsRouteTests(unittest.TestCase):
    def setUp(self) -> None:
        spotlight_events.clear_cache()
        self.addCleanup(spotlight_events.clear_cache)
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        root = Path(self.tempdir.name)
        database_path = root / "events.sqlite"
        connection = connect(database_path)
        apply_schema(connection, BACKEND_ROOT / "schema.sql")
        connection.close()
        env = mock.patch.dict(os.environ, {"SPOTLIGHT_PAYLOAD_CACHE_DIR": ""})
        env.start()
        self.addCleanup(env.stop)
        self.service = SpotlightScanService(database_path, REPO_ROOT)
        self.addCleanup(lambda: self.service.connection.close())
        events_path = root / "spotlight_events.json"
        flyers_dir = root / "flyers"
        flyers_dir.mkdir()
        (flyers_dir / "ontario.png").write_bytes(PNG_BYTES)
        events_path.write_text(
            json.dumps({"events": [_event(flyer="ontario.png"), _event(id="no-flyer", flyer=None)]}),
            encoding="utf-8",
        )
        maps_dir = root / "maps"
        maps_dir.mkdir()
        (maps_dir / "ontario-2026-08.json").write_text(json.dumps(_map_doc()), encoding="utf-8")
        (maps_dir / "ontario-2026-08.png").write_bytes(PNG_BYTES)
        for name, value in (("EVENTS_PATH", events_path), ("FLYERS_DIR", flyers_dir), ("MAPS_DIR", maps_dir)):
            patcher = mock.patch.object(spotlight_events, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def _get(self, path: str) -> list[tuple[str, Any]]:
        handler = SpotlightRequestHandler.__new__(SpotlightRequestHandler)
        handler.path = path
        handler.headers = {}
        handler.service = self.service
        writes: list[tuple[str, Any]] = []
        handler._write_json = lambda status, payload: writes.append(("json", (status, payload)))  # type: ignore[method-assign]
        handler._write_public_image = lambda body, **kw: writes.append(("image", (body, kw)))  # type: ignore[method-assign]
        handler.do_GET()
        self.assertEqual(len(writes), 1, writes)
        return writes

    def test_events_route_shape_without_auth(self) -> None:
        ((kind, (status, payload)),) = self._get("/api/v1/events")
        self.assertEqual((kind, status), ("json", HTTPStatus.OK))
        self.assertEqual(set(payload), {"items"})
        items = {i["id"]: i for i in payload["items"]}
        self.assertEqual(set(items), {"ontario-2026-08", "no-flyer"})
        for item in items.values():
            self.assertEqual(set(item), ITEM_KEYS)
        self.assertEqual(items["ontario-2026-08"]["flyerUrl"], "/api/v1/events/ontario-2026-08/flyer")
        self.assertIsNone(items["no-flyer"]["flyerUrl"])

    def test_events_route_500_on_failure(self) -> None:
        with mock.patch.object(spotlight_events, "build_events_payload", side_effect=RuntimeError("boom")), \
                mock.patch("traceback.print_exc"):
            ((_, (status, payload)),) = self._get("/api/v1/events")
        self.assertEqual(status, HTTPStatus.INTERNAL_SERVER_ERROR)
        self.assertIn("error", payload)

    def test_flyer_route(self) -> None:
        ((kind, (body, kw)),) = self._get("/api/v1/events/ontario-2026-08/flyer")
        self.assertEqual(kind, "image")
        self.assertEqual(body, PNG_BYTES)
        self.assertEqual(kw, {"content_type": "image/png", "max_age": 3600})
        for path in (
            "/api/v1/events/no-flyer/flyer",
            "/api/v1/events/unknown/flyer",
            "/api/v1/events//flyer",
            "/api/v1/events/..%2F..%2Fserver.py/flyer",
        ):
            with self.subTest(path=path):
                ((kind, (status, payload)),) = self._get(path)
                self.assertEqual((kind, status, payload), ("json", HTTPStatus.NOT_FOUND, {"error": "not_found"}))

    def test_map_routes(self) -> None:
        ((kind, (status, payload)),) = self._get("/api/v1/events/ontario-2026-08/map")
        self.assertEqual((kind, status), ("json", HTTPStatus.OK))
        self.assertEqual(payload["imageUrl"], "/api/v1/events/ontario-2026-08/map-image")
        self.assertNotIn("imageFile", payload)
        ((kind, (body, kw)),) = self._get("/api/v1/events/ontario-2026-08/map-image")
        self.assertEqual((kind, body, kw), ("image", PNG_BYTES, {"content_type": "image/png", "max_age": 600}))
        for path in (
            "/api/v1/events/no-flyer/map",
            "/api/v1/events/no-flyer/map-image",
            "/api/v1/events/unknown/map",
            "/api/v1/events//map",
            "/api/v1/events/..%2F..%2Fserver.py/map-image",
        ):
            with self.subTest(path=path):
                ((kind, (status, payload)),) = self._get(path)
                self.assertEqual((kind, status, payload), ("json", HTTPStatus.NOT_FOUND, {"error": "not_found"}))


if __name__ == "__main__":
    unittest.main()
