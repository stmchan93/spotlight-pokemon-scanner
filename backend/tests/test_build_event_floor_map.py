"""tools/build_event_floor_map.py: Figma layout frame -> served floor map (no network)."""

from __future__ import annotations

import csv
import json
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from tools.build_event_floor_map import (  # noqa: E402
    build_map,
    build_vendors_only_map,
    email_sha256,
    load_csv,
    load_known_vendors,
    match_csv,
    parse_figma_url,
    parse_location,
    tags_for,
    vendor_email_hashes,
)
from tools import build_event_floor_map  # noqa: E402

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
    food = _node("FRAME", "food", 400, 0, 50, 100, [_table(1, 400, 0), _table(2, 400, 50), _text("Food/ Drink", 420, 40)],
                 fills=[{"type": "SOLID", "color": {"r": 1, "g": 0.898, "b": 0, "a": 1}, "opacity": 0.7}])
    walls = _node("RECTANGLE", "site map", 0, 0, 1000, 500, fills=[{"type": "IMAGE"}])
    floor = _node("FRAME", "map", 0, 0, 1000, 500, [walls, block_c, block_h, food])
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
            _layout(), event_id="show", image_file="show.png", image_size=(800, 400), base_image_file="show-base.png",
            csv_rows=CSV_ROWS,
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
        self.assertEqual(self.doc["tags"], ["Pokémon", "One Piece", "Graded", "Singles", "Sealed", "Food"])

    def test_report_flags_what_a_human_must_fix(self) -> None:
        self.assertEqual(self.report["unknownTables"], ["Ghost Booth (K26): K26"])
        self.assertEqual(self.vendors["Ghost Booth"]["tableIds"], [])
        self.assertIn("Ghost Booth", self.report["noCsvMatch"])

    def test_vector_drawing_pieces(self) -> None:
        vector = self.doc["vector"]
        self.assertEqual(vector["baseImageFile"], "show-base.png")
        self.assertEqual(vector["baseImage"], {"x": 0.0, "y": 0.0, "width": 1.0, "height": 1.0})
        self.assertEqual(vector["areas"], [{"shape": "rect", "x": 0.4, "y": 0.0, "width": 0.05, "height": 0.2,
                                            "color": "#FFE500", "opacity": 0.7}])
        self.assertEqual(sorted(label["text"] for label in vector["labels"]), ["C", "Food/ Drink", "H", "HA"])
        self.assertNotIn("1", [label["text"] for label in vector["labels"]])

    def test_no_contact_details_leave_the_csv(self) -> None:
        for vendor in self.doc["vendors"]:
            self.assertEqual(set(vendor), {"id", "name", "location", "tableIds", "tags", "instagram"})
        self.assertNotIn("imageUrl", self.doc)
        self.assertEqual(self.doc["imageFile"], "show.png")
        self.assertEqual(self.doc["updatedAt"], "2026-10-15T00:00:00Z")


class EnrichmentTests(unittest.TestCase):
    def test_tag_override_replaces_keyword_tags(self) -> None:
        from tools.build_event_floor_map import EXACT_TAGS, _norm

        self.assertEqual(EXACT_TAGS[_norm("Diamond Shields")], ["Pokémon"])

    def test_filter_tags_keep_chip_order_and_drop_the_rest(self) -> None:
        from tools.build_event_floor_map import filter_tags

        self.assertEqual(filter_tags(["Vintage", "Graded", "Pokémon", "Supplies"]), ["Pokémon", "Graded", "Vintage"])
        self.assertEqual(filter_tags([]), [])

    def test_treasure_tags_map_to_chips(self) -> None:
        from tools.build_event_floor_map import treasure_chips

        self.assertEqual(
            treasure_chips("One-Piece|TCG|Lorcana|Pokemon|Funko Pop!|Football|Anime TCG"),
            ["One Piece", "Lorcana", "Pokémon", "Collectibles/Toys", "Sports"],
        )

    def test_treasure_tags_join_the_text_tags(self) -> None:
        tag_rows = [
            {"business_name": "PeteLocks", "name": "", "instagram": "@pete_locks", "tags": "Pokemon|Dragon Ball|Plushies"},
            {"business_name": "Main Street Cards", "name": "", "instagram": "", "tags": "Lorcana|TCG"},
        ]
        doc, report = build_map(
            _layout(), event_id="show", image_file="show.png", image_size=(800, 400),
            csv_rows=CSV_ROWS, tag_rows=tag_rows,
        )
        vendors = {v["name"]: v for v in doc["vendors"]}
        # Text found Pokémon/Graded/Sealed; the profile adds Lorcana; "TCG" maps to nothing.
        self.assertEqual(vendors["Main Street Cards"]["tags"], ["Pokémon", "Lorcana", "Graded", "Sealed"])
        # No application row at all: the profile alone supplies tags and the handle.
        self.assertEqual(vendors["PeteLocks"]["tags"], ["Pokémon", "Dragon Ball", "Collectibles/Toys"])
        self.assertEqual(vendors["PeteLocks"]["instagram"], "pete_locks")
        self.assertIn("Chazer808", report["noTagsMatch"])
        self.assertNotIn("Aloha Puddin", report["noTagsMatch"])

    def test_tags(self) -> None:
        self.assertEqual(tags_for("We sell WOTC vintage, PSA slabs"), ["Graded", "Vintage"])
        self.assertEqual(tags_for("cookies"), [])

    def test_match_prefers_exact_then_prefix(self) -> None:
        self.assertIs(match_csv("main street cards", CSV_ROWS), CSV_ROWS[0])
        self.assertIs(match_csv("Chazer808", CSV_ROWS), CSV_ROWS[1])
        self.assertIsNone(match_csv("Nobody", CSV_ROWS))


