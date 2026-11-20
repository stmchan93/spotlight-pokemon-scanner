"""Eval round 8: art-search tiles (one per artwork across languages, at most 3),
artwork descriptions for the judge, and sentence caps for narrowing and art turns."""

from __future__ import annotations

import asyncio
import sys
import unittest
from pathlib import Path
from typing import Any

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT / "tests") not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT / "tests"))
# backend/ first so the assistant_eval package wins over tools/assistant_eval.py.
sys.path.insert(0, str(BACKEND_ROOT))
if not hasattr(sys.modules.get("assistant_eval", sys), "__path__"):
    sys.modules.pop("assistant_eval", None)

from assistant_eval import grading  # noqa: E402
from test_mcp_assistant import HAVE_DEPS, USER_A, FakeClient, message, text, tool_use  # noqa: E402

from mcp_server.assistant import length_guard  # noqa: E402

if HAVE_DEPS:
    from test_mcp_assistant_tiles import TilesCase

    from mcp_server.assistant.engine import AssistantEngine
    from mcp_server.assistant.tools import MAX_ART_TILES, AssistantToolbox, art_search_tiles, artwork_groups
else:  # pragma: no cover
    TilesCase = unittest.TestCase  # type: ignore[assignment,misc]

# Turn 2 of pokemon_priciest_then_singles, eval_7 repeat 1: two long compound
# sentences that the judge read as three.
EVAL7_SINGLES = (
    "The priciest single raw cards are Umbreon (Skyridge H30/H32) at $4,999.99 and Shining Charizard "
    "(Neo Destiny 107/105) at $3,998.99. The top graded singles are a PSA 10 1st Edition Shadowless Holofoil "
    "Charizard (Base 4/102) at about $409,540 and a PSA 10 Holofoil Pikachu ☆ (Holon Phantoms 104/110) at "
    "about $113,700."
)
# vibe_sleeping, eval_7 repeat 3.
EVAL7_SLEEPING = (
    "Best starting points for cozy sleeping Pokémon: Cyndaquil (BREAKthrough 18/162, $1.14), Meowth "
    "(Unbroken Bonds 147/214, $2.37), and Cosmoem (Celebrations 14, $0.24). Priciest English match: Bianca's "
    "Devotion (Temporal Forces 209/162, $26.30). Skwovet (Scarlet & Violet 222/198, $8.28) is another good pick."
)
SINGLES_Q = "Show only single cards, not sealed"
SINGLES_TOOLS = ["search_cards", "find_top_graded"]


class SentenceCapTests(unittest.TestCase):
    def test_eval7_singles_answer_is_over_the_narrowing_cap(self) -> None:
        self.assertEqual(length_guard.turn_kind(SINGLES_Q, SINGLES_TOOLS), "narrowing")
        limit = length_guard.limit_for(SINGLES_Q, SINGLES_TOOLS)
        sentences = length_guard.sentence_limit_for(SINGLES_Q, SINGLES_TOOLS)
        self.assertEqual((limit, sentences), (40, 2))
        self.assertEqual(length_guard.sentence_count(EVAL7_SINGLES), 2)
        self.assertTrue(length_guard.over_limit(EVAL7_SINGLES, limit, sentences))
        trimmed = length_guard.trim_to_limit(EVAL7_SINGLES, limit, sentences)
        self.assertLessEqual(length_guard.sentence_count(trimmed), 2)
        self.assertLessEqual(length_guard.word_count(trimmed), limit)
        self.assertTrue(trimmed.startswith("The priciest single raw cards are Umbreon"))

    def test_bullet_lines_count_as_sentences(self) -> None:
        bullets = "Top singles:\n- Umbreon at $4,999.99\n- Shining Charizard at $3,998.99\n* Lugia at $2,000.00"
        self.assertEqual(length_guard.sentence_count(bullets), 4)
        self.assertTrue(length_guard.over_limit(bullets, 40, 2))
        trimmed = length_guard.trim_to_limit(bullets, 40, 2)
        self.assertLessEqual(length_guard.sentence_count(trimmed), 2)

    def test_numbered_list_marker_is_not_a_sentence(self) -> None:
        self.assertEqual(length_guard.sentence_count("1. Umbreon at $4,999.99\n2. Shining Charizard at $3,998.99"), 2)
        self.assertEqual(length_guard.sentence_count("Pikachu is No. 1. It costs $5."), 2)

    def test_art_search_turns_cap_at_two_sentences(self) -> None:
        q, tools = "Show me cozy cards with Pokémon sleeping", ["list_facets", "search_cards"]
        self.assertEqual(length_guard.turn_kind(q, tools, art_search=True), "art_search")
        self.assertEqual(length_guard.sentence_limit_for(q, tools, art_search=True), 2)
        self.assertEqual(length_guard.sentence_count(EVAL7_SLEEPING), 3)
        limit = length_guard.limit_for(q, tools, art_search=True)
        trimmed = length_guard.trim_to_limit(EVAL7_SLEEPING, limit, 2)
        self.assertEqual(length_guard.sentence_count(trimmed), 2)
        self.assertTrue(trimmed.startswith("Best starting points"))


