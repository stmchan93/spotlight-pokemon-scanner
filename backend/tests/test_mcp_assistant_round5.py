"""Eval round 5: the code-enforced word limit (length_guard + one rewrite call),
grading_upside's raw price = the collection's, the ambiguous-printing hint,
history summaries with condition, scoped collection totals, art wording."""

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

from catalog_tools import upsert_card  # noqa: E402
from mcp_server.assistant import length_guard  # noqa: E402

if HAVE_DEPS:
    from mcp_server.assistant.engine import (
        SYSTEM_PROMPT,
        AssistantEngine,
        ensure_choice_question,
        ensure_total_first,
        strip_pseudo_calls,
    )
    from mcp_server.assistant.tools import (
        MAX_CHOICE_TILES,
        AssistantToolbox,
        ambiguity_hint,
        default_printing_hint,
        choose_tiles,
        history_summary,
        neutral_art_coverage,
    )

LONG = (
    "Pikachu ex is $120.00 right now, its highest price this year. It has climbed steadily since the set came out "
    "and collectors keep chasing the special illustration. Charizard ex sits at $8.00, which is far below its "
    "peak and a reasonable pickup for a binder. Both cards are popular at shows and sell quickly when listed. "
    "Prices move daily, so check the card page before you buy. Graded copies follow their own market, and a clean "
    "copy can be worth far more than a played one, so condition matters a lot here too. This is a snapshot of past prices, not a prediction."
)


class LengthGuardUnitTests(unittest.TestCase):
    def test_limits_come_from_one_table(self) -> None:
        limit = length_guard.limit_for
        self.assertEqual(limit("How much is Pikachu?", ["search_cards"]), length_guard.WORD_LIMITS["default"])
        self.assertEqual(limit("Why did Charizard go up?", ["get_price_history"]), length_guard.WORD_LIMITS["explanation"])
        self.assertEqual(limit("Write me a poem", []), length_guard.WORD_LIMITS["refusal"])
        self.assertEqual(limit("Why did it move?", ["get_price_history"], no_data=True), length_guard.WORD_LIMITS["no_data"])
        self.assertEqual(limit("Show Kyogre's price history", ["search_cards", "get_price_history"]),
                         length_guard.WORD_LIMITS["price_history"])
        self.assertEqual(limit("Cozy sleeping cards", ["list_facets", "search_cards"]), length_guard.WORD_LIMITS["art_search"])

    def test_trim_keeps_whole_sentences_and_the_prediction_line(self) -> None:
        out = length_guard.trim_to_limit(LONG, 40)
        self.assertLessEqual(length_guard.word_count(out), 40)
        self.assertTrue(out.startswith("Pikachu ex is $120.00"))
        self.assertTrue(out.endswith("not a prediction."))
        self.assertNotIn("check the card page", out)

    def test_trim_cuts_one_long_sentence_at_a_word(self) -> None:
        out = length_guard.trim_to_limit("word " * 60 + "end.", 10)
        self.assertLessEqual(length_guard.word_count(out), 10)

    def test_number_check(self) -> None:
        backed = length_guard.tool_numbers(['{"price_usd":1450.0,"raw":504.48}'])
        self.assertTrue(length_guard.keeps_numbers("Sold for $1,450 vs $504.48 (187%).", "$1,450 vs $504.48.", backed))
        self.assertFalse(length_guard.keeps_numbers("Sold for $1,450 vs $504.48.", "Sold for $1,450.", backed))

    def test_table_to_bullets(self) -> None:
        self.assertFalse(length_guard.has_table("Kyogre-EX | $504.48 | one line is not a table"))
        self.assertTrue(length_guard.has_table("| A | B |\n|---|---|"))
        no_header = length_guard.tables_to_bullets("| Pikachu ex | $120 | NM |\n| Charizard ex | $8 | LP |")
        self.assertEqual(no_header, "- **Pikachu ex**: $120 · NM\n- **Charizard ex**: $8 · LP")
        self.assertEqual(length_guard.tables_to_bullets("No table here."), "No table here.")

    def test_data_source_caveats_count_as_internal_wording(self) -> None:
        for caveat in ("PSA 10 figures are market estimates based on recorded sales.",
                       "These are estimates based on recent sales.", "Data may lag a day.",
                       "According to our data, it's up.", "Ekalight's data shows a rise.",
                       "These are basket moves of each set's top 10 cards, so one hot card can move a whole set."):
            self.assertTrue(length_guard.has_internal_wording(caveat), caveat)
        for fine in ("Grading costs money and takes time.", "This is past price data, not a prediction.",
                     "Kyogre-EX sold for $1,450 in a PSA 10."):
            self.assertFalse(length_guard.has_internal_wording(fine), fine)

    def test_empty_results(self) -> None:
        self.assertTrue(length_guard.is_empty_result({"points": []}, is_error=False))
        self.assertTrue(length_guard.is_empty_result({}, is_error=True))
        self.assertFalse(length_guard.is_empty_result({"results": [{"card_id": "x"}]}, is_error=False))


