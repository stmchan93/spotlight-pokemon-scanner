from __future__ import annotations

import contextlib
import sys
import tempfile
from http import HTTPStatus
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import unittest

BACKEND_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_ROOT.parent

if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from catalog_tools import apply_schema, connect, upsert_catalog_card  # noqa: E402
import server as server_module  # noqa: E402
from scrydex_adapter import scrydex_request_stats_snapshot  # noqa: E402
from server import SpotlightRequestHandler, SpotlightScanService  # noqa: E402

if str(BACKEND_ROOT / "tests") not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT / "tests"))

from test_scan_two_phase_phase8 import catalog_card, raw_payload  # type: ignore  # noqa: E402


POOL_SIZE = server_module.SCAN_CANDIDATE_POOL_SIZE


def _match(card_id: str, similarity: float) -> SimpleNamespace:
    return SimpleNamespace(
        row_index=0,
        similarity=similarity,
        entry={
            "providerCardId": card_id,
            "name": f"Card {card_id}",
            "collectorNumber": f"{card_id}/000",
            "setId": "set",
            "setName": "Pool Set",
            "setSeries": "Test Series",
            "setPtcgoCode": "POOL",
            "sourceProvider": "scrydex",
            "sourceRecordID": card_id,
            "imageUrl": f"https://images.example/{card_id}-large.png",
            "language": "English",
        },
    )


class ScanCandidatePoolTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.database_path = Path(self.tempdir.name) / "candidate-pool.sqlite"
        connection = connect(self.database_path)
        apply_schema(connection, BACKEND_ROOT / "schema.sql")
        # 12 catalog cards so the pool can extend beyond the hydrated top 10.
        self.card_ids = [f"pool-{i:02d}" for i in range(12)]
        for index, card_id in enumerate(self.card_ids):
            upsert_catalog_card(
                connection,
                catalog_card(
                    card_id=card_id,
                    name=f"Card {card_id}",
                    set_name="Pool Set",
                    number=f"{card_id}/000",
                    set_id="set",
                    market_price=10.0 + index,
                ),
                REPO_ROOT,
                "2026-04-09T04:00:00Z",
                refresh_embeddings=False,
            )
        connection.commit()
        connection.close()
        self.service = SpotlightScanService(self.database_path, REPO_ROOT)

    def tearDown(self) -> None:
        self.service.connection.close()
        self.tempdir.cleanup()

    def _install_matcher(self) -> None:
        matches = [
            _match(card_id, similarity=0.95 - 0.01 * index)
            for index, card_id in enumerate(self.card_ids)
        ]

        class FakeVisualMatcher:
            def prewarm(self):
                return {"available": True, "prewarmed": True}

            def match_payload(self, payload, *, top_k: int = 10):  # noqa: ARG002
                return list(matches[:top_k]), {"source": "fake", "timings": {}}

        self.service._raw_visual_matcher = FakeVisualMatcher()  # noqa: SLF001

    def _persisted_rows(self) -> list:
        return self.service.connection.execute(
            """
            SELECT rank, card_id, candidate_json
            FROM scan_prediction_candidates
            WHERE scan_id = ?
            ORDER BY rank ASC
            """,
            ("scan-pool",),
        ).fetchall()

    def test_response_hydrates_exactly_ten_and_persists_full_pool(self) -> None:
        self._install_matcher()
        response = self.service.visual_match_scan(raw_payload(scan_id="scan-pool"))

        # The live response is unchanged: exactly 10 hydrated top candidates.
        self.assertEqual(len(response["topCandidates"]), 10)
        # New additive field reports the persisted pool size (12 here, capped to POOL_SIZE).
        self.assertEqual(response["candidatePoolSize"], min(12, POOL_SIZE))
        # Top 10 are hydrated with pricing in the live response.
        self.assertIsNotNone(response["topCandidates"][0]["candidate"].get("pricing"))

        rows = self._persisted_rows()
        self.assertEqual(len(rows), min(12, POOL_SIZE))
        # Lightweight rows (rank > 10) persist card id + score but carry no pricing.
        import json

        beyond_ten = [r for r in rows if r["rank"] > 10]
        self.assertTrue(beyond_ten)
        for row in beyond_ten:
            encoded = json.loads(row["candidate_json"])
            self.assertNotIn("pricing", encoded["candidate"])
            self.assertEqual(encoded["candidate"]["variant"], "Raw")

    def test_window_endpoint_enriches_pricing_cached_only(self) -> None:
        self._install_matcher()
        self.service.visual_match_scan(raw_payload(scan_id="scan-pool"))

        scrydex_before = int(scrydex_request_stats_snapshot().get("total") or 0)
        result = self.service.scan_candidates_window("scan-pool", offset=10, limit=POOL_SIZE)
        scrydex_after = int(scrydex_request_stats_snapshot().get("total") or 0)

        # No live Scrydex request was made while paging / enriching pricing.
        self.assertEqual(scrydex_before, scrydex_after)

        self.assertEqual(result["total"], min(12, POOL_SIZE))
        # offset=10 returns the lightweight tail (cards 11..12).
        self.assertEqual(len(result["candidates"]), max(0, min(12, POOL_SIZE) - 10))
        self.assertTrue(result["candidates"])
        for encoded in result["candidates"]:
            # Pricing is hydrated on demand from cached SQLite snapshots.
            self.assertIsNotNone(encoded["candidate"].get("pricing"))
            self.assertEqual(encoded["candidate"]["pricing"]["pricingMode"], "raw")

    def test_window_owner_check_returns_not_found_for_other_owner(self) -> None:
        self._install_matcher()
        self.service.visual_match_scan(raw_payload(scan_id="scan-pool"))

        # Re-point the stored scan to a different owner; the caller (fallback user)
        # must no longer be able to read it.
        self.service.connection.execute(
            "UPDATE scan_events SET owner_user_id = ? WHERE scan_id = ?",
            ("someone-else", "scan-pool"),
        )
        self.service.connection.commit()

        with self.assertRaises(FileNotFoundError):
            self.service.scan_candidates_window("scan-pool", offset=0, limit=POOL_SIZE)


