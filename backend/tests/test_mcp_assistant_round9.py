"""Eval round 9: explicit collection mover leaders (with the find_movers price floor
on the % ranking), disclaimer-then-length ordering, the missing-cards tile label, and
no unrequested print-language remarks in art answers."""

from __future__ import annotations

import asyncio
import sys
import unittest
from pathlib import Path
from typing import Any

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT / "tests") not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT / "tests"))

from test_mcp_assistant import HAVE_DEPS, USER_A, AssistantCase, FakeClient, message, text, tool_use  # noqa: E402
from test_mcp_tools import McpToolsCase  # noqa: E402

from mcp_server.assistant import length_guard  # noqa: E402

if HAVE_DEPS:
    from mcp_server.assistant.compact import compact_result
    from mcp_server.assistant.engine import SYSTEM_PROMPT, AssistantEngine
    from mcp_server.assistant.tools import MISSING_LABEL, AssistantToolbox, apply_question_rules, movers_only

# invest_now, eval_10 repeat 2: 84 words against the eval's 80 ("what's a" read as a definition question).
EVAL10_INVEST = (
    "No card is a sure bet, but the **Mega Evolution promo ex cards** are sitting near their lows. Pikachu ex "
    "(ME 107) is at $20.91, its lowest in the period covered, after a high of $400. Espeon ex and Umbreon ex are "
    "also down sharply from their highs. Their price history covers only about 40 to 50 days, so this is a short "
    "look. Market price is roughly what copies have recently sold for. This is a snapshot of past prices, not a "
    "prediction."
)
INVEST_Q = "What's a good card to invest in right now?"
INVEST_TOOLS = ["find_price_lows", "get_market_trends"]
# vibe_sleeping, eval_10 repeats 2 and 3.
EVAL10_SLEEPING = (
    "Here are some cozy sleeping Pokémon: Meowth (Unbroken Bonds 147/214) at $2.37 is the priciest English option, "
    "with Cyndaquil (BREAKthrough 18/162) at $1.14 and Cosmoem (Celebrations 14) at $0.24. Prices are market prices, "
    "roughly what copies have recently sold for."
)
EVAL10_SLEEPING_3 = (
    "Here are five cozy sleeping Pokémon cards, including Meowth (Unbroken Bonds) at $2.37 and Mareep (Japanese) "
    "at $4.59. Prices are market prices, roughly what copies have recently sold for."
)


class PortfolioLeaderTests(McpToolsCase):
    def _seed(self) -> None:
        # Kyogre: the dollar leader. Gyarados: the % leader above the floor. Penny card: +60% on $0.30.
        for card_id, name, start, now in (
            ("bw5-104", "Kyogre-EX", 486.0, 504.48),
            ("base1-6", "Gyarados", 54.6, 62.04),
            ("penny", "Dyna Tree Hill", 0.30, 0.48),
            ("drop", "Falling Card", 20.0, 15.0),
            ("penny-drop", "Penny Drop", 0.50, 0.20),
        ):
            self.card(card_id, name)
            self.price(card_id, now)
            self.history(card_id, [(30, start), (1, now)])
            self.holding(f"h-{card_id}", USER_A, card_id, added_days_ago=400)
        self.conn.commit()

    def test_leaders_are_explicit_and_pct_ranking_has_the_price_floor(self) -> None:
        summary = self.call("get_portfolio_summary", range_key="30d")
        self.assertEqual(summary["top_gainer_by_usd"]["card_id"], "bw5-104")
        self.assertEqual(summary["top_gainer_by_pct"]["card_id"], "base1-6")
        self.assertEqual(summary["top_loser_by_usd"]["card_id"], "drop")
        self.assertEqual(summary["top_loser_by_pct"]["card_id"], "drop")
        self.assertNotIn("penny", [m["card_id"] for m in summary["top_gainers_pct"]])
        self.assertNotIn("penny-drop", [m["card_id"] for m in summary["top_losers_pct"]])
        # The dollar ranking still lists every holding that moved.
        self.assertIn("penny", [m["card_id"] for m in summary["top_gainers"]])
        self.assertIn("$3", summary["movers_basis"])

    @unittest.skipUnless(HAVE_DEPS, "assistant deps missing")
    def test_movers_payload_keeps_compact_leaders(self) -> None:
        summary = self.call("get_portfolio_summary", range_key="30d")
        payload = compact_result("get_portfolio_summary", movers_only(summary), {"focus": "movers"})
        self.assertEqual(payload["top_gainer_by_pct"], {"card_id": "base1-6", "name": "Gyarados",
                                                        "change_usd": 7.44, "change_pct": 13.63})
        self.assertEqual(payload["top_gainer_by_usd"]["card_id"], "bw5-104")
        self.assertNotIn("value_usd", payload)

    @unittest.skipUnless(HAVE_DEPS, "assistant deps missing")
    def test_prompt_names_leaders_only_from_the_leader_fields(self) -> None:
        self.assertIn("top_gainer_by_pct", SYSTEM_PROMPT)


