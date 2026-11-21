"""Set-level answers ("which sets are doing well?") show SET tiles (logo, name,
% change; tap opens the set) instead of card tiles, unless the text also names
cards. Persisted, listed, and replayed from the shared-answer cache."""

from __future__ import annotations

import json
import sqlite3
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from typing import Any

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT / "tests") not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT / "tests"))

from test_mcp_assistant import HAVE_DEPS, AssistantCase, bearer, message, text, tool_use  # noqa: E402

from catalog_tools import upsert_runtime_setting, utc_now  # noqa: E402
from market_movers import LATEST_PAYLOAD_SETTING_KEY  # noqa: E402

if HAVE_DEPS:
    from mcp_server.assistant.shared_answers import replay, shared_reply
    from mcp_server.assistant.store import message_payload
    from mcp_server.assistant.tools import cards_beside_sets, named_sets, trend_set_refs
    from mcp_server.tools import _set_id_from_group_key

AS_OF = "2026-11-16"
SETS = [  # (set_id, label, pct)
    ("bw8", "Plasma Storm", 66.9),
    ("dp5", "Majestic Dawn", 17.8),
    ("me3", "Ascended Heroes", -24.0),
]


def show(*card_ids: str) -> Any:
    cards = [{"card_id": card_id, "variant": None, "grader": None, "grade": None} for card_id in card_ids]
    return tool_use("show_cards", {"cards": cards, "label": "Top trending cards"}, "show")


def trends() -> Any:
    return message([tool_use("get_market_trends", {"game": "pokemon"}, "t1")], "tool_use")


class SetTilesCase(AssistantCase):
    def _seed(self) -> None:
        super()._seed()
        payload = {"windowDays": 30, "asOfDate": AS_OF, "games": [{"game": "pokemon", "items": [
            {"cardId": "ssp-1", "priceNow": 120.0, "priceThen": 60.0, "changePercent": 100.0, "currencyCode": "USD"},
            {"cardId": "ssp-3", "priceNow": 4.0, "priceThen": 3.0, "changePercent": 33.0, "currencyCode": "USD"},
        ]}]}
        upsert_runtime_setting(self.conn, key=LATEST_PAYLOAD_SETTING_KEY, value={"version": "v", "payload": payload})
        now = utc_now()
        self.conn.execute(
            "INSERT INTO meta_pulse_runs (game, as_of_date, window_days, lane, paired_card_count, moved_card_count, "
            "value_now, value_then, group_count, computed_at) VALUES ('pokemon', ?, 30, 'raw', 500, 300, 1000, 900, 3, ?)",
            (AS_OF, now),
        )
        for set_id, label, pct in SETS:
            self.conn.execute(
                "INSERT INTO meta_pulse_groups (game, as_of_date, window_days, lane, group_key, segment_key, label, "
                "description, median_change_percent, value_now, value_then, value_change_usd, card_count, "
                "moved_card_count, spark_points_json, computed_at, sort_score, release_date) "
                "VALUES ('pokemon', ?, 30, 'raw', ?, 'set', ?, '40 cards', ?, 100, 90, 10, 40, 8, '[]', ?, ?, '2013-02-06')",
                (AS_OF, f"set:{set_id}:raw", label, pct, now, pct),
            )
        self.conn.execute(
            "INSERT INTO expansions (id, game, name, language, release_date, logo_url, symbol_url, created_at, updated_at) "
            "VALUES ('bw8', 'pokemon', 'Plasma Storm', 'en', '2013-02-06', 'https://img.example/bw8-logo.png', "
            "'https://img.example/bw8-symbol.png', ?, ?)",
            (now, now),
        )
        self.conn.commit()

    def reply(self, *script: Any, question: str = "What sets are doing well and what's not?") -> dict[str, Any]:
        self.client.queue(*script)
        response = self.ask(question)
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()["message"]


