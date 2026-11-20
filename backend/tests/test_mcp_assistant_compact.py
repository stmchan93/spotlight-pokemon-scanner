"""Compact tool_result serialization for the model (input-token cost): heavy
fields dropped, answer fields and prompt-referenced keys kept, charts and tiles
still built from the full results."""

from __future__ import annotations

import json
import re
import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))
if str(BACKEND_ROOT / "tests") not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT / "tests"))

from catalog_tools import utc_now  # noqa: E402
from mcp_server.assistant.compact import MAX_HISTORY_POINTS, compact_result, model_payload  # noqa: E402
from test_mcp_assistant import HAVE_DEPS, AssistantCase, message, text, tool_use  # noqa: E402

# Real recorded results from eval round 8 (one per tool; judge-only artwork removed).
FIXTURE = BACKEND_ROOT / "tests" / "fixtures" / "assistant_tool_results_eval8.json"
SAMPLES: list[dict[str, Any]] = json.loads(FIXTURE.read_text())

CARD_FIELDS = ("card_id", "name", "set", "number", "rarity_bucket")
# Prompt/description words deliberately not sent: excluded prices must never be quoted, and
# propose_update_holding takes holding_id only "from get_my_collection or get_card my_holdings".
INTENTIONALLY_DROPPED = {"listed_price_usd"}
DROPPED_FOR_TOOL = {("get_portfolio_summary", "holding_id")}


def sample(tool: str) -> dict[str, Any]:
    return next(item for item in SAMPLES if item["tool"] == tool)


def compact(tool: str) -> dict[str, Any]:
    item = sample(tool)
    return json.loads(model_payload(tool, item["content"], item["arguments"]))


def keys_in(value: Any, found: dict[str, list[Any]] | None = None) -> dict[str, list[Any]]:
    found = {} if found is None else found
    if isinstance(value, dict):
        for key, item in value.items():
            found.setdefault(key, []).append(item)
            keys_in(item, found)
    elif isinstance(value, list):
        for item in value:
            keys_in(item, found)
    return found


def baseline(content: Any) -> str:
    return json.dumps(content, default=str, separators=(",", ":"))


