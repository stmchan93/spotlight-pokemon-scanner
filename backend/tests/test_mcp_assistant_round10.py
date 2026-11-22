"""Eval round 10 (owner hand labels 2026-11-21): plumbing phrases, the unasked market-price
explainer, unasked flat-history narration, set-cost wording, ranked print-language remarks,
stated counts that match the tiles, and every tile named in short replies."""

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

from mcp_server.assistant import length_guard  # noqa: E402

if HAVE_DEPS:
    from mcp_server.assistant.engine import (
        SYSTEM_PROMPT,
        TAP_TO_PICK_TEXT,
        AssistantEngine,
        clean_answer_text,
        ensure_choice_question,
    )
    from mcp_server.assistant.tools import AssistantToolbox

# Answers from the 2026-11-21 labelled run.
L010 = (
    "The most expensive One Piece card in Ekalight is **Rocks.D.Xebec** (The World's Strongest Warriors, OP17-118) "
    "at **$6,100** market price, which is roughly what copies have recently sold for. Ekalight has no graded prices "
    "for One Piece, so there's no graded leader to compare.\n\nThe Near Mint Foil price of Rocks.D.Xebec (The "
    "World's Strongest Warriors #OP17-118) has held at $6,100 from Oct 1 to Nov 19, 2026, with no movement in that span."
)
L012 = (
    "The Near Mint Holofoil price of Charizard ex (151 #199/165) fell 32.6%, from $417.43 on Apr 16, 2026 to $281.34 "
    "on Nov 19, 2026. Ekalight's history only starts Apr 16, so this covers about 7 months, not the full year. "
    "It peaked at $500.42 on May 23."
)
L013 = (
    "I couldn't verify a recent move. Ekalight returned no price history for Charizard ex 199/165 (151, Special "
    "Illustration Rare), so I can't say what changed. Its current Near Mint market price is $281.34."
)
L020 = (
    "You're missing 251 of 252 English Surging Sparks cards, and the full set would cost about $993.80 at current "
    "market prices. The most valuable gaps are Pikachu ex (238/191) at $219.25 and Latias ex (239/191) at $155.99."
)
L026 = (
    "You're missing 84 of the 237 Evolving Skies singles, and the cheapest of them run $0.05 to $0.09 each. "
    "Here are the first 20 by price."
)
L029 = (
    "Here are some cozy sleeping Pokémon: Meowth (Unbroken Bonds 147/214) at $2.37 is the priciest English option, "
    "with Cyndaquil (BREAKthrough 18/162) at $1.14 and Cosmoem (Celebrations 14) at $0.24. Prices are market prices, "
    "roughly what copies have recently sold for."
)
ONE_PIECE = [
    {"card_id": "onepiece~OP11-054", "name": "Nami", "price_usd": 215.64},
    {"card_id": "onepiece~tcgplayer-718692", "name": "Karoo", "price_usd": 4.19},
    {"card_id": "onepiece~OP16-002", "name": "Izo", "price_usd": 0.06},
]
L004 = (
    "Your One Piece collection is worth **$224.08** across 3 cards. Nami (OP11-054, Third Anniversary, Near Mint) "
    "makes up most of that at $215.64."
)


class PlumbingTests(unittest.TestCase):
    def test_ekalight_returned_and_has_no_become_first_person(self) -> None:
        self.assertIn("I have no price history for Charizard ex", length_guard.rewrite_plumbing(L013))
        self.assertEqual(
            length_guard.rewrite_plumbing("Ekalight has no PSA 10 price history for it."),
            "I have no PSA 10 price history for it.",
        )
        self.assertEqual(length_guard.rewrite_plumbing("Ekalight doesn't have a price."), "I don't have a price.")
        self.assertEqual(length_guard.rewrite_plumbing("The search found three printings."), "I found three printings.")
        self.assertEqual(length_guard.rewrite_plumbing("Ekalight couldn't match it."), "I couldn't match it.")

    def test_other_ekalight_mentions_stay(self) -> None:
        for line in ("Ekalight prices are in USD only.", "The most expensive One Piece card in Ekalight is Nami."):
            self.assertEqual(length_guard.rewrite_plumbing(line), line)


class CoverageTests(unittest.TestCase):
    def test_months_covered_and_not_the_full_year(self) -> None:
        for line in ("This covers about 7 months.", "That's not the full year.", "It spans roughly 40 days."):
            self.assertTrue(length_guard.has_coverage_disclosure(line), line)
        out = length_guard.drop_internal_sentences(L012)
        self.assertNotIn("7 months", out)
        self.assertIn("It peaked at $500.42 on May 23.", out)

    def test_dated_moves_are_not_coverage(self) -> None:
        self.assertFalse(length_guard.has_coverage_disclosure("Up 18% over the past 30 days, now $504.48."))


