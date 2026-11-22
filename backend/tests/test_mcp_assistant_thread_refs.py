"""Thread card memory and tap-to-pick for any intent (owner staging thread 2026-11-22).

The thread: the owner attached a photo of Mega Lucario ex and priced it; later asked
about trades, looked up "the torchic" (a search tile: Nintendo Black Star Promos Torchic),
then their own Torchics (2 raw Shiny Collection 005/020 + 1 CGC 10 of it + 1 ADV Promos),
said "The first one worth 39", and finally "Trade for that lucsrio". Bugs reproduced:
1. "The first one worth 39" showed the raw copy AND an unpriced CGC 10 tile, and the raw
   tile lost its "2x".
2. "that lucario" was out of the 10-message history window, so the model searched again.
3. The ask-which reply wasn't tap-to-pick (only add/update were).
4. "...against your Torchic at $39" showed the oldest Torchic tile (Nintendo Black, $128.49).
"""

from __future__ import annotations

import asyncio
import json
import sys
import unittest
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT / "tests") not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT / "tests"))

from test_mcp_assistant import HAVE_DEPS, USER_A, AssistantCase, FakeClient, message, text, tool_use  # noqa: E402

if HAVE_DEPS:
    from mcp_server.assistant.choice import TAP_HINT, pick_printing_choice
    from mcp_server.assistant.engine import (
        PICKED_CARDS_HEADER,
        AssistantEngine,
        _history_refs,
        last_choice_card_ids,
    )
    from mcp_server.assistant.store import HISTORY_MESSAGES
    from mcp_server.assistant.tools import (
        THREAD_MEMORY_HEADER,
        AssistantToolbox,
        asks_to_pick,
        choice_candidates,
        choose_tiles,
    )


def _tile(card_id: str, name: str, set_name: str, number: str, *, price=None, quantity=None, grader=None,
          grade=None, variant=None) -> dict:
    return {"card_id": card_id, "name": name, "set": set_name, "number": number, "language": "Japanese",
            "image_small_url": f"https://img.example/{card_id}.png", "app_url": f"spotlight://cards/{card_id}",
            "price_usd": price, "variant": variant, "grader": grader, "grade": grade, "quantity_owned": quantity}


SC_RAW = _tile("sc1_ja-5", "Torchic", "Shiny Collection", "005/020", price=39.0, quantity=2,
               variant="1st Edition Holofoil")
SC_CGC = _tile("sc1_ja-5", "Torchic", "Shiny Collection", "005/020", grader="CGC", grade="10", quantity=1,
               variant="1st Edition Holofoil")
ADV = _tile("advp_ja-4", "Torchic", "ADV Promos", "004/ADV-P", price=22.99, quantity=1, variant="Normal")
NP8 = _tile("np-8", "Torchic", "Nintendo Black Star Promos", "008", price=128.49)


def _history() -> list[dict]:
    """The thread's last turns as store.history returns them (oldest first)."""
    return [
        {"role": "user", "text": "The torchic"},
        {"role": "assistant", "text": "Torchic has several printings. Tap a card below to pick it.",
         "tool_calls": ["search_cards(text=torchic)"], "cards": [NP8]},
        {"role": "user", "text": "Check the torchic in my collection"},
        {"role": "assistant", "text": "You own 3 Torchic holdings worth $100.99. A CGC 10 copy has no recent price.",
         "tool_calls": ["get_my_collection(text=torchic)"], "cards": [SC_RAW, ADV, SC_CGC]},
        {"role": "user", "text": "The raw copy"},
        {"role": "assistant", "text": "Your raw Torchic copies: 2 Shiny Collection at $39 and 1 ADV Promos at $22.99. "
                                      "Which one do you want to trade?",
         "tool_calls": ["get_my_collection(text=torchic, holding_type=raw)"], "cards": [SC_RAW, ADV]},
    ]


