"""Game scope for market-wide answers (owner decision 2026-11-20): one game per
ranking, resolved in code (question > thread > screen > collection > Pokémon),
pinned on market tool calls, remembered per thread, and part of the shared
answer cache key."""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path
from unittest import mock

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT / "tests") not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT / "tests"))

from test_mcp_assistant import (  # noqa: E402
    GUEST, HAVE_DEPS, USER_A, USER_B, AssistantCase, content_text, message, text, tool_use,
)

if HAVE_DEPS:
    from mcp_server.assistant import game_scope, shared_answers
    from mcp_server.assistant.game_scope import GameScope, enforce_game, resolve_game


@unittest.skipUnless(HAVE_DEPS, "anthropic / mcp not installed")
class ResolutionTests(unittest.TestCase):
    def test_question_names_a_game(self) -> None:
        scope = resolve_game("what one piece cards are rising", thread_game="lorcana", context_game="pokemon",
                             collection=("gundam",))
        self.assertEqual((scope.game, scope.source), ("onepiece", "question"))
        self.assertEqual(resolve_game("Which Pokémon cards dropped?").game, "pokemon")
        self.assertEqual(resolve_game("top Disney Lorcana risers").game, "lorcana")
        # Several named: the first is the scope, all stay allowed for the model.
        scope = resolve_game("compare lorcana and one-piece risers")
        self.assertEqual((scope.game, scope.named), ("lorcana", ("lorcana", "onepiece")))

    def test_all_games_is_unscoped(self) -> None:
        for question in ("what's rising across all games", "biggest risers in every game", "top cards of all TCGs"):
            scope = resolve_game(question, context_game="pokemon")
            self.assertIsNone(scope.game, question)
            self.assertEqual(scope.source, "all_games")
            self.assertEqual(scope.cache_scope, "game:all_games")

    def test_unsupported_game_is_not_answered_with_another(self) -> None:
        scope = resolve_game("which MTG cards are rising", context_game="pokemon", collection=("pokemon",))
        self.assertEqual((scope.game, scope.source), (None, "unsupported"))
        self.assertIn("no cards or prices", game_scope.scope_note(scope))

    def test_fallback_order(self) -> None:
        question = "which cards are rising the most"
        self.assertEqual(
            resolve_game(question, thread_game="lorcana", context_game="onepiece", collection=("gundam",)).source,
            "thread",
        )
        scope = resolve_game(question, context_game="onepiece", collection=("gundam",))
        self.assertEqual((scope.game, scope.source), ("onepiece", "context"))
        scope = resolve_game(question, context_game="chess", collection=("gundam", "pokemon"))
        self.assertEqual((scope.game, scope.source), ("gundam", "collection"))
        scope = resolve_game(question)
        self.assertEqual((scope.game, scope.source), ("pokemon", "default"))
        # Only a named game is remembered straight from resolution.
        self.assertEqual(resolve_game("one piece risers").remembered, "onepiece")
        self.assertIsNone(scope.remembered)

    def test_scope_note_names_the_game(self) -> None:
        note = game_scope.scope_note(resolve_game("x", context_game="onepiece"))
        self.assertIn("Game scope: One Piece", note)
        self.assertIn("**One Piece**", note)