@unittest.skipUnless(HAVE_DEPS, "anthropic / mcp not installed")
class LengthGuardEngineTests(AssistantCase):
    def run_turn(self, client: Any, question: str) -> Any:
        engine = AssistantEngine(self.config, AssistantToolbox(self.tools), client)
        return asyncio.run(engine.run_turn(owner_user_id=USER_A, history=[], question=question))

    def script(self, final_text: str, *extra: Any) -> FakeClient:
        return FakeClient([
            message([tool_use("search_cards", {"filter": {"text": "pikachu"}}, "s1")], "tool_use"),
            message([text(final_text)]),
            *extra,
        ])

    def test_short_answer_makes_no_extra_call(self) -> None:
        client = self.script("Pikachu ex is $120.00.")
        turn = self.run_turn(client, "How much is Pikachu ex 238?")
        self.assertEqual(len(client.messages.calls), 2)
        self.assertIsNone(turn.length_guard)

    def test_rewrite_is_used_and_costed(self) -> None:
        rewrite = "Pikachu ex is $120.00, its yearly high; Charizard ex is $8.00. Snapshot of past prices, not a prediction."
        client = self.script(LONG, message([text(rewrite)], input_tokens=200, output_tokens=40))
        turn = self.run_turn(client, "How much is Pikachu ex 238?")
        self.assertEqual(turn.text, rewrite)
        self.assertEqual(turn.length_guard, "rewrite")
        call = client.messages.calls[-1]
        self.assertEqual(call["output_config"], {"effort": "low"})
        self.assertNotIn("tools", call)
        self.assertIn(f"at most {turn.word_limit} words", call["system"])
        self.assertEqual(turn.input_tokens, 1000 * 2 + 200)
        self.assertEqual(turn.output_tokens, 100 * 2 + 40)

    def test_rewrite_dropping_a_tool_number_falls_back_to_trim(self) -> None:
        client = self.script(LONG, message([text("Pikachu ex is near its yearly high.")]))
        turn = self.run_turn(client, "How much is Pikachu ex 238?")
        self.assertEqual(turn.length_guard, "trim")
        self.assertIn("$120.00", turn.text)
        self.assertLessEqual(length_guard.word_count(turn.text), turn.word_limit)

    def test_failed_rewrite_call_trims(self) -> None:
        client = self.script(LONG, RuntimeError("boom"))
        turn = self.run_turn(client, "How much is Pikachu ex 238?")
        self.assertEqual((turn.status, turn.length_guard), ("ok", "trim"))
        self.assertLessEqual(length_guard.word_count(turn.text), turn.word_limit)

    def test_owner_table_becomes_bullets_without_an_extra_call(self) -> None:
        # Owner 2026-11-20: "What are these worth in a PSA 10?" came back as a raw-pipe table plus a caveat.
        answer = (
            "Of the 2 cards in your scan tray, Kyogre-EX gains the most in a PSA 10.\n\n"
            "| Card | Raw | PSA 10 | Gross premium |\n|---|---|---|---|\n"
            "| **Kyogre-EX** (Dark Explorers 104/108) | $504.48 | $1,450 | +$945.52 (+187%) |\n"
            "| Lugia (HGSS02) | $485.99 | no recent sale | — |\n\n"
            "Grading costs money and takes time."
        )
        client = self.script(answer)
        turn = self.run_turn(client, "What are these worth in a PSA 10?")
        self.assertEqual(len(client.messages.calls), 2)
        self.assertNotIn("|", turn.text)
        self.assertIn(
            "- **Kyogre-EX** (Dark Explorers 104/108): Raw **$504.48** · PSA 10 **$1,450** · Gross premium "
            "**+$945.52** (**+187%**)\n"
            "- **Lugia** (HGSS02): Raw **$485.99** · PSA 10 no recent sale",
            turn.text,
        )
        self.assertTrue(turn.text.endswith("Grading costs money and takes time."))

    def test_data_source_caveat_is_dropped_and_fees_line_kept(self) -> None:
        answer = (
            "Of the 2 cards in your scan tray, Kyogre-EX gains the most in a PSA 10.\n\n"
            "- **Kyogre-EX** (Dark Explorers 104/108): raw $504.48 → PSA 10 $1,450 (+$945.52, +187%)\n"
            "- **Lugia** (HGSS02): raw $485.99 · no recent PSA 10 sale\n\n"
            "PSA 10 figures are market estimates based on recorded sales. Grading costs money and takes time."
        )
        client = self.script(answer, RuntimeError("no rewrite"))
        turn = self.run_turn(client, "What are these worth in a PSA 10?")
        self.assertEqual(turn.length_guard, "drop")
        self.assertNotIn("estimate", turn.text)
        self.assertIn("(**+$945.52**, **+187%**)\n- **Lugia**", turn.text)  # bullets stay one list
        self.assertTrue(turn.text.endswith("Grading costs money and takes time."))