class InvestLengthTests(unittest.TestCase):
    def test_recommendation_on_market_turn_is_not_an_explanation(self) -> None:
        self.assertEqual(length_guard.turn_kind(INVEST_Q, INVEST_TOOLS), "default")
        self.assertEqual(length_guard.limit_for(INVEST_Q, INVEST_TOOLS), 80)
        self.assertEqual(length_guard.turn_kind("What's a SIR?", ["search_cards"]), "explanation")
        self.assertEqual(length_guard.turn_kind("Should I buy Charizard now?", INVEST_TOOLS), "explanation")

    def test_eval10_invest_trims_and_keeps_the_disclaimer(self) -> None:
        self.assertGreater(length_guard.word_count(EVAL10_INVEST), 80)
        trimmed = length_guard.trim_to_limit(EVAL10_INVEST, 80)
        self.assertLessEqual(length_guard.word_count(trimmed), 80)
        self.assertTrue(trimmed.endswith("not a prediction."))


@unittest.skipUnless(HAVE_DEPS, "anthropic / mcp not installed")
class DisclaimerOrderEngineTests(AssistantCase):
    def run_turn(self, answer: str, *extra: Any) -> Any:
        client = FakeClient([
            message([tool_use("find_price_lows", {}, "t1"), tool_use("get_market_trends", {}, "t2")], "tool_use"),
            message([text(answer)]),
            *extra,
        ])
        engine = AssistantEngine(self.config, AssistantToolbox(self.tools), client)
        return asyncio.run(engine.run_turn(owner_user_id=USER_A, history=[], question=INVEST_Q))

    def test_eval10_invest_answer_ends_within_the_limit(self) -> None:
        turn = self.run_turn(EVAL10_INVEST, RuntimeError("no rewrite"))
        self.assertEqual(turn.word_limit, 80)
        self.assertLessEqual(length_guard.word_count(turn.text), 80)
        self.assertIn("not a prediction", turn.text)

    def test_appended_disclaimer_counts_toward_the_limit(self) -> None:
        long = " ".join(f"Card {i} has been sliding for weeks at shows." for i in range(12))
        turn = self.run_turn(long, RuntimeError("no rewrite"))
        self.assertTrue(turn.text.endswith(length_guard.DISCLAIMER_TEXT))
        self.assertLessEqual(length_guard.word_count(turn.text), 80)

    def test_trimmed_model_disclaimer_is_replaced_within_the_limit(self) -> None:
        # "No card is a sure bet" opens the answer; a long body pushes the total over.
        long = "No card is a sure bet. " + " ".join(f"Card {i} has been sliding for weeks." for i in range(14))
        turn = self.run_turn(long, RuntimeError("no rewrite"))
        self.assertFalse(length_guard.needs_disclaimer(turn.text, INVEST_TOOLS))
        self.assertLessEqual(length_guard.word_count(turn.text), 80)

    def test_rewrite_that_drops_the_disclaimer_is_rejected(self) -> None:
        long = " ".join(f"Card {i} has been sliding for weeks." for i in range(14)) + " This is not a prediction."
        turn = self.run_turn(long, message([text("Card 1 has been sliding for weeks.")]))
        self.assertNotEqual(turn.length_guard, "rewrite")
        self.assertIn("not a prediction", turn.text)
        self.assertLessEqual(length_guard.word_count(turn.text), 80)