class SetTileTurnTests(SetTilesCase):
    def test_set_answer_shows_sets_not_cards(self) -> None:
        reply = self.reply(
            trends(),
            message([text("Plasma Storm is up 66.9% over 30 days, while Ascended Heroes fell 24%."),
                     show("ssp-1", "ssp-3")], "tool_use"),
        )
        self.assertEqual(reply["cards"], [])
        self.assertIsNone(reply["cards_label"])
        self.assertEqual([s["set_id"] for s in reply["sets"]], ["bw8", "me3"])
        plasma = reply["sets"][0]
        self.assertEqual(plasma["name"], "Plasma Storm")
        self.assertEqual(plasma["game"], "pokemon")
        self.assertEqual(plasma["logo_url"], "https://img.example/bw8-logo.png")
        self.assertEqual(plasma["symbol_url"], "https://img.example/bw8-symbol.png")
        self.assertEqual((plasma["change_pct"], plasma["window"], plasma["release_year"]), (66.9, "30d", "2013"))
        # No expansion row: Pokemon falls back to Scrydex's stable logo path.
        self.assertEqual(reply["sets"][1]["logo_url"], "https://images.scrydex.com/pokemon/me3-logo/logo")
        self.assertEqual(reply["sets"][1]["change_pct"], -24.0)

        stored = self.conn.execute("SELECT sets_json FROM assistant_messages WHERE id = ?", (reply["id"],)).fetchone()
        self.assertEqual(json.loads(stored[0]), reply["sets"])
        listed = self.http.get(f"/api/v1/assistant/threads/{reply['thread_id']}/messages", headers=bearer("user-a"))
        messages = listed.json()["messages"]
        self.assertEqual([m["sets"] for m in messages], [[], reply["sets"]])

    def test_cards_the_text_names_stay_beside_the_sets(self) -> None:
        reply = self.reply(
            trends(),
            message([text("Plasma Storm leads the sets at +66.9%, and Pikachu ex doubled."),
                     show("ssp-1", "ssp-3")], "tool_use"),
            question="What's hot right now?",
        )
        self.assertEqual([s["name"] for s in reply["sets"]], ["Plasma Storm"])
        self.assertEqual([c["card_id"] for c in reply["cards"]], ["ssp-1"])

    def test_no_set_named_keeps_card_tiles(self) -> None:
        reply = self.reply(
            trends(),
            message([text("Pikachu ex doubled this month."), show("ssp-1")], "tool_use"),
            question="What's hot right now?",
        )
        self.assertEqual(reply["sets"], [])
        self.assertEqual([c["card_id"] for c in reply["cards"]], ["ssp-1"])


@unittest.skipUnless(HAVE_DEPS, "anthropic / mcp not installed")
class SetTileUnitTests(unittest.TestCase):
    def test_group_key_to_set_id(self) -> None:
        self.assertEqual(_set_id_from_group_key("set:sv8:raw"), "sv8")
        self.assertEqual(_set_id_from_group_key("set:op:01:raw"), "op:01")
        self.assertIsNone(_set_id_from_group_key("rarity:sir:raw"))
        self.assertIsNone(_set_id_from_group_key(None))

    def test_trend_set_refs_need_an_id(self) -> None:
        refs = trend_set_refs({
            "sets_game": "pokemon", "sets_window": "7d",
            "rising_sets": [{"set": "Fossil", "set_id": "base3", "change_pct": 8.0, "release_year": "1999"},
                            {"set": "No Id", "change_pct": 5.0}],
            "falling_sets": [{"set": "Gym Heroes", "set_id": "gym1", "change_pct": -6.0}],
        })
        self.assertEqual([(r["set_id"], r["change_pct"], r["window"]) for r in refs],
                         [("base3", 8.0, "7d"), ("gym1", -6.0, "7d")])
        self.assertEqual(trend_set_refs(None), [])

    def test_named_sets_mention_order_and_longer_names(self) -> None:
        refs = [{"set_id": "base1", "name": "Base"}, {"set_id": "base4", "name": "Base Set 2"},
                {"set_id": "base3", "name": "Fossil"}]
        named = named_sets(refs, "Fossil climbed while Base Set 2 slipped.")
        self.assertEqual([r["set_id"] for r in named], ["base3", "base4"])

    def test_cards_inside_a_set_name_do_not_count(self) -> None:
        sets = [{"set_id": "neo4", "name": "Neo Destiny"}]
        cards = [{"card_id": "c1", "name": "Destiny"}, {"card_id": "c2", "name": "Dusknoir"},
                 {"card_id": "c3", "name": "Porygon"}]
        kept = cards_beside_sets(cards, sets, "Neo Destiny is up 20%; Porygon led it.", keep_ids={"c2"})
        self.assertEqual([c["card_id"] for c in kept], ["c2", "c3"])

    def test_shared_answers_carry_sets(self) -> None:
        tile = {"set_id": "bw8", "name": "Plasma Storm", "change_pct": 66.9}
        turn = SimpleNamespace(text="Plasma Storm is up.", cards=[], cards_label=None, cards_view_all=None,
                               suggestions=[], charts=[], sets=[tile], tools_used=["get_market_trends"], tool_calls=[])
        cached = shared_reply(turn)
        self.assertEqual(cached["sets"], [tile])
        self.assertEqual(replay(cached)["sets"], [tile])
        self.assertEqual(replay({"text": "old cache entry"})["sets"], [])

    def test_old_rows_without_sets_column_read_empty(self) -> None:
        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        conn.execute("CREATE TABLE m (id, thread_id, role, text, cards_json, actions_json, created_at, status)")
        conn.execute("INSERT INTO m VALUES ('a', 't', 'assistant', 'hi', NULL, NULL, 'now', 'ok')")
        self.assertEqual(message_payload(conn.execute("SELECT * FROM m").fetchone())["sets"], [])


if __name__ == "__main__":
    unittest.main()