@unittest.skipUnless(HAVE_DEPS, "anthropic / mcp not installed")
class EnforcementTests(unittest.TestCase):
    pokemon = GameScope("pokemon", "context") if HAVE_DEPS else None

    def test_omitted_or_any_game_is_injected(self) -> None:
        self.assertEqual(enforce_game("get_market_trends", {}, self.pokemon), ({"game": "pokemon"}, "pokemon"))
        args, game = enforce_game("find_top_graded", {"filter": {"game": "any", "product": "single"}}, self.pokemon)
        self.assertEqual((args["filter"], game), ({"game": "pokemon", "product": "single"}, "pokemon"))

    def test_model_game_overridden_unless_the_question_named_it(self) -> None:
        args, _ = enforce_game("get_market_trends", {"game": "lorcana"}, self.pokemon)
        self.assertEqual(args["game"], "pokemon")
        named = resolve_game("compare lorcana and one piece risers")
        args, game = enforce_game("get_market_trends", {"game": "onepiece"}, named)
        self.assertEqual((args["game"], game), ("onepiece", "onepiece"))

    def test_filter_game_moves_to_the_top_level_arg(self) -> None:
        # find_price_lows rejects game + filter.game disagreeing; one place only.
        args, _ = enforce_game("find_price_lows", {"filter": {"game": "riftbound", "product": "single"}}, self.pokemon)
        self.assertEqual(args, {"filter": {"product": "single"}, "game": "pokemon"})

    def test_specific_and_personal_calls_pass_through(self) -> None:
        cases = [
            ("find_price_lows", {"owned": "owned"}),
            ("find_new_highs", {"filter": {"set": "Evolving Skies"}}),
            ("find_movers", {"direction": "down", "filter": {"set": "Evolving Skies"}}),
            ("find_movers", {"direction": "up", "owned": "owned"}),
            ("search_cards", {"filter": {"text": "charizard"}, "sort": "price_desc"}),
            ("search_cards", {"filter": {"mood": ["cozy"]}}),
            ("get_my_collection", {"sort": "value_desc"}),
            ("get_card", {"card_id": "onepiece~OP01-120"}),
        ]
        for name, arguments in cases:
            self.assertEqual(enforce_game(name, arguments, self.pokemon), (arguments, None), name)
        # All games asked: nothing pinned.
        self.assertEqual(enforce_game("get_market_trends", {}, resolve_game("all games risers")), ({}, None))

    def test_whole_game_rankings_are_pinned(self) -> None:
        args, game = enforce_game(
            "find_movers", {"direction": "up", "filter": {"rarity_bucket": ["sir"]}}, self.pokemon
        )
        self.assertEqual((args["filter"]["game"], game), ("pokemon", "pokemon"))
        args, game = enforce_game("search_cards", {"filter": {"product": "single"}, "sort": "price_desc"}, self.pokemon)
        self.assertEqual((args["filter"]["game"], game), ("pokemon", "pokemon"))

    def test_switch_chip(self) -> None:
        scope = resolve_game("rising", collection=("pokemon", "onepiece"))
        chip = game_scope.switch_suggestion(scope, "pokemon")
        self.assertEqual(chip, "What about One Piece?")
        self.assertIsNone(game_scope.switch_suggestion(scope, None))
        self.assertIsNone(game_scope.switch_suggestion(resolve_game("rising", collection=("pokemon",)), "pokemon"))
        # The screen's game is the fallback for a user with one collection game.
        scope = resolve_game("rising", context_game="lorcana", collection=("pokemon",))
        self.assertEqual(game_scope.switch_suggestion(scope, "pokemon"), "What about Disney Lorcana?")
        merged = game_scope.with_switch_suggestion(
            ["Show Lorcana risers", "More Pokémon risers", "Is it worth grading?", "Add it to my Watchlist"],
            chip, "pokemon",
        )
        self.assertEqual(merged, ["More Pokémon risers", "Is it worth grading?", "What about One Piece?"])


