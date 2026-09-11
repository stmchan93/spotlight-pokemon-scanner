"""The derived TCGplayer product index, and the lock around the guard built on it.

The guard used to find its product ids by `json.loads`-ing every card payload —
45,844 cards and 398 MB on staging — with no lock, so a cold process answered N
concurrent requests by doing N full builds and pinned both vCPUs. This file pins
the two halves of the fix: the ids now come from a table, and only one thread
ever builds the guard.
"""

import json
import sqlite3
import sys
import threading
import time
import unittest
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

import catalog_tools as ct  # noqa: E402


def _payload(*pairs: tuple[str, str]) -> str:
    return json.dumps(
        {
            "variants": [
                {"name": name, "marketplaces": [{"name": "tcgplayer", "product_id": pid}]}
                for name, pid in pairs
            ]
        }
    )


def _catalog() -> sqlite3.Connection:
    """A catalog with the index table present but not yet built."""
    con = sqlite3.connect(":memory:")
    con.row_factory = sqlite3.Row
    con.execute("CREATE TABLE cards (id TEXT PRIMARY KEY, source_payload_json TEXT)")
    con.execute(
        "CREATE TABLE card_tcgplayer_products ("
        "card_id TEXT NOT NULL, ordinal INTEGER NOT NULL, product_id TEXT NOT NULL, "
        "variant_label TEXT NOT NULL, PRIMARY KEY (card_id, ordinal))"
    )
    con.execute(
        "CREATE TABLE runtime_settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, "
        "updated_at TEXT NOT NULL)"
    )
    # The live mis-map: an ME-promo Oshawott whose phantom "normal" shares
    # Archeops' product id.
    con.execute(
        "INSERT INTO cards VALUES (?, ?)",
        ("mep-51", _payload(("normal", "695136"), ("holofoil", "699875"))),
    )
    con.execute(
        "INSERT INTO cards VALUES (?, ?)",
        ("rsv10pt5-51", _payload(("holofoil", "642163"), ("fossilMuseumStamp", "695136"))),
    )
    con.commit()
    ct.reset_collision_guard_cache()
    return con