@unittest.skipUnless(HAVE_DEPS, "anthropic / mcp not installed")
class ArtTileTests(TilesCase):
    def _seed(self) -> None:
        super()._seed()
        self.card("ssp-5", "Snorlax", number="5")
        self.card("ssp-6", "Munchlax", number="6")
        # An EN/JP pair tagged as two groups (tagged before its language link landed).
        self.card("ssp-7", "Poliwhirl", number="176")
        self.card("jp-poli", "Poliwhirl", number="176")
        self.conn.execute("UPDATE cards SET language = 'Japanese' WHERE id = 'jp-poli'")
        import tag_card_art

        tag_card_art.write_tagged_groups(
            self.conn,
            [{"art_group_id": "g-poli-en", "representative_card_id": "ssp-7", "members": {"ssp-7": "self"},
              "tags": {}, "rows": [("weather_time", "rain", None, 0.9)], "alt_text": "Poliwhirl on a rainy street."},
             {"art_group_id": "g-poli-jp", "representative_card_id": "jp-poli", "members": {"jp-poli": "self"},
              "tags": {}, "rows": [("weather_time", "rain", None, 0.9)], "alt_text": "Poliwhirl on a rainy street."}],
            model="test",
        )
        self.conn.execute(
            "INSERT INTO card_language_links (card_id, counterpart_card_id, counterpart_language, match_method, "
            "created_at) VALUES ('ssp-7', 'jp-poli', 'Japanese', 'test', '2026-11-20')"
        )
        self.conn.commit()

    def test_language_link_merges_separately_tagged_groups(self) -> None:
        groups = artwork_groups(self.conn, ["ssp-7", "jp-poli", "ssp-1", "jp-1", "ssp-3"])
        self.assertEqual(groups["ssp-7"], groups["jp-poli"])
        self.assertEqual(groups["ssp-1"], groups["jp-1"])
        self.assertNotEqual(groups["ssp-1"], groups["ssp-3"])

    def test_art_tiles_keep_one_artwork_english_first(self) -> None:
        tiles = [
            {"card_id": "jp-poli", "name": "Poliwhirl", "language": "Japanese"},
            {"card_id": "ssp-7", "name": "Poliwhirl"},
            {"card_id": "ssp-3", "name": "Eevee"},
        ]
        groups = {"jp-poli": "g", "ssp-7": "g"}
        out = art_search_tiles(tiles, groups, question="Find cards with rainy night art", text="Poliwhirl and Eevee.")
        self.assertEqual([t["card_id"] for t in out], ["ssp-7", "ssp-3"])
        out = art_search_tiles(tiles, groups, question="Japanese cards with rainy art", text="Poliwhirl.")
        self.assertEqual(out[0]["card_id"], "jp-poli")

    def test_art_tiles_cap_at_three_named_first(self) -> None:
        tiles = [{"card_id": f"c{i}", "name": name} for i, name in enumerate(["Oddish", "Lapras", "Snorlax", "Eevee", "Munchlax"])]
        out = art_search_tiles(tiles, {}, question="cozy cards", text="Munchlax and Eevee are the coziest.")
        self.assertEqual(len(out), MAX_ART_TILES)
        self.assertEqual([t["name"] for t in out], ["Munchlax", "Eevee", "Oddish"])

    def tiles_for(self, refs: list[dict[str, Any]], text_value: str, question: str, **kwargs: Any) -> list[str]:
        cards, _, _, _ = AssistantToolbox(self.tools).build_tiles(
            owner_user_id=USER_A, turn_refs=refs, selection=None, label=None, text=text_value, charts=[],
            watchlist_ids=set(), watchlist_total=None, sparkline_windows={}, question=question,
            tools_used={"search_cards"}, **kwargs,
        )
        return [card["card_id"] for card in cards]

    def test_build_tiles_for_art_search(self) -> None:
        refs = [
            {"card_id": "ssp-7", "name": "Poliwhirl", "number": "176"},
            {"card_id": "jp-poli", "name": "Poliwhirl", "number": "176", "language": "Japanese"},
            {"card_id": "ssp-3", "name": "Eevee", "number": "3"},
            {"card_id": "ssp-5", "name": "Snorlax", "number": "5"},
            {"card_id": "ssp-6", "name": "Munchlax", "number": "6"},
        ]
        answer = "Poliwhirl, Eevee, Snorlax and Munchlax show rainy streets."
        self.assertEqual(self.tiles_for(refs, answer, "Find cards with rainy night art", art_search=True),
                         ["ssp-7", "ssp-3", "ssp-5"])
        # Not an art search: no art cap.
        self.assertEqual(len(self.tiles_for(refs, answer, "Find cards with rainy night art")), 4)

    def test_counterpart_question_keeps_the_pair(self) -> None:
        refs = [{"card_id": "ssp-7", "name": "Poliwhirl", "number": "176"},
                {"card_id": "jp-poli", "name": "Poliwhirl", "number": "176", "language": "Japanese"}]
        ids = self.tiles_for(refs, "The Japanese version is Poliwhirl 176.", "Is there a Japanese version of this rainy Poliwhirl?",
                         art_search=True, language_pairs={"ssp-7": "jp-poli"}, keep_ids={"ssp-7"})
        self.assertIn("jp-poli", ids)

    def test_engine_trims_art_answer_to_two_sentences_and_three_tiles(self) -> None:
        client = FakeClient([
            message([tool_use("search_cards", {"filter": {"weather_time": ["rain"]}}, "s1")], "tool_use"),
            message([text("Poliwhirl shows a rainy street. Poliwhirl is also out in Japan. It is a cozy pick.")]),
            RuntimeError("no rewrite"),
        ])
        engine = AssistantEngine(self.config, AssistantToolbox(self.tools), client)
        turn = asyncio.run(engine.run_turn(owner_user_id=USER_A, history=[], question="Find cards with rainy night art"))
        self.assertEqual(turn.sentence_limit, 2)
        self.assertEqual(length_guard.sentence_count(turn.text), 2)
        self.assertEqual([card["card_id"] for card in turn.cards], ["ssp-7"])


