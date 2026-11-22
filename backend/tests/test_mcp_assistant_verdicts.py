"""Marketable assistant features (docs/assistant-marketable-features-plan-2026-11-21.md):
grading scenarios + fee table, check_deal, compare_trade, collection actions, move route."""

from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

BACKEND_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_ROOT.parent
for path in (BACKEND_ROOT, BACKEND_ROOT / "tests"):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

from test_mcp_chat_data_fixes import ChatFixCase  # noqa: E402
from test_mcp_tools import USER_A, _days_ago  # noqa: E402
from catalog_tools import apply_schema, connect, replace_slab_recent_sales_cache, upsert_catalog_card  # noqa: E402
from mcp_server import grading_fees  # noqa: E402
from mcp_server.assistant import verdicts  # noqa: E402
from mcp_server.assistant.engine import correct_tool_arguments, question_asking_usd  # noqa: E402
from mcp_server.assistant.tools import AssistantToolbox  # noqa: E402

FEES_JSON = {
    "as_of": "2026-11-21",
    "shipping_usd": 20.0,
    "graders": {
        "PSA": {
            "tiers": [
                {"id": "standard", "name": "Standard", "price_usd": 59.99, "max_declared_value_usd": 1000, "available": True},
                {"id": "priority", "name": "Priority", "price_usd": 79.99, "max_declared_value_usd": 1500, "available": True},
            ],
            "return_shipping": {"domestic_cards_up_to_2000_insured_usd": {"1-4": 19.99}},
            "other_tiers": [{"id": "value", "price_usd": None, "available": False}],
        },
        "CGC": {"tiers": [
            {"id": "bulk", "name": "Bulk", "price_usd": 17.0, "max_declared_value_usd": 500, "min_cards": 25, "available": True},
            {"id": "economy", "name": "Economy", "price_usd": 20.0, "max_declared_value_usd": 1000, "available": True},
        ]},
    },
}


