from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from http import HTTPStatus
from pathlib import Path
from unittest.mock import Mock, patch

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

import anthropic_adapter  # noqa: E402
import grading_analysis  # noqa: E402
from catalog_tools import apply_schema, connect, upsert_card, upsert_fx_rate_snapshot  # noqa: E402
from grading_analysis import NoGradingData, build_analysis, rules_summary, select_tier  # noqa: E402
from server import SpotlightRequestHandler, SpotlightScanService  # noqa: E402

REPO_ROOT = BACKEND_ROOT.parent
_FRESH = datetime.now(timezone.utc).isoformat()

# Same shape as backend/data/grading_fees.json, with made-up round numbers.
FIXTURE_FEES = {
    "schema_version": 1,
    "as_of": "2026-11-21",
    "shipping_usd": 20.0,
    "graders": {
        "PSA": {
            "source_url": "https://www.psacard.com/pricing",
            "tiers": [
                {"id": "standard", "name": "Standard", "price_usd": 60.0, "max_declared_value_usd": 1000,
                 "turnaround_business_days": "90-100", "available": True},
                {"id": "bulk", "name": "Bulk", "price_usd": 10.0, "max_declared_value_usd": 500,
                 "turnaround_business_days": "120", "available": True, "min_cards": 20},
                {"id": "priority", "name": "Priority", "price_usd": 80.0, "max_declared_value_usd": 1500,
                 "turnaround_business_days": "70-80", "available": True},
                {"id": "express", "name": "Express", "price_usd": 200.0, "max_declared_value_usd": 2500,
                 "turnaround_business_days": "20-30", "available": True},
            ],
            "other_tiers": [
                {"id": "value", "name": "Value", "price_usd": 40.0, "max_declared_value_usd": 500, "available": False},
            ],
            "return_shipping": {
                "domestic_cards_up_to_2000_insured_usd": {"1-4": 20.0, "5-9": 25.0},
                "domestic_cards_up_to_12500_insured_usd": {"1-4": 35.0, "5-9": 40.0},
            },
        },
    },
}


class FeeFixtureMixin:
    """Points the loader at a temp fee file for each test."""

    fees: dict = FIXTURE_FEES

    def setUp(self) -> None:  # noqa: D401
        self._fee_dir = tempfile.TemporaryDirectory()
        self.fee_path = Path(self._fee_dir.name) / "grading_fees.json"
        self.fee_path.write_text(json.dumps(self.fees), encoding="utf-8")
        self._fee_env = patch.dict(os.environ, {"SPOTLIGHT_GRADING_FEES_PATH": str(self.fee_path),
                                                "GRADING_SHIPPING_USD": ""})
        self._fee_env.start()
        super().setUp()  # type: ignore[misc]

    def tearDown(self) -> None:
        super().tearDown()  # type: ignore[misc]
        self._fee_env.stop()
        self._fee_dir.cleanup()


def _fees() -> grading_analysis.PsaFees:
    fees = grading_analysis.parse_psa_fees(FIXTURE_FEES)
    assert fees is not None
    return fees


def _analysis(raw: float, prices: dict[str, float]) -> dict:
    return build_analysis(
        card_id="c1", variant=None, raw_price_usd=raw, grade_prices_usd=prices,
        prices_as_of=None, fees=_fees(),
    )