EXPORT_CSV = Path(__file__).resolve().parent / "fixtures" / "event_vendors_export_sample.csv"


class VendorsOnlyTests(unittest.TestCase):
    def setUp(self) -> None:
        self.rows = load_csv(EXPORT_CSV)
        self.doc, self.report = build_vendors_only_map(
            self.rows, event_id="show", now=datetime(2026, 10, 29, tzinfo=timezone.utc),
        )
        self.vendors = {v["name"]: v for v in self.doc["vendors"]}

    def test_confirmed_vendors_with_no_floor(self) -> None:
        # PAID + MIXED only; a blank business name falls back to the person's; repeats collapse.
        self.assertEqual(set(self.vendors), {"Aloha Puddin", "chazer808 collectibles partnered w/ space 62",
                                             "Main Street Cards", "Pete Locks"})
        self.assertEqual(len(self.report["skippedStatus"]), 3)
        self.assertEqual(self.report["duplicates"], ["Main Street Cards"])
        self.assertEqual(self.doc["tables"], [])
        for key in ("imageFile", "imageWidth", "imageHeight", "vector"):
            self.assertIsNone(self.doc[key])
        main = self.vendors["Main Street Cards"]
        self.assertEqual(main, {"id": "main-street-cards", "name": "Main Street Cards", "location": "",
                                "tableIds": [], "tags": ["Pokémon", "Graded", "Sealed"], "instagram": "mainstreet"})
        self.assertEqual(self.vendors["Aloha Puddin"]["tags"], ["Food"])
        self.assertEqual(self.doc["tags"], ["Pokémon", "One Piece", "Graded", "Singles", "Sealed", "Vintage", "Food"])
        self.assertEqual(self.doc["updatedAt"], "2026-10-29T00:00:00Z")

    def test_no_contact_details_leave_the_csv(self) -> None:
        text = json.dumps(self.doc)
        for vendor in self.doc["vendors"]:
            self.assertEqual(set(vendor), {"id", "name", "location", "tableIds", "tags", "instagram"})
        self.assertNotIn("Pat Example", text)
        self.assertNotIn("applied_at", text)

    def test_ids_use_the_full_builds_slug(self) -> None:
        full, _ = build_map(_layout(), event_id="show", image_file="show.png", image_size=(800, 400),
                            csv_rows=self.rows)
        full_ids = {v["name"]: v["id"] for v in full["vendors"]}
        self.assertEqual(self.vendors["Main Street Cards"]["id"], full_ids["Main Street Cards"])
        self.assertEqual(self.vendors["Aloha Puddin"]["id"], full_ids["Aloha Puddin"])

    def test_full_build_keeps_the_vendors_only_ids(self) -> None:
        # The layout names them "Chazer808" and "PeteLocks"; their applications don't.
        bare, _ = build_map(_layout(), event_id="show", image_file="show.png", image_size=(800, 400), csv_rows=self.rows)
        self.assertEqual({v["name"]: v["id"] for v in bare["vendors"]}["Chazer808"], "chazer808")
        full, report = build_map(_layout(), event_id="show", image_file="show.png", image_size=(800, 400),
                                 csv_rows=self.rows, known_vendors=self.doc["vendors"])
        ids = {v["name"]: v["id"] for v in full["vendors"]}
        early = {v["id"] for v in self.doc["vendors"]}
        self.assertEqual(ids["Chazer808"], "chazer808-collectibles-partnered-w-space-62")
        self.assertEqual(ids["PeteLocks"], "pete-locks")
        self.assertEqual(ids["Main Street Cards"], "main-street-cards")
        self.assertEqual(ids["Ghost Booth"], "ghost-booth")
        self.assertEqual({i for n, i in ids.items() if n != "Ghost Booth"}, early)
        self.assertIn("PeteLocks -> pete-locks", report["carriedIds"])
        self.assertEqual(full["vendors"][0]["tableIds"], ["FOOD1"])

    def test_rebuild_against_its_own_map_changes_no_id(self) -> None:
        first, _ = build_map(_layout(), event_id="show", image_file="show.png", image_size=(800, 400), csv_rows=CSV_ROWS)
        again, report = build_map(_layout(), event_id="show", image_file="show.png", image_size=(800, 400),
                                  csv_rows=CSV_ROWS, known_vendors=first["vendors"])
        self.assertEqual(first["vendors"], again["vendors"])
        self.assertNotIn("carriedIds", report)

    def test_known_vendors_read_this_event_first(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp)
            (out / "a-show.json").write_text(json.dumps({"vendors": [{"id": "old", "name": "Main Street Cards"}]}))
            (out / "show.json").write_text(json.dumps(self.doc))
            (out / "broken.json").write_text("{nope")
            known = load_known_vendors(out, "show")
        self.assertEqual(known[0]["id"], self.doc["vendors"][0]["id"])
        self.assertEqual(known[-1]["id"], "old")


