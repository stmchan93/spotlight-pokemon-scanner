"""Owner decision 2026-11-20: chat answers never reveal how much price history
Ekalight has, and never claim a window the data doesn't cover."""

from __future__ import annotations

import asyncio
import json
import sys
import unittest
from pathlib import Path
from typing import Any

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))
if str(BACKEND_ROOT / "tests") not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT / "tests"))

from test_mcp_assistant import HAVE_DEPS, USER_A, AssistantCase, FakeClient, message, text, tool_use  # noqa: E402

from mcp_server.assistant import length_guard  # noqa: E402

if HAVE_DEPS:
    from mcp_server.assistant.engine import SYSTEM_PROMPT, AssistantEngine
    from mcp_server.assistant.tools import TOOL_DEFINITIONS, AssistantToolbox

OWNER_EXAMPLE = (
    "Umbreon VMAX, Giratina V and Lugia V sit near their lows, 40-60% below their highs. That said, these cards "
    "only have 30-61 days of history so the 'low' covers that stretch and the old highs may have been short-lived "
    "spikes.\n\nThis is past price data, not a prediction."
)
COVERAGE_SENTENCES = (
    "These cards only have 30-61 days of history.",
    "Price history starts in August.",
    "Its history only goes back to September.",
    "That's the closest window I can check.",
    "It's not a full year of data.",
    "The old highs may have been short-lived spikes.",
    "Ekalight only has 45 days for it.",
    "This card has limited history.",
    "The data begins on Sep 2.",
)
LEGIT_SENTENCES = (
    "Charizard ex jumped on Oct 28 to $420.",
    "It fell from $374 on Aug 22 to $288 on Nov 18.",
    "It's at its lowest recorded price.",
    "It's up 12% over the past year.",
    "Pikachu ex has been sliding lately.",
)


class CoverageBackstopTests(unittest.TestCase):
    def test_coverage_phrases_flagged(self) -> None:
        for sentence in COVERAGE_SENTENCES:
            self.assertTrue(length_guard.has_coverage_disclosure(sentence), sentence)
            self.assertTrue(length_guard.has_internal_wording(sentence), sentence)

    def test_dated_moves_and_neutral_wording_untouched(self) -> None:
        for sentence in LEGIT_SENTENCES:
            self.assertFalse(length_guard.has_internal_wording(sentence), sentence)
            self.assertEqual(length_guard.drop_internal_sentences(sentence), sentence)

    def test_owner_example_sentence_dropped_disclaimer_kept(self) -> None:
        out = length_guard.drop_internal_sentences(OWNER_EXAMPLE)
        self.assertFalse(length_guard.has_coverage_disclosure(out))
        self.assertTrue(out.startswith("Umbreon VMAX, Giratina V and Lugia V sit near their lows"))
        self.assertNotIn("That said", out)
        self.assertIn("not a prediction", out)

    def test_rewrite_instruction_names_coverage(self) -> None:
        self.assertIn("how much price history exists", length_guard.NO_INTERNAL_INSTRUCTION)
        self.assertIn("how much price history exists", length_guard.REWRITE_INTERNAL_ONLY)

    def test_eval_default_ban_matches_the_backstop(self) -> None:
        import re

        import yaml

        cases = yaml.safe_load((BACKEND_ROOT / "assistant_eval" / "cases.yaml").read_text())
        pattern = cases["defaults"]["banned"]["history_coverage"]
        self.assertTrue(re.search(pattern, OWNER_EXAMPLE, re.IGNORECASE))
        for sentence in LEGIT_SENTENCES + ("I couldn't find any price history for it.",):
            self.assertIsNone(re.search(pattern, sentence, re.IGNORECASE), sentence)

    def test_never_empty(self) -> None:
        only = "Price history starts in August."
        self.assertTrue(length_guard.drop_internal_sentences(only).strip())


@unittest.skipUnless(HAVE_DEPS, "assistant deps missing")
class CoveragePromptTests(unittest.TestCase):
    def test_rule_present_and_no_coverage_instruction(self) -> None:
        self.assertIn("never say how much price history Ekalight has", SYSTEM_PROMPT)
        self.assertIn("window_label", SYSTEM_PROMPT)
        for phrase in ("days_covered", "covers_full_range", "covers_full_window", "how much history it covers",
                       "say the span the data covers", 'say e.g. "since April"'):
            self.assertNotIn(phrase, SYSTEM_PROMPT, phrase)

    def test_tool_descriptions_drop_coverage_fields(self) -> None:
        blob = json.dumps([tool["description"] for tool in TOOL_DEFINITIONS])
        for phrase in ("days_covered", "covers_full_range", "covers_full_window", "say how much it covers"):
            self.assertNotIn(phrase, blob, phrase)
        self.assertIn("window_label", blob)


@unittest.skipUnless(HAVE_DEPS, "assistant deps missing")
class CoverageEngineTests(AssistantCase):
    def run_turn(self, answer: str, *extra: Any) -> Any:
        client = FakeClient([
            message([tool_use("find_price_lows", {}, "t1")], "tool_use"),
            message([text(answer)]),
            *extra,
        ])
        engine = AssistantEngine(self.config, AssistantToolbox(self.tools), client)
        return asyncio.run(engine.run_turn(owner_user_id=USER_A, history=[], question="Undervalued cards"))

    def test_owner_example_stripped_when_rewrite_fails(self) -> None:
        turn = self.run_turn(OWNER_EXAMPLE, RuntimeError("no rewrite"))
        self.assertFalse(length_guard.has_coverage_disclosure(turn.text))
        self.assertIn("not a prediction", turn.text)
        self.assertIn("Umbreon VMAX", turn.text)

    def test_rewrite_that_still_discloses_is_rejected(self) -> None:
        turn = self.run_turn(OWNER_EXAMPLE, message([text(
            "Umbreon VMAX, Giratina V and Lugia V sit near their lows; history starts in October. "
            "This is past price data, not a prediction.")]))
        self.assertNotEqual(turn.length_guard, "rewrite")
        self.assertFalse(length_guard.has_coverage_disclosure(turn.text))


if __name__ == "__main__":
    unittest.main()
