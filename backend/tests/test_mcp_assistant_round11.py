"""Eval 2026-11-22 (owner-approved fixes): the "N cards aren't counted — no recent price" line on a
collection total, no dangling clause after the market-price filler is cut, per-card bullets on mover
answers, and a pick-a-printing reply that asks for nothing but the tap."""

from __future__ import annotations

import asyncio
import sys
import unittest
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT / "tests") not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT / "tests"))

from test_mcp_assistant import HAVE_DEPS, FakeClient, message, text, tool_use  # noqa: E402
import test_mcp_price_quality as price_quality  # noqa: E402  (module import: its tests aren't re-collected here)
from test_mcp_tools import USER_A  # noqa: E402

from mcp_server.assistant import length_guard  # noqa: E402
from mcp_server.assistant.choice import TAP_HINT, strip_detail_asks, with_tap_hint  # noqa: E402

if HAVE_DEPS:
    from mcp_server.assistant.config import AssistantConfig
    from mcp_server.assistant.engine import SYSTEM_PROMPT, AssistantEngine, NotCounted, ensure_not_counted_line
    from mcp_server.assistant.tools import AssistantToolbox, not_counted_line, with_not_counted

# The 2026-11-22 staging answers, verbatim.
YEN_CUT = (
    "I can't show yen, but Charizard ex (199/165) from 151 is **$279.23** in USD (TCGplayer market price). "
    "That's the Special Illustration Rare printing, and the price is a market price, so it's."
)
YEN_BEFORE_STRIP = YEN_CUT[:-1] + " what copies have recently sold for."
MOVERS_PROSE = (
    "In **Pokémon** Evolving Skies, **Umbreon VMAX** (215/203) dropped the most in dollars over the past 30 days, "
    "down **$129.40** (**5.6%**) to **$2,195.10**. In percentage terms, **Darkness Energy** (236/203) fell the "
    "most, down **16.5%** to **$18.73**."
)
PIKACHU_ASKS = (
    "There are lots of Pikachu printings, so I need you to pick one. Tap a card below to choose the right one, "
    "and tell me the quantity and condition if they're not 1 copy in Near Mint."
)
PIKACHU_ASKS_2 = (
    "There are many Pikachu printings, so I need you to pick one before I add it. Tap a card below to choose the "
    "right one. Tell me the quantity and condition too (Near Mint is the default)."
)


class DanglingClauseTests(unittest.TestCase):
    def test_yen_answer_drops_the_sentence_not_half_of_it(self) -> None:
        out = length_guard.strip_market_price_filler(YEN_BEFORE_STRIP)
        self.assertEqual(
            out,
            "I can't show yen, but Charizard ex (199/165) from 151 is **$279.23** in USD (TCGplayer market price).",
        )

    def test_ends_mid_thought(self) -> None:
        self.assertTrue(length_guard.ends_mid_thought(YEN_CUT))
        self.assertTrue(length_guard.ends_mid_thought("That's the SIR, and it's a market price, so it’s."))
        self.assertTrue(length_guard.ends_mid_thought("It is $5 and the."))
        for whole in ("The SIR is worth it.", "It is **$279.23**.", "Prices are in USD only.", "Tap a card below."):
            self.assertFalse(length_guard.ends_mid_thought(whole), whole)

    def test_clause_cut_that_reads_whole_is_kept(self) -> None:
        self.assertEqual(
            length_guard.strip_market_price_filler("Umbreon is $5, which is roughly what copies have recently sold for."),
            "Umbreon is $5.",
        )
        self.assertEqual(
            length_guard.strip_market_price_filler("Umbreon is $5 (roughly what copies sold for recently)."),
            "Umbreon is $5.",
        )

    def test_internal_wording_scrub_never_leaves_a_dangling_clause(self) -> None:
        out = length_guard.drop_internal_sentences("It's $5. The SIR is pricier, and so it's, per the tool, higher.")
        self.assertEqual(out, "It's $5.")