@unittest.skipUnless(HAVE_DEPS, "anthropic / mcp not installed")
class TileRuleTests(unittest.TestCase):
    def test_history_refs_are_most_recent_first_and_keep_holding_fields(self) -> None:
        refs = _history_refs(_history())
        self.assertEqual(refs[0]["card_id"], "sc1_ja-5")
        self.assertEqual(refs[-1]["card_id"], "np-8")
        self.assertEqual((refs[0]["quantity_owned"], refs[0]["variant"], refs[0]["shown_price_usd"]),
                         (2, "1st Edition Holofoil", 39.0))

    def test_number_pin_skips_a_slab_the_text_never_names(self) -> None:
        refs = _history_refs(_history())
        answer = "Got it: the **Torchic (Shiny Collection 005/020, 1st Edition Holofoil)** at **$39**. What would you get?"
        tiles, _ = choose_tiles(None, [], answer, [], extra_refs=refs)
        self.assertEqual([(t["card_id"], t["grader"]) for t in tiles], [("sc1_ja-5", None)])
        # Naming the slab still shows it.
        tiles, _ = choose_tiles(None, [], "Your CGC 10 Torchic 005/020 has no recent sale.", [], extra_refs=refs)
        self.assertIn(("sc1_ja-5", "CGC"), [(t["card_id"], t["grader"]) for t in tiles])

    def test_unpinned_name_prefers_quoted_price_then_owned_then_most_recent(self) -> None:
        # Oldest-first (the old order) with the search tile first: the price quote still wins.
        refs = _history_refs(list(reversed(_history())))
        tiles, _ = choose_tiles(None, [], "I'll check it against your Torchic at $39.", [], extra_refs=refs)
        self.assertEqual([t["card_id"] for t in tiles], ["sc1_ja-5"])
        owned_last = [dict(NP8, via="history"), dict(ADV, via="history")]
        tiles, _ = choose_tiles(None, [], "Your Torchic is a good trade piece.", [], extra_refs=owned_last)
        self.assertEqual([t["card_id"] for t in tiles], ["advp_ja-4"])

    def test_asks_to_pick_without_a_question_mark(self) -> None:
        self.assertTrue(asks_to_pick("Lucario has several printings, so I need to know which one you want. "
                                     "Tap a card below to pick it."))
        self.assertTrue(asks_to_pick("Which Charizard do you mean?"))
        self.assertFalse(asks_to_pick("Got it: the Torchic at $39. What would you get in return?"))

    def test_choice_candidates_drop_earlier_cards_named_in_passing(self) -> None:
        turn = [{"card_id": "dp1-6", "name": "Lucario", "set": "Diamond & Pearl", "number": "6/130"},
                {"card_id": "pl-1", "name": "Lucario", "set": "Platinum", "number": "1"}]
        selection = [turn[0], dict(NP8)]
        picked = choice_candidates(selection, turn, "Tap a card below to pick the Lucario.")
        self.assertEqual([t["card_id"] for t in picked], ["dp1-6", "pl-1"])

    def test_pick_choice_for_any_intent(self) -> None:
        cards = [{"card_id": "a"}, {"card_id": "b"}]
        choice = pick_printing_choice("Trade for that lucario", cards=cards, actions=[], turn_card_ids={"a", "b"},
                                      asks_to_pick=True)
        self.assertEqual((choice["kind"], choice["intent"]), ("pick_printing", "pick"))
        self.assertIsNone(pick_printing_choice("Trade for that lucario", cards=cards, actions=[],
                                               turn_card_ids={"a", "b"}))
        self.assertIsNone(pick_printing_choice("Trade for that lucario", cards=cards[:1], actions=[],
                                               turn_card_ids={"a", "b"}, asks_to_pick=True))

    def test_last_choice_card_ids(self) -> None:
        history = [{"role": "user", "text": "q"},
                   {"role": "assistant", "text": "a", "cards": [{"card_id": "x"}, {"card_id": "y"}],
                    "choice": {"kind": "pick_printing", "intent": "pick"}}]
        self.assertEqual(last_choice_card_ids(history), {"x", "y"})
        self.assertEqual(last_choice_card_ids(history[:1]), set())
        self.assertEqual(last_choice_card_ids([*history, {"role": "assistant", "text": "b", "cards": []}]), set())


