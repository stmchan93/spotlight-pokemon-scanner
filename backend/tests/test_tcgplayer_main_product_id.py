"""The card's main TCGplayer product id (`tcgplayerProductId`) on card detail,
scan candidates and search results: the client opens that product page when the
selected printing has no id of its own (Base Charizard's TCGplayer-named
"Holofoil" printing matched no Scrydex variant name and fell back to a search)."""

from __future__ import annotations

import json
import sqlite3
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

import catalog_tools as ct  # noqa: E402
from server import SpotlightScanService  # noqa: E402


def _variants(*pairs: tuple[str, str]) -> str:
    return json.dumps({
        "variants": [
            {"name": name, "marketplaces": [{"name": "tcgplayer", "product_id": pid}]}
            for name, pid in pairs
        ]
    })


def _service() -> SimpleNamespace:
    con = sqlite3.connect(":memory:")
    con.execute("CREATE TABLE cards (id TEXT PRIMARY KEY, source_payload_json TEXT, tcgplayer_id TEXT)")
    con.execute(
        "INSERT INTO cards VALUES (?, ?, ?)",
        ("base1-4", _variants(("unlimitedHolofoil", "42382"), ("jumbo", "179079")), "42382"),
    )
    con.execute("INSERT INTO cards VALUES (?, ?, ?)", ("no-id-1", "{}", None))
    # Two cards whose payloads share 695136 → collision-guarded.
    con.execute("INSERT INTO cards VALUES (?, ?, ?)", ("mep-51", _variants(("normal", "695136")), "695136"))
    con.execute("INSERT INTO cards VALUES (?, ?, ?)", ("rsv10pt5-51", _variants(("stamp", "695136")), None))
    ct.reset_collision_guard_cache()
    return SimpleNamespace(connection=con)


def _main_ids(service, card_ids):
    return SpotlightScanService._main_tcgplayer_product_ids(service, card_ids)


class MainTcgplayerProductIdTests(unittest.TestCase):
    def tearDown(self):
        ct.reset_collision_guard_cache()

    def test_returns_the_cards_own_product_id(self):
        self.assertEqual(_main_ids(_service(), ["base1-4"]), {"base1-4": "42382"})

    def test_batches_and_skips_cards_without_an_id(self):
        self.assertEqual(_main_ids(_service(), ["base1-4", "no-id-1", "missing", ""]), {"base1-4": "42382"})

    def test_drops_a_collision_guarded_id(self):
        self.assertEqual(_main_ids(_service(), ["mep-51"]), {})

    def test_empty_input_and_pre_migration_db(self):
        self.assertEqual(_main_ids(_service(), []), {})
        con = sqlite3.connect(":memory:")
        con.execute("CREATE TABLE cards (id TEXT PRIMARY KEY, source_payload_json TEXT)")
        ct.reset_collision_guard_cache()
        self.assertEqual(_main_ids(SimpleNamespace(connection=con), ["base1-4"]), {})
