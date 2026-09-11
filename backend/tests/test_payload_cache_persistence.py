"""Computed payloads survive a process restart.

A restart threw away every cached dashboard / deck-entries / performance
payload, and the box then spent its first minutes recomputing byte-identical
output: 31s for 5 owners on staging, 144-221s for 36 on production, with single
Insights recomputes reaching 28.6s. Whoever opened the app in that window waited
on work the previous process had already done (user, 2026-09-11).

Nothing about a deploy invalidates these — they are a pure function of the
owner's rows and the latest prices, which is exactly what the version token
fingerprints. So the token is the safety: a mismatch misses, and a stale file
can never be served.
"""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_ROOT.parent
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from catalog_tools import apply_schema, connect  # noqa: E402
from server import SpotlightScanService  # noqa: E402


class PayloadCachePersistenceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.database_path = Path(self.tempdir.name) / "payload-cache.sqlite"
        connection = connect(self.database_path)
        apply_schema(connection, BACKEND_ROOT / "schema.sql")
        connection.close()
        self.service = self._new_service()

    def _new_service(self) -> SpotlightScanService:
        """A fresh process, as far as the caches are concerned."""
        service = SpotlightScanService(self.database_path, REPO_ROOT)
        self.addCleanup(service.connection.close)
        return service

    def test_a_payload_survives_into_a_new_process(self) -> None:
        key = ("owner-1", "America/Los_Angeles", "1W")
        self.service._store_dashboard_cache(key, "token-a", {"summary": {"currentValue": 12.5}})

        restarted = self._new_service()
        # Its in-memory cache is empty, as after any restart.
        self.assertEqual(restarted._dashboard_cache, {})
        self.assertEqual(
            restarted._hydrate_from_disk("dashboard", key, "token-a"),
            {"summary": {"currentValue": 12.5}},
        )

    def test_a_changed_token_misses_so_stale_output_is_never_served(self) -> None:
        key = ("owner-1", "America/Los_Angeles", "1W")
        self.service._store_dashboard_cache(key, "token-a", {"summary": {"currentValue": 12.5}})

        # The daily price sync moves the token; the old file must not answer.
        self.assertIsNone(self._new_service()._hydrate_from_disk("dashboard", key, "token-b"))

    def test_namespaces_do_not_collide(self) -> None:
        key = ("owner-1", 200, 0)
        self.service._store_deck_entries_cache(key, "token-a", {"entries": [1, 2, 3]})

        restarted = self._new_service()
        self.assertEqual(restarted._hydrate_from_disk("deck_entries", key, "token-a"), {"entries": [1, 2, 3]})
        # Same key and token, different payload kind → no answer.
        self.assertIsNone(restarted._hydrate_from_disk("dashboard", key, "token-a"))

    def test_a_corrupt_file_misses_instead_of_raising(self) -> None:
        key = ("owner-1", "America/Los_Angeles", "1W")
        self.service._store_dashboard_cache(key, "token-a", {"summary": {}})
        path = self.service._payload_cache_path("dashboard", key, "token-a")
        self.assertIsNotNone(path)
        assert path is not None
        path.write_text("{ truncated", encoding="utf-8")

        self.assertIsNone(self._new_service()._hydrate_from_disk("dashboard", key, "token-a"))

    def test_no_version_never_reads_a_file(self) -> None:
        # A token the service could not compute means it cannot vouch for
        # freshness, so it must recompute rather than guess.
        key = ("owner-1", "America/Los_Angeles", "1W")
        self.service._store_dashboard_cache(key, "token-a", {"summary": {}})
        self.assertIsNone(self.service._hydrate_from_disk("dashboard", key, None))

    def test_pruning_keeps_the_newest_and_drops_the_rest(self) -> None:
        for index in range(8):
            self.service._store_dashboard_cache(("owner", "tz", str(index)), "t", {"n": index})

        removed = self.service.prune_payload_cache(max_entries=3)

        self.assertEqual(removed, 5)
        root = self.service._payload_cache_root
        assert root is not None
        self.assertEqual(len(list(root.glob("*.json"))), 3)

    def test_the_mirror_can_be_turned_off(self) -> None:
        import os

        previous = os.environ.get("SPOTLIGHT_PAYLOAD_CACHE_DIR")
        os.environ["SPOTLIGHT_PAYLOAD_CACHE_DIR"] = ""
        try:
            service = self._new_service()
            self.assertIsNone(service._payload_cache_root)
            # Storing is still safe; it just doesn't mirror.
            service._store_dashboard_cache(("o", "tz", "1W"), "t", {"a": 1})
            self.assertIsNone(service._hydrate_from_disk("dashboard", ("o", "tz", "1W"), "t"))
        finally:
            if previous is None:
                os.environ.pop("SPOTLIGHT_PAYLOAD_CACHE_DIR", None)
            else:
                os.environ["SPOTLIGHT_PAYLOAD_CACHE_DIR"] = previous


if __name__ == "__main__":
    unittest.main()

    def test_bumping_the_generation_orphans_every_existing_file(self) -> None:
        """A code change that alters the payload must not be served from disk.

        The version token fingerprints the owner's DATA, so it is identical
        across a deploy that only changed the MATH. The mirror then served the
        payload the old code wrote — the delta fix shipped and the phantom week's
        gain was still on screen (user, 2026-09-11).
        """
        key = ("owner-1", "America/Los_Angeles", "1W")
        self.service._store_dashboard_cache(key, "token-a", {"summary": {"deltaValue": 415000}})

        restarted = self._new_service()
        self.assertIsNotNone(restarted._hydrate_from_disk("dashboard", key, "token-a"))

        # Ship a computation change.
        restarted.PAYLOAD_CACHE_GENERATION += 1
        self.assertIsNone(restarted._hydrate_from_disk("dashboard", key, "token-a"))