@unittest.skipUnless(HAVE_DEPS, "anthropic / mcp not installed")
class ThreadShapeTests(AssistantCase):
    def setUp(self) -> None:
        super().setUp()
        self.card("sc1_ja-5", "Torchic", number="005/020", set_name="Shiny Collection")
        self.card("advp_ja-4", "Torchic", number="004/ADV-P", set_name="ADV Promos")
        self.card("np-8", "Torchic", number="008", set_name="Nintendo Black Star Promos")
        self.card("mep-33", "Mega Lucario ex", number="033", set_name="Mega Evolution Black Star Promos")
        self.card("dp1-6", "Lucario", number="6/130", set_name="Diamond & Pearl")
        self.card("pl-1", "Lucario", number="1", set_name="Platinum")
        for card_id, amount in (("sc1_ja-5", 39.0), ("advp_ja-4", 22.99), ("np-8", 128.49), ("mep-33", 8.25),
                                ("dp1-6", 61.84), ("pl-1", 5.0)):
            self.price(card_id, amount)
        self.holding("t-raw", USER_A, "sc1_ja-5", quantity=2)
        self.holding("t-cgc", USER_A, "sc1_ja-5", quantity=1, grader="CGC", grade="10")
        self.holding("t-adv", USER_A, "advp_ja-4", quantity=1)
        self.conn.commit()

    def engine(self, *responses) -> AssistantEngine:
        return AssistantEngine(self.config, AssistantToolbox(self.tools), FakeClient(list(responses)))

    def test_bug1_the_first_one_worth_39_is_one_2x_tile(self) -> None:
        turn = asyncio.run(self.engine(message([text(
            "Got it: the **Torchic (Shiny Collection 005/020, 1st Edition Holofoil)** at **$39**. "
            "What would you get in return?"
        )])).run_turn(owner_user_id=USER_A, history=_history(), question="The first one worth 39"))
        self.assertEqual(len(turn.cards), 1, turn.cards)
        tile = turn.cards[0]
        self.assertEqual((tile["card_id"], tile["grader"], tile["quantity_owned"], tile["price_usd"]),
                         ("sc1_ja-5", None, 2, 39.0))
        self.assertNotIn("via", tile)
        self.assertNotIn("shown_price_usd", tile)

    def test_bug1_owned_count_is_todays_not_the_old_tiles(self) -> None:
        self.conn.execute("UPDATE deck_entries SET quantity = 3 WHERE id = 't-raw'")
        self.conn.commit()
        turn = asyncio.run(self.engine(message([text("Your Torchic (005/020) is $39.")])).run_turn(
            owner_user_id=USER_A, history=_history(), question="that one"))
        self.assertEqual([(t["card_id"], t["quantity_owned"]) for t in turn.cards], [("sc1_ja-5", 3)])

    def test_bug3_bug4_trade_ask_which_is_a_pick_choice_without_the_old_torchic(self) -> None:
        turn = asyncio.run(self.engine(
            message([tool_use("search_cards", {"filter": {"text": "lucario"}}, "s1"),
                     tool_use("show_cards", {"cards": [{"card_id": "dp1-6"}, {"card_id": "np-8"}]}, "s2")],
                    "tool_use"),
            message([text("Lucario has several printings, so I need to know which one you want. Tap a card below "
                          "to pick it, and I'll run the trade check against your Torchic at $39.")]),
        ).run_turn(owner_user_id=USER_A, history=_history(), question="Trade for that lucsrio"))
        self.assertEqual(turn.choice["intent"], "pick")
        ids = [card["card_id"] for card in turn.cards]
        self.assertIn("dp1-6", ids)
        self.assertIn("pl-1", ids)
        self.assertNotIn("np-8", ids)
        self.assertTrue(all(card["name"] == "Lucario" for card in turn.cards), ids)

    def test_bug4_a_plain_answer_names_the_owned_torchic(self) -> None:
        turn = asyncio.run(self.engine(message([text(
            "A fair trade for your Torchic at $39 would be a card worth about $35 to $43."
        )])).run_turn(owner_user_id=USER_A, history=_history(), question="what would be fair"))
        self.assertEqual([card["card_id"] for card in turn.cards], ["sc1_ja-5"])

    def test_bug2_photo_card_outside_the_window_stays_in_thread_memory(self) -> None:
        self.build(unlimited_user_ids=frozenset({USER_A}))
        self.client.queue(message([text("The card in your photo is Mega Lucario ex at $8.25.")]))
        first = self.ask("Is this card worth 12",
                         context={"source": "home", "attached_card_ids": ["mep-33"]}).json()
        thread_id = first["thread_id"]
        stored = self.conn.execute(
            "SELECT context_cards_json FROM assistant_messages WHERE thread_id = ? AND role = 'user'", (thread_id,)
        ).fetchone()[0]
        self.assertEqual(json.loads(stored)["attached"], ["mep-33"])
        for index in range(HISTORY_MESSAGES // 2 + 1):  # push the photo turn out of the history window
            self.client.queue(message([text(f"Answer {index}.")]))
            self.ask(f"filler question {index}", thread_id=thread_id)
        self.client.queue(
            message([tool_use("show_cards", {"cards": [{"card_id": "mep-33"}]}, "s1"),
                     text("Trading your Torchic for the Mega Lucario ex from your photo: tell me the offer.")],
                    "tool_use"),
        )
        response = self.ask("Trade for that lucsrio", thread_id=thread_id)
        self.assertEqual(response.status_code, 200, response.text)
        reply = response.json()["message"]
        context = self.client.messages.calls[-1]["messages"][-1]["content"][0]["text"]
        self.assertIn(THREAD_MEMORY_HEADER, context)
        self.assertIn("Mega Lucario ex · Mega Evolution Black Star Promos · #033 · photo the user attached "
                      "(card_id: mep-33)", context)
        self.assertEqual([card["card_id"] for card in reply["cards"]], ["mep-33"])

    def test_bug3_tapping_a_pick_tile_is_a_pick_not_the_scan_tray(self) -> None:
        self.client.queue(
            message([tool_use("search_cards", {"filter": {"text": "lucario"}}, "s1")], "tool_use"),
            message([text("Which Lucario do you mean?")]),
        )
        first = self.ask("Trade my Torchic for a lucario").json()
        self.assertEqual(first["message"]["choice"]["intent"], "pick")
        self.assertTrue(first["message"]["text"].endswith(TAP_HINT))
        self.client.queue(message([text("Lucario (Diamond & Pearl 6/130) is $61.84.")]))
        self.ask("I mean Lucario (Diamond & Pearl 6/130)", thread_id=first["thread_id"],
                 context={"source": "home", "card_ids": ["dp1-6"]})
        context = self.client.messages.calls[-1]["messages"][-1]["content"][0]["text"]
        self.assertIn(PICKED_CARDS_HEADER, context)
        self.assertNotIn("The user's scan tray contains", context)
        stored = self.conn.execute(
            "SELECT context_cards_json FROM assistant_messages WHERE thread_id = ? AND role = 'user' "
            "ORDER BY created_at DESC LIMIT 1", (first["thread_id"],)
        ).fetchone()[0]
        self.assertEqual(json.loads(stored)["picked"], ["dp1-6"])


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
