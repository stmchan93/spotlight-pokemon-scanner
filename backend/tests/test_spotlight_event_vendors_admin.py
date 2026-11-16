"""Vendor / floor-map admin: browser edits layered over the shipped map files (no network)."""

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

import spotlight_event_vendors_admin as vendors_admin  # noqa: E402
import spotlight_events  # noqa: E402
from catalog_tools import apply_schema, connect  # noqa: E402
from server import SpotlightRequestHandler, SpotlightScanService  # noqa: E402

TOKEN = "test-ops-token"
EVENT_ID = "ontario-2026-08"


def _event() -> dict[str, Any]:
    return {
        "id": EVENT_ID,
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
        "featured": True,
    }


def _table(block: str, number: int) -> dict[str, Any]:
    return {"id": f"{block}{number}", "block": block, "number": number, "x": 0.1, "y": 0.1, "width": 0.01, "height": 0.01}


def _map() -> dict[str, Any]:
    return {
        "eventId": EVENT_ID,
        "imageFile": f"{EVENT_ID}.png",
        "tables": [_table("A", 1), _table("A", 2), _table("A", 3), _table("B", 1)],
        "vendors": [
            {"id": "alpha", "name": "Alpha", "location": "A1-A2", "tableIds": ["A1", "A2"], "tags": ["Pokémon"]},
            {"id": "beta", "name": "Beta", "location": "B1", "tableIds": ["B1"], "tags": []},
        ],
        "vector": None,
    }


def _png(width: int = 40, height: int = 30) -> bytes:
    from PIL import Image

    out = io.BytesIO()
    Image.new("RGB", (width, height), (10, 20, 30)).save(out, format="PNG")
    return out.getvalue()


