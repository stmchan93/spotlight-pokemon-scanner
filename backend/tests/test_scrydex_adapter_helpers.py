from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch


BACKEND_ROOT = Path(__file__).resolve().parents[1]

if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from catalog_tools import RawEvidence  # noqa: E402
import scrydex_adapter as scrydex_adapter_module  # noqa: E402
from scrydex_adapter import (  # noqa: E402
    ScrydexProvider,
    _best_scrydex_raw_price,
    _contains_japanese_text,
    _contexts_from_price_history_entry,
    _contexts_from_variant_payloads,
    _default_scrydex_audit_db_path,
    _graded_context_key,
    _humanize_scrydex_variant_name,
    _normalize_scrydex_language,
    _normalize_variant_key,
    _payload_context_stub,
    _quote_query_value,
    _record_scrydex_request,
    _scrydex_card_data,
    _scrydex_expansion_scopes,
    _scrydex_slab_number_queries,
    _scrydex_slab_title_clauses,
    _scrydex_trend_price,
    _scrydex_variant_hint_score,
    _scrydex_japanese_expansion_scopes,
    _scrydex_japanese_title_clauses,
    _scrydex_raw_title_clauses,
    _scrydex_result_count,
    _scrydex_runtime_label,
    _scrydex_variant_display_name,
    _upsert_graded_context,
    _upsert_raw_context,
    _best_scrydex_graded_price,
    build_scrydex_pricing_bundle_from_card_payload,
    scrydex_api_request,
    reset_scrydex_request_stats,
    search_remote_scrydex_raw_candidates,
    scrydex_request_stats_snapshot,
)


def make_raw_evidence(**overrides: object) -> RawEvidence:
    payload: dict[str, object] = {
        "title_text_primary": "",
        "title_text_secondary": "",
        "recognized_text": "",
        "footer_band_text": "",
        "bottom_left_text": "",
        "bottom_right_text": "",
        "collector_number_exact": None,
        "collector_number_partial": None,
        "collector_number_query_values": (),
        "collector_number_printed_total": None,
        "set_badge_hint_kind": None,
        "set_badge_hint_source": None,
        "set_badge_hint_raw_value": None,
        "set_hint_tokens": (),
        "trusted_set_hint_tokens": (),
        "promo_code_hint": None,
        "recognized_tokens": (),
        "crop_confidence": 0.0,
        "title_confidence_score": 0.0,
        "collector_confidence_score": 0.0,
        "set_confidence_score": 0.0,
        "used_fallback_normalization": False,
        "target_quality_score": 1.0,
    }
    payload.update(overrides)
    return RawEvidence(**payload)