class MarketPriceFillerTests(unittest.TestCase):
    def test_sentence_and_clause_forms_are_dropped(self) -> None:
        out = length_guard.strip_market_price_filler(L029)
        self.assertNotIn("sold for", out)
        self.assertTrue(out.endswith("Cosmoem (Celebrations 14) at $0.24."))
        out = length_guard.strip_market_price_filler(L010)
        self.assertIn("at **$6,100** market price. Ekalight has no graded", out)
        out = length_guard.strip_market_price_filler(
            "The priciest SIR is **Umbreon ex** at $1,138.79. Market price is roughly what copies have recently sold for."
        )
        self.assertEqual(out, "The priciest SIR is **Umbreon ex** at $1,138.79.")
        self.assertEqual(
            length_guard.strip_market_price_filler("Umbreon is $4,999.99. These are raw market prices, roughly recent sale values."),
            "Umbreon is $4,999.99.",
        )

    def test_disclaimer_sentence_and_tcgplayer_tag_stay(self) -> None:
        line = "These are market prices, so they reflect recent sales, not a forecast."
        self.assertEqual(length_guard.strip_market_price_filler(line), line)
        tagged = "Rocks.D.Xebec is $6,100 (TCGplayer market price)."
        self.assertEqual(length_guard.strip_market_price_filler(tagged), tagged)
        self.assertFalse(length_guard.has_internal_wording(tagged))

    def test_only_kept_when_the_question_asks_what_a_price_means(self) -> None:
        self.assertTrue(length_guard.asks_price_meaning("Explain how Ekalight prices my cards"))
        self.assertTrue(length_guard.asks_price_meaning("What does market price mean?"))
        for question in ("What's the most expensive One Piece card?", "Show Kyogre-EX's price history",
                         "How much is Charizard?", "Show me cozy cards with Pokémon sleeping"):
            self.assertFalse(length_guard.asks_price_meaning(question), question)


class UnaskedHistoryTests(unittest.TestCase):
    def test_flat_narration_is_dropped_on_a_ranking_question(self) -> None:
        out = length_guard.drop_unasked_history(L010, "What's the most expensive One Piece card?")
        self.assertNotIn("held at", out)
        self.assertIn("Rocks.D.Xebec", out)

    def test_history_questions_keep_it(self) -> None:
        self.assertEqual(length_guard.drop_unasked_history(L010, "How has Rocks.D.Xebec moved lately?"), L010)

    def test_the_first_sentence_is_never_dropped(self) -> None:
        line = "Nami has held at $215 since Oct 1."
        self.assertEqual(length_guard.drop_unasked_history(line, "What's my priciest One Piece card?"), line)


class SetCostTests(unittest.TestCase):
    def test_full_set_cost_becomes_missing_cards_cost(self) -> None:
        self.assertIn("and the 251 missing cards would cost about $993.80", length_guard.fix_set_cost_wording(L020))
        self.assertEqual(length_guard.fix_set_cost_wording("The full set would cost $50."),
                         "Finishing the set would cost $50.")


class LanguageTests(unittest.TestCase):
    def test_ranked_language_and_parenthetical_go(self) -> None:
        out = length_guard.strip_ranked_language(L029)
        self.assertIn("is the priciest option, with Cyndaquil", out)
        self.assertEqual(length_guard.strip_ranked_language("Mareep (Japanese) is $4.59."), "Mareep is $4.59.")
        line = "The selection includes a Japanese print."
        self.assertEqual(length_guard.strip_ranked_language(line), line)


class ShownCountTests(unittest.TestCase):
    def test_stated_count_follows_the_tiles(self) -> None:
        self.assertTrue(length_guard.fix_shown_count(L026, 12).endswith("Here are the first 12 by price."))
        self.assertEqual(length_guard.fix_shown_count("Here are the top eight under $50:", 5),
                         "Here are the top five under $50:")
        self.assertEqual(length_guard.fix_shown_count("Here are 8 of your 17 Watchlist cards.", 8),
                         "Here are 8 of your 17 Watchlist cards.")
        self.assertEqual(length_guard.stated_shown_counts(L026), [20])

    def test_other_numbers_are_left_alone(self) -> None:
        for line in ("Here are the past 30 days of moves.", "You're missing 84 of 237.", "Here's one to watch."):
            self.assertEqual(length_guard.fix_shown_count(line, 3), line)


class TileNamingTests(unittest.TestCase):
    def test_l004_unnamed_holdings(self) -> None:
        self.assertEqual([t["name"] for t in length_guard.unnamed_tiles(ONE_PIECE, L004)], ["Karoo", "Izo"])
        self.assertEqual(
            length_guard.append_tile_names(L004, ONE_PIECE[1:]),
            L004 + " Also shown: Karoo ($4.19) and Izo ($0.06).",
        )

    def test_question_names_count_and_lists_may_name_some(self) -> None:
        pikachu = [{"card_id": "ssp-1", "name": "Pikachu ex", "price_usd": 120.0}]
        self.assertEqual(length_guard.unnamed_tiles(pikachu, "$120.", "Pikachu ex price?"), [])
        self.assertEqual(length_guard.unnamed_tiles(ONE_PIECE, "Here are three, including Nami."), [])
        self.assertEqual(length_guard.unnamed_tiles(ONE_PIECE * 2, "Nami."), [])  # longer lists are framed
        star = [{"card_id": "ex13-104", "name": "Pikachu ☆", "price_usd": 3200.0}]
        self.assertEqual(length_guard.unnamed_tiles(star, "Pikachu Star is $3,200."), [])