class JudgeArtworkTests(unittest.TestCase):
    DATA = {"results": [
        {"card_id": "sv3pt5-176", "name": "Poliwhirl", "set": "151", "number": "176/165", "price_usd": 33.59},
        {"card_id": "bw5-61", "name": "Umbreon", "set": "Dark Explorers", "number": "61/108", "price_usd": 19.04},
    ]}

    def test_attach_artwork_adds_descriptions_without_mutating(self) -> None:
        alt = {"sv3pt5-176": "Poliwhirl stands on a   rain-soaked city street at night."}
        out = grading.attach_artwork(self.DATA, alt.get)
        self.assertEqual(out["results"][0]["artwork"], "Poliwhirl stands on a rain-soaked city street at night.")
        self.assertNotIn("artwork", out["results"][1])
        self.assertNotIn("artwork", self.DATA["results"][0])
        self.assertEqual(grading.attach_artwork([1, 2], alt.get), [1, 2])

    def test_compact_judge_context_shows_artwork(self) -> None:
        data = grading.attach_artwork(self.DATA, {"sv3pt5-176": "Poliwhirl on a rainy city street."}.get)
        record = {"answer": "Poliwhirl shows a rainy street.", "tool_results": [
            {"name": "search_cards", "call": "search_cards(weather_time=rain)", "is_error": False, "data": data},
        ]}
        compact = grading.compact_tool_results(record)
        self.assertIn("artwork: Poliwhirl on a rainy city street.", compact)
        self.assertNotIn("artwork=", compact)


if __name__ == "__main__":
    unittest.main()