class FeeTableTests(unittest.TestCase):
    def test_missing_file_falls_back_to_labelled_placeholder(self) -> None:
        with mock.patch.dict(os.environ, {grading_fees.FEES_PATH_ENV: "/nonexistent/grading_fees.json"}):
            table = grading_fees.load_fee_table()
        self.assertTrue(table.placeholder)
        self.assertIsNotNone(table.fee_for("PSA", 200))

    def test_json_tiers_caps_minimums_and_return_shipping(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "fees.json"
            path.write_text(json.dumps(FEES_JSON))
            with mock.patch.dict(os.environ, {grading_fees.FEES_PATH_ENV: str(path)}):
                table = grading_fees.load_fee_table()
        self.assertFalse(table.placeholder)
        self.assertEqual(table.as_of, "2026-11-21")
        self.assertEqual(table.fee_for("PSA", 900).fee_usd, 59.99)
        self.assertEqual(table.fee_for("PSA", 1450).name, "Priority")
        self.assertEqual(table.fee_for("CGC", 100).name, "Economy")  # bulk needs 25 cards
        self.assertEqual(table.shipping_for("PSA", 900), 19.99)
        self.assertEqual(table.shipping_for("CGC", 900), 20.0)

    def test_repo_fee_file_parses(self) -> None:
        if not grading_fees.FEES_PATH.exists():
            self.skipTest("data/grading_fees.json not present")
        table = grading_fees.parse_table(json.loads(grading_fees.FEES_PATH.read_text()))
        self.assertIsNotNone(table)
        self.assertIn("PSA", table.graders)


class BandTests(unittest.TestCase):
    def test_deal_bands(self) -> None:
        self.assertEqual(verdicts.deal_verdict(90.0), "good_buy")
        self.assertEqual(verdicts.deal_verdict(100.0), "fair")
        self.assertEqual(verdicts.deal_verdict(105.1), "above_market")
        self.assertEqual(verdicts.deal_verdict(None), "unknown")
        self.assertEqual(verdicts.deal_verdict(80.0, "selling"), "strong_offer")
        self.assertEqual(verdicts.deal_verdict(70.0, "selling"), "typical_offer")
        self.assertEqual(verdicts.deal_verdict(50.0, "selling"), "low_offer")

    def test_trade_bands(self) -> None:
        self.assertEqual(verdicts.trade_gap(100, 96), (-4.0, 4.0))
        self.assertEqual(verdicts.trade_verdict(100, 96), "fair")
        self.assertEqual(verdicts.trade_verdict(100, 90), "slightly_uneven")
        self.assertEqual(verdicts.trade_verdict(100, 80), "uneven")

    def test_asking_price_from_question(self) -> None:
        self.assertEqual(question_asking_usd("They want $250 for this, good deal?"), 250.0)
        self.assertIsNone(question_asking_usd("$5 each for these"))
        self.assertIsNone(question_asking_usd("$5 or $10?"))
        args = correct_tool_arguments("check_deal", {"cards": [], "asking_total_usd": None}, "is $1,200 fair?")
        self.assertEqual(args["asking_total_usd"], 1200.0)


class VerdictToolCase(ChatFixCase):
    def _seed(self) -> None:
        self.any_card("xy5-54", "Kyogre-EX", set_name="Primal Clash", set_code="xy5", number="54/160")
        self.main_price("xy5-54", 100.0, variant="Holofoil")
        replace_slab_recent_sales_cache(
            self.conn, card_id="xy5-54", grader="PSA", grade="10", source="ebay",
            sales=[{"sourceSaleID": "k1", "title": "Kyogre EX Primal Clash 54/160 PSA 10", "price": 400.0,
                    "currencyCode": "USD", "soldAt": _days_ago(4)}],
        )
        self.any_card("lugia", "Lugia", number="9")
        self.main_price("lugia", 50.0, variant="Holofoil")
        self.cell("lugia", 0, 250.0, lane="graded", grader="PSA", grade="10", variant="holofoil")
        self.cell("lugia", 0, 90.0, lane="graded", grader="PSA", grade="9", variant="holofoil")
        self.cell("lugia", 0, 60.0, lane="graded", grader="PSA", grade="8", variant="holofoil")
        self.any_card("nopr", "Unpriced Thing", number="7")
        self.any_card("char-a", "Charizard", set_name="Base", set_code="base1", number="4")
        self.main_price("char-a", 300.0)
        self.any_card("char-b", "Charizard", set_name="Jungle", set_code="jun", number="5")
        self.main_price("char-b", 30.0)
        self.collection("col-main", USER_A, "Main Collection")
        self.collection("col-grade", USER_A, "Grading pile")
        self.holding("h1", USER_A, "xy5-54", quantity=2, collection_id="col-main")
        self.conn.commit()

    def toolbox(self) -> AssistantToolbox:
        return AssistantToolbox(self.tools)


class GradingScenarioTests(VerdictToolCase):
    def test_scenarios_net_of_fee_and_shipping(self) -> None:
        with mock.patch.dict(os.environ, {grading_fees.FEES_PATH_ENV: "/nonexistent.json"}):
            outcome = self.toolbox().run("grading_upside", {"card_ids": ["lugia"]}, owner_user_id=USER_A)
        self.assertFalse(outcome.is_error, outcome.content)
        card = outcome.content["cards"][0]
        rows = {row["grade"]: row for row in card["scenarios"]}
        self.assertEqual([row["grade"] for row in card["scenarios"]], ["10", "9", "8"])
        fee, ship = rows["10"]["fee_usd"], rows["10"]["shipping_usd"]
        self.assertAlmostEqual(rows["10"]["net_usd"], round(250.0 - 50.0 - fee - ship, 2))
        self.assertLess(rows["9"]["net_usd"], 0)
        self.assertEqual(card["break_even"], {"PSA": "10"})
        self.assertEqual(card["recommendation"], "grade_if_confident_10")
        self.assertTrue(outcome.content["fees"]["placeholder"])
        self.assertEqual(outcome.verdict["kind"], "grading")
        self.assertEqual(len(outcome.verdict["cards"][0]["scenarios"]), 3)

    def test_bgs_rows_only_with_a_comp(self) -> None:
        outcome = self.toolbox().run("grading_upside", {"card_ids": ["lugia"], "graders": ["PSA", "BGS"]},
                                     owner_user_id=USER_A)
        graders = {row["grader"] for row in outcome.content["cards"][0]["scenarios"]}
        self.assertEqual(graders, {"PSA"})


class CheckDealTests(VerdictToolCase):
    def deal(self, **args):
        args.setdefault("asking_total_usd", None)
        args.setdefault("side", None)
        return self.toolbox().run("check_deal", args, owner_user_id=USER_A)

    def test_lot_total_split_and_verdict(self) -> None:
        outcome = self.deal(cards=[{"card_id": "xy5-54"}, {"card_id": "lugia"}], asking_total_usd=120.0)
        content = outcome.content
        self.assertEqual((content["market_usd"], content["asking_usd"], content["pct_of_market"]), (150.0, 120.0, 80.0))
        self.assertEqual(content["verdict"], "good_buy")
        self.assertEqual(content["good_buy_up_to_usd"], 135.0)
        self.assertEqual([item["asking_usd"] for item in content["items"]], [80.0, 40.0])
        self.assertEqual(outcome.verdict["kind"], "deal")
        self.assertEqual({ref["card_id"] for ref in outcome.cards}, {"xy5-54", "lugia"})

    def test_extreme_asks_and_selling_side(self) -> None:
        self.assertEqual(self.deal(cards=[{"card_id": "xy5-54"}], asking_total_usd=100000).content["verdict"],
                         "above_market")
        sold = self.deal(cards=[{"card_id": "xy5-54"}], asking_total_usd=85, side="selling").content
        self.assertEqual(sold["verdict"], "strong_offer")

    def test_unpriced_card_is_unknown(self) -> None:
        content = self.deal(cards=[{"card_id": "nopr"}], asking_total_usd=50).content
        self.assertEqual(content["verdict"], "unknown")
        self.assertIsNone(content["market_usd"])
        self.assertEqual(content["unpriced"], ["Unpriced Thing"])

    def test_scanned_cards_are_the_default(self) -> None:
        from mcp_server.assistant.direct_add import TurnWrites

        turn = TurnWrites(client_message_id=None, question="$1 for this?", context_card_ids=("xy5-54",))
        outcome = self.toolbox().run("check_deal", {"cards": [], "asking_total_usd": 1, "side": None},
                                     owner_user_id=USER_A, turn=turn)
        self.assertEqual(outcome.content["verdict"], "good_buy")

    def test_slab_uses_graded_comp_and_solds(self) -> None:
        item = {"card_id": "xy5-54", "grader": "PSA", "grade": "10"}
        content = self.deal(cards=[item], asking_total_usd=300).content
        self.assertEqual(content["market_usd"], 400.0)
        self.assertEqual(content["items"][0]["solds"]["count"], 1)

    def test_ambiguous_name_asks_which(self) -> None:
        outcome = self.deal(cards=[{"name": "Charizard"}], asking_total_usd=100)
        self.assertEqual(outcome.content["verdict"], "unknown")
        self.assertIn("Which Charizard", outcome.content["ask_which"])
        self.assertIsNone(outcome.verdict)
        self.assertEqual({ref["card_id"] for ref in outcome.cards}, {"char-a", "char-b"})

    def test_needs_a_price(self) -> None:
        self.assertTrue(self.deal(cards=[{"card_id": "xy5-54"}]).is_error)


class CompareTradeTests(VerdictToolCase):
    def test_totals_gap_verdict_and_cash_fix(self) -> None:
        outcome = self.toolbox().run(
            "compare_trade",
            {"side_a": [{"card_id": "xy5-54"}], "side_b": [{"card_id": "lugia", "quantity": 2}, {"card_id": "char-b"}]},
            owner_user_id=USER_A,
        )
        content = outcome.content
        self.assertEqual((content["side_a"]["total_usd"], content["side_b"]["total_usd"]), (100.0, 130.0))
        self.assertEqual((content["gap_usd"], content["gap_pct"], content["favors"]), (30.0, 23.1, "you"))
        self.assertEqual(content["verdict"], "uneven")
        self.assertEqual(content["balance"]["who_adds"], "you")
        self.assertEqual(content["balance"]["cash_usd"], 30.0)
        self.assertEqual(outcome.verdict["kind"], "trade")

    def test_unpriced_side_has_no_total(self) -> None:
        content = self.toolbox().run(
            "compare_trade", {"side_a": [{"card_id": "xy5-54"}], "side_b": [{"card_id": "nopr"}]}, owner_user_id=USER_A
        ).content
        self.assertEqual(content["verdict"], "unknown")
        self.assertIsNone(content["side_b"]["total_usd"])
        self.assertEqual(content["side_b"]["unpriced_count"], 1)


class CollectionActionTests(VerdictToolCase):
    def test_list_and_proposals_never_write(self) -> None:
        box = self.toolbox()
        listed = box.run("list_my_collections", {}, owner_user_id=USER_A).content
        self.assertEqual([c["name"] for c in listed["collections"]], ["Main Collection", "Grading pile"])
        removal = box.run("propose_remove_holding", {"holding_id": "h1", "quantity": 1}, owner_user_id=USER_A)
        self.assertEqual(removal.action["type"], "remove_holding")
        self.assertIn("Remove 1 of 2", removal.action["summary"])
        self.assertEqual(removal.action["params"]["remaining_quantity"], 1)
        move = box.run("propose_move_holding", {"holding_id": "h1", "collection_id": "col-grade", "quantity": None},
                       owner_user_id=USER_A)
        self.assertEqual(move.action["params"]["quantity"], 2)
        self.assertIn("to Grading pile", move.action["summary"])
        same = box.run("propose_move_holding", {"holding_id": "h1", "collection_id": "col-main", "quantity": None},
                       owner_user_id=USER_A)
        self.assertTrue(same.is_error)
        create = box.run("propose_create_collection", {"name": "Show stock", "holding_ids": ["h1"]}, owner_user_id=USER_A)
        self.assertEqual(create.action["params"], {"name": "Show stock", "holding_ids": ["h1"]})
        self.assertEqual(self.conn.execute("SELECT quantity FROM deck_entries WHERE id='h1'").fetchone()[0], 2)
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM collections").fetchone()[0], 2)


class MoveDeckEntryTests(unittest.TestCase):
    def setUp(self) -> None:
        from server import SpotlightScanService

        self.tempdir = tempfile.TemporaryDirectory()
        path = Path(self.tempdir.name) / "move.sqlite"
        conn = connect(path)
        apply_schema(conn, BACKEND_ROOT / "schema.sql")
        upsert_catalog_card(conn, {"id": "sv5k-88", "name": "Grimer", "setName": "Wild Force", "number": "088",
                                   "setId": "sv5k"}, REPO_ROOT, "2026-06-17T00:00:00Z", refresh_embeddings=False)
        conn.commit()
        conn.close()
        self.service = SpotlightScanService(path, REPO_ROOT)
        self.target = self.service.create_collection({"name": "Grading pile"})["collection"]["id"]
        self.service.create_deck_entry({"cardID": "sv5k-88", "selectionSource": "manual_search", "quantity": 3,
                                        "addedAt": "2026-06-17T07:27:30Z"})
        self.entry = str(self.service.connection.execute("SELECT id FROM deck_entries").fetchone()[0])

    def tearDown(self) -> None:
        self.service.connection.close()
        self.tempdir.cleanup()

    def rows(self):
        return sorted(
            (str(r["collection_id"]) == self.target, int(r["quantity"]))
            for r in self.service.connection.execute("SELECT collection_id, quantity FROM deck_entries").fetchall()
        )

    def test_partial_then_rest_merges(self) -> None:
        result = self.service.move_deck_entry({"deckEntryID": self.entry, "collectionID": self.target, "quantity": 1})
        self.assertEqual(result["movedQuantity"], 1)
        self.assertEqual(self.rows(), [(False, 2), (True, 1)])
        self.service.move_deck_entry({"deckEntryID": self.entry, "collectionID": self.target})
        self.assertEqual(self.rows(), [(True, 3)])

    def test_rejects_same_collection_and_bad_quantity(self) -> None:
        self.service.move_deck_entry({"deckEntryID": self.entry, "collectionID": self.target})
        with self.assertRaises(ValueError):
            self.service.move_deck_entry({"deckEntryID": self.entry, "collectionID": self.target})
        with self.assertRaises(FileNotFoundError):
            self.service.move_deck_entry({"deckEntryID": "nope", "collectionID": self.target})


if __name__ == "__main__":
    unittest.main()


class VerdictTurnTests(unittest.TestCase):
    """check_deal through the HTTP turn: the reply and the stored message carry the verdict card."""

    def test_deal_verdict_reaches_reply_and_history(self) -> None:
        from test_mcp_assistant import AssistantCase, message, text, tool_use

        class Case(AssistantCase):
            def runTest(self) -> None:  # noqa: N802
                pass

        case = Case()
        case.setUp()
        self.addCleanup(case.tearDown)
        case.client.queue(message([tool_use("check_deal", {"cards": [], "asking_total_usd": None, "side": None})],
                                  stop_reason="tool_use"))
        case.client.queue(message([text("**Good buy.** $1 is 1% of market for this scanned card.")]))
        response = case.ask("They want $1 for this, good deal?", context={"source": "scanner", "card_ids": ["ssp-1"]})
        self.assertEqual(response.status_code, 200, response.text)
        reply = response.json()["message"]
        self.assertEqual(len(reply["verdicts"]), 1)
        card = reply["verdicts"][0]
        self.assertEqual((card["kind"], card["verdict"], card["asking_usd"]), ("deal", "good_buy", 1.0))
        thread = response.json()["thread_id"]
        from test_mcp_assistant import bearer, USER_A as ASSISTANT_USER

        history = case.http.get(f"/api/v1/assistant/threads/{thread}/messages", headers=bearer(ASSISTANT_USER)).json()
        stored = [m for m in history["messages"] if m["role"] == "assistant"][-1]
        self.assertEqual(stored["verdicts"][0]["verdict"], "good_buy")


class AmountsMatchToolTests(unittest.TestCase):
    def record(self, answer: str, data: dict) -> dict:
        return {"question": "They want $250 for this?", "answer": answer,
                "tool_results": [{"name": "check_deal", "data": data}]}

    def test_amounts_within_tolerance_pass_and_invented_fail(self) -> None:
        from assistant_eval.grading import check_amounts_match_tool

        data = {"asking_usd": 250.0, "market_usd": 287.93, "pct_of_market": 86.8, "items": [{"change_30d_pct": -6.1}]}
        spec = {"tool": "check_deal", "tolerance_pct": 1}
        ok = check_amounts_match_tool(self.record("**Fair.** $250 is **87%** of market ($287.93), down 6.1%.", data), spec)
        self.assertTrue(ok.passed, ok.reason)
        bad = check_amounts_match_tool(self.record("$250 is 87% of market ($300).", data), spec)
        self.assertFalse(bad.passed)
        self.assertIn("$300", bad.reason)
        self.assertTrue(check_amounts_match_tool({"answer": "x"}, spec, known_tools=frozenset()).skipped)