class MoverBulletTests(unittest.TestCase):
    names = ["Umbreon VMAX", "Darkness Energy", "Umbreon V"]

    def test_two_cards_in_prose_become_bullets(self) -> None:
        out = length_guard.bold_bullet_figures(length_guard.bullet_prose_cards(MOVERS_PROSE, self.names))
        lines = out.split("\n")
        self.assertEqual(len(lines), 2)
        self.assertTrue(all(line.startswith("- ") for line in lines))
        self.assertIn("**Umbreon VMAX**", lines[0])
        self.assertIn("**Darkness Energy**", lines[1])
        self.assertIn("**16.5%**", lines[1])

    def test_lead_and_tail_sentences_stay_around_the_list(self) -> None:
        text = (
            "Two Evolving Skies cards fell hardest. Umbreon VMAX is down 5.6% to $2,195.10. "
            "Darkness Energy is down 16.5% to $18.73. This is past price data, not a prediction."
        )
        out = length_guard.bold_bullet_figures(length_guard.bullet_prose_cards(text, self.names))
        self.assertEqual(
            out,
            "Two Evolving Skies cards fell hardest.\n\n"
            "- **Umbreon VMAX** is down **5.6%** to **$2,195.10**.\n"
            "- **Darkness Energy** is down **16.5%** to **$18.73**.\n\n"
            "This is past price data, not a prediction.",
        )

    def test_left_alone(self) -> None:
        one = "Umbreon VMAX dropped the most, down **5.6%** to **$2,195.10**."
        self.assertEqual(length_guard.bullet_prose_cards(one, self.names), one)
        bulleted = "Biggest drops:\n- **Umbreon VMAX**: **$2,195.10**\n- Darkness Energy: $18.73"
        self.assertEqual(length_guard.bullet_prose_cards(bulleted, self.names), bulleted)
        both = "Umbreon VMAX ($2,195.10) and Darkness Energy ($18.73) fell."
        self.assertEqual(length_guard.bullet_prose_cards(both, self.names), both)
        same_card = "Umbreon VMAX fell to $2,195.10. Umbreon VMAX was $2,324.50 a month ago."
        self.assertEqual(length_guard.bullet_prose_cards(same_card, self.names), same_card)


class TapOnlyChoiceTests(unittest.TestCase):
    add = {"intent": "add"}

    def test_pikachu_reply_asks_only_for_the_tap(self) -> None:
        self.assertEqual(
            with_tap_hint(strip_detail_asks(PIKACHU_ASKS, self.add)),
            "There are lots of Pikachu printings, so I need you to pick one. Tap a card below to choose the right one.",
        )
        self.assertEqual(
            with_tap_hint(strip_detail_asks(PIKACHU_ASKS_2, self.add)),
            "There are many Pikachu printings, so I need you to pick one before I add it. "
            "Tap a card below to choose the right one.",
        )

    def test_whole_ask_sentence_goes_and_the_hint_is_added(self) -> None:
        out = with_tap_hint(strip_detail_asks("Several Pikachu match. How many copies, and in what condition?", self.add))
        self.assertEqual(out, f"Several Pikachu match.\n\n{TAP_HINT}")

    def test_defaults_statement_and_update_intent_stay(self) -> None:
        stated = "Tap a card below to pick the right one. The add defaults to 1 copy in Near Mint, which you can change."
        self.assertEqual(strip_detail_asks(stated, self.add), stated)
        update = "Which Pikachu, and what condition should it be?"
        self.assertEqual(strip_detail_asks(update, {"intent": "update"}), update)