class FeeFileTests(FeeFixtureMixin, unittest.TestCase):
    def test_parses_open_single_card_tiers_only(self) -> None:
        fees = grading_analysis.load_psa_fees()
        self.assertEqual([t["name"] for t in fees.tiers], ["Standard", "Priority", "Express"])
        self.assertEqual(fees.tiers[0]["turnaroundText"], "~90–100 business days")
        self.assertEqual(fees.as_of, "2026-11-21")
        self.assertEqual(fees.source_url, "https://www.psacard.com/pricing")
        self.assertEqual(fees.return_fees, ((2000.0, 20.0), (12500.0, 35.0)))

    def test_loaded_once_per_file_version(self) -> None:
        with patch.object(grading_analysis, "parse_psa_fees", wraps=grading_analysis.parse_psa_fees) as parse:
            grading_analysis._fees_cache = None
            grading_analysis.load_psa_fees()
            grading_analysis.load_psa_fees()
        self.assertEqual(parse.call_count, 1)

    def test_missing_file_is_no_data(self) -> None:
        with patch.dict(os.environ, {"SPOTLIGHT_GRADING_FEES_PATH": str(self.fee_path) + ".missing"}):
            with self.assertRaises(NoGradingData):
                grading_analysis.load_psa_fees()

    def test_invalid_file_is_no_data(self) -> None:
        bad = Path(self._fee_dir.name) / "bad.json"
        bad.write_text("{not json", encoding="utf-8")
        empty = Path(self._fee_dir.name) / "empty.json"
        empty.write_text(json.dumps({"as_of": "x", "shipping_usd": 20, "graders": {"PSA": {"tiers": []}}}), encoding="utf-8")
        for path in (bad, empty):
            with patch.dict(os.environ, {"SPOTLIGHT_GRADING_FEES_PATH": str(path)}):
                with self.assertRaises(NoGradingData):
                    grading_analysis.load_psa_fees()

    def test_real_repo_fee_file_parses(self) -> None:
        fees = grading_analysis.parse_psa_fees(json.loads((BACKEND_ROOT / "data" / "grading_fees.json").read_text()))
        self.assertIsNotNone(fees)
        self.assertTrue(all(t["feeUsd"] > 0 for t in fees.tiers))
        self.assertNotIn("Value", [t["name"] for t in fees.tiers])


class TierSelectionTests(FeeFixtureMixin, unittest.TestCase):
    def test_cap_boundaries(self) -> None:
        fees = _fees()
        self.assertEqual(select_tier(fees, 10.0)["name"], "Standard")  # Bulk needs 20 cards, Value is paused
        self.assertEqual(select_tier(fees, 1000.0)["name"], "Standard")
        self.assertEqual(select_tier(fees, 1000.01)["name"], "Priority")
        self.assertEqual(select_tier(fees, 1500.0)["name"], "Priority")
        self.assertEqual(select_tier(fees, 2500.0)["name"], "Express")

    def test_above_every_cap_uses_highest_tier(self) -> None:
        self.assertEqual(select_tier(_fees(), 9000.0)["name"], "Express")

    def test_null_cap_is_unlimited(self) -> None:
        raw = json.loads(json.dumps(FIXTURE_FEES))
        raw["graders"]["PSA"]["tiers"].append({"name": "Top", "price_usd": 500.0, "max_declared_value_usd": None})
        fees = grading_analysis.parse_psa_fees(raw)
        self.assertEqual(select_tier(fees, 9000.0)["name"], "Top")
        self.assertEqual(select_tier(fees, 100.0)["name"], "Standard")

    def test_tier_follows_psa10_price(self) -> None:
        result = _analysis(100.0, {"10": 1200.0, "9": 300.0})
        self.assertEqual(result["tier"]["name"], "Priority")
        self.assertEqual(result["tier"]["feeUsd"], 80.0)
        self.assertEqual(result["tier"]["valueCapUsd"], 1500.0)
        self.assertEqual(result["tier"]["turnaroundText"], "~70–80 business days")

    def test_shipping_is_inbound_plus_return_fee(self) -> None:
        fees = _fees()
        self.assertEqual(grading_analysis.shipping_usd(fees, 500.0), 40.0)
        self.assertEqual(grading_analysis.shipping_usd(fees, 2000.01), 55.0)
        self.assertEqual(grading_analysis.shipping_usd(fees, 50000.0), 55.0)
        no_return = grading_analysis.parse_psa_fees({**FIXTURE_FEES, "graders": {"PSA": {
            **FIXTURE_FEES["graders"]["PSA"], "return_shipping": None}}})
        self.assertEqual(grading_analysis.shipping_usd(no_return, 500.0), 20.0)

    def test_shipping_env_override(self) -> None:
        with patch.dict(os.environ, {"GRADING_SHIPPING_USD": "30"}):
            self.assertEqual(grading_analysis.shipping_usd(_fees(), 500.0), 30.0)
        with patch.dict(os.environ, {"GRADING_SHIPPING_USD": "junk"}):
            self.assertEqual(grading_analysis.shipping_usd(_fees(), 500.0), 40.0)