class ScanCandidatesRouteTests(unittest.TestCase):
    def _build_handler(self, path: str, service: Mock) -> tuple[SpotlightRequestHandler, dict]:
        handler = SpotlightRequestHandler.__new__(SpotlightRequestHandler)
        handler.path = path
        handler.service = service
        service.request_identity_context.return_value = contextlib.nullcontext()
        captured: dict[str, object] = {}

        def write_json(status: HTTPStatus, payload: dict[str, object]) -> None:
            captured["status"] = status
            captured["payload"] = payload

        handler._require_request_identity = lambda: object()  # type: ignore[method-assign]
        handler._write_json = write_json  # type: ignore[method-assign]
        return handler, captured

    def test_get_route_dispatches_to_window_with_query_params(self) -> None:
        service = Mock()
        service.scan_candidates_window.return_value = {"candidates": [], "total": 0}
        handler, captured = self._build_handler(
            "/api/v1/scan/scan-pool/candidates?offset=10&limit=5", service
        )
        handler.do_GET()

        service.scan_candidates_window.assert_called_once_with(
            "scan-pool", offset=10, limit=5
        )
        self.assertEqual(captured["status"], HTTPStatus.OK)
        self.assertEqual(captured["payload"], {"candidates": [], "total": 0})

    def test_get_route_returns_404_for_unowned_scan(self) -> None:
        service = Mock()
        service.scan_candidates_window.side_effect = FileNotFoundError("Scan not found.")
        handler, captured = self._build_handler(
            "/api/v1/scan/scan-pool/candidates", service
        )
        handler.do_GET()
        self.assertEqual(captured["status"], HTTPStatus.NOT_FOUND)


class VisualCandidateStubGameTests(unittest.TestCase):
    """Scan candidates must carry their game, or the client draws Pokémon UI.

    `_candidate_base_payload` defaults a missing `game` to pokemon, so a stub
    without the key made every One Piece scan candidate render grading lanes
    the game doesn't have. The namespaced id is the authority: `onepiece~…`
    resolves to onepiece, a bare id to pokemon — cache hit or miss alike.
    """

    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        database_path = Path(self.tempdir.name) / "stub-game.sqlite"
        connection = connect(database_path)
        apply_schema(connection, BACKEND_ROOT / "schema.sql")
        connection.commit()
        connection.close()
        self.service = SpotlightScanService(database_path, REPO_ROOT)

    def tearDown(self) -> None:
        self.service.connection.close()
        self.tempdir.cleanup()

    def _stub(self, card_id: str) -> dict:
        return self.service._visual_candidate_stub(  # noqa: SLF001
            {"providerCardId": card_id, "name": "Any", "language": "English"}
        )

    def test_namespaced_id_resolves_to_its_game(self) -> None:
        self.assertEqual(self._stub("onepiece~OP05-119")["game"], "onepiece")
        self.assertEqual(self._stub("lorcana~AOTV-224")["game"], "lorcana")

    def test_bare_id_stays_pokemon(self) -> None:
        self.assertEqual(self._stub("sv5-163")["game"], "pokemon")


if __name__ == "__main__":
    unittest.main()