class ScrydexAdapterHelperTests(unittest.TestCase):
    def tearDown(self) -> None:
        reset_scrydex_request_stats()

    def test_record_scrydex_request_updates_counters_and_caps_recent_entries(self) -> None:
        reset_scrydex_request_stats()

        for index in range(27):
            entry = _record_scrydex_request(
                "/pokemon/v1/cards",
                "raw_search" if index % 2 == 0 else "slab_search",
                {"q": f"card-{index}", "include": "prices", "page_size": "10"},
            )
            self.assertEqual(entry["sequence"], index + 1)

        snapshot = scrydex_request_stats_snapshot()
        self.assertEqual(snapshot["total"], 27)
        self.assertEqual(snapshot["byType"]["raw_search"], 14)
        self.assertEqual(snapshot["byType"]["slab_search"], 13)
        self.assertEqual(snapshot["byPath"]["/pokemon/v1/cards"], 27)
        self.assertEqual(len(snapshot["recent"]), 25)
        self.assertEqual(snapshot["recent"][0]["sequence"], 3)
        self.assertEqual(snapshot["recent"][-1]["sequence"], 27)

    def test_default_scrydex_audit_db_path_respects_env_override(self) -> None:
        with patch.dict(os.environ, {"SPOTLIGHT_SCRYDEX_AUDIT_DB_PATH": "~/tmp/scrydex-audit.sqlite"}, clear=False):
            self.assertEqual(
                _default_scrydex_audit_db_path(),
                Path("~/tmp/scrydex-audit.sqlite").expanduser(),
            )

        with patch.dict(os.environ, {}, clear=True):
            default_path = _default_scrydex_audit_db_path()
        self.assertTrue(str(default_path).endswith("backend/data/scrydex_request_audit.sqlite"))

    def test_scrydex_runtime_label_uses_override_or_hostname_and_executable(self) -> None:
        with patch.dict(os.environ, {"SPOTLIGHT_RUNTIME_LABEL": "staging-vm"}, clear=False):
            self.assertEqual(_scrydex_runtime_label(), "staging-vm")

        with patch.dict(os.environ, {}, clear=True), patch.object(sys, "argv", ["tools/run.py"]):
            runtime_label = _scrydex_runtime_label()

        self.assertIn(":", runtime_label)
        self.assertTrue(runtime_label.endswith(":run.py"))

    def test_scrydex_result_count_handles_list_dict_and_missing_payloads(self) -> None:
        self.assertEqual(_scrydex_result_count({"data": [1, 2, 3]}), 3)
        self.assertEqual(_scrydex_result_count({"data": {"id": "base1-4"}}), 1)
        self.assertIsNone(_scrydex_result_count({"data": None}))

    def test_normalization_and_text_helpers_cover_language_quotes_and_japanese_detection(self) -> None:
        self.assertEqual(_normalize_scrydex_language("ja"), "Japanese")
        self.assertEqual(_normalize_scrydex_language("English"), "English")
        self.assertEqual(_normalize_scrydex_language("German"), "German")
        self.assertEqual(_quote_query_value('Mew "Black Star" \\ Promo'), 'Mew \\"Black Star\\" \\\\ Promo')
        self.assertTrue(_contains_japanese_text("リザードン"))
        self.assertFalse(_contains_japanese_text("Charizard"))

    def test_title_clause_builders_cover_english_and_japanese_evidence(self) -> None:
        english_evidence = make_raw_evidence(
            title_text_primary="Dark Charizard",
            recognized_tokens=("dark", "charizard", "team", "rocket"),
        )
        japanese_evidence = make_raw_evidence(
            title_text_primary="リザードン",
            trusted_set_hint_tokens=("sv6_ja", "Space Juggler"),
        )

        self.assertEqual(
            _scrydex_raw_title_clauses(english_evidence),
            ['name:"Dark Charizard"', "name:dark name:charizard"],
        )
        self.assertEqual(_scrydex_japanese_title_clauses(japanese_evidence), ['name:"リザードン"'])
        self.assertEqual(
            _scrydex_japanese_expansion_scopes(japanese_evidence),
            ["expansion.id:sv6_ja", 'expansion.name:"Space Juggler"'],
        )

    def test_best_scrydex_raw_price_prefers_nm_market_rows_and_ignores_graded_only_rows(self) -> None:
        payload = {
            "data": {
                "id": "base1-4",
                "variants": [
                    {
                        "name": "normal",
                        "prices": [
                            {"type": "graded", "company": "PSA", "grade": "9", "market": 2000, "currency": "USD"},
                            {"type": "raw", "condition": "LP", "mid": 4.0, "currency": "USD"},
                            {"type": "raw", "condition": "NM", "market": 5.25, "mid": 4.5, "currency": "USD"},
                            {"type": "raw", "condition": "NM", "market": 9.99, "currency": "USD", "is_signed": True},
                        ],
                    },
                ],
            },
        }

        variant_name, price = _best_scrydex_raw_price(payload) or (None, None)

        self.assertEqual(variant_name, "normal")
        self.assertIsNotNone(price)
        self.assertEqual(price["market"], 5.25)

    def test_variant_display_name_and_pricing_bundle_build_raw_and_graded_contexts(self) -> None:
        payload = {
            "data": {
                "id": "base1-4",
                "name": "Charizard",
                "expansion": {"name": "Base"},
                "variants": [
                    {
                        "name": "holofoil",
                        "prices": [
                            {
                                "type": "raw",
                                "condition": "NM",
                                "currency": "USD",
                                "market": 345.67,
                                "low": 300.0,
                                "mid": 320.0,
                                "high": 390.0,
                                "trends": {"days_30": {"price_change": 12.5}},
                            },
                            {
                                "type": "graded",
                                "company": "PSA",
                                "grade": "9",
                                "currency": "USD",
                                "market": 2200.0,
                                "low": 2100.0,
                                "mid": 2150.0,
                                "high": 2400.0,
                            },
                        ],
                    },
                ],
            },
        }

        bundle = build_scrydex_pricing_bundle_from_card_payload(payload)

        self.assertEqual(_scrydex_variant_display_name("standard"), "Normal")
        self.assertEqual(_scrydex_variant_display_name("firstEditionHolofoil"), "First Edition Holofoil")
        self.assertEqual(bundle["displayCurrencyCode"], "USD")
        self.assertEqual(bundle["defaultRawVariant"], "Holofoil")
        self.assertEqual(bundle["defaultRawCondition"], "NM")
        self.assertEqual(bundle["defaultRawMarketPrice"], 345.67)
        self.assertIn("Holofoil", bundle["rawContexts"]["variants"])
        self.assertIn("PSA", bundle["gradedContexts"]["graders"])
        self.assertIn("9", bundle["gradedContexts"]["graders"]["PSA"])

    def test_card_data_and_variant_helper_utilities_cover_error_and_humanization_paths(self) -> None:
        self.assertEqual(_scrydex_card_data({"data": {"id": "base1-4"}})["id"], "base1-4")
        self.assertEqual(_scrydex_card_data({"id": "base1-4"})["id"], "base1-4")
        with self.assertRaisesRegex(ValueError, "must be a dictionary"):
            _scrydex_card_data([])  # type: ignore[arg-type]
        with self.assertRaisesRegex(ValueError, "missing a card data object"):
            _scrydex_card_data({"data": []})

        self.assertEqual(_normalize_variant_key("First Edition Holofoil"), "firsteditionholofoil")
        self.assertEqual(_humanize_scrydex_variant_name("firstEditionHolofoil"), "First Edition Holofoil")
        self.assertEqual(_scrydex_variant_hint_score("Shadowless FirstEdition", {"shadowless": True, "firstEdition": True}), 8)
        self.assertLess(_scrydex_variant_hint_score("Jumbo", {"jumbo": False}), 0)

    def test_context_helpers_build_raw_and_graded_buckets_from_variant_payloads(self) -> None:
        price = {
            "type": "raw",
            "condition": "LP",
            "currency": "USD",
            "low": 10.0,
            "market": 12.0,
            "mid": 11.0,
            "high": 13.0,
            "direct_low": 9.5,
            "trends": {"days_30": {"price_change": 1.25}},
        }
        stub = _payload_context_stub(variant_key="normal", variant_label="Normal", price=price)
        self.assertEqual(stub["variant"], "Normal")
        self.assertEqual(_scrydex_trend_price(price), 1.25)
        self.assertIsNone(_scrydex_trend_price({}))

        raw_contexts: dict[str, object] = {"variants": {}}
        _upsert_raw_context(raw_contexts, variant_key="normal", variant_label="Normal", price=price)
        self.assertIn("Normal", raw_contexts["variants"])

        graded_contexts: dict[str, object] = {"graders": {}}
        graded_price = {
            "type": "graded",
            "company": "PSA",
            "grade": "10",
            "currency": "USD",
            "market": 1200.0,
            "mid": 1100.0,
            "low": 1000.0,
            "high": 1300.0,
            "is_perfect": False,
            "is_signed": False,
            "is_error": False,
        }
        _upsert_graded_context(graded_contexts, variant_key="holofoil", variant_label="Holofoil", price=graded_price)
        entries = graded_contexts["graders"]["PSA"]["10"]
        self.assertEqual(len(entries), 1)
        self.assertEqual(
            _graded_context_key(entries[0]),
            ("Holofoil", 0, 0, 0),
        )

        variant_payloads = [
            {"name": "normal", "prices": [price]},
            {"name": "holofoil", "prices": [graded_price]},
        ]
        raw_buckets, graded_buckets, raw_count, graded_count, display_currency = _contexts_from_variant_payloads(variant_payloads)
        self.assertEqual(raw_count, 1)
        self.assertEqual(graded_count, 1)
        self.assertEqual(display_currency, "USD")
        self.assertIn("Normal", raw_buckets["variants"])
        self.assertIn("PSA", graded_buckets["graders"])

        raw_buckets2, graded_buckets2, raw_count2, graded_count2, _ = _contexts_from_price_history_entry([
            {**price, "variant": "normal"},
            {**graded_price, "variant": "holofoil"},
        ])
        self.assertEqual(raw_count2, 1)
        self.assertEqual(graded_count2, 1)
        self.assertIn("Normal", raw_buckets2["variants"])
        self.assertIn("PSA", graded_buckets2["graders"])

    def test_slab_query_helpers_and_best_graded_price_cover_variant_hints(self) -> None:
        self.assertEqual(_scrydex_slab_title_clauses("Mew Black Star Promo"), ['name:"Mew Black Star Promo"', "name:mew name:black name:star name:promo"])
        self.assertEqual(_scrydex_slab_number_queries("No. 009"), ['number:"NO009"', 'printed_number:"NO009"'])
        self.assertEqual(
            _scrydex_expansion_scopes(["black-star-promos", "sv6_ja", "Space Juggler"]),
            ["expansion.code:black-star-promos", "expansion.id:sv6_ja", 'expansion.name:"Space Juggler"'],
        )

        payload = {
            "data": {
                "id": "basep-9",
                "variants": [
                    {
                        "name": "Unlimited Holofoil",
                        "prices": [
                            {"type": "graded", "company": "PSA", "grade": "9", "currency": "USD", "market": 150.0},
                        ],
                    },
                    {
                        "name": "First Edition Shadowless",
                        "prices": [
                            {"type": "graded", "company": "PSA", "grade": "9", "currency": "USD", "market": 300.0},
                        ],
                    },
                ],
            },
        }

        variant_name, price = _best_scrydex_graded_price(
            payload,
            grader="PSA",
            grade="9",
            preferred_variant="First Edition Shadowless",
            variant_hints={"firstEdition": True, "shadowless": True},
        ) or (None, None)

        self.assertEqual(variant_name, "First Edition Shadowless")
        self.assertEqual(price["market"], 300.0)

    def test_scrydex_api_request_covers_success_and_error_audit_paths(self) -> None:
        request_entry = {"sequence": 7, "timestamp": "2026-05-05T00:00:00Z"}
        audit_calls: list[dict[str, object]] = []
        log_calls: list[dict[str, object]] = []

        class _FakeResponse:
            def __enter__(self):
                return self

            def __exit__(self, exc_type, exc, tb) -> bool:
                return False

            def read(self) -> bytes:
                return b'{"data":[{"id":"base1-4"}]}'

        def _capture_log(**kwargs: object) -> None:
            log_calls.append(kwargs)

        def _capture_audit(**kwargs: object) -> None:
            audit_calls.append(kwargs)

        with (
            patch.object(scrydex_adapter_module, "scrydex_credentials", return_value=("api-key", "team-id")),
            patch.object(scrydex_adapter_module, "_record_scrydex_request", return_value=request_entry),
            patch.object(scrydex_adapter_module, "_log_scrydex_request_line", side_effect=_capture_log),
            patch.object(scrydex_adapter_module, "store_scrydex_request_audit", side_effect=_capture_audit),
            patch.object(scrydex_adapter_module, "urlopen", return_value=_FakeResponse()),
        ):
            payload = scrydex_api_request("/pokemon/v1/cards", request_type="raw_search", q="charizard", page_size="5")

        self.assertEqual(payload["data"][0]["id"], "base1-4")
        self.assertEqual(log_calls[0]["phase"], "ok")
        self.assertEqual(audit_calls[0]["outcome"], "ok")
        self.assertEqual(audit_calls[0]["result_count"], 1)

        audit_calls.clear()
        log_calls.clear()
        with (
            patch.object(scrydex_adapter_module, "scrydex_credentials", return_value=("api-key", "team-id")),
            patch.object(scrydex_adapter_module, "_record_scrydex_request", return_value=request_entry),
            patch.object(scrydex_adapter_module, "_log_scrydex_request_line", side_effect=_capture_log),
            patch.object(scrydex_adapter_module, "store_scrydex_request_audit", side_effect=_capture_audit),
            patch.object(scrydex_adapter_module, "urlopen", side_effect=RuntimeError("network down")),
        ):
            with self.assertRaisesRegex(RuntimeError, "network down"):
                scrydex_api_request("/pokemon/v1/cards", request_type="raw_search", q="charizard")

        self.assertEqual(log_calls[0]["phase"], "error")
        self.assertEqual(audit_calls[0]["outcome"], "error")
        self.assertEqual(audit_calls[0]["error_text"], "network down")

    def test_search_remote_scrydex_raw_candidates_handles_retryable_query_attempts_and_dedupes(self) -> None:
        evidence = make_raw_evidence(
            title_text_primary="Charizard",
            collector_number_exact="4/102",
            trusted_set_hint_tokens=("base1",),
            recognized_tokens=("charizard", "rocket", "promo"),
        )
        signals = SimpleNamespace()
        captured_queries: list[str] = []

        def _run_cards_query(query: str, *, include_prices: bool, page_size: int, request_type: str):
            captured_queries.append(query)
            if len(captured_queries) == 1:
                raise RuntimeError("transient search failure")
            return [
                {"id": "base1-4", "name": "Charizard"},
                {"id": "base1-4", "name": "Charizard duplicate"},
                {"id": "base1-2", "name": "Blastoise"},
            ]

        with (
            patch.object(scrydex_adapter_module, "build_raw_retrieval_plan", return_value=SimpleNamespace(routes={"title_collector", "broad_text_fallback"})),
            patch.object(scrydex_adapter_module, "_scrydex_run_cards_query", side_effect=_run_cards_query),
            patch.object(scrydex_adapter_module, "raw_evidence_looks_japanese", return_value=False),
        ):
            result = search_remote_scrydex_raw_candidates(evidence, signals, page_size=5)

        self.assertEqual(len(captured_queries), 2)
        self.assertIn('printed_number:"4/102" expansion.code:base1', captured_queries[0])
        self.assertIn('name:"Charizard" printed_number:"4/102"', captured_queries[1])
        self.assertEqual(result.attempts[0]["error"], "transient search failure")
        self.assertEqual(result.attempts[1]["count"], 3)
        self.assertEqual([card["id"] for card in result.cards], ["base1-4", "base1-2"])

    def test_scrydex_provider_refresh_paths_cover_success_errors_and_missing_pricing(self) -> None:
        provider = ScrydexProvider()

        with patch.object(scrydex_adapter_module, "scrydex_credentials", return_value=("api-key", "team-id")):
            self.assertTrue(provider.is_ready())
            self.assertTrue(provider.get_metadata().is_ready)

        with patch.object(scrydex_adapter_module, "scrydex_credentials", return_value=None):
            self.assertFalse(provider.is_ready())

        with (
            patch.object(scrydex_adapter_module, "fetch_scrydex_card_by_id", return_value={"id": "base1-4"}),
            patch.object(scrydex_adapter_module, "persist_scrydex_raw_snapshot", return_value={"id": "base1-4"}),
        ):
            raw_success = provider.refresh_raw_pricing(None, "base1-4")
        self.assertTrue(raw_success.success)
        self.assertEqual(raw_success.provider_id, "scrydex")

        with patch.object(scrydex_adapter_module, "fetch_scrydex_card_by_id", side_effect=RuntimeError("fetch failed")):
            raw_failure = provider.refresh_raw_pricing(None, "base1-4")
        self.assertFalse(raw_failure.success)
        self.assertEqual(raw_failure.error, "fetch failed")

        with (
            patch.object(scrydex_adapter_module, "fetch_scrydex_card_by_id", return_value={"id": "base1-4"}),
            patch.object(scrydex_adapter_module, "persist_scrydex_raw_snapshot", return_value=None),
        ):
            raw_missing = provider.refresh_raw_pricing(None, "base1-4")
        self.assertFalse(raw_missing.success)
        self.assertIn("No raw pricing available", raw_missing.error or "")

        with (
            patch.object(scrydex_adapter_module, "fetch_scrydex_card_by_id", return_value={"id": "base1-4"}),
            patch.object(scrydex_adapter_module, "persist_scrydex_psa_snapshot", return_value={"id": "base1-4"}),
        ):
            psa_success = provider.refresh_psa_pricing(None, "base1-4", "PSA", "9", preferred_variant="Holofoil")
        self.assertTrue(psa_success.success)
        self.assertEqual(psa_success.grader, "PSA")
        self.assertEqual(psa_success.grade, "9")

        with patch.object(scrydex_adapter_module, "fetch_scrydex_card_by_id", side_effect=RuntimeError("psa fetch failed")):
            psa_failure = provider.refresh_psa_pricing(None, "base1-4", "PSA", "9")
        self.assertFalse(psa_failure.success)
        self.assertEqual(psa_failure.error, "psa fetch failed")

        with (
            patch.object(scrydex_adapter_module, "fetch_scrydex_card_by_id", return_value={"id": "base1-4"}),
            patch.object(scrydex_adapter_module, "persist_scrydex_psa_snapshot", return_value=None),
        ):
            psa_missing = provider.refresh_psa_pricing(None, "base1-4", "PSA", "9")
        self.assertFalse(psa_missing.success)
        self.assertIn("No graded pricing available", psa_missing.error or "")


if __name__ == "__main__":
    unittest.main()
