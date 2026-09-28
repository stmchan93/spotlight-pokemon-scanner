"""Scan responses carry `matchedVariant` on each topCandidates item whose
winning visual-index row was an alt-art (TCGplayer) row, across every visual
response path: single scan, binder batch, rerank, and the persisted pool."""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

BACKEND_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_ROOT.parent

if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))
if str(BACKEND_ROOT / "tests") not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT / "tests"))

from catalog_tools import apply_schema, connect, upsert_catalog_card  # noqa: E402
import server as server_module  # noqa: E402
from server import SpotlightScanService  # noqa: E402
from test_scan_two_phase_phase8 import catalog_card, raw_payload  # type: ignore  # noqa: E402

POOL_SIZE = server_module.SCAN_CANDIDATE_POOL_SIZE

EXPECTED_VARIANT = {
    "label": "Manga Alt Art",
    "tcgplayerProductId": "527026",
    "imageUrl": "https://tcgplayer-cdn.tcgplayer.com/product/527026_in_1000x1000.jpg",
    "source": "tcgplayer",
}


def _match(card_id: str, similarity: float, *, alt_product_id: str | None = None) -> SimpleNamespace:
    entry = {
        "providerCardId": card_id,
        "name": f"Card {card_id}",
        "collectorNumber": f"{card_id}/000",
        "setId": "set",
        "setName": "Alt Set",
        "sourceProvider": "scrydex",
        "sourceRecordID": card_id,
        "imageUrl": f"https://images.example/{card_id}-large.png",
        "language": "English",
    }
    if alt_product_id is not None:
        entry.update(
            {
                "referenceSource": "tcgplayer",
                "variantLabel": "Manga Alt Art",
                "tcgplayerProductId": alt_product_id,
                "tcgplayerOrdinal": 1,
            }
        )
    return SimpleNamespace(row_index=0, similarity=similarity, entry=entry)


class _FakeVisualMatcher:
    def __init__(self, matches: list[SimpleNamespace]) -> None:
        self.matches = matches

    def prewarm(self):
        return {"available": True, "prewarmed": True}

    def match_payload(self, payload, *, top_k: int = 10, **_kwargs):  # noqa: ARG002
        return list(self.matches[:top_k]), {"source": "fake", "timings": {}}


class AltArtScanResponseTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        database_path = Path(self.tempdir.name) / "alt-art.sqlite"
        connection = connect(database_path)
        apply_schema(connection, BACKEND_ROOT / "schema.sql")
        # 12 cards so the persisted pool reaches past the hydrated top 10.
        self.card_ids = [f"alt-{i:02d}" for i in range(12)]
        for index, card_id in enumerate(self.card_ids):
            upsert_catalog_card(
                connection,
                catalog_card(
                    card_id=card_id,
                    name=f"Card {card_id}",
                    set_name="Alt Set",
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
        self.service = SpotlightScanService(database_path, REPO_ROOT)
        # Rank 1 and rank 11 won on an alt-art row; everything else on its base row.
        self.service._raw_visual_matcher = _FakeVisualMatcher(  # noqa: SLF001
            [
                _match(
                    card_id,
                    0.95 - 0.01 * index,
                    alt_product_id="527026" if index in (0, 10) else None,
                )
                for index, card_id in enumerate(self.card_ids)
            ]
        )

    def tearDown(self) -> None:
        self.service.connection.close()
        self.tempdir.cleanup()

    def _assert_variant_only_on_first(self, top_candidates: list[dict]) -> None:
        self.assertEqual(top_candidates[0]["candidate"]["id"], "alt-00")
        self.assertEqual(top_candidates[0]["matchedVariant"], EXPECTED_VARIANT)
        for item in top_candidates[1:]:
            self.assertNotIn("matchedVariant", item)

    def test_single_scan_surfaces_variant_and_persists_it(self) -> None:
        response = self.service.visual_match_scan(raw_payload(scan_id="scan-alt"))
        self._assert_variant_only_on_first(response["topCandidates"])
        self.assertNotIn("matchedVariant", response["topCandidates"][0]["candidate"])

        row = self.service.connection.execute(
            "SELECT response_json FROM scan_events WHERE scan_id = ?", ("scan-alt",)
        ).fetchone()
        persisted = json.loads(row["response_json"])
        self.assertEqual(persisted["topCandidates"][0]["matchedVariant"], EXPECTED_VARIANT)

    def test_load_more_window_keeps_variant_on_lightweight_rows(self) -> None:
        self.service.visual_match_scan(raw_payload(scan_id="scan-alt"))
        window = self.service.scan_candidates_window("scan-alt", offset=0, limit=POOL_SIZE)
        by_id = {item["candidate"]["id"]: item for item in window["candidates"]}
        self.assertEqual(by_id["alt-00"]["matchedVariant"], EXPECTED_VARIANT)
        if POOL_SIZE > 10:
            self.assertEqual(by_id["alt-10"]["matchedVariant"], EXPECTED_VARIANT)
        self.assertNotIn("matchedVariant", by_id["alt-01"])

    def test_rerank_keeps_variant(self) -> None:
        self.service.visual_match_scan(raw_payload(scan_id="scan-alt"))
        response = self.service.rerank_visual_match(raw_payload(scan_id="scan-alt"))
        self.assertEqual(response["matchingStage"], "reranked")
        by_id = {item["candidate"]["id"]: item for item in response["topCandidates"]}
        self.assertEqual(by_id["alt-00"]["matchedVariant"], EXPECTED_VARIANT)
        self.assertNotIn("matchedVariant", by_id["alt-01"])

        # The reranked pool is what "load more" reads next.
        window = self.service.scan_candidates_window("scan-alt", offset=0, limit=POOL_SIZE)
        by_id = {item["candidate"]["id"]: item for item in window["candidates"]}
        self.assertEqual(by_id["alt-00"]["matchedVariant"], EXPECTED_VARIANT)

    def test_binder_batch_surfaces_variant(self) -> None:
        base = raw_payload(scan_id="unused")
        payload = {key: value for key, value in base.items() if key not in ("scanID", "image")}
        payload["items"] = [
            {"scanID": "scan-pocket-0", "pocketIndex": 0, "image": {"jpegBase64": "dGVzdA==", "width": 630, "height": 880}}
        ]
        response = self.service.visual_match_scan_batch(payload)
        self._assert_variant_only_on_first(response["results"][0]["topCandidates"])

    def test_base_row_scan_has_no_variant(self) -> None:
        self.service._raw_visual_matcher = _FakeVisualMatcher(  # noqa: SLF001
            [_match(card_id, 0.9 - 0.01 * i) for i, card_id in enumerate(self.card_ids)]
        )
        response = self.service.visual_match_scan(raw_payload(scan_id="scan-base"))
        for item in response["topCandidates"]:
            self.assertNotIn("matchedVariant", item)


if __name__ == "__main__":
    unittest.main()