@unittest.skipUnless(HAVE_DEPS, "assistant deps missing")
class MissingLabelTests(unittest.TestCase):
    TILES = [{"card_id": "sv8-238", "name": "Pikachu ex"}, {"card_id": "sv8-239", "name": "Latias ex"}]

    def rules(self, question: str, label: str | None = None, tools: set[str] = frozenset({"find_missing"})):
        return apply_question_rules(list(self.TILES), [], label, question=question, text="", pool=list(self.TILES),
                                    holding_refs=[], language_pairs={}, tools_used=tools)[2]

    def test_missing_question_gets_the_label(self) -> None:
        self.assertEqual(self.rules("What am I missing from Surging Sparks?"), MISSING_LABEL)

    def test_existing_label_and_cheap_asks_are_kept(self) -> None:
        self.assertEqual(self.rules("What am I missing from 151?", "Chase cards you're missing"),
                         "Chase cards you're missing")
        self.assertIsNone(self.rules("Cheapest cards I'm missing from 151"))
        self.assertIsNone(self.rules("What am I missing under $10?"))
        self.assertIsNone(self.rules("What am I missing?", tools={"search_cards"}))


class ArtLanguageTests(unittest.TestCase):
    def test_language_adjective_and_parenthetical_are_stripped(self) -> None:
        out = length_guard.strip_language_mentions(EVAL10_SLEEPING)
        self.assertIn("at $2.37 is the priciest option, with Cyndaquil", out)
        self.assertFalse(length_guard.has_internal_wording(out, language=True))
        out = length_guard.strip_language_mentions(EVAL10_SLEEPING_3)
        self.assertIn("Mareep at $4.59", out)

    def test_language_only_counts_when_flagged(self) -> None:
        line = "Meowth is the only one printed in Japanese."
        self.assertFalse(length_guard.has_internal_wording(line))
        self.assertTrue(length_guard.has_internal_wording(line, language=True))
        self.assertEqual(length_guard.drop_internal_sentences(f"Meowth is $2.37. {line}", language=True),
                         "Meowth is $2.37.")

    def test_language_questions_allow_language(self) -> None:
        self.assertTrue(length_guard.asks_language("Any Japanese cards with sleeping Pokémon?"))
        self.assertFalse(length_guard.asks_language("Show me cozy cards with Pokémon sleeping"))


@unittest.skipUnless(HAVE_DEPS, "anthropic / mcp not installed")
class ArtLanguageEngineTests(AssistantCase):
    def run_turn(self, question: str, answer: str) -> tuple[Any, FakeClient]:
        client = FakeClient([
            message([tool_use("search_cards", {"filter": {"mood": ["cozy"], "activity": ["sleeping"]}}, "s1")],
                    "tool_use"),
            message([text(answer)]),
            RuntimeError("no rewrite"),
        ])
        engine = AssistantEngine(self.config, AssistantToolbox(self.tools), client)
        return asyncio.run(engine.run_turn(owner_user_id=USER_A, history=[], question=question)), client

    def test_eval10_sleeping_answer_loses_the_language_remark_without_a_rewrite(self) -> None:
        answer = "Meowth (Unbroken Bonds 147/214) at $2.37 is the priciest English option. Cosmoem is $0.24."
        turn, client = self.run_turn("Show me cozy cards with Pokémon sleeping", answer)
        self.assertEqual(turn.text, "Meowth (Unbroken Bonds 147/214) at $2.37 is the priciest option. Cosmoem is $0.24.")
        self.assertEqual(len(client.messages.calls), 2)

    def test_asked_language_is_kept(self) -> None:
        answer = "Meowth (Unbroken Bonds 147/214) at $2.37 is the priciest English option."
        turn, _ = self.run_turn("Show me cozy English cards with Pokémon sleeping", answer)
        self.assertEqual(turn.text, answer)


@unittest.skipUnless(HAVE_DEPS, "assistant deps missing")
class PromptRuleTests(unittest.TestCase):
    def test_final_checks_lead_with_the_overall_leader(self) -> None:
        checks = SYSTEM_PROMPT.split("Final checks before answering:")[1]
        self.assertIn("single priciest card overall", checks)


if __name__ == "__main__":
    unittest.main()