@unittest.skipUnless(HAVE_DEPS, "anthropic / mcp not installed")
class GameScopeServiceTests(AssistantCase):
    RISING = "Which cards are rising the most?"

    def setUp(self) -> None:
        super().setUp()
        for card_id, name in (("onepiece~OP01-120", "Shanks"), ("onepiece~OP05-119", "Luffy"),
                              ("onepiece~OP02-013", "Ace")):
            self.card(card_id, name)
            self.conn.execute("UPDATE cards SET game = 'onepiece' WHERE id = ?", (card_id,))
        self.conn.commit()
        self.flags: list[str] = []
        flagger = mock.patch("mcp_server.assistant.service.flag_turn", side_effect=lambda *a: list(self.flags))
        flagger.start()
        self.addCleanup(flagger.stop)

    def queue_trends(self, args: dict | None = None, answer: str = "Top risers: Pikachu ex up 20%.",
                     tool: str = "get_market_trends") -> None:
        self.client.queue(
            message([tool_use(tool, args or {}, "t1")], "tool_use"),
            message([text(answer + "\n<followups>\nIs it worth grading?\nShow Lorcana risers\n</followups>")]),
        )

    def last_call_args(self, reply_id: str) -> list[str]:
        row = self.conn.execute("SELECT tool_calls_json FROM assistant_messages WHERE id = ?", (reply_id,)).fetchone()
        return json.loads(row[0])

    def first_prompt(self, index: int = -2) -> str:
        return content_text(self.client.messages.calls[index]["messages"][-1])

    def thread_game(self, thread_id: str) -> str | None:
        return self.conn.execute("SELECT game FROM assistant_threads WHERE id = ?", (thread_id,)).fetchone()[0]

    def test_context_game_scopes_and_is_remembered(self) -> None:
        self.queue_trends({"game": "lorcana"})  # the model guessed a game the question never named
        response = self.ask(self.RISING, context={"source": "home", "game": "onepiece"})
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertEqual(self.last_call_args(body["message"]["id"]), ["get_market_trends(game=onepiece)"])
        self.assertIn("Game scope: One Piece", self.first_prompt(0))
        self.assertEqual(self.thread_game(body["thread_id"]), "onepiece")
        # USER_A collects Pokémon: one chip switches to it; the model's own game switch is dropped.
        self.assertEqual(body["message"]["suggestions"], ["Is it worth grading?", "What about Pokémon?"])

    def test_thread_memory_beats_the_screen(self) -> None:
        self.queue_trends()
        first = self.ask("What One Piece cards are rising?").json()
        self.assertEqual(self.thread_game(first["thread_id"]), "onepiece")
        self.queue_trends(tool="find_price_lows", args={"filter": {"product": "single"}})
        second = self.ask("Which ones are undervalued?", thread_id=first["thread_id"],
                          context={"source": "home", "game": "pokemon"}).json()
        self.assertEqual(self.last_call_args(second["message"]["id"]),
                         ["find_price_lows(product=single, game=onepiece)"])
        # A later question naming another game switches the thread.
        self.queue_trends()
        third = self.ask("and lorcana?", thread_id=first["thread_id"]).json()
        self.assertEqual(self.last_call_args(third["message"]["id"]), ["get_market_trends(game=lorcana)"])
        self.assertEqual(self.thread_game(first["thread_id"]), "lorcana")

    def test_collection_majority_then_pokemon(self) -> None:
        # USER_B: one Pokémon entry, two One Piece entries -> One Piece.
        self.holding("b2", USER_B, "onepiece~OP01-120")
        self.holding("b3", USER_B, "onepiece~OP05-119", quantity=4)
        self.conn.commit()
        self.assertEqual(game_scope.collection_games(self.conn, USER_B), ("onepiece", "pokemon"))
        self.queue_trends()
        body = self.ask(self.RISING, user=USER_B).json()
        self.assertEqual(self.last_call_args(body["message"]["id"]), ["get_market_trends(game=onepiece)"])
        self.assertEqual(body["message"]["suggestions"][-1], "What about Pokémon?")
        # A guest skips the collection step: Pokémon, and no switch chip.
        self.queue_trends()
        guest = self.ask(self.RISING, user=GUEST, anonymous=True).json()
        self.assertEqual(self.last_call_args(guest["message"]["id"]), ["get_market_trends(game=pokemon)"])
        self.assertEqual(guest["message"]["suggestions"], ["Is it worth grading?"])

    def test_specific_card_questions_are_not_game_filtered(self) -> None:
        self.queue_trends(tool="search_cards", args={"filter": {"text": "shanks"}})
        body = self.ask("How much is Shanks?", context={"source": "home", "game": "pokemon"}).json()
        self.assertEqual(self.last_call_args(body["message"]["id"]), ["search_cards(text=shanks)"])
        self.assertIsNone(self.thread_game(body["thread_id"]))

    def test_context_game_validation(self) -> None:
        bad = self.ask(self.RISING, context={"source": "home", "game": 7})
        self.assertEqual(bad.status_code, 400)
        # A game this server doesn't know (newer app) is ignored, not rejected.
        self.queue_trends()
        body = self.ask(self.RISING, context={"source": "home", "game": "starwars"}).json()
        self.assertEqual(self.last_call_args(body["message"]["id"]), ["get_market_trends(game=pokemon)"])

    def test_shared_cache_is_scoped_by_game(self) -> None:
        with mock.patch.object(shared_answers, "data_version", side_effect=lambda conn: "v1"):
            self.queue_trends()
            first = self.ask(self.RISING, user=USER_A, context={"source": "home", "game": "pokemon"})
            self.assertEqual(first.status_code, 200)
            calls = len(self.client.messages.calls)
            self.assertEqual(self.count("assistant_shared_answers"), 1)
            # A One Piece asker never gets the Pokémon answer.
            self.queue_trends(answer="Top One Piece risers: Shanks up 30%.")
            second = self.ask(self.RISING, user=USER_B, context={"source": "home", "game": "onepiece"}).json()
            self.assertGreater(len(self.client.messages.calls), calls)
            self.assertIn("One Piece", second["message"]["text"])
            calls = len(self.client.messages.calls)
            # Another Pokémon asker replays it, with their own switch chip and thread game.
            self.holding("b2", USER_B, "onepiece~OP01-120")
            self.conn.commit()
            third = self.ask(self.RISING, user=USER_B, context={"source": "home", "game": "pokemon"}).json()
            self.assertEqual(len(self.client.messages.calls), calls)
            self.assertEqual(third["message"]["text"], first.json()["message"]["text"])
            self.assertEqual(third["message"]["suggestions"], ["Is it worth grading?", "What about One Piece?"])
            self.assertEqual(self.thread_game(third["thread_id"]), "pokemon")


if __name__ == "__main__":
    unittest.main()