@unittest.skipUnless(HAVE_DEPS, "assistant deps missing")
class NotCountedTests(unittest.TestCase):
    summary = {
        "value_usd": 3235.8, "holdings_count": 83, "stale_price_count": 5, "untrusted_price_count": 3,
        "excluded_holding_count": 8, "excluded_card_count": 9, "excluded_price_note": "8 holding(s) left out",
    }

    def test_payload_gives_a_ready_line_and_counted_holdings(self) -> None:
        out = with_not_counted(dict(self.summary))
        self.assertEqual(out["not_counted_line"], "9 cards aren't counted — no recent price.")
        self.assertEqual(out["holdings_count"], 75)
        self.assertEqual(out["not_counted_holdings"], 8)
        for key in ("stale_price_count", "untrusted_price_count", "excluded_price_note", "excluded_card_count"):
            self.assertNotIn(key, out)
        self.assertEqual(not_counted_line(1), "1 card isn't counted — no recent price.")
        self.assertEqual(with_not_counted({"value_usd": 5.0, "holdings_count": 2}), {"value_usd": 5.0, "holdings_count": 2})
        collection = with_not_counted({"total_value_usd": 10.0, "total_count": 4, "excluded_holding_count": 1,
                                       "excluded_card_count": 1})
        self.assertEqual((collection["total_count"], collection["counted_count"]), (4, 3))

    def info(self) -> NotCounted:
        info = NotCounted.from_content(3235.8, with_not_counted(dict(self.summary)))
        assert info is not None
        return info

    def test_staging_answer_gets_the_line_and_a_true_count(self) -> None:
        answer = (
            "Your collection is worth **$3,235.80** across 83 holdings. Your largest holding is the Legacy Booster "
            "Display Case at $807.94, followed by Kyogre-EX at $504.48."
        )
        self.assertEqual(
            ensure_not_counted_line(answer, [self.info()]),
            "Your collection is worth **$3,235.80** across 75 holdings. 9 cards aren't counted — no recent price. "
            "Your largest holding is the Legacy Booster Display Case at $807.94, followed by Kyogre-EX at $504.48.",
        )

    def test_left_alone_when_said_absent_or_no_total(self) -> None:
        said = "Your collection is worth **$3,235.80**. 9 cards aren't counted — no recent price."
        self.assertEqual(ensure_not_counted_line(said, [self.info()]), said)
        no_total = "Kyogre-EX is your top card at $504.48."
        self.assertEqual(ensure_not_counted_line(no_total, [self.info()]), no_total)
        self.assertEqual(ensure_not_counted_line("Worth $3,235.80.", [None]), "Worth $3,235.80.")

    def test_prompt_says_the_line(self) -> None:
        self.assertIn("not_counted_line", SYSTEM_PROMPT)
        self.assertNotIn("Collection totals: no note about unpriced holdings.", SYSTEM_PROMPT)
        self.assertIn("never ask for quantity or condition there", SYSTEM_PROMPT)
        self.assertIn("Naming 2 or more cards", SYSTEM_PROMPT)


@unittest.skipUnless(HAVE_DEPS, "assistant deps missing")
class NotCountedEngineTests(price_quality.PriceQualityCase):
    _seed = price_quality.StaleAndUntrustedTests._seed  # 2 fresh copies counted; 1 stale + 1 untrusted left out

    def run_turn(self, answer: str) -> str:
        client = FakeClient([
            message([tool_use("get_portfolio_summary", {"focus": "value"}, "p1")], "tool_use"),
            message([text(answer)]),
        ])
        config = AssistantConfig(enabled=True, daily_spend_cap_usd=5.0, max_tool_rounds=4)
        engine = AssistantEngine(config, AssistantToolbox(self.tools), client)
        turn = asyncio.run(engine.run_turn(owner_user_id=USER_A, history=[], question="What's my collection worth?"))
        payload = client.messages.calls[-1]["messages"][-1]["content"][0]["content"]
        self.assertIn("2 cards aren't counted", payload)
        self.assertNotIn("stale_price_count", payload)
        return turn.text

    def test_total_without_the_line_gets_it(self) -> None:
        self.assertEqual(
            self.run_turn("Your collection is worth **$100.00** across 3 holdings."),
            "Your collection is worth **$100.00** across 1 holding. 2 cards aren't counted — no recent price.",
        )

    def test_line_already_said_is_kept_once(self) -> None:
        answer = "Your collection is worth **$100.00**. 2 cards aren't counted — no recent price."
        self.assertEqual(self.run_turn(answer), answer)


if __name__ == "__main__":
    unittest.main()
