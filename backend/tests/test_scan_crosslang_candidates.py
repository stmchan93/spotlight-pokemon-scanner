from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

BACKEND_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_ROOT.parent

if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from catalog_tools import apply_schema, connect, upsert_catalog_card  # noqa: E402
import server as server_module  # noqa: E402
from server import SpotlightScanService, scan_keep_crosslang_candidates_enabled  # noqa: E402

if str(BACKEND_ROOT / "tests") not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT / "tests"))

from test_scan_two_phase_phase8 import catalog_card, raw_payload  # type: ignore  # noqa: E402


CROSSLANG_ENV = server_module.SCAN_KEEP_CROSSLANG_CANDIDATES_ENV


def _en_match(card_id: str, similarity: float) -> SimpleNamespace:
    return SimpleNamespace(
        row_index=0,
        similarity=similarity,
        entry={
            "providerCardId": card_id,
            "name": f"Card {card_id}",
            "collectorNumber": f"{card_id}/000",
            "setId": "ens",
            "setName": "English Set",
            "setSeries": "Test Series",
            "setPtcgoCode": "ENS",
            "sourceProvider": "scrydex",
            "sourceRecordID": card_id,
            "imageUrl": f"https://images.example/{card_id}-large.png",
            "language": "English",
        },
    )


def _jp_match(card_id: str, similarity: float) -> SimpleNamespace:
    return SimpleNamespace(
        row_index=0,
        similarity=similarity,
        entry={
            "providerCardId": card_id,
            "name": f"Card {card_id}",
            "collectorNumber": f"{card_id}/000",
            "setId": "jps_ja",
            "setName": "Japanese Set",
            "setSeries": "Test Series",
            "setPtcgoCode": "JPS",
            "sourceProvider": "scrydex",
            "sourceRecordID": card_id,
            "imageUrl": f"https://images.example/{card_id}-large.png",
            "language": "Japanese",
        },
    )


def _jp_catalog_card(*, card_id: str, name: str, market_price: float) -> dict[str, object]:
    card = catalog_card(
        card_id=card_id,
        name=name,
        set_name="Japanese Set",
        number=f"{card_id}/000",
        set_id="jps_ja",
        market_price=market_price,
    )
    card["language"] = "Japanese"
    return card


class CrossLanguageCandidateTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.database_path = Path(self.tempdir.name) / "crosslang.sqlite"
        connection = connect(self.database_path)
        apply_schema(connection, BACKEND_ROOT / "schema.sql")
        # Two English catalog cards and one Japanese card. The Japanese card is the
        # GLOBAL best visual match (highest similarity), i.e. the actually-scanned
        # card, but the toggle is English so it is hard-filtered out of the ranking.
        upsert_catalog_card(
            connection,
            catalog_card(card_id="en-1", name="Card en-1", set_name="English Set", number="en-1/000", set_id="ens", market_price=10.0),
            REPO_ROOT,
            "2026-04-09T04:00:00Z",
            refresh_embeddings=False,
        )
        upsert_catalog_card(
            connection,
            catalog_card(card_id="en-2", name="Card en-2", set_name="English Set", number="en-2/000", set_id="ens", market_price=11.0),
            REPO_ROOT,
            "2026-04-09T04:00:00Z",
            refresh_embeddings=False,
        )
        upsert_catalog_card(
            connection,
            _jp_catalog_card(card_id="jp-1", name="Card jp-1", market_price=12.0),
            REPO_ROOT,
            "2026-04-09T04:00:00Z",
            refresh_embeddings=False,
        )
        connection.commit()
        connection.close()
        self.service = SpotlightScanService(self.database_path, REPO_ROOT)
        self._install_matcher()
        # Ensure tests start from a known flag environment.
        self._original_env = os.environ.get(CROSSLANG_ENV)
        os.environ.pop(CROSSLANG_ENV, None)

    def tearDown(self) -> None:
        if self._original_env is None:
            os.environ.pop(CROSSLANG_ENV, None)
        else:
            os.environ[CROSSLANG_ENV] = self._original_env
        self.service.connection.close()
        self.tempdir.cleanup()

    def _install_matcher(self) -> None:
        # Global ranking: jp-1 (0.97) > en-1 (0.95) > en-2 (0.93).
        matches = [
            _jp_match("jp-1", similarity=0.97),
            _en_match("en-1", similarity=0.95),
            _en_match("en-2", similarity=0.93),
        ]

        class FakeVisualMatcher:
            def prewarm(self):
                return {"available": True, "prewarmed": True}

            def match_payload(self, payload, *, top_k: int = 10):  # noqa: ARG002
                return list(matches[:top_k]), {"source": "fake", "timings": {}}

        self.service._raw_visual_matcher = FakeVisualMatcher()  # noqa: SLF001

    def _english_payload(self, scan_id: str) -> dict[str, object]:
        payload = raw_payload(scan_id=scan_id)
        payload["cardLanguage"] = "english"
        return payload

    def test_default_flag_is_on(self) -> None:
        self.assertTrue(scan_keep_crosslang_candidates_enabled())

    def test_flag_on_keeps_top1_english_and_appends_japanese_tail(self) -> None:
        os.environ[CROSSLANG_ENV] = "1"
        response = self.service.visual_match_scan(self._english_payload("scan-on"))
        candidates = response["topCandidates"]
        ids = [c["candidate"]["id"] for c in candidates]

        # Top-1 is the toggle-language (English) #1 visual match, unchanged.
        self.assertEqual(ids[0], "en-1")
        self.assertEqual(ids[1], "en-2")
        # The actually-scanned Japanese card is appended at the TAIL, reachable.
        self.assertEqual(ids[-1], "jp-1")
        self.assertEqual(ids.count("jp-1"), 1)
        # The tail Japanese candidate carries its language and the switch tag.
        jp_candidate = candidates[-1]
        self.assertEqual(jp_candidate["candidate"]["language"], "Japanese")
        self.assertTrue(jp_candidate.get("crossLanguageSwitch"))

    def test_flag_off_drops_japanese_entirely(self) -> None:
        os.environ[CROSSLANG_ENV] = "0"
        response = self.service.visual_match_scan(self._english_payload("scan-off"))
        ids = [c["candidate"]["id"] for c in response["topCandidates"]]

        self.assertEqual(ids[0], "en-1")
        self.assertNotIn("jp-1", ids)
        # Only the toggle-language English cards remain.
        self.assertEqual(set(ids), {"en-1", "en-2"})

    def test_ranked_order_identical_flag_on_vs_off_except_tail(self) -> None:
        os.environ[CROSSLANG_ENV] = "0"
        off = self.service.visual_match_scan(self._english_payload("scan-cmp-off"))
        off_ids = [c["candidate"]["id"] for c in off["topCandidates"]]

        os.environ[CROSSLANG_ENV] = "1"
        on = self.service.visual_match_scan(self._english_payload("scan-cmp-on"))
        on_ids = [c["candidate"]["id"] for c in on["topCandidates"]]

        # The decision/ranking head is byte-for-byte identical; only a tail is added.
        self.assertEqual(on_ids[: len(off_ids)], off_ids)
        self.assertEqual(on_ids[len(off_ids):], ["jp-1"])
        # Confidence/top-1 decision are computed pre-append, so they match exactly.
        self.assertEqual(on["confidence"], off["confidence"])
        self.assertEqual(on["topCandidates"][0], off["topCandidates"][0])

    def test_no_toggle_returns_no_crosslang_tail(self) -> None:
        os.environ[CROSSLANG_ENV] = "1"
        payload = raw_payload(scan_id="scan-no-toggle")  # no cardLanguage
        response = self.service.visual_match_scan(payload)
        ids = [c["candidate"]["id"] for c in response["topCandidates"]]
        # With no toggle the global ranking is returned unchanged (jp-1 wins) and
        # no cross-language tail is appended.
        self.assertEqual(ids[0], "jp-1")
        self.assertFalse(any(c.get("crossLanguageSwitch") for c in response["topCandidates"]))


if __name__ == "__main__":
    unittest.main()