@unittest.skipUnless(HAVE_DEPS, "anthropic / mcp not installed")
class GradingUpsideCollectionPriceTests(AssistantCase):
    def _seed(self) -> None:
        super()._seed()
        upsert_card(
            self.conn, card_id="xy5g_ja-77", name="Teammates", set_name="Gaia Volcano", number="077/070",
            rarity="Secret Rare", variant="Raw", language="Japanese", source_provider="scrydex",
            source_record_id="xy5g_ja-77", set_id="xy5g_ja", set_ptcgo_code="XY5G", set_release_date="2014-11-08",
            artist=None, supertype="Trainer", national_pokedex_numbers=[], image_url=None,
            source_payload={"id": "xy5g_ja-77"},
        )
        self.price("xy5g_ja-77", 461.96)  # Scrydex-anchored: catalog reads distrust it for Japanese cards
        self.holding("a-jp", USER_A, "xy5g_ja-77")
        self.conn.commit()

    def test_raw_price_matches_the_collection(self) -> None:
        box = AssistantToolbox(self.tools)
        held = box.run("get_my_collection", {"sort": "price_desc"}, owner_user_id=USER_A).content["items"]
        collection_price = next(item["price_usd"] for item in held if item["card_id"] == "xy5g_ja-77")
        self.assertIsNotNone(collection_price)
        upside = box.run("grading_upside", {"card_ids": ["xy5g_ja-77", "ssp-3"]}, owner_user_id=USER_A).content
        rows = {row["card_id"]: row for row in upside["cards"]}
        self.assertEqual(rows["xy5g_ja-77"]["raw_price_usd"], collection_price)
        self.assertIsNone(rows["ssp-3"]["raw_price_usd"])  # unowned + unpriced: still no raw price


