from __future__ import annotations

import io
import sys
import tempfile
import time
import unittest
from concurrent.futures import ThreadPoolExecutor, as_completed
from http import HTTPStatus
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

BACKEND_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_ROOT.parent

if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from catalog_tools import apply_schema, connect, upsert_catalog_card  # noqa: E402
import server as server_module  # noqa: E402
from server import SpotlightRequestHandler, SpotlightScanService  # noqa: E402


def catalog_card(
    *,
    card_id: str,
    name: str,
    set_name: str,
    number: str,
    set_id: str,
    market_price: float | None = None,
) -> dict[str, object]:
    tcgplayer = {}
    if market_price is not None:
        tcgplayer = {
            "updatedAt": "2026-04-09T04:00:00Z",
            "url": f"https://prices.example/{card_id}",
            "prices": {
                "normal": {
                    "low": max(0.1, market_price - 1.0),
                    "mid": market_price - 0.5,
                    "market": market_price,
                    "high": market_price + 1.0,
                    "directLow": market_price - 0.25,
                }
            },
        }
    return {
        "id": card_id,
        "name": name,
        "set_name": set_name,
        "number": number,
        "rarity": "Rare",
        "variant": "Raw",
        "language": "English",
        "reference_image_path": None,
        "reference_image_url": f"https://images.example/{card_id}-large.png",
        "reference_image_small_url": f"https://images.example/{card_id}-small.png",
        "source": "scrydex",
        "source_record_id": card_id,
        "set_id": set_id,
        "set_series": "Test Series",
        "set_ptcgo_code": set_id.upper(),
        "set_release_date": "2024-01-01",
        "supertype": "Pokémon",
        "subtypes": [],
        "types": ["Fire"],
        "artist": "Test Artist",
        "regulation_mark": None,
        "national_pokedex_numbers": [],
        "tcgplayer": tcgplayer,
        "cardmarket": {},
        "source_payload": {"id": card_id, "name": name},
    }


def raw_payload(
    *,
    scan_id: str = "scan-phase8",
    title_text_primary: str = "",
    whole_card_text: str = "",
    footer_band_text: str = "",
    collector_number_exact: str = "",
    set_hint_tokens: list[str] | None = None,
    crop_confidence: float = 0.95,
    jpeg_base64: str | None = "dGVzdA==",
) -> dict[str, object]:
    payload = {
        "scanID": scan_id,
        "capturedAt": "2026-04-16T04:00:00Z",
        "collectorNumber": collector_number_exact or None,
        "setHintTokens": set_hint_tokens or [],
        "promoCodeHint": None,
        "recognizedTokens": [],
        "resolverModeHint": "raw_card",
        "cropConfidence": crop_confidence,
        "warnings": [],
        "ocrAnalysis": {
            "rawEvidence": {
                "titleTextPrimary": title_text_primary or None,
                "titleTextSecondary": None,
                "collectorNumberExact": collector_number_exact or None,
                "collectorNumberPartial": None,
                "setHints": set_hint_tokens or [],
                "footerBandText": footer_band_text,
                "wholeCardText": whole_card_text,
            }
        },
        "image": {
            "jpegBase64": jpeg_base64,
            "width": 630,
            "height": 880,
        },
        "rawResolverMode": "hybrid",
    }
    return payload


class TwoPhaseScanTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.database_path = Path(self.tempdir.name) / "two-phase.sqlite"
        connection = connect(self.database_path)
        apply_schema(connection, BACKEND_ROOT / "schema.sql")
        for card in (
            catalog_card(card_id="obf-223", name="Charizard ex", set_name="Obsidian Flames", number="223/197", set_id="obf", market_price=42.0),
            catalog_card(card_id="pal-223", name="Charizard ex", set_name="Paldea Evolved", number="223/193", set_id="pal", market_price=15.0),
        ):
            upsert_catalog_card(connection, card, REPO_ROOT, "2026-04-09T04:00:00Z", refresh_embeddings=False)
        connection.commit()
        connection.close()
        self.service = SpotlightScanService(self.database_path, REPO_ROOT)

    def tearDown(self) -> None:
        self.service.connection.close()
        self.tempdir.cleanup()

    def test_visual_match_scan_caches_shortlist_and_returns_provisional_response(self) -> None:
        class FakeVisualMatcher:
            def __init__(self) -> None:
                self.calls = 0

            def prewarm(self):
                return {"available": True, "prewarmed": True}

            def match_payload(self, payload: dict[str, object], *, top_k: int = 10):  # noqa: ARG002
                self.calls += 1
                return (
                    [
                        SimpleNamespace(
                            row_index=0,
                            similarity=0.91,
                            entry={
                                "providerCardId": "obf-223",
                                "name": "Charizard ex",
                                "collectorNumber": "223/197",
                                "setId": "obf",
                                "setName": "Obsidian Flames",
                                "setSeries": "Scarlet & Violet",
                                "setPtcgoCode": "OBF",
                                "sourceProvider": "scrydex",
                                "sourceRecordID": "obf-223",
                                "imageUrl": "https://images.example/obf-223-large.png",
                                "language": "English",
                            },
                        ),
                        SimpleNamespace(
                            row_index=1,
                            similarity=0.84,
                            entry={
                                "providerCardId": "pal-223",
                                "name": "Charizard ex",
                                "collectorNumber": "223/193",
                                "setId": "pal",
                                "setName": "Paldea Evolved",
                                "setSeries": "Scarlet & Violet",
                                "setPtcgoCode": "PAL",
                                "sourceProvider": "scrydex",
                                "sourceRecordID": "pal-223",
                                "imageUrl": "https://images.example/pal-223-large.png",
                                "language": "English",
                            },
                        ),
                    ],
                    {
                        "source": "fake",
                        "timings": {
                            "imageDecodeMs": 1.0,
                            "ensureRuntimeMs": 2.0,
                            "embeddingMs": 3.0,
                            "indexSearchMs": 4.0,
                            "matchPayloadMs": 5.0,
                        },
                    },
                )

        matcher = FakeVisualMatcher()
        self.service._raw_visual_matcher = matcher

        response = self.service.visual_match_scan(
            raw_payload(
                title_text_primary="Charizard ex",
                whole_card_text="Charizard ex",
                footer_band_text="OBF 223/197",
                collector_number_exact="223/197",
                set_hint_tokens=["OBF"],
            )
        )

        self.assertEqual(matcher.calls, 1)
        self.assertTrue(response["isProvisional"])
        self.assertEqual(response["matchingStage"], "visual")
        self.assertEqual(response["resolverPath"], "visual_only_index")
        self.assertEqual(response["topCandidates"][0]["candidate"]["id"], "obf-223")
        pending = self.service._pending_visual_scan("scan-phase8")
        self.assertIsNotNone(pending)
        self.assertEqual(len(pending.visual_matches), 2)

    def test_rerank_uses_cached_shortlist_and_marks_final_result(self) -> None:
        class FakeVisualMatcher:
            def __init__(self) -> None:
                self.calls = 0

            def prewarm(self):
                return {"available": True, "prewarmed": True}

            def match_payload(self, payload: dict[str, object], *, top_k: int = 10):  # noqa: ARG002
                self.calls += 1
                return (
                    [
                        SimpleNamespace(
                            row_index=0,
                            similarity=0.91,
                            entry={
                                "providerCardId": "obf-223",
                                "name": "Charizard ex",
                                "collectorNumber": "223/197",
                                "setId": "obf",
                                "setName": "Obsidian Flames",
                                "setSeries": "Scarlet & Violet",
                                "setPtcgoCode": "OBF",
                                "sourceProvider": "scrydex",
                                "sourceRecordID": "obf-223",
                                "imageUrl": "https://images.example/obf-223-large.png",
                                "language": "English",
                            },
                        ),
                        SimpleNamespace(
                            row_index=1,
                            similarity=0.84,
                            entry={
                                "providerCardId": "pal-223",
                                "name": "Charizard ex",
                                "collectorNumber": "223/193",
                                "setId": "pal",
                                "setName": "Paldea Evolved",
                                "setSeries": "Scarlet & Violet",
                                "setPtcgoCode": "PAL",
                                "sourceProvider": "scrydex",
                                "sourceRecordID": "pal-223",
                                "imageUrl": "https://images.example/pal-223-large.png",
                                "language": "English",
                            },
                        ),
                    ],
                    {
                        "source": "fake",
                        "timings": {
                            "imageDecodeMs": 1.0,
                            "ensureRuntimeMs": 2.0,
                            "embeddingMs": 3.0,
                            "indexSearchMs": 4.0,
                            "matchPayloadMs": 5.0,
                        },
                    },
                )

        matcher = FakeVisualMatcher()
        self.service._raw_visual_matcher = matcher
        visual_payload = raw_payload(
            title_text_primary="Charizard ex",
            whole_card_text="Charizard ex",
            footer_band_text="OBF 223/197",
            collector_number_exact="223/197",
            set_hint_tokens=["OBF"],
        )
        self.service.visual_match_scan(visual_payload)
        self.assertEqual(matcher.calls, 1)

        rerank_payload = raw_payload(
            scan_id="scan-phase8",
            title_text_primary="Charizard ex",
            whole_card_text="Charizard ex",
            footer_band_text="OBF 223/197",
            collector_number_exact="223/197",
            set_hint_tokens=["OBF"],
        )
        response = self.service.rerank_visual_match(rerank_payload)

        self.assertEqual(matcher.calls, 1)
        self.assertFalse(response["isProvisional"])
        self.assertEqual(response["matchingStage"], "reranked")
        self.assertEqual(response["resolverPath"], "visual_hybrid_index")
        self.assertEqual(response["topCandidates"][0]["candidate"]["id"], "obf-223")
        self.assertEqual(response["rawDecisionDebug"]["visualHybrid"]["visualPhaseSource"], "cached")

    def test_rerank_cache_miss_falls_back_to_match_scan(self) -> None:
        fallback_response = {"ok": True}
        self.service.match_scan = Mock(return_value=fallback_response)  # type: ignore[method-assign]

        response = self.service.rerank_visual_match(raw_payload(scan_id="missing-scan"))

        self.service.match_scan.assert_called_once()
        self.assertEqual(response, fallback_response)

    def test_rerank_cache_miss_without_image_bytes_raises_explicit_error(self) -> None:
        with self.assertRaisesRegex(ValueError, "Cached visual shortlist expired"):
            self.service.rerank_visual_match(raw_payload(scan_id="missing-scan", jpeg_base64=None))

    def test_scan_routes_dispatch_to_two_phase_methods(self) -> None:
        handler = SpotlightRequestHandler.__new__(SpotlightRequestHandler)
        handler.path = "/api/v1/scan/visual-match"
        handler.service = Mock()
        handler.service.visual_match_scan.return_value = {"stage": "visual"}
        captured: dict[str, object] = {}

        def write_json(status: HTTPStatus, payload: dict[str, object]) -> None:
            captured["status"] = status
            captured["payload"] = payload

        handler._read_json_body = lambda: {"scanID": "scan-phase8"}  # type: ignore[method-assign]
        handler._write_json = write_json  # type: ignore[method-assign]
        handler.do_POST()

        handler.service.visual_match_scan.assert_called_once_with({"scanID": "scan-phase8"})
        self.assertEqual(captured["status"], HTTPStatus.OK)
        self.assertEqual(captured["payload"], {"stage": "visual"})

        handler = SpotlightRequestHandler.__new__(SpotlightRequestHandler)
        handler.path = "/api/v1/scan/rerank"
        handler.service = Mock()
        handler.service.rerank_visual_match.return_value = {"stage": "rerank"}
        captured = {}
        handler._read_json_body = lambda: {"scanID": "scan-phase8"}  # type: ignore[method-assign]
        handler._write_json = write_json  # type: ignore[method-assign]
        handler.do_POST()

        handler.service.rerank_visual_match.assert_called_once_with({"scanID": "scan-phase8"})
        self.assertEqual(captured["status"], HTTPStatus.OK)
        self.assertEqual(captured["payload"], {"stage": "rerank"})

    def test_scan_rerank_route_returns_conflict_for_cache_expiry_error(self) -> None:
        handler = SpotlightRequestHandler.__new__(SpotlightRequestHandler)
        handler.path = "/api/v1/scan/rerank"
        handler.service = Mock()
        handler.service.rerank_visual_match.side_effect = ValueError("Cached visual shortlist expired")
        captured: dict[str, object] = {}

        def write_json_timed(status: HTTPStatus, payload: dict[str, object], *, label: str, started_at: float) -> None:  # noqa: ARG001
            captured["status"] = status
            captured["payload"] = payload

        handler._read_json_body = lambda: {"scanID": "scan-phase8"}  # type: ignore[method-assign]
        handler._write_json_timed = write_json_timed  # type: ignore[method-assign]
        handler.do_POST()

        self.assertEqual(captured["status"], HTTPStatus.CONFLICT)
        self.assertEqual(captured["payload"], {"error": "Cached visual shortlist expired", "errorType": "ValueError"})

    def test_read_json_body_enforces_path_specific_size_limits(self) -> None:
        original_default_limit = server_module.DEFAULT_JSON_BODY_LIMIT_BYTES
        original_artifact_limit = server_module.SCAN_ARTIFACT_JSON_BODY_LIMIT_BYTES
        server_module.DEFAULT_JSON_BODY_LIMIT_BYTES = 32
        server_module.SCAN_ARTIFACT_JSON_BODY_LIMIT_BYTES = 96
        try:
            scan_body = b'{"scanID":"' + (b"x" * 40) + b'"}'
            handler = SpotlightRequestHandler.__new__(SpotlightRequestHandler)
            handler.path = "/api/v1/scan/match"
            handler.headers = {"Content-Length": str(len(scan_body))}
            handler.rfile = io.BytesIO(scan_body)

            payload = handler._read_json_body()

            self.assertIsNone(payload)
            self.assertEqual(handler._json_body_error_status, HTTPStatus.REQUEST_ENTITY_TOO_LARGE)
            self.assertEqual(handler._json_body_error_message, "JSON body exceeds 32 bytes")

            artifact_body = b'{"scanID":"' + (b"y" * 50) + b'"}'
            handler = SpotlightRequestHandler.__new__(SpotlightRequestHandler)
            handler.path = "/api/v1/scan-artifacts"
            handler.headers = {"Content-Length": str(len(artifact_body))}
            handler.rfile = io.BytesIO(artifact_body)

            artifact_payload = handler._read_json_body()

            self.assertEqual(artifact_payload, {"scanID": "y" * 50})
            self.assertIsNone(handler._json_body_error_status)

            oversized_artifact_body = b'{"scanID":"' + (b"z" * 120) + b'"}'
            handler = SpotlightRequestHandler.__new__(SpotlightRequestHandler)
            handler.path = "/api/v1/scan-artifacts"
            handler.headers = {"Content-Length": str(len(oversized_artifact_body))}
            handler.rfile = io.BytesIO(oversized_artifact_body)

            rejected_payload = handler._read_json_body()

            self.assertIsNone(rejected_payload)
            self.assertEqual(handler._json_body_error_status, HTTPStatus.REQUEST_ENTITY_TOO_LARGE)
            self.assertEqual(handler._json_body_error_message, "JSON body exceeds 96 bytes")
        finally:
            server_module.DEFAULT_JSON_BODY_LIMIT_BYTES = original_default_limit
            server_module.SCAN_ARTIFACT_JSON_BODY_LIMIT_BYTES = original_artifact_limit

    def test_concurrent_two_phase_requests_keep_cached_shortlists_isolated(self) -> None:
        class FakeVisualMatcher:
            def __init__(self) -> None:
                self.calls = 0

            def prewarm(self):
                return {"available": True, "prewarmed": True}

            def match_payload(self, payload: dict[str, object], *, top_k: int = 10):  # noqa: ARG002
                self.calls += 1
                scan_id = str(payload.get("scanID") or "")
                scan_index = int(scan_id.rsplit("-", 1)[-1])
                use_obf = (scan_index % 2) == 0
                time.sleep(0.01)
                if use_obf:
                    primary = {
                        "providerCardId": "obf-223",
                        "name": "Charizard ex",
                        "collectorNumber": "223/197",
                        "setId": "obf",
                        "setName": "Obsidian Flames",
                        "setSeries": "Scarlet & Violet",
                        "setPtcgoCode": "OBF",
                        "sourceProvider": "scrydex",
                        "sourceRecordID": "obf-223",
                        "imageUrl": "https://images.example/obf-223-large.png",
                        "language": "English",
                    }
                    secondary = {
                        "providerCardId": "pal-223",
                        "name": "Charizard ex",
                        "collectorNumber": "223/193",
                        "setId": "pal",
                        "setName": "Paldea Evolved",
                        "setSeries": "Scarlet & Violet",
                        "setPtcgoCode": "PAL",
                        "sourceProvider": "scrydex",
                        "sourceRecordID": "pal-223",
                        "imageUrl": "https://images.example/pal-223-large.png",
                        "language": "English",
                    }
                else:
                    primary = {
                        "providerCardId": "pal-223",
                        "name": "Charizard ex",
                        "collectorNumber": "223/193",
                        "setId": "pal",
                        "setName": "Paldea Evolved",
                        "setSeries": "Scarlet & Violet",
                        "setPtcgoCode": "PAL",
                        "sourceProvider": "scrydex",
                        "sourceRecordID": "pal-223",
                        "imageUrl": "https://images.example/pal-223-large.png",
                        "language": "English",
                    }
                    secondary = {
                        "providerCardId": "obf-223",
                        "name": "Charizard ex",
                        "collectorNumber": "223/197",
                        "setId": "obf",
                        "setName": "Obsidian Flames",
                        "setSeries": "Scarlet & Violet",
                        "setPtcgoCode": "OBF",
                        "sourceProvider": "scrydex",
                        "sourceRecordID": "obf-223",
                        "imageUrl": "https://images.example/obf-223-large.png",
                        "language": "English",
                    }

                return (
                    [
                        SimpleNamespace(row_index=0, similarity=0.91, entry=primary),
                        SimpleNamespace(row_index=1, similarity=0.84, entry=secondary),
                    ],
                    {
                        "source": "fake",
                        "timings": {
                            "imageDecodeMs": 1.0,
                            "ensureRuntimeMs": 2.0,
                            "embeddingMs": 3.0,
                            "indexSearchMs": 4.0,
                            "matchPayloadMs": 5.0,
                        },
                    },
                )

        matcher = FakeVisualMatcher()
        self.service._raw_visual_matcher = matcher

        scan_ids = [f"scan-phase8-{index}" for index in range(24)]

        def payload_for_scan(scan_id: str) -> tuple[dict[str, object], str]:
            scan_index = int(scan_id.rsplit("-", 1)[-1])
            if (scan_index % 2) == 0:
                expected_card_id = "obf-223"
                payload = raw_payload(
                    scan_id=scan_id,
                    title_text_primary="Charizard ex",
                    whole_card_text="Charizard ex",
                    footer_band_text="OBF 223/197",
                    collector_number_exact="223/197",
                    set_hint_tokens=["OBF"],
                )
            else:
                expected_card_id = "pal-223"
                payload = raw_payload(
                    scan_id=scan_id,
                    title_text_primary="Charizard ex",
                    whole_card_text="Charizard ex",
                    footer_band_text="PAL 223/193",
                    collector_number_exact="223/193",
                    set_hint_tokens=["PAL"],
                )
            return payload, expected_card_id

        def run_scan(scan_id: str) -> tuple[str, str, dict[str, object], dict[str, object]]:
            payload, expected_card_id = payload_for_scan(scan_id)
            visual_response = self.service.visual_match_scan(payload)
            rerank_response = self.service.rerank_visual_match(payload)
            return scan_id, expected_card_id, visual_response, rerank_response

        results: list[tuple[str, str, dict[str, object], dict[str, object]]] = []
        with ThreadPoolExecutor(max_workers=8) as executor:
            futures = [executor.submit(run_scan, scan_id) for scan_id in scan_ids]
            for future in as_completed(futures):
                results.append(future.result())

        self.assertEqual(matcher.calls, len(scan_ids))
        self.assertEqual(len(results), len(scan_ids))

        for scan_id, expected_card_id, visual_response, rerank_response in results:
            self.assertEqual(visual_response["matchingStage"], "visual")
            self.assertTrue(visual_response["isProvisional"])
            self.assertEqual(rerank_response["matchingStage"], "reranked")
            self.assertFalse(rerank_response["isProvisional"])
            self.assertEqual(rerank_response["topCandidates"][0]["candidate"]["id"], expected_card_id)
            self.assertEqual(
                rerank_response["rawDecisionDebug"]["visualHybrid"]["visualPhaseSource"],
                "cached",
            )
            self.assertIsNone(self.service._pending_visual_scan(scan_id))

    def test_duplicate_concurrent_reranks_consume_cached_shortlist_once(self) -> None:
        class FakeVisualMatcher:
            def prewarm(self):
                return {"available": True, "prewarmed": True}

            def match_payload(self, payload: dict[str, object], *, top_k: int = 10):  # noqa: ARG002
                return (
                    [
                        SimpleNamespace(
                            row_index=0,
                            similarity=0.91,
                            entry={
                                "providerCardId": "obf-223",
                                "name": "Charizard ex",
                                "collectorNumber": "223/197",
                                "setId": "obf",
                                "setName": "Obsidian Flames",
                                "setSeries": "Scarlet & Violet",
                                "setPtcgoCode": "OBF",
                                "sourceProvider": "scrydex",
                                "sourceRecordID": "obf-223",
                                "imageUrl": "https://images.example/obf-223-large.png",
                                "language": "English",
                            },
                        )
                    ],
                    {
                        "source": "fake",
                        "timings": {
                            "imageDecodeMs": 1.0,
                            "ensureRuntimeMs": 2.0,
                            "embeddingMs": 3.0,
                            "indexSearchMs": 4.0,
                            "matchPayloadMs": 5.0,
                        },
                    },
                )

        self.service._raw_visual_matcher = FakeVisualMatcher()
        payload = raw_payload(
            title_text_primary="Charizard ex",
            whole_card_text="Charizard ex",
            footer_band_text="OBF 223/197",
            collector_number_exact="223/197",
            set_hint_tokens=["OBF"],
        )
        self.service.visual_match_scan(payload)

        def fake_resolve(
            payload: dict[str, object],
            *,
            matches: list[object],
            debug: dict[str, object],
            requested_top_k: int,
            api_key: str | None = None,
            visual_match_ms: float,
            visual_phase_source: str,
        ) -> dict[str, object]:
            time.sleep(0.02)
            return {
                "scanID": str(payload.get("scanID") or ""),
                "topCandidates": [
                    {
                        "candidate": {
                            "id": "obf-223",
                            "name": "Charizard ex",
                        }
                    }
                ],
                "confidence": "medium",
                "ambiguityFlags": [],
                "matcherSource": "visualIndex",
                "matcherVersion": "test",
                "resolverMode": "raw_card",
                "resolverPath": "visual_hybrid_index",
                "reviewDisposition": "ready",
                "reviewReason": None,
                "rawDecisionDebug": {
                    "visualHybrid": {
                        "visualPhaseSource": visual_phase_source,
                        "candidateCount": len(matches),
                        "debug": debug,
                    }
                },
            }

        self.service._resolve_raw_candidates_visual_hybrid_from_matches = fake_resolve  # type: ignore[method-assign]
        fallback_response = {"matchingStage": "fallback", "topCandidates": []}
        self.service.match_scan = Mock(return_value=fallback_response)  # type: ignore[method-assign]

        results: list[dict[str, object]] = []
        with ThreadPoolExecutor(max_workers=2) as executor:
            futures = [executor.submit(self.service.rerank_visual_match, payload) for _ in range(2)]
            for future in as_completed(futures):
                results.append(future.result())

        reranked_count = sum(1 for response in results if response.get("matchingStage") == "reranked")
        fallback_count = sum(1 for response in results if response.get("matchingStage") == "fallback")

        self.assertEqual(reranked_count, 1)
        self.assertEqual(fallback_count, 1)
        self.service.match_scan.assert_called_once_with(payload)


if __name__ == "__main__":
    unittest.main()