class ProductIndexTests(unittest.TestCase):
    def setUp(self) -> None:
        self.connection = _catalog()
        self.addCleanup(self.connection.close)
        self.addCleanup(ct.reset_collision_guard_cache)

    def test_an_unbuilt_index_is_not_mistaken_for_an_empty_one(self) -> None:
        """Emptiness is ambiguous, so the marker is the runtime setting.

        A catalog legitimately holding no TCGplayer ids must look the same to
        callers as one whose index is simply built and empty; only "never built"
        may fall back to the scan.
        """
        self.assertFalse(ct.tcgplayer_product_index_is_authoritative(self.connection))
        ct.rebuild_tcgplayer_product_index(self.connection)
        self.assertTrue(ct.tcgplayer_product_index_is_authoritative(self.connection))

        self.connection.execute("DELETE FROM card_tcgplayer_products")
        self.connection.commit()
        self.assertTrue(ct.tcgplayer_product_index_is_authoritative(self.connection))

    def test_rebuild_records_one_row_per_payload_printing(self) -> None:
        stats = ct.rebuild_tcgplayer_product_index(self.connection)
        self.assertEqual(stats, {"scanned": 2, "rows": 4})
        rows = self.connection.execute(
            "SELECT card_id, ordinal, product_id, variant_label FROM card_tcgplayer_products "
            "ORDER BY card_id, ordinal"
        ).fetchall()
        self.assertEqual(
            [tuple(row) for row in rows],
            [
                ("mep-51", 0, "695136", "Normal"),
                ("mep-51", 1, "699875", "Holofoil"),
                ("rsv10pt5-51", 0, "642163", "Holofoil"),
                ("rsv10pt5-51", 1, "695136", "Fossil Museum Stamp"),
            ],
        )

    def test_rebuild_is_idempotent(self) -> None:
        ct.rebuild_tcgplayer_product_index(self.connection)
        first = ct.rebuild_tcgplayer_product_index(self.connection)
        self.assertEqual(first, {"scanned": 2, "rows": 4})
        count = self.connection.execute(
            "SELECT COUNT(*) FROM card_tcgplayer_products"
        ).fetchone()[0]
        self.assertEqual(count, 4)

    def test_index_and_payload_scan_agree_on_the_guard(self) -> None:
        """The whole point: reading the table must answer exactly what parsing
        45,844 payloads answered, or the fix is a behaviour change."""
        from_scan = ct._build_collision_guard(self.connection)
        ct.rebuild_tcgplayer_product_index(self.connection)
        from_index = ct._build_collision_guard(self.connection)

        self.assertEqual(from_index["colliding_product_ids"], frozenset({"695136"}))
        self.assertEqual(
            from_index["colliding_product_ids"], from_scan["colliding_product_ids"]
        )
        self.assertEqual(
            from_index["suppressed_labels_by_card"], from_scan["suppressed_labels_by_card"]
        )
        self.assertEqual(
            from_index["suppressed_labels_by_card"],
            {"mep-51": {"Normal"}, "rsv10pt5-51": {"Fossil Museum Stamp"}},
        )

    def test_the_index_reads_no_payloads(self) -> None:
        """Guards the actual regression: a later edit that quietly reintroduces
        the payload scan on the serving path."""
        ct.rebuild_tcgplayer_product_index(self.connection)
        self.connection.execute("UPDATE cards SET source_payload_json = 'not json at all'")
        self.connection.commit()
        ct.reset_collision_guard_cache()

        guard = ct.collision_guard(self.connection)
        self.assertEqual(guard["colliding_product_ids"], frozenset({"695136"}))

    def test_upsert_keeps_the_index_current(self) -> None:
        """A catalog sync must not leave the index behind — otherwise it is only
        correct until the next card changes."""
        ct.rebuild_tcgplayer_product_index(self.connection)

        ct._replace_card_tcgplayer_products(
            self.connection,
            card_id="mep-51",
            source_payload=json.loads(_payload(("holofoil", "699875"))),
        )
        self.connection.commit()
        ct.reset_collision_guard_cache()

        # The phantom "normal" is gone from the payload, so nothing collides.
        self.assertEqual(
            ct.collision_guard(self.connection)["colliding_product_ids"], frozenset()
        )

    def test_a_card_that_loses_every_product_id_loses_every_row(self) -> None:
        ct.rebuild_tcgplayer_product_index(self.connection)
        ct._replace_card_tcgplayer_products(
            self.connection, card_id="mep-51", source_payload={}
        )
        self.connection.commit()
        remaining = self.connection.execute(
            "SELECT COUNT(*) FROM card_tcgplayer_products WHERE card_id = 'mep-51'"
        ).fetchone()[0]
        self.assertEqual(remaining, 0)


class CollisionGuardLockTests(unittest.TestCase):
    """One build, however many threads ask at once."""

    def tearDown(self) -> None:
        ct.reset_collision_guard_cache()

    def test_concurrent_callers_share_a_single_build(self) -> None:
        ct.reset_collision_guard_cache()
        builds = []
        builds_lock = threading.Lock()
        original = ct._build_collision_guard

        def slow_build(connection):
            with builds_lock:
                builds.append(1)
            # Wide enough that an unlocked accessor would let every waiting
            # thread past the `is None` check before the first one finished.
            time.sleep(0.15)
            return original(connection)

        ct._build_collision_guard = slow_build
        self.addCleanup(setattr, ct, "_build_collision_guard", original)

        results = []
        results_lock = threading.Lock()

        def ask():
            con = _no_collision_catalog()
            try:
                guard = ct.collision_guard(con)
            finally:
                con.close()
            with results_lock:
                results.append(guard)

        threads = [threading.Thread(target=ask) for _ in range(6)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()

        self.assertEqual(len(builds), 1)
        self.assertEqual(len(results), 6)
        # Every caller got the same object, not six equal copies.
        for guard in results[1:]:
            self.assertIs(guard, results[0])


def _no_collision_catalog() -> sqlite3.Connection:
    con = sqlite3.connect(":memory:")
    con.row_factory = sqlite3.Row
    con.execute("CREATE TABLE cards (id TEXT PRIMARY KEY, source_payload_json TEXT)")
    con.execute("INSERT INTO cards VALUES (?, ?)", ("a-1", _payload(("holofoil", "111"))))
    con.commit()
    return con


if __name__ == "__main__":
    unittest.main()