@unittest.skipUnless(HAVE_DEPS, "anthropic / mcp not installed")
class AmbiguityTests(AssistantCase):
    def _seed(self) -> None:
        super()._seed()
        self.card("base1-4", "Charizard", number="4/102", set_name="Base")
        self.card("neo4-107", "Charizard", number="107/105", set_name="Neo Destiny")
        self.price("base1-4", 1001.05)
        self.price("neo4-107", 3998.99)
        self.conn.commit()

    RESULTS = {"results": [
        {"card_id": "neo4-107", "name": "Charizard", "set": "Neo Destiny", "number": "107/105"},
        {"card_id": "base1-4", "name": "Charizard", "set": "Base", "number": "4/102"},
    ]}

    def test_hint_rules(self) -> None:
        hint = ambiguity_hint(self.RESULTS, {"text": "Charizard"}, "How much is Charizard?")
        self.assertTrue(hint["ambiguous"])
        self.assertEqual(hint["ask_which"], "Which Charizard do you mean: Neo Destiny #107/105 or Base #4/102?")
        for question in ("How much is Charizard 4/102?", "What's the most expensive Charizard?",
                         "Show Charizard's price history", "How much is Base Set Charizard"):
            self.assertEqual(ambiguity_hint(self.RESULTS, {"text": "Charizard"}, question), {}, question)
        self.assertEqual(ambiguity_hint(self.RESULTS, {"text": "Charizard", "set": "Base"}, "How much is Charizard?"), {})
        one = {"results": self.RESULTS["results"][:1]}
        self.assertEqual(ambiguity_hint(one, {"text": "Charizard"}, "How much is Charizard?"), {})

    def test_one_set_defaults_to_the_priciest_non_gold_printing(self) -> None:
        for card_id, number in (("me5-48", "48/084"), ("me5-116", "116/084"), ("me5-120", "120/084")):
            self.card(card_id, "Mega Darkrai ex", number=number, set_name="Pitch Black")
        self.conn.execute("UPDATE cards SET rarity = 'Mega Hyper Rare' WHERE id = 'me5-120'")
        self.conn.commit()
        results = {"results": [
            {"card_id": "me5-120", "name": "Mega Darkrai ex", "set": "Pitch Black", "number": "120/084", "price_usd": 201.17},
            {"card_id": "me5-116", "name": "Mega Darkrai ex", "set": "Pitch Black", "number": "116/084", "price_usd": 124.55},
            {"card_id": "me5-48", "name": "Mega Darkrai ex", "set": "Pitch Black", "number": "48/084", "price_usd": 0.70},
        ]}
        flt = {"text": "Mega Darkrai ex"}
        hint = default_printing_hint(self.conn, results, flt, "How is the mega darkrai ex doing gimme a price chart")
        self.assertEqual(hint["default_printing_card_id"], "me5-116")
        self.assertIn("Don't ask which one", hint["default_printing_note"])
        gold = default_printing_hint(self.conn, results, flt, "price chart for the gold mega darkrai ex")
        self.assertEqual(gold["default_printing_card_id"], "me5-120")
        # Rankings and printings across several sets keep their own rules.
        self.assertEqual(default_printing_hint(self.conn, results, flt, "most expensive mega darkrai ex"), {})
        self.assertEqual(default_printing_hint(self.conn, self.RESULTS, {"text": "Charizard"}, "How much is Charizard?"), {})

    def test_answer_that_ignores_the_hint_still_asks_and_keeps_candidates(self) -> None:
        client = FakeClient([
            message([tool_use("search_cards", {"filter": {"text": "Charizard"}, "sort": "price_desc"}, "s1")],
                    "tool_use"),
            message([text("The priciest Charizard is Neo Destiny at $3,998.99.")]),
        ])
        engine = AssistantEngine(self.config, AssistantToolbox(self.tools), client)
        turn = asyncio.run(engine.run_turn(owner_user_id=USER_A, history=[], question="How much is Charizard?"))
        self.assertTrue(turn.text.endswith("Which Charizard do you mean: Neo Destiny #107/105 or Base #4/102?"))
        self.assertEqual({card["card_id"] for card in turn.cards}, {"neo4-107", "base1-4"})

    def test_choice_tiles_are_capped(self) -> None:
        refs = [{"card_id": f"c{i}", "name": "Charizard", "set": f"S{i}", "number": str(i)} for i in range(10)]
        tiles, _ = choose_tiles(None, refs, "Which Charizard do you mean?", [])
        self.assertEqual(len(tiles), MAX_CHOICE_TILES)

    def test_choice_question_helper(self) -> None:
        self.assertEqual(ensure_choice_question("Which one do you mean?", "Which X?"), "Which one do you mean?")
        self.assertEqual(ensure_choice_question("It varies.", None), "It varies.")