class MathAndVerdictTests(FeeFixtureMixin, unittest.TestCase):
    def test_math(self) -> None:
        result = _analysis(50.0, {"10": 400.0, "9": 150.0, "8": 80.0, "7": 60.0})
        self.assertEqual(result["tier"]["name"], "Standard")
        self.assertEqual(result["shippingUsd"], 40.0)
        self.assertEqual(result["totalCostUsd"], 100.0)
        self.assertEqual([o["grade"] for o in result["outcomes"]], ["10", "9", "8", "7"])
        ten = result["outcomes"][0]
        self.assertEqual(ten["netUsd"], 300.0)
        self.assertEqual(ten["gainVsRawUsd"], 250.0)
        nine = result["outcomes"][1]
        self.assertEqual(nine["netUsd"], 50.0)
        self.assertEqual(nine["gainVsRawUsd"], 0.0)
        self.assertFalse(nine["worthIt"])  # exactly break-even is not worth it
        self.assertEqual(result["breakEvenGrade"], "10")
        self.assertEqual(result["currencyCode"], "USD")
        self.assertEqual(result["feesAsOf"], "2026-11-21")
        self.assertEqual(result["feesSourceUrl"], "https://www.psacard.com/pricing")

    def test_worth_it(self) -> None:
        result = _analysis(50.0, {"10": 400.0, "9": 160.0, "8": 90.0})
        self.assertEqual(result["verdict"], "worth_it")
        self.assertEqual(result["breakEvenGrade"], "9")
        self.assertTrue(rules_summary(result).startswith("Worth grading: a PSA 9"))

    def test_only_at_10(self) -> None:
        result = _analysis(50.0, {"10": 400.0, "9": 100.0})
        self.assertEqual(result["verdict"], "only_at_10")
        self.assertEqual(result["breakEvenGrade"], "10")
        self.assertIn("only if you're confident it's a 10", rules_summary(result))

    def test_not_worth_it(self) -> None:
        result = _analysis(50.0, {"10": 120.0, "9": 60.0})
        self.assertEqual(result["verdict"], "not_worth_it")
        self.assertIsNone(result["breakEvenGrade"])
        self.assertTrue(rules_summary(result).startswith("Not worth grading"))

    def test_missing_10_uses_best_grade_and_unpriced_grades_skipped(self) -> None:
        result = _analysis(20.0, {"9": 1200.0, "7": 150.0, "9.5": 900.0})
        self.assertEqual([o["grade"] for o in result["outcomes"]], ["9", "7"])
        self.assertEqual(result["tier"]["name"], "Priority")
        self.assertEqual(result["verdict"], "worth_it")

    def test_no_data_raises(self) -> None:
        with self.assertRaises(NoGradingData):
            _analysis(0.0, {"10": 100.0})
        with self.assertRaises(NoGradingData):
            build_analysis(card_id="c", variant=None, raw_price_usd=None, grade_prices_usd={"10": 1.0}, prices_as_of=None)
        with self.assertRaises(NoGradingData):
            _analysis(10.0, {})


def _graded(prices: dict[str, float], currency: str = "USD") -> str:
    return json.dumps({"graders": {"PSA": {
        grade: [{"grader": "PSA", "grade": grade, "variant": "Normal", "currencyCode": currency, "market": price}]
        for grade, price in prices.items()
    }}})


def _raw(nm: float | None, currency: str = "USD") -> str:
    if nm is None:
        return "{}"
    return json.dumps({"variants": {"Normal": {
        "variant": "Normal", "variantKey": "normal",
        "conditions": {"NM": {"market": nm, "currencyCode": currency}},
    }}})


