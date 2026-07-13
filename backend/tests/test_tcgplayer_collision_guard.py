"""TCGplayer product_id collision guard.

A product id Scrydex maps to >1 distinct card is a mis-map (observed live: an
ME-promo Oshawott whose phantom "Normal" printing shared Archeops' product id,
surfacing Archeops' price AND deep-linking to Archeops). The guard suppresses
the offending printing on every card sharing the id.
"""

import json
import sqlite3
import sys
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

import catalog_tools as ct  # noqa: E402


def _catalog_with_collision() -> sqlite3.Connection:
    con = sqlite3.connect(":memory:")
    con.execute("CREATE TABLE cards (id TEXT PRIMARY KEY, source_payload_json TEXT)")
    oshawott = {
        "variants": [
            {"name": "normal", "marketplaces": [{"name": "tcgplayer", "product_id": "695136"}]},
            {"name": "holofoil", "marketplaces": [{"name": "tcgplayer", "product_id": "699875"}]},
        ]
    }
    archeops = {
        "variants": [
            {"name": "holofoil", "marketplaces": [{"name": "tcgplayer", "product_id": "642163"}]},
            {"name": "fossilMuseumStamp", "marketplaces": [{"name": "tcgplayer", "product_id": "695136"}]},
        ]
    }
    con.execute("INSERT INTO cards VALUES (?, ?)", ("mep-51", json.dumps(oshawott)))
    con.execute("INSERT INTO cards VALUES (?, ?)", ("rsv10pt5-51", json.dumps(archeops)))
    ct.reset_collision_guard_cache()
    return con


def test_detects_the_shared_product_id():
    con = _catalog_with_collision()
    guard = ct.collision_guard(con)
    assert guard["colliding_product_ids"] == frozenset({"695136"})


def test_suppresses_the_offending_printing_on_both_cards():
    con = _catalog_with_collision()
    # Oshawott loses its phantom "Normal"; Archeops loses "Fossil Museum Stamp".
    assert ct.suppressed_raw_variant_labels(con, "mep-51") == {"Normal"}
    assert ct.suppressed_raw_variant_labels(con, "rsv10pt5-51") == {"Fossil Museum Stamp"}


def test_deep_link_subset_drops_the_colliding_id_keeps_the_valid_one():
    con = _catalog_with_collision()
    guard = ct.collision_guard(con)
    payload = json.loads(
        con.execute("SELECT source_payload_json FROM cards WHERE id='mep-51'").fetchone()[0]
    )
    subset = ct.tcgplayer_variants_subset(payload, guard["colliding_product_ids"])
    ids = [m["product_id"] for v in subset["variants"] for m in v["marketplaces"]]
    assert ids == ["699875"]  # the real Oshawott; 695136 (Archeops) dropped


def test_raw_contexts_filter_drops_phantom_variant():
    con = _catalog_with_collision()
    suppressed = ct.suppressed_raw_variant_labels(con, "mep-51")
    raw_contexts = {"variants": {"Normal": {"market": 47.88}, "Holofoil": {"market": 14.54}}}
    filtered = ct.filter_suppressed_raw_variants(raw_contexts, suppressed)
    assert list(filtered["variants"].keys()) == ["Holofoil"]


def test_filter_never_blanks_a_card_with_only_a_suppressed_variant():
    # If suppression would remove every printing, keep the data rather than leave
    # the PDP with no raw price at all.
    raw_contexts = {"variants": {"Normal": {"market": 47.88}}}
    filtered = ct.filter_suppressed_raw_variants(raw_contexts, {"Normal"})
    assert list(filtered["variants"].keys()) == ["Normal"]


def test_no_collision_is_a_noop():
    con = sqlite3.connect(":memory:")
    con.execute("CREATE TABLE cards (id TEXT PRIMARY KEY, source_payload_json TEXT)")
    payload = {"variants": [{"name": "holofoil", "marketplaces": [{"name": "tcgplayer", "product_id": "111"}]}]}
    con.execute("INSERT INTO cards VALUES (?, ?)", ("a-1", json.dumps(payload)))
    ct.reset_collision_guard_cache()
    assert ct.collision_guard(con)["colliding_product_ids"] == frozenset()
    assert ct.suppressed_raw_variant_labels(con, "a-1") == set()
