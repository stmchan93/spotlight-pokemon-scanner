"""Assistant price-chart attachments: built from get_price_history TOOL
RESULTS (never model text), capped, persisted, returned, replayed."""

from __future__ import annotations

import json
import sqlite3
import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT / "tests") not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT / "tests"))

from catalog_tools import utc_now  # noqa: E402
from test_mcp_assistant import HAVE_DEPS, USER_A, AssistantCase, bearer, message, text, tool_use  # noqa: E402

if HAVE_DEPS:
    from mcp_server.assistant.engine import SYSTEM_PROMPT
    from mcp_server.assistant.store import ensure_schema, message_payload
    from mcp_server.assistant.tools import MAX_CHART_POINTS, MAX_CHARTS, price_chart


class ChartTests(AssistantCase):
    def history_cell(self, card_id: str, days_ago: int, market: float, *, lane: str = "raw",
                     grader: str | None = None, grade: str | None = None) -> None:
        condition = None if lane == "graded" else "NM"
        day = (datetime.now(timezone.utc).date() - timedelta(days=days_ago)).isoformat()
        self.conn.execute(
            "INSERT INTO card_price_history_cell (card_id, provider, price_date, lane, cell_key, variant_key, "
            "condition, grader, grade, is_perfect, is_signed, is_error, currency_code, low, market, mid, high, "
            "direct_low, trend, updated_at) VALUES (?, 'scrydex', ?, ?, ?, 'holofoil', ?, ?, ?, 0, 0, 0, 'USD', "
            "?, ?, ?, ?, NULL, NULL, ?)",
            (card_id, day, lane, f"{lane}|{grader or ''}|{grade or ''}|holofoil|{condition or ''}|s0",
             condition, grader, grade, market, market, market, market, utc_now()),
        )

    def setUp(self) -> None:
        super().setUp()
        for days in range(300, -1, -1):
            self.history_cell("ssp-1", days, 100.0 + days)
        for days in (60, 30, 5):
            self.history_cell("ssp-1", days, 900.0 + days, lane="graded", grader="PSA", grade="10")
        self.history_cell("ssp-3", 5, 2.0)  # one point: nothing to draw
        self.conn.commit()

    def test_chart_built_from_tool_result_persisted_and_listed(self) -> None:
        self.client.queue(
            message([tool_use("get_price_history", {"card_id": "ssp-1", "range": "1y"}, "h1")], "tool_use"),
            message([text("Pikachu ex slid from $400 to $100 this year (999,999).")]),
        )
        body = self.ask("Show Pikachu ex's price history", cmid="chart-1").json()
        reply = body["message"]
        self.assertEqual(len(reply["charts"]), 1)
        chart = reply["charts"][0]
        self.assertEqual(
            {k: chart[k] for k in ("card_id", "name", "condition", "grader", "grade", "range", "source")},
            {"card_id": "ssp-1", "name": "Pikachu ex", "condition": "NM", "grader": None, "grade": None,
             "range": "1y", "source": "scrydex"},
        )
        self.assertEqual(set(chart), {"card_id", "name", "variant", "condition", "grader", "grade", "range",
                                      "points", "source"})
        self.assertGreater(len(chart["points"]), 2)
        self.assertLessEqual(len(chart["points"]), MAX_CHART_POINTS)
        tool_points = json.loads(self.client.messages.calls[1]["messages"][-1]["content"][0]["content"])["points"]
        self.assertEqual(chart["points"][0], tool_points[0])
        self.assertEqual(chart["points"][-1], tool_points[-1])
        self.assertTrue(all(set(point) == {"date", "usd"} for point in chart["points"]))
        self.assertNotIn(999999.0, [point["usd"] for point in chart["points"]])
        self.assertEqual(body["user_message"]["charts"], [])

        stored = self.conn.execute("SELECT charts_json FROM assistant_messages WHERE id = ?", (reply["id"],)).fetchone()
        self.assertEqual(json.loads(stored["charts_json"]), reply["charts"])
        listed = self.http.get(
            f"/api/v1/assistant/threads/{body['thread_id']}/messages", headers=bearer(USER_A)
        ).json()["messages"]
        self.assertEqual([m["charts"] for m in listed], [[], reply["charts"]])
        replay = self.ask("Show Pikachu ex's price history", cmid="chart-1").json()["message"]
        self.assertEqual(replay["charts"], reply["charts"])
        self.assertEqual(len(self.client.messages.calls), 2)

    def test_graded_chart_cap_and_dedupe(self) -> None:
        graded = {"card_id": "ssp-1", "range": "90d", "grader": "PSA", "grade": "10"}
        self.client.queue(
            message([
                tool_use("get_price_history", graded, "g1"),
                tool_use("get_price_history", graded, "g2"),  # same series: one chart
                tool_use("get_price_history", {"card_id": "ssp-3"}, "one"),  # single point: no chart
                tool_use("get_price_history", {"card_id": "ssp-1", "range": "30d"}, "r30"),
                tool_use("get_price_history", {"card_id": "ssp-1", "range": "1y"}, "r1y"),
            ], "tool_use"),
            message([text("PSA 10 is up.")]),
        )
        charts = self.ask().json()["message"]["charts"]
        self.assertEqual(len(charts), MAX_CHARTS)
        self.assertEqual((charts[0]["grader"], charts[0]["grade"], charts[0]["condition"]), ("PSA", "10", None))
        self.assertEqual([p["usd"] for p in charts[0]["points"]], [960.0, 930.0, 905.0])
        self.assertEqual((charts[1]["range"], charts[1]["grader"]), ("30d", None))

    def test_no_chart_without_history_call_or_on_refusal(self) -> None:
        self.client.queue(message([tool_use("get_card", {"card_id": "ssp-1"}, "c")], "tool_use"), message([text("ok")]))
        self.assertEqual(self.ask().json()["message"]["charts"], [])
        self.client.queue(
            message([tool_use("get_price_history", {"card_id": "ssp-1"}, "h")], "tool_use"),
            message([text("nope")], "refusal"),
        )
        self.assertEqual(self.ask().json()["message"]["charts"], [])

    def test_price_chart_downsamples_keeping_ends(self) -> None:
        points = [{"date": f"2026-01-{i % 28 + 1:02d}", "usd": float(i)} for i in range(365)]
        chart = price_chart({"card_id": "c", "points": points}, name="C", range_key="1y")
        self.assertEqual(len(chart["points"]), MAX_CHART_POINTS)
        self.assertEqual((chart["points"][0]["usd"], chart["points"][-1]["usd"]), (0.0, 364.0))
        self.assertIsNone(price_chart({"card_id": "c", "points": points[:1]}, name="C", range_key="1y"))
        self.assertIsNone(price_chart({"error": "x"}, name=None, range_key="1y"))

    def test_system_prompt_asks_for_history_chart(self) -> None:
        self.assertIn("call get_price_history so the app shows a chart", SYSTEM_PROMPT)

    def test_schema_patch_and_bad_json(self) -> None:
        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        conn.execute(
            "CREATE TABLE assistant_messages (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, owner_user_id TEXT NOT NULL,"
            " role TEXT NOT NULL, text TEXT NOT NULL, cards_json TEXT, actions_json TEXT,"
            " status TEXT NOT NULL DEFAULT 'ok', client_message_id TEXT, input_tokens INTEGER, output_tokens INTEGER,"
            " cost_usd REAL, tools_used TEXT, created_at TEXT NOT NULL)"
        )
        conn.execute(
            "INSERT INTO assistant_messages (id, thread_id, owner_user_id, role, text, created_at)"
            " VALUES ('m-old', 't', 'u', 'assistant', 'old reply', '2026-11-17T00:00:00Z')"
        )
        ensure_schema(conn)
        ensure_schema(conn)
        columns = [row[1] for row in conn.execute("PRAGMA table_info(assistant_messages)")]
        self.assertEqual(columns.count("charts_json"), 1)
        self.assertEqual(message_payload(conn.execute("SELECT * FROM assistant_messages").fetchone())["charts"], [])
        conn.execute("UPDATE assistant_messages SET charts_json = 'not json'")
        self.assertEqual(message_payload(conn.execute("SELECT * FROM assistant_messages").fetchone())["charts"], [])
        conn.close()
        self.assertIn("charts_json", (BACKEND_ROOT / "schema.sql").read_text())


if __name__ == "__main__":
    unittest.main()