class CompactPerToolTests(unittest.TestCase):
    def test_every_tool_has_a_sample(self) -> None:
        self.assertEqual(len({item["tool"] for item in SAMPLES}), 17)

    def test_list_items_keep_answer_fields(self) -> None:
        for tool, list_key in (("search_cards", "results"), ("find_missing", "missing"), ("get_my_collection", "items"),
                               ("get_my_watchlist", "items"), ("find_price_lows", "cards"), ("find_new_highs", "cards"),
                               ("find_top_graded", "cards"), ("get_market_trends", "rising_cards"),
                               ("grading_upside", "cards")):
            with self.subTest(tool=tool):
                full = sample(tool)["content"][list_key]
                small = compact(tool)[list_key]
                self.assertEqual([i["card_id"] for i in small], [i["card_id"] for i in full])
                for before, after in zip(full, small):
                    for field in CARD_FIELDS + ("price_usd", "variant", "grader", "grade", "quantity", "value_usd",
                                                "change_usd", "change_pct", "target_price_usd", "days_covered"):
                        if before.get(field) not in (None, ""):
                            self.assertIn(field, after, (tool, field))
                            if isinstance(before[field], float):
                                self.assertAlmostEqual(after[field], before[field], places=2)

    def test_heavy_fields_dropped(self) -> None:
        for item in SAMPLES:
            small = keys_in(compact_result(item["tool"], item["content"], item["arguments"]))
            for key in ("image_small_url", "app_url", "tcgplayer_id", "buy_links", "sources", "price_trust_reason",
                        "listed_price_usd"):
                self.assertNotIn(key, small, (item["tool"], key))
            if item["tool"] != "get_card":
                self.assertNotIn("set_code", small, item["tool"])
            self.assertNotIn("tcgplayer", small.get("price_source", []), item["tool"])
        self.assertNotIn("holding_id", keys_in(compact("get_portfolio_summary")))
        self.assertNotIn("artist", keys_in(compact("get_my_watchlist")))

    def test_nulls_dropped_except_meaningful_ones(self) -> None:
        small = compact_result("search_cards", {"results": [
            {"card_id": "a", "name": "A", "price_usd": None, "grader": None, "number": "", "similar": []},
        ], "next_cursor": None, "ambiguous": False})
        self.assertEqual(small, {"results": [{"card_id": "a", "name": "A", "price_usd": None}], "ambiguous": False})
        self.assertIn('"language_pair":null', model_payload("get_card", {"card_id": "x", "language_pair": None}))
        self.assertEqual(compact_result("get_my_watchlist", {"items": []}), {"items": []})

    def test_holding_ids_kept_where_updates_come_from(self) -> None:
        full = sample("get_my_collection")["content"]["items"]
        self.assertEqual([i["holding_id"] for i in compact("get_my_collection")["items"]], [i["holding_id"] for i in full])
        card = compact_result("get_card", {"card_id": "x", "my_holdings": [{"holding_id": "h1", "quantity": 1}]})
        self.assertEqual(card["my_holdings"], [{"holding_id": "h1", "quantity": 1}])

    def test_floats_rounded_and_timestamps_dated(self) -> None:
        small = compact_result("get_my_watchlist", {"items": [
            {"card_id": "a", "price_usd": 12.34567, "watched_at": "2026-10-19T06:53:48.028010+00:00"}]})
        self.assertEqual(small["items"][0], {"card_id": "a", "price_usd": 12.35, "watched_at": "2026-10-19"})

    def test_artist_only_for_artist_searches_and_card_page(self) -> None:
        content = {"results": [{"card_id": "a", "artist": "Mitsuhiro Arita"}]}
        self.assertNotIn("artist", compact_result("search_cards", content, {"filter": {"text": "pikachu"}})["results"][0])
        self.assertIn("artist", compact_result("search_cards", content, {"filter": {"artist": "Arita"}})["results"][0])
        self.assertIn("artist", compact("get_card"))

    def test_shared_language_sent_once(self) -> None:
        small = compact("search_cards")
        langs = {i.get("language") for i in sample("search_cards")["content"]["results"]}
        if len(langs) == 1:
            self.assertEqual(small["all_results"], {"language": langs.pop()})
            self.assertTrue(all("language" not in i for i in small["results"]))
        mixed = compact_result("search_cards", {"results": [
            {"card_id": "a", "language": "English"}, {"card_id": "b", "language": "Japanese"},
            {"card_id": "c", "language": "English"}]})
        self.assertNotIn("all_results", mixed)
        self.assertEqual([i["language"] for i in mixed["results"]], ["English", "Japanese", "English"])

    def test_price_history_sampled_with_summary_and_steps(self) -> None:
        full = sample("get_price_history")["content"]
        small = compact("get_price_history")
        self.assertGreater(len(full["points"]), MAX_HISTORY_POINTS)
        self.assertLessEqual(len(small["points"]), MAX_HISTORY_POINTS)
        self.assertEqual(small["points"][0], full["points"][0])
        self.assertEqual(small["points"][-1], full["points"][-1])
        self.assertEqual(small["point_count"], len(full["points"]))
        self.assertEqual(small["low"]["usd"], min(p["usd"] for p in full["points"]))
        self.assertEqual(small["high"]["usd"], max(p["usd"] for p in full["points"]))
        self.assertIn(small["low"], small["points"])
        self.assertIn(small["high"], small["points"])
        self.assertLessEqual(len(small["largest_steps"]), 3)
        steps = [abs(b["usd"] - a["usd"]) for a, b in zip(full["points"], full["points"][1:])]
        self.assertAlmostEqual(abs(small["largest_steps"][0]["change_usd"]), max(steps), places=2)
        for key in ("summary", "first_date", "last_date", "first_usd", "last_usd", "covers_full_range", "card_id"):
            self.assertEqual(small[key], full[key], key)

    def test_short_history_untouched(self) -> None:
        content = {"card_id": "a", "points": [{"date": "2026-11-01", "usd": 1.0}, {"date": "2026-11-02", "usd": 2.0}]}
        self.assertEqual(compact_result("get_price_history", content)["points"], content["points"])

    def test_card_artwork_values_without_confidences(self) -> None:
        small = compact("get_card")
        full = sample("get_card")["content"]
        self.assertEqual(small["alt_text"], full["alt_text"])
        self.assertEqual(small["artwork"]["mood"], [m["value"] for m in full["artwork"]["mood"]])
        self.assertNotIn("confidence", json.dumps(small["artwork"]))

    def test_top_graded_excluded_keeps_reason_not_price(self) -> None:
        small = compact("find_top_graded")
        self.assertTrue(small["excluded_untrusted"])
        for item in small["excluded_untrusted"]:
            self.assertEqual(set(item) - {"label", "grader", "grade", "reason"}, set())
        self.assertTrue(all("price_verified" in card for card in small["cards"]))

    def test_list_facets_values_only(self) -> None:
        small = compact("list_facets")
        full = sample("list_facets")["content"]
        self.assertEqual(small["facets"]["scene"], [f["value"] for f in full["facets"]["scene"]])
        self.assertEqual([t["id"] for t in small["themes"]], [t["id"] for t in full["themes"]])

    def test_errors_and_proposals_pass_through(self) -> None:
        self.assertEqual(json.loads(model_payload("get_card", {"error": "Card not found: x."})), {"error": "Card not found: x."})
        proposal = sample("propose_watch_card")["content"]
        self.assertEqual(compact("propose_watch_card"), proposal)

    def test_prompt_referenced_fields_preserved(self) -> None:
        if not HAVE_DEPS:
            self.skipTest("assistant deps missing")
        from mcp_server.assistant.engine import SYSTEM_PROMPT
        from mcp_server.assistant.tools import TOOL_DEFINITIONS

        words = set(re.findall(r"\b[a-z]+(?:_[a-z0-9]+)+\b", SYSTEM_PROMPT + json.dumps(TOOL_DEFINITIONS)))
        checked = set()
        for item in SAMPLES:
            full = keys_in(item["content"])
            small = keys_in(compact_result(item["tool"], item["content"], item["arguments"]))
            for word in words & set(full):
                if word in INTENTIONALLY_DROPPED or (item["tool"], word) in DROPPED_FOR_TOOL or all(v in (None, "", [], {}, "tcgplayer") for v in full[word]):
                    continue
                checked.add(word)
                self.assertTrue(word in small, (item["tool"], word))
        for word in ("price_verified", "excluded_untrusted", "language_pair", "covers_full_range", "first_date",
                     "total_value_usd", "top_gainers_pct", "holding_id", "rarity_bucket", "days_covered", "ask_which",
                     "graded_price_usd"):
            self.assertIn(word, checked)

    def test_size_reduction_on_recorded_sample(self) -> None:
        before = sum(len(baseline(item["content"])) for item in SAMPLES)
        after = sum(len(model_payload(item["tool"], item["content"], item["arguments"])) for item in SAMPLES)
        self.assertLess(after, before * 0.7, (before, after))
        for tool, ratio in (("get_price_history", 0.5), ("list_facets", 0.6), ("get_card", 0.7)):
            item = sample(tool)
            self.assertLess(len(model_payload(tool, item["content"], item["arguments"])),
                            len(baseline(item["content"])) * ratio, tool)


