"""Natural-language search (POST /api/v1/assistant/search): model interpretation -> validated
filter -> search_cards rows shaped like /api/v1/cards/search, server-built chips, the
no-LLM direct path, flag/cap/fallback behavior. Fake Anthropic client, no network."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT / "tests") not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT / "tests"))

from test_mcp_assistant import (  # noqa: E402
    GUEST, HAVE_DEPS, USER_A, AssistantCase, bearer, message, text, tool_use,
)

if HAVE_DEPS:
    from mcp_server.assistant.smart_search import (
        TOOL_NAME, build_chips, effective_intent, sanitize_interpretation,
    )
    from mcp_server.assistant.store import utc_day


def interpret(intent: str = "search", **fields):
    return message([tool_use(TOOL_NAME, {"intent": intent, **fields})], stop_reason="tool_use",
                   input_tokens=600, output_tokens=40)


@unittest.skipUnless(HAVE_DEPS, "anthropic / mcp not installed")
class SmartSearchTests(AssistantCase):
    def build(self, **overrides):
        overrides.setdefault("search_enabled", True)
        super().build(**overrides)

    def search(self, body: dict, *, user: str = USER_A, **token_kwargs):
        return self.http.post("/api/v1/assistant/search", json={"game": "pokemon", "limit": 10, **body},
                              headers=bearer(user, **token_kwargs))

    def test_query_is_interpreted_searched_and_chipped(self) -> None:
        self.client.queue(interpret(filter={"text": "Charizard", "price_max_usd": 50}, sort="price_asc"))
        response = self.search({"query": "cheap charizard under $50"})
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["intent"], "search")
        self.assertEqual(body["interpretation"], {
            "filter": {"text": "Charizard", "price_max_usd": 50.0}, "owned": "any", "sort": "price_asc",
        })
        self.assertEqual([chip["label"] for chip in body["chips"]], ["Charizard", "Under $50", "Cheapest first"])
        self.assertEqual([chip["field"] for chip in body["chips"]], ["text", "price_max_usd", "sort"])
        # Same row shape as /api/v1/cards/search: catalog fields + attached pricing.
        self.assertEqual([row["id"] for row in body["results"]], ["ssp-2"])
        self.assertEqual(body["results"][0]["name"], "Charizard ex")
        self.assertIn("pricing", body["results"][0])
        call = self.client.messages.calls[0]
        self.assertEqual(call["tool_choice"], {"type": "tool", "name": TOOL_NAME})
        self.assertEqual(call["model"], "claude-haiku-5-5")
        # The LLM cost lands in the spend-cap ledger without counting a chat question.
        used, cost = self.assistant.store.usage_row(USER_A, utc_day())
        self.assertEqual(used, 0)
        self.assertGreater(cost, 0)

    def test_direct_interpretation_makes_no_llm_call(self) -> None:
        response = self.search({"interpretation": {"filter": {"text": "Pikachu"}, "owned": "owned", "sort": "relevance"}})
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["intent"], "search")
        self.assertEqual([row["id"] for row in body["results"]], ["ssp-1"])
        self.assertEqual([chip["id"] for chip in body["chips"]], ["text", "owned"])
        self.assertEqual(self.client.messages.calls, [])

    def test_flag_off_is_404(self) -> None:
        self.build(search_enabled=False)
        response = self.search({"query": "eevee alt arts under $50"})
        self.assertEqual(response.status_code, 404)
        self.assertEqual(self.client.messages.calls, [])

    def test_unauthenticated_is_401(self) -> None:
        self.assertEqual(self.http.post("/api/v1/assistant/search", json={"query": "x"}).status_code, 401)

    def test_daily_limit_falls_back_to_plain(self) -> None:
        self.build(search_daily_limit=1)
        self.client.queue(interpret(filter={"text": "Eevee", "price_max_usd": 50}))
        self.assertEqual(self.search({"query": "eevee under $50"}).json()["intent"], "search")
        second = self.search({"query": "pikachu under $10"}).json()
        self.assertEqual(second["intent"], "plain")
        self.assertEqual(len(self.client.messages.calls), 1)
        # Cached interpretations cost nothing, so they still work past the cap.
        self.assertEqual(self.search({"query": "Eevee  under $50"}).json()["intent"], "search")
        self.assertEqual(len(self.client.messages.calls), 1)

    def test_spend_cap_falls_back_to_plain(self) -> None:
        self.build(daily_spend_cap_usd=0.0)
        body = self.search({"query": "eevee alt arts under $50"}).json()
        self.assertEqual(body, {"intent": "plain", "interpretation": None, "chips": [], "results": [], "nextCursor": None})
        self.assertEqual(self.client.messages.calls, [])

    def test_bad_model_output_falls_back(self) -> None:
        self.client.queue(message([text("Sure! Here's a search.")]))
        self.assertEqual(self.search({"query": "eevee alt arts under $50"}).json()["intent"], "plain")
        self.client.queue(RuntimeError("boom"))
        self.assertEqual(self.search({"query": "pikachu promos from 2023"}).json()["intent"], "plain")

    def test_invalid_fields_are_dropped_not_fatal(self) -> None:
        self.client.queue(interpret(
            filter={"text": "Eevee", "rarity_bucket": ["mythic"], "price_min_usd": -5, "scene": ["moon"],
                    "weather_time": ["rain"], "bogus": 1},
            sort="sideways",
        ))
        body = self.search({"query": "eevee in the rain"}).json()
        self.assertEqual(body["interpretation"], {
            "filter": {"text": "Eevee", "weather_time": ["rain"]}, "owned": "any", "sort": "relevance",
        })

    def test_question_and_plain_intents_pass_through(self) -> None:
        self.client.queue(interpret("question"))
        body = self.search({"query": "what are my best cards to grade right now"}).json()
        self.assertEqual((body["intent"], body["results"]), ("question", []))
        # A bare name is plain even if the model called it a search.
        self.client.queue(interpret(filter={"text": "Umbreon VMAX"}))
        self.assertEqual(self.search({"query": "the umbreon vmax card"}).json()["intent"], "plain")

    def test_guest_owned_filter_is_dropped(self) -> None:
        body = self.search(
            {"interpretation": {"filter": {"text": "Eevee"}, "owned": "owned", "sort": "price_asc"}},
            user=GUEST, anonymous=True,
        ).json()
        self.assertEqual(body["interpretation"]["owned"], "any")
        self.assertNotIn("owned", [chip["field"] for chip in body["chips"]])

    def test_bad_requests(self) -> None:
        self.assertEqual(self.search({"limit": 10}).status_code, 400)
        self.assertEqual(self.search({"query": "x", "limit": 99}).status_code, 400)
        self.assertEqual(self.search({"query": "x", "game": "mtg"}).status_code, 400)


@unittest.skipUnless(HAVE_DEPS, "anthropic / mcp not installed")
class SmartSearchUnitTests(unittest.TestCase):
    def test_chip_labels(self) -> None:
        interpretation = sanitize_interpretation({
            "filter": {"text": "Eevee", "rarity_bucket": ["illustration", "sir"], "language": "japanese",
                       "artist": "Mitsuhiro Arita", "price_min_usd": 20, "price_max_usd": 49.5, "game": "onepiece"},
            "owned": "not_owned", "sort": "price_desc",
        })
        labels = [chip["label"] for chip in build_chips(interpretation, request_game="pokemon")]
        self.assertEqual(labels, [
            "Eevee", "Alt art", "by Mitsuhiro Arita", "Japanese", "One Piece", "Over $20", "Under $49.50",
            "Not owned", "Priciest first",
        ])
        # The scoped game is not a chip; the app's game chips already show it.
        self.assertNotIn("game", [c["field"] for c in build_chips(interpretation, request_game="onepiece")])

    def test_art_fields_dropped_outside_pokemon_singles(self) -> None:
        interpretation = sanitize_interpretation({"filter": {"text": "Luffy", "game": "onepiece", "mood": ["cozy"]}})
        self.assertEqual(interpretation["filter"], {"text": "Luffy", "game": "onepiece"})

    def test_min_over_max_drops_the_range(self) -> None:
        interpretation = sanitize_interpretation({"filter": {"text": "Mew", "price_min_usd": 90, "price_max_usd": 10}})
        self.assertEqual(interpretation["filter"], {"text": "Mew"})

    def test_effective_intent(self) -> None:
        self.assertEqual(effective_intent("nonsense", sanitize_interpretation({})), "plain")
        self.assertEqual(effective_intent("search", sanitize_interpretation({"filter": {"language": "Japanese"}})), "plain")
        self.assertEqual(effective_intent("search", sanitize_interpretation({"sort": "price_desc",
                                                                             "filter": {"text": "Charizard"}})), "search")


if __name__ == "__main__":
    unittest.main()