class VendorsAdminTests(unittest.TestCase):
    def setUp(self) -> None:
        spotlight_events.clear_cache()
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        root = Path(self.tempdir.name)
        database_path = root / "events.sqlite"
        connection = connect(database_path)
        apply_schema(connection, BACKEND_ROOT / "schema.sql")
        connection.close()
        env = mock.patch.dict(os.environ, {"SPOTLIGHT_PAYLOAD_CACHE_DIR": "", "SPOTLIGHT_OPS_REFRESH_TOKEN": TOKEN})
        env.start()
        self.addCleanup(env.stop)
        self.service = SpotlightScanService(database_path, REPO_ROOT)
        self.addCleanup(lambda: self.service.connection.close())
        self.addCleanup(lambda: spotlight_events.configure_admin(None))
        self.addCleanup(lambda: spotlight_events.configure_vendor_admin(None))
        events_path = root / "spotlight_events.json"
        events_path.write_text(json.dumps({"events": [_event()]}), encoding="utf-8")
        maps = root / "maps"
        maps.mkdir()
        (maps / f"{EVENT_ID}.json").write_text(json.dumps(_map()), encoding="utf-8")
        (maps / f"{EVENT_ID}.png").write_bytes(_png())
        for name, value in (("EVENTS_PATH", events_path), ("FLYERS_DIR", root / "flyers"), ("MAPS_DIR", maps)):
            patcher = mock.patch.object(spotlight_events, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def _call(self, method: str, path: str, body: bytes = b"", *, token: str | None = TOKEN) -> tuple[str, Any]:
        handler = SpotlightRequestHandler.__new__(SpotlightRequestHandler)
        handler.path = path
        handler.headers = {"Content-Length": str(len(body)), "Content-Type": "application/json"}
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

    def _post(self, action: str, payload: Any = None, raw: bytes | None = None) -> tuple[int, Any]:
        body = raw if raw is not None else json.dumps(payload or {}).encode()
        _, (status, data) = self._call("POST", f"/api/v1/admin/events/{EVENT_ID}/{action}", body)
        return status, data

    def _served(self) -> dict[str, dict[str, Any]]:
        payload = spotlight_events.floor_map_payload(EVENT_ID)
        assert payload is not None
        return {vendor["id"]: vendor for vendor in payload["vendors"]}

    def test_needs_the_ops_token(self) -> None:
        _, (status, _) = self._call("GET", f"/api/v1/admin/events/{EVENT_ID}/vendors", token="wrong")
        self.assertEqual(status, HTTPStatus.UNAUTHORIZED)
        _, (status, _) = self._call("POST", f"/api/v1/admin/events/{EVENT_ID}/vendors/alpha/remove", b"{}", token=None)
        self.assertEqual(status, HTTPStatus.UNAUTHORIZED)

    def test_move_takes_the_table_off_its_old_vendor(self) -> None:
        status, data = self._post("vendors/beta/move", {"tableIds": ["A2", "A3"]})
        self.assertEqual(status, HTTPStatus.OK, data)
        served = self._served()
        self.assertEqual(served["beta"]["tableIds"], ["A2", "A3"])
        self.assertEqual(served["beta"]["location"], "A2-A3")
        self.assertEqual(served["alpha"]["tableIds"], ["A1"])
        self.assertEqual(served["alpha"]["location"], "A1")

    def test_move_rejects_unknown_tables(self) -> None:
        status, data = self._post("vendors/beta/move", {"tableIds": ["Z9"]})
        self.assertEqual(status, HTTPStatus.BAD_REQUEST)
        self.assertIn("Z9", data["error"])

    def test_swap_exchanges_tables(self) -> None:
        status, _ = self._post("vendors/alpha/swap", {"with": "beta"})
        self.assertEqual(status, HTTPStatus.OK)
        served = self._served()
        self.assertEqual(served["alpha"]["tableIds"], ["B1"])
        self.assertEqual(served["beta"]["tableIds"], ["A1", "A2"])

    def test_add_edit_remove_restore(self) -> None:
        status, data = self._post("vendors", {"name": "Gamma Cards", "tableIds": ["A3"], "instagram": "@gamma"})
        self.assertEqual(status, HTTPStatus.OK, data)
        self.assertEqual(data["vendor"]["id"], "gamma-cards")
        self.assertEqual(self._served()["gamma-cards"]["instagram"], "gamma")

        self._post("vendors", {"id": "alpha", "name": "Alpha TCG", "tableIds": ["A1", "A2"]})
        self.assertEqual(self._served()["alpha"]["name"], "Alpha TCG")

        self._post("vendors/beta/remove")
        self.assertNotIn("beta", self._served())
        _, (_, view) = self._call("GET", f"/api/v1/admin/events/{EVENT_ID}/vendors")
        self.assertEqual([r["id"] for r in view["removed"]], ["beta"])
        sources = {v["id"]: v["source"] for v in view["vendors"]}
        self.assertEqual(sources, {"alpha": "edited", "gamma-cards": "added"})

        self._post("vendors/beta/restore")
        self.assertEqual(self._served()["beta"]["tableIds"], ["B1"])

    def test_uploaded_logo_is_served_and_versioned(self) -> None:
        status, _ = self._post("vendors/alpha/logo", raw=_png(300, 200))
        self.assertEqual(status, HTTPStatus.OK)
        url = self._served()["alpha"]["logoUrl"]
        self.assertTrue(url.startswith(f"/api/v1/events/{EVENT_ID}/vendor-logos/alpha?v="), url)
        kind, (data, _) = self._call("GET", url.split("?")[0])
        self.assertEqual(kind, "image")
        self.assertTrue(data.startswith(b"RIFF"))  # WebP

    def test_uploaded_map_replaces_the_file_once_it_has_an_image(self) -> None:
        document = {
            "tables": [_table("C", 1), _table("C", 2)],
            "vendors": [{"id": "delta", "name": "Delta", "tableIds": ["C1", "C2"], "tags": []}],
        }
        status, data = self._post("map", document)
        self.assertEqual(status, HTTPStatus.OK, data)
        # Tables but no image yet: keep serving the shipped map.
        self.assertIn("alpha", self._served())

        status, _ = self._post("map/image", raw=_png(80, 60))
        self.assertEqual(status, HTTPStatus.OK)
        payload = spotlight_events.floor_map_payload(EVENT_ID)
        assert payload is not None
        self.assertEqual([v["id"] for v in payload["vendors"]], ["delta"])
        self.assertEqual(payload["vendors"][0]["location"], "C1-C2")
        self.assertIn("?v=", payload["imageUrl"])
        kind, (data, _) = self._call("GET", f"/api/v1/events/{EVENT_ID}/map-image")
        self.assertEqual(kind, "image")
        self.assertTrue(data.startswith(b"\x89PNG"))

        self._post("map/reset")
        self.assertIn("alpha", self._served())

    def test_rebuilt_file_cannot_double_book_an_admin_table(self) -> None:
        self._post("vendors/beta/move", {"tableIds": ["A3"]})
        rebuilt = _map()
        rebuilt["vendors"][0]["tableIds"] = ["A1", "A2", "A3"]
        (spotlight_events.MAPS_DIR / f"{EVENT_ID}.json").write_text(json.dumps(rebuilt), encoding="utf-8")
        os.utime(spotlight_events.MAPS_DIR / f"{EVENT_ID}.json", (1, 1))
        spotlight_events.clear_cache()
        served = self._served()
        self.assertEqual(served["beta"]["tableIds"], ["A3"])
        self.assertEqual(served["alpha"]["tableIds"], ["A1", "A2"])


class FormatLocationTests(unittest.TestCase):
    def test_ranges(self) -> None:
        tables = [_table("A", n) for n in (1, 2, 3, 5)] + [_table("B", 7)]
        self.assertEqual(vendors_admin.format_location(["A3", "A1", "A2", "B7", "A5"], tables), "A1-A3, A5, B7")
        self.assertEqual(vendors_admin.format_location([], tables), "")


if __name__ == "__main__":
    unittest.main()