@unittest.skipUnless(HAVE_DEPS, "assistant deps missing")
class CompactBoundaryTests(AssistantCase):
    def setUp(self) -> None:
        super().setUp()
        for days in range(120, -1, -1):
            day = (datetime.now(timezone.utc).date() - timedelta(days=days)).isoformat()
            self.conn.execute(
                "INSERT INTO card_price_history_cell (card_id, provider, price_date, lane, cell_key, variant_key, "
                "condition, grader, grade, is_perfect, is_signed, is_error, currency_code, low, market, mid, high, "
                "direct_low, trend, updated_at) VALUES ('ssp-1', 'scrydex', ?, 'raw', 'raw|||holofoil|NM|s0', "
                "'holofoil', 'NM', NULL, NULL, 0, 0, 0, 'USD', ?, ?, ?, ?, NULL, NULL, ?)",
                (day, 100.0 + days, 100.0 + days, 100.0 + days, 100.0 + days, utc_now()),
            )
        self.conn.commit()

    def test_chart_uses_full_history_while_model_sees_sample(self) -> None:
        self.client.queue(
            message([tool_use("get_price_history", {"card_id": "ssp-1", "range": "1y"}, "h1")], "tool_use"),
            message([text("Pikachu ex fell from $220 to $100.")]),
        )
        reply = self.ask("Show Pikachu ex's price history").json()["message"]
        sent = json.loads(self.client.messages.calls[1]["messages"][-1]["content"][0]["content"])
        self.assertLessEqual(len(sent["points"]), MAX_HISTORY_POINTS)
        self.assertGreater(sent["point_count"], MAX_HISTORY_POINTS)
        self.assertGreater(len(reply["charts"][0]["points"]), MAX_HISTORY_POINTS)
        self.assertEqual(reply["charts"][0]["points"][0], sent["points"][0])
        self.assertEqual(reply["charts"][0]["points"][-1], sent["points"][-1])
        self.assertEqual([card["card_id"] for card in reply["cards"]], ["ssp-1"])

    def test_tiles_keep_full_card_data(self) -> None:
        self.client.queue(
            message([tool_use("get_my_collection", {}, "c1")], "tool_use"),
            message([text("Your collection is worth $120.")]),
        )
        reply = self.ask("What's in my collection?").json()["message"]
        sent = self.client.messages.calls[1]["messages"][-1]["content"][0]["content"]
        self.assertNotIn("set_code", sent)
        self.assertNotIn("image_small_url", sent)
        self.assertIn("ssp-1", [card["card_id"] for card in reply["cards"]])
        self.assertTrue(all(card.get("name") for card in reply["cards"]))


if __name__ == "__main__":
    unittest.main()