class VendorEmailSidecarTests(unittest.TestCase):
    """Treasure emails leave the CSV only as sha256 hashes, in a sidecar the map never includes."""

    def _rows(self) -> list[dict[str, str]]:
        rows = load_csv(EXPORT_CSV)
        emails = {
            "Main Street Cards": ["  Pat@Example.com ", "pat.second@example.com"],
            "chazer808 collectibles partnered w/ space 62": ["sam@example.com"],
            "Waiting Room Cards": ["kim@example.com"],
        }
        for row in rows:
            queue = emails.get(row["business_name"])
            if queue:
                row["email"] = queue.pop(0)
        return rows

    def test_hash_is_lower_trimmed_sha256(self) -> None:
        self.assertEqual(email_sha256("  Pat@Example.COM\n"), email_sha256("pat@example.com"))
        self.assertRegex(email_sha256("pat@example.com"), r"^[0-9a-f]{64}$")

    def test_confirmed_rows_only_merged_per_vendor(self) -> None:
        rows = self._rows()
        doc, _ = build_vendors_only_map(rows, event_id="show")
        hashes = vendor_email_hashes(doc["vendors"], rows)
        # Both Main Street applications fold into one vendor; WAITLISTED never gets a hash.
        self.assertEqual(hashes["main-street-cards"],
                         sorted({email_sha256("pat@example.com"), email_sha256("pat.second@example.com")}))
        self.assertEqual(hashes["chazer808-collectibles-partnered-w-space-62"], [email_sha256("sam@example.com")])
        self.assertEqual(set(hashes), {"main-street-cards", "chazer808-collectibles-partnered-w-space-62"})
        self.assertNotIn(email_sha256("kim@example.com"), json.dumps(hashes))

    def test_full_build_uses_the_same_ids(self) -> None:
        rows = self._rows()
        full, _ = build_map(_layout(), event_id="show", image_file="show.png", image_size=(800, 400), csv_rows=rows)
        hashes = vendor_email_hashes(full["vendors"], rows)
        ids = {v["name"]: v["id"] for v in full["vendors"]}
        self.assertIn(ids["Main Street Cards"], hashes)
        # The layout's "Chazer808" finds its application by prefix, as the build does.
        self.assertEqual(hashes[ids["Chazer808"]], [email_sha256("sam@example.com")])

    def test_main_writes_sidecar_with_hashes_only(self) -> None:
        rows = self._rows()
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp)
            csv_path = out / "export.csv"
            header = EXPORT_CSV.read_text(encoding="utf-8").splitlines()[0].split(",")
            with csv_path.open("w", encoding="utf-8", newline="") as handle:
                writer = csv.DictWriter(handle, fieldnames=header)
                writer.writeheader()
                for row in rows:
                    writer.writerow({k: row.get(k, "") for k in header})
            build_event_floor_map.main(["--event-id", "show", "--vendors-only", "--vendors-csv", str(csv_path),
                                        "--out-dir", str(out)])
            map_text = (out / "show.json").read_text(encoding="utf-8")
            sidecar_text = (out / "show.vendor-emails.json").read_text(encoding="utf-8")
            # A rebuild must not read the sidecar as a past show's map.
            known = load_known_vendors(out, "show")
        sidecar = json.loads(sidecar_text)
        self.assertEqual(sidecar["eventId"], "show")
        self.assertEqual(set(sidecar["vendors"]), {"main-street-cards", "chazer808-collectibles-partnered-w-space-62"})
        for text in (map_text, sidecar_text):
            self.assertNotIn("@example.com", text.lower())
            self.assertNotIn("example.com", text.lower())
        self.assertNotIn(email_sha256("pat@example.com"), map_text)
        self.assertTrue(all(v.get("name") for v in known))


if __name__ == "__main__":
    unittest.main()