@unittest.skipUnless(HAVE_DEPS, "assistant deps missing")
class CleanAnswerTests(unittest.TestCase):
    def test_l010_reads_clean(self) -> None:
        out = clean_answer_text(L010, "What's the most expensive One Piece card?", ["search_cards", "get_price_history"])
        self.assertEqual(
            out,
            "The most expensive One Piece card in Ekalight is **Rocks.D.Xebec** (The World's Strongest Warriors, "
            "OP17-118) at **$6,100** market price. I have no graded prices for One Piece, so there's no graded leader "
            "to compare.",
        )

    def test_language_kept_when_asked_or_choosing(self) -> None:
        line = "Meowth is the priciest English option."
        self.assertEqual(clean_answer_text(line, "Any English cozy cards?", ["search_cards"]), line)
        self.assertEqual(clean_answer_text(line, "Cozy cards?", ["search_cards"], keep_language=True), line)

    def test_set_cost_only_on_find_missing(self) -> None:
        self.assertEqual(clean_answer_text(L020, "q", ["search_cards"]), L020)

    def test_prompt_rules(self) -> None:
        self.assertIn(TAP_TO_PICK_TEXT, SYSTEM_PROMPT)
        self.assertIn("Gym Heroes, Gym Challenge, and all four Neo sets", SYSTEM_PROMPT)
        self.assertIn("TCGplayer market price", SYSTEM_PROMPT)
        self.assertIn("never \"the full set would cost\"", SYSTEM_PROMPT)
        self.assertIn("sorted by price", SYSTEM_PROMPT)
        self.assertNotIn("say Ekalight has no price", SYSTEM_PROMPT)

    def test_tap_to_pick_counts_as_the_choice_question(self) -> None:
        line = f"There are many Pikachu printings. {TAP_TO_PICK_TEXT}"
        self.assertEqual(ensure_choice_question(line, "Which Pikachu do you mean?"), line)


@unittest.skipUnless(HAVE_DEPS, "anthropic / mcp not installed")
class TileNamingEngineTests(AssistantCase):
    def run_turn(self, answer: str, *extra: Any, question: str = "What's my priciest card?") -> tuple[Any, FakeClient]:
        client = FakeClient([
            message([tool_use("search_cards", {"filter": {"text": "pikachu"}}, "s1")], "tool_use"),
            message([text(answer)]),
            *extra,
        ])
        engine = AssistantEngine(self.config, AssistantToolbox(self.tools), client)
        return asyncio.run(engine.run_turn(owner_user_id=USER_A, history=[], question=question)), client

    def test_rewrite_names_the_tile(self) -> None:
        turn, client = self.run_turn("It's $120.00 right now.", message([text("Pikachu ex is $120.00 right now.")]))
        self.assertEqual([card["name"] for card in turn.cards], ["Pikachu ex"])
        self.assertEqual(turn.text, "Pikachu ex is $120.00 right now.")
        self.assertEqual(turn.tile_naming, "rewrite")
        call = client.messages.calls[-1]
        self.assertIn("Pikachu ex ($120.00)", call["system"])
        self.assertEqual(call["output_config"], {"effort": "low"})

    def test_failed_rewrite_appends_the_names(self) -> None:
        turn, _ = self.run_turn("It's $120.00 right now.", RuntimeError("no rewrite"))
        self.assertEqual(turn.text, "It's $120.00 right now. Also shown: Pikachu ex ($120.00).")
        self.assertEqual(turn.tile_naming, "append")

    def test_rewrite_that_drops_a_number_is_rejected(self) -> None:
        turn, _ = self.run_turn("It's $120.00 right now.", message([text("Pikachu ex is the priciest.")]))
        self.assertEqual(turn.tile_naming, "append")
        self.assertIn("$120.00", turn.text)

    def test_named_tiles_make_no_extra_call(self) -> None:
        turn, client = self.run_turn("Pikachu ex is $120.00 right now.")
        self.assertIsNone(turn.tile_naming)
        self.assertEqual(len(client.messages.calls), 2)

    def test_tap_to_pick_reply_is_not_rewritten(self) -> None:
        answer = f"There are a few Pikachu printings. {TAP_TO_PICK_TEXT}"
        turn, client = self.run_turn(answer, question="Add a card to my collection")
        self.assertEqual(turn.text, answer)
        self.assertEqual(len(client.messages.calls), 2)


if __name__ == "__main__":
    unittest.main()