class AnswerShapeTests(unittest.TestCase):
    def test_history_summary_states_condition_and_dated_move(self) -> None:
        result = {"condition": "NM", "variant": "Holofoil", "first_usd": 374.44, "last_usd": 287.93,
                  "first_date": "2026-08-22", "last_date": "2026-11-18"}
        card = {"name": "Charizard ex", "setName": "151", "number": "199/165"}
        self.assertEqual(
            history_summary(result, card),
            "Charizard ex (151 #199/165), Near Mint Holofoil: $374.44 on 2026-08-22 -> $287.93 on 2026-11-18 (-23.10%).",
        )
        self.assertIn("PSA 10", history_summary({**result, "grader": "PSA", "grade": "10"}, card))

    def test_total_first(self) -> None:
        q = "How much is my One Piece collection worth?"
        out = ensure_total_first("Nami eased 8% since August.", q, [(227.02, "One Piece")])
        self.assertTrue(out.startswith("Your One Piece cards are worth about $227.02 in total."))
        self.assertEqual(ensure_total_first("It's worth $227.02.", q, [(227.02, "One Piece")]), "It's worth $227.02.")
        self.assertEqual(ensure_total_first("Snorlax led.", "My biggest gainers?", [(5.0, None)]), "Snorlax led.")

    def test_art_coverage_has_no_tag_wording(self) -> None:
        out = neutral_art_coverage({"tagged_cards": 10, "catalog_cards": 20, "note": "Art tags cover 10 of 20"})
        self.assertNotRegex(str(out).lower(), r"\btag")

    def test_trailing_show_cards_block_is_stripped(self) -> None:
        raw = 'Pikachu ex is $21.66.\n\n<br>\n\nshow_cards\n{"cards":[{"card_id":"x"}]}'
        self.assertEqual(strip_pseudo_calls(raw), "Pikachu ex is $21.66.")
        self.assertEqual(strip_pseudo_calls("A.\n\nshow_cards: Pikachu ex MEP 107"), "A.")

    @unittest.skipUnless(HAVE_DEPS, "anthropic / mcp not installed")
    def test_prompt_rules(self) -> None:
        for rule in ("never say tag, tagged, matching", "Never list both endpoint prices",
                     "open with the actual move and dates", "ambiguous=true", "total_value_usd",
                     "never a table", "Of the 3 cards in your scan tray", "This scanned card", "market estimates",
                     "raw $504.48 → PSA 10 $1,450 (+$945.52, +187%)", "no recent PSA 10 sale"):
            self.assertIn(rule, SYSTEM_PROMPT)
        self.assertNotIn("except the worth-grading table", SYSTEM_PROMPT)


if __name__ == "__main__":
    unittest.main()


class DisclaimerPhrasingTests(unittest.TestCase):
    def test_model_written_disclaimer_variants_are_recognized(self) -> None:
        # A recognized model line means no second "This is past price data..." gets appended.
        for line in ("Past moves aren't a prediction.", "This isn't a forecast.", "This is not a prediction."):
            self.assertTrue(length_guard.has_disclaimer(line), line)
        self.assertFalse(length_guard.has_disclaimer("Plasma Storm rose 67%."))