class ServiceTests(FeeFixtureMixin, unittest.TestCase):
    def setUp(self) -> None:
        super().setUp()
        self.tempdir = tempfile.TemporaryDirectory()
        self.database_path = Path(self.tempdir.name) / "grading.sqlite"
        connection = connect(self.database_path)
        apply_schema(connection, BACKEND_ROOT / "schema.sql")
        connection.close()
        self.service: SpotlightScanService | None = None
        self.env = patch.dict(os.environ, {"ANTHROPIC_API_KEY": "test-key"})
        self.env.start()

    def tearDown(self) -> None:
        self.env.stop()
        if self.service is not None:
            self.service.connection.close()
        self.tempdir.cleanup()
        super().tearDown()

    def _seed(self, *, raw: str, graded: str, currency: str = "USD", fx: bool = False) -> SpotlightScanService:
        connection = connect(self.database_path)
        upsert_card(connection, card_id="c1", name="Pikachu", set_name="Base", number="58",
                    rarity="Common", variant="Raw", language="English", supertype="Pokémon")
        if fx:
            upsert_fx_rate_snapshot(connection, base_currency="JPY", quote_currency="USD", rate=0.0064,
                                    source="ecb", effective_at="2026-11-20", source_url="https://example.test")
        connection.execute(
            """
            INSERT INTO card_price_snapshots (
                card_id, provider, graded_contexts_json, raw_contexts_json, display_currency_code, updated_at
            ) VALUES (?,?,?,?,?,?)
            """,
            ("c1", "scrydex", graded, raw, currency, _FRESH),
        )
        connection.commit()
        connection.close()
        self.service = SpotlightScanService(self.database_path, REPO_ROOT)
        self.service._emit_structured_log = Mock()  # type: ignore[method-assign]
        return self.service

    def _llm(self, text: str = "Worth grading only if you're confident it's a 10. Break-even is PSA 10; expect a long wait.") -> Mock:
        return Mock(return_value={"content": [{"type": "text", "text": text}]})

    def test_end_to_end_ai_summary_and_cache(self) -> None:
        service = self._seed(raw=_raw(50.0), graded=_graded({"10": 400.0, "9": 100.0, "8": 70.0}))
        llm = self._llm()
        with patch.object(anthropic_adapter, "anthropic_messages_request", llm):
            first = service.card_grading_analysis("c1")
            second = service.card_grading_analysis("c1")
        self.assertEqual(llm.call_count, 1)
        self.assertEqual(first, second)
        self.assertEqual(first["summarySource"], "ai")
        self.assertEqual(first["rawPriceUsd"], 50.0)
        self.assertEqual([o["grade"] for o in first["outcomes"]], ["10", "9", "8"])
        self.assertEqual(first["verdict"], "only_at_10")
        self.assertEqual(first["pricesAsOf"], _FRESH)
        payload = llm.call_args.args[0]
        self.assertEqual(payload["model"], "claude-haiku-5-5")
        self.assertIn("Pikachu", payload["messages"][0]["content"])
        logs = [c.args[0] for c in service._emit_structured_log.call_args_list
                if c.args[0].get("event") == "grading_analysis_request"]
        self.assertEqual([log["cacheHit"] for log in logs], [False, True])
        self.assertEqual(logs[0]["summarySource"], "ai")

    def test_llm_failure_falls_back_to_rules(self) -> None:
        service = self._seed(raw=_raw(50.0), graded=_graded({"10": 400.0}))
        with patch.object(anthropic_adapter, "anthropic_messages_request", Mock(side_effect=OSError("boom"))):
            result = service.card_grading_analysis("c1")
        self.assertEqual(result["summarySource"], "rules")
        self.assertTrue(result["summary"].startswith("Worth grading only if"))

    def test_llm_output_with_odds_rejected(self) -> None:
        service = self._seed(raw=_raw(50.0), graded=_graded({"10": 400.0}))
        with patch.object(anthropic_adapter, "anthropic_messages_request",
                          self._llm("Worth it. You have a 40% chance of a 10.")):
            result = service.card_grading_analysis("c1")
        self.assertEqual(result["summarySource"], "rules")

    def test_missing_api_key_uses_rules_without_calling(self) -> None:
        service = self._seed(raw=_raw(50.0), graded=_graded({"10": 400.0}))
        llm = self._llm()
        with patch.dict(os.environ, {"ANTHROPIC_API_KEY": ""}), \
                patch.object(anthropic_adapter, "anthropic_messages_request", llm):
            result = service.card_grading_analysis("c1")
        llm.assert_not_called()
        self.assertEqual(result["summarySource"], "rules")

    def test_missing_fee_file_is_no_content(self) -> None:
        service = self._seed(raw=_raw(50.0), graded=_graded({"10": 400.0}))
        llm = self._llm()
        with patch.dict(os.environ, {"SPOTLIGHT_GRADING_FEES_PATH": str(self.fee_path) + ".missing"}), \
                patch.object(anthropic_adapter, "anthropic_messages_request", llm):
            with self.assertRaises(NoGradingData):
                service.card_grading_analysis("c1")
        llm.assert_not_called()

    def test_unknown_card_returns_none(self) -> None:
        service = self._seed(raw=_raw(50.0), graded=_graded({"10": 400.0}))
        self.assertIsNone(service.card_grading_analysis("nope"))

    def test_no_raw_nm_is_no_content(self) -> None:
        service = self._seed(raw=_raw(None), graded=_graded({"10": 400.0}))
        with self.assertRaises(NoGradingData):
            service.card_grading_analysis("c1")

    def test_no_psa_prices_is_no_content(self) -> None:
        service = self._seed(raw=_raw(50.0), graded=json.dumps({"graders": {}}))
        with self.assertRaises(NoGradingData):
            service.card_grading_analysis("c1")

    def test_non_usd_without_fx_is_no_content(self) -> None:
        # No JPY->USD snapshot: rows stay JPY and are never used.
        service = self._seed(raw=_raw(50.0), graded=_graded({"10": 60000.0}, currency="JPY"))
        with self.assertRaises(NoGradingData):
            service.card_grading_analysis("c1")

    def test_non_usd_converted_like_the_card_page(self) -> None:
        service = self._seed(raw=_raw(50.0), graded=_graded({"10": 60000.0}, currency="JPY"), fx=True)
        with patch.object(anthropic_adapter, "anthropic_messages_request", Mock(side_effect=OSError("x"))):
            result = service.card_grading_analysis("c1")
        self.assertEqual(result["outcomes"][0]["priceUsd"], 384.0)
        self.assertEqual(result["currencyCode"], "USD")


