"""tools/build_event_floor_map.py: Figma layout frame -> served floor map (no network)."""

from __future__ import annotations

import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from tools.build_event_floor_map import (  # noqa: E402
    build_map,
    match_csv,
    parse_figma_url,
    parse_location,
    tags_for,
)

_ids = iter(range(1, 10_000))


def _node(kind: str, name: str, x: float, y: float, w: float, h: float, children=None, **extra):
    node = {"id": f"1:{next(_ids)}", "type": kind, "name": name,
            "absoluteBoundingBox": {"x": x, "y": y, "width": w, "height": h}, "children": children or []}
    node.update(extra)
    return node


def _text(chars: str, x: float, y: float, w: float = 10, h: float = 10):
    return _node("TEXT", chars, x, y, w, h, characters=chars)


def _table(number: int, x: float, y: float, w: float = 10, h: float = 30):
    return _node("FRAME", "6' table", x, y, w, h, [_text(str(number), x + 2, y + 2)])


def _row(name: str, location: str, y: float):
    return _node("FRAME", "row", 2000, y, 300, 20, [_text(name, 2000, y), _text(location, 2200, y)])


def _layout():
    # Block C: two tables. Block H/HA share one frame; HA's tables sit in their own
    # group, and H's table 1 is nearer the HA label than the H label (the real file).
    block_c = _node("FRAME", "c", 0, 0, 100, 200, [_table(1, 0, 0), _table(2, 0, 40), _text("C", 50, 100)])
    ha_group = _node("GROUP", "g", 200, 260, 60, 40, [_table(1, 200, 260, 30, 10), _table(2, 230, 260, 30, 10)])
    block_h = _node("FRAME", "h", 200, 0, 100, 300, [
        _table(1, 200, 0), _table(2, 200, 200), _table(3, 200, 100),
        _text("H", 250, 60), _text("HA", 220, 240), ha_group,
    ])
    food = _node("FRAME", "food", 400, 0, 50, 100, [_table(1, 400, 0), _table(2, 400, 50), _text("Food/ Drink", 420, 40)])
    floor = _node("FRAME", "map", 0, 0, 1000, 500, [block_c, block_h, food])
    vendors = _node("FRAME", "list", 2000, 0, 300, 400, [
        _row("VENDOR", "LOCATION", 0),
        _row("Main Street Cards", "C1-C2", 20),
        _row("PeteLocks", "HA 1-2", 40),
        _row("Aloha Puddin", "1", 60),
        _row("Ghost Booth", "K26", 80),
        _row("Chazer808", "H1, H3", 100),
    ])
    return _node("FRAME", "Frame 498", 0, 0, 3000, 600, [floor, vendors])


CSV_ROWS = [
    {"business_name": "Main Street Cards", "name": "x", "instagram": "@mainstreet", "inventory": "Pokemon slabs and sealed", "purchase": "STANDARD", "status": "PAID"},
    {"business_name": "chazer808 collectibles partnered w/ space 62", "name": "y", "instagram": "https://instagram.com/chazer808/", "inventory": "One Piece singles", "purchase": "STANDARD", "status": "PAID"},
    {"business_name": "Aloha Puddin", "name": "z", "instagram": "", "inventory": "Banana pudding", "purchase": "Non-open Flamed Food Table x1", "status": "PAID"},
]


class LocationParsingTests(unittest.TestCase):
    def test_forms_in_the_real_layout(self) -> None:
        self.assertEqual(parse_location("A29"), ["A29"])
        self.assertEqual(parse_location("C1-C3, C26"), ["C1", "C2", "C3", "C26"])
        self.assertEqual(parse_location("L7-8"), ["L7", "L8"])
        self.assertEqual(parse_location("HA 1-3"), ["HA1", "HA2", "HA3"])
        self.assertEqual(parse_location("D1-D2,D27"), ["D1", "D2", "D27"])
        self.assertEqual(parse_location("4-5"), ["FOOD4", "FOOD5"])

    def test_rejects_nonsense(self) -> None:
        for bad in ("C5-C1", "C1-D3", "booth twelve"):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                parse_location(bad)


class FigmaUrlTests(unittest.TestCase):
    def test_key_and_node(self) -> None:
        self.assertEqual(
            parse_figma_url("https://www.figma.com/design/ABC123/Show?node-id=2381-2048&m=dev"),
            ("ABC123", "2381:2048"),
        )
        with self.assertRaises(ValueError):
            parse_figma_url("https://www.figma.com/design/ABC123/Show")


class BuildMapTests(unittest.TestCase):
    def setUp(self) -> None:
        self.doc, self.report = build_map(
            _layout(), event_id="show", image_file="show.png", image_size=(800, 400), csv_rows=CSV_ROWS,
            now=datetime(2026, 10, 15, tzinfo=timezone.utc),
        )
        self.vendors = {v["name"]: v for v in self.doc["vendors"]}

    def test_tables_get_block_ids_and_fractional_boxes(self) -> None:
        ids = [t["id"] for t in self.doc["tables"]]
        self.assertEqual(sorted(ids), sorted(["C1", "C2", "H1", "H2", "H3", "HA1", "HA2", "FOOD1", "FOOD2"]))
        c1 = next(t for t in self.doc["tables"] if t["id"] == "C1")
        self.assertEqual((c1["x"], c1["y"], c1["width"], c1["height"]), (0.0, 0.0, 0.01, 0.06))

    def test_vendors_map_to_tables_tags_and_handles(self) -> None:
        self.assertNotIn("VENDOR", self.vendors)
        main = self.vendors["Main Street Cards"]
        self.assertEqual(main["tableIds"], ["C1", "C2"])
        self.assertEqual(main["tags"], ["Pokémon", "Graded", "Sealed"])
        self.assertEqual(main["instagram"], "mainstreet")
        self.assertEqual(self.vendors["PeteLocks"]["tableIds"], ["HA1", "HA2"])
        self.assertEqual(self.vendors["Chazer808"]["instagram"], "chazer808")
        self.assertEqual(self.vendors["Aloha Puddin"]["tags"], ["Food"])
        self.assertEqual(self.doc["tags"][0], "Food")

    def test_report_flags_what_a_human_must_fix(self) -> None:
        self.assertEqual(self.report["unknownTables"], ["Ghost Booth (K26): K26"])
        self.assertEqual(self.vendors["Ghost Booth"]["tableIds"], [])
        self.assertIn("Ghost Booth", self.report["noCsvMatch"])

    def test_no_contact_details_leave_the_csv(self) -> None:
        for vendor in self.doc["vendors"]:
            self.assertEqual(set(vendor), {"id", "name", "location", "tableIds", "tags", "instagram"})
        self.assertNotIn("imageUrl", self.doc)
        self.assertEqual(self.doc["imageFile"], "show.png")
        self.assertEqual(self.doc["updatedAt"], "2026-10-15T00:00:00Z")


class EnrichmentTests(unittest.TestCase):
    def test_tags(self) -> None:
        self.assertEqual(tags_for("We sell WOTC vintage, PSA slabs"), ["Graded", "Vintage"])
        self.assertEqual(tags_for("cookies"), [])

    def test_match_prefers_exact_then_prefix(self) -> None:
        self.assertIs(match_csv("main street cards", CSV_ROWS), CSV_ROWS[0])
        self.assertIs(match_csv("Chazer808", CSV_ROWS), CSV_ROWS[1])
        self.assertIsNone(match_csv("Nobody", CSV_ROWS))


if __name__ == "__main__":
    unittest.main()