class RouteTests(unittest.TestCase):
    def _handler(self, path: str) -> tuple[SpotlightRequestHandler, dict]:
        handler = SpotlightRequestHandler.__new__(SpotlightRequestHandler)
        handler.path = path
        handler.service = Mock()
        captured: dict = {}

        def write_json(status: HTTPStatus, payload: dict) -> None:
            captured["status"] = status
            captured["payload"] = payload

        handler._write_json = write_json  # type: ignore[method-assign]
        handler._write_no_content = lambda: captured.__setitem__("status", HTTPStatus.NO_CONTENT)  # type: ignore[method-assign]
        return handler, captured

    def test_dispatches_with_variant(self) -> None:
        handler, captured = self._handler("/api/v1/cards/c1/grading-analysis?variant=Holofoil&grader=psa")
        handler.service.card_grading_analysis.return_value = {"cardId": "c1"}
        handler.do_GET()
        handler.service.card_grading_analysis.assert_called_once_with("c1", variant="Holofoil")
        self.assertEqual(captured["status"], HTTPStatus.OK)

    def test_non_psa_grader_is_400(self) -> None:
        handler, captured = self._handler("/api/v1/cards/c1/grading-analysis?grader=CGC")
        handler.do_GET()
        handler.service.card_grading_analysis.assert_not_called()
        self.assertEqual(captured["status"], HTTPStatus.BAD_REQUEST)

    def test_unknown_card_is_404(self) -> None:
        handler, captured = self._handler("/api/v1/cards/nope/grading-analysis")
        handler.service.card_grading_analysis.return_value = None
        handler.do_GET()
        self.assertEqual(captured["status"], HTTPStatus.NOT_FOUND)

    def test_no_data_is_204(self) -> None:
        handler, captured = self._handler("/api/v1/cards/c1/grading-analysis")
        handler.service.card_grading_analysis.side_effect = NoGradingData("none")
        handler.do_GET()
        self.assertEqual(captured["status"], HTTPStatus.NO_CONTENT)


if __name__ == "__main__":
    unittest.main()
