"""find_movers: biggest movers inside a scope (set / rarity / name / owned),
computed on the fly from card_price_history_daily (scoped_movers.py). Guards
ranking by % and $, the window-start point, the USD/printing/glitch/penny
guardrails, coverage flags, the scope requirement, owner scoping, tier
exposure, the assistant tool wiring and its compact model payload.
"""

from __future__ import annotations

import sys
import tempfile
import unittest
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_ROOT.parent
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from catalog_tools import apply_schema, connect, upsert_card, utc_now  # noqa: E402
import scoped_movers  # noqa: E402
from mcp_server.assistant.compact import compact_result  # noqa: E402
from mcp_server.assistant.tools import (  # noqa: E402
    READ_TOOLS,
    RANKING_TOOLS,
    TOOL_DEFINITIONS,
    AssistantToolbox,
    apply_question_rules,
)
from mcp_server.filters import ToolInputError  # noqa: E402
from mcp_server.policy import PUBLIC_POLICY, USER_POLICY  # noqa: E402
from mcp_server.readonly_service import ReadOnlySpotlightService  # noqa: E402
from mcp_server.tools import CollectionTools  # noqa: E402

TODAY = datetime.now(timezone.utc).date()


def _d(days_ago: int, ref: date = TODAY) -> str:
    return (ref - timedelta(days=days_ago)).isoformat()


class CardMoveTests(unittest.TestCase):
    """Pure per-card guardrails (no DB)."""

    REF = date(2026, 11, 17)

    def rows(self, points, *, lane="main", currency="USD", variant="Holofoil"):
        out = []
        for days_ago, value in points:
            day = _d(days_ago, self.REF)
            if lane == "main":
                out.append((day, "USD", None, value, variant))
            else:
                out.append((day, currency, value, None, None))
        return sorted(out)

    def move(self, card_id, rows, *, window=30, language="English"):
        return scoped_movers.card_move(card_id, language, rows, window_days=window, ref_date=self.REF)

    def test_start_is_first_point_at_or_after_window_start(self) -> None:
        move = self.move("a", self.rows([(30, 100.0), (20, 95.0), (10, 90.0), (0, 80.0)]))
        self.assertEqual((move.start_date, move.start_usd, move.end_usd), (_d(30, self.REF), 100.0, 80.0))
        self.assertAlmostEqual(move.change_pct, -20.0)
        self.assertEqual(move.days_covered, 30)
        self.assertTrue(move.covers_full_window)

    def test_late_start_flags_partial_coverage(self) -> None:
        move = self.move("a", self.rows([(200, 50.0), (120, 55.0), (60, 60.0), (0, 70.0)]), window=365)
        self.assertEqual(move.start_date, _d(200, self.REF))
        self.assertFalse(move.covers_full_window)
        self.assertEqual(move.days_covered, 200)
        # Too little history for the window: not a move at all.
        self.assertIsNone(self.move("b", self.rows([(5, 50.0), (3, 55.0), (0, 60.0)]), window=365))

    def test_printing_switch_is_not_a_move(self) -> None:
        old = self.rows([(30, 40.0), (25, 41.0), (20, 42.0)], variant="World Championship Deck")
        new = self.rows([(15, 360.0), (10, 362.0), (5, 361.0), (0, 363.0)], variant="Holofoil")
        move = self.move("espeon", sorted(old + new))
        self.assertEqual(move.variant, "Holofoil")
        self.assertEqual(move.start_usd, 360.0)  # never $40 -> $363
        self.assertFalse(move.covers_full_window)

    def test_glitch_step_and_flat_series_excluded(self) -> None:
        self.assertIsNone(self.move("glitch", self.rows([(30, 280.0), (20, 290.0), (10, 2997.0), (0, 285.0)])))
        self.assertIsNone(self.move("flat", self.rows([(30, 10.0), (20, 10.0), (0, 20.0)])))

    def test_penny_floor_applies_then_and_now(self) -> None:
        self.assertIsNone(self.move("up", self.rows([(30, 0.5), (20, 1.5), (10, 2.5), (0, 4.0)])))
        self.assertIsNone(self.move("down", self.rows([(30, 6.0), (20, 4.0), (10, 3.0), (0, 1.0)])))

    def test_japanese_never_uses_scrydex_default_raw(self) -> None:
        yen = self.rows([(30, 1000.0), (20, 1500.0), (0, 2000.0)], lane="default", currency="USD")
        self.assertIsNone(self.move("sv2a_ja-201", yen, language="Japanese"))
        self.assertIsNone(self.move("en-1", self.rows([(30, 10.0), (20, 15.0), (0, 20.0)], lane="default", currency="JPY")))
        main = self.rows([(30, 100.0), (20, 110.0), (0, 120.0)])
        self.assertIsNotNone(self.move("sv2a_ja-201", main, language="Japanese"))

    def test_default_raw_fallback_for_usd_cards(self) -> None:
        move = self.move("en-1", self.rows([(30, 10.0), (20, 15.0), (0, 20.0)], lane="default"))
        self.assertEqual((move.source, move.variant, move.change_usd), (scoped_movers.SOURCE_DEFAULT_RAW, None, 10.0))

    def test_rank_by_pct_and_usd(self) -> None:
        def mv(card_id, start, end):
            return scoped_movers.Move(card_id, "main_raw", None, start, end, "a", "b", 30, True)

        moves = [mv("cheap", 10.0, 5.0), mv("pricey", 1000.0, 800.0), mv("up", 10.0, 30.0), mv("mid", 100.0, 60.0)]
        down_pct = [m.card_id for m in scoped_movers.rank_moves(moves, direction="down")]
        down_usd = [m.card_id for m in scoped_movers.rank_moves(moves, direction="down", by="usd")]
        self.assertEqual(down_pct, ["cheap", "mid", "pricey"])
        self.assertEqual(down_usd, ["pricey", "mid", "cheap"])
        self.assertEqual([m.card_id for m in scoped_movers.rank_moves(moves, direction="up")], ["up"])


class FindMoversToolTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        db_path = Path(self.tempdir.name) / "movers.sqlite"
        conn = connect(db_path)
        apply_schema(conn, BACKEND_ROOT / "schema.sql")
        conn.close()
        self.service = ReadOnlySpotlightService(db_path, REPO_ROOT)
        self.addCleanup(lambda: self.service.connection.close())
        self.tools = CollectionTools(self.service)
        self.conn = self.service.connection

    def card(self, card_id: str, *, set_name: str = "Evolving Skies", set_id: str = "swsh7", language: str = "English",
             rarity: str = "Rare", game: str = "pokemon", supertype: str | None = None, image: bool = True,
             name: str | None = None) -> None:
        upsert_card(
            self.conn, card_id=card_id, name=name or f"Card {card_id}", set_name=set_name, number="1", rarity=rarity,
            variant="Raw", language=language, game=game, source_provider="scrydex", source_record_id=card_id,
            image_url=f"https://img.example/{card_id}.png" if image else None, source_payload={"id": card_id},
            set_id=set_id, supertype=supertype,
        )

    def path(self, card_id: str, start: float, end: float, *, days: int = 30, step: int = 5) -> None:
        """Linear main-lane path from `days` ago to today, one point every `step` days."""
        for day in range(days, -1, -step):
            value = round(end + (start - end) * day / days, 2)
            self.conn.execute(
                "INSERT INTO card_price_history_daily (card_id, provider, price_date, display_currency_code, "
                "main_raw_market_price, main_raw_variant, updated_at) VALUES (?, 'scrydex', ?, 'USD', ?, 'Holofoil', ?)",
                (card_id, _d(day), value, utc_now()),
            )

    def holding(self, owner: str, card_id: str) -> None:
        self.conn.execute(
            "INSERT INTO deck_entries (id, owner_user_id, identity_key, item_kind, card_id, condition, quantity, "
            "cost_basis_total, cost_basis_currency_code, added_at, updated_at) "
            "VALUES (?, ?, ?, 'raw', ?, 'near_mint', 1, 0, 'USD', ?, ?)",
            (f"{owner}-{card_id}", owner, f"{card_id}||", card_id, utc_now(), utc_now()),
        )

    def seed_set(self) -> None:
        self.card("es-1")
        self.path("es-1", 100.0, 70.0)  # -30%, -$30
        self.card("es-2")
        self.path("es-2", 1000.0, 800.0)  # -20%, -$200
        self.card("es-3")
        self.path("es-3", 20.0, 30.0)  # +50%
        self.card("es-penny")
        self.path("es-penny", 2.0, 0.5)
        self.card("es-jp", set_name="Evolving Skies", language="Japanese", set_id="swsh7")
        self.path("es-jp", 100.0, 10.0)
        self.card("bs-1", set_name="Base Set", set_id="base1")
        self.path("bs-1", 100.0, 10.0)

    def test_set_scope_ranked_by_pct_with_usd_list(self) -> None:
        self.seed_set()
        result = self.tools.find_movers("user-a", {"set": "Evolving Skies"}, direction="down", window="30d")
        self.assertEqual([c["card_id"] for c in result["cards"]], ["es-1", "es-2"])
        self.assertEqual([c["card_id"] for c in result["top_by_usd"]], ["es-2", "es-1"])
        first = result["cards"][0]
        self.assertEqual((first["start_usd"], first["end_usd"], first["change_usd"], first["change_pct"]),
                         (100.0, 70.0, -30.0, -30.0))
        self.assertEqual((first["start_date"], first["end_date"], first["days_covered"]), (_d(30), _d(0), 30))
        self.assertTrue(first["covers_full_window"])
        self.assertEqual(first["variant"], "Holofoil")
        self.assertEqual((result["window"], result["direction"], result["ranked_by"], result["as_of"]),
                         ("30d", "down", "pct", TODAY.isoformat()))
        self.assertNotIn("note", result)
        up = self.tools.find_movers("user-a", {"set": "Evolving Skies"}, direction="up")
        self.assertEqual([c["card_id"] for c in up["cards"]], ["es-3"])
        by_usd = self.tools.find_movers("user-a", {"set": "swsh7"}, direction="down", rank_by="usd")
        self.assertEqual([c["card_id"] for c in by_usd["cards"]], ["es-2", "es-1"])
        self.assertIn("top_by_pct", by_usd)
        shaped = USER_POLICY.shape(result)
        for key in ("start_usd", "end_usd", "start_date", "end_date", "covers_full_window", "change_pct", "days_covered"):
            self.assertIn(key, shaped["cards"][0])

    def test_collectibility_filter(self) -> None:
        # Owner 2026-11-20: a $5 Fairy Energy topping "rising the most" is noise.
        self.card("es-mon")
        self.path("es-mon", 20.0, 30.0)  # +50%
        self.card("es-energy", supertype="Energy", rarity="Common", name="Fairy Energy")
        self.path("es-energy", 10.0, 40.0)  # +300%
        self.card("es-cheap")
        self.path("es-cheap", 3.0, 8.0)  # +167%, under the $10 floor
        self.card("es-blank", image=False)
        self.path("es-blank", 20.0, 60.0)  # +200%, no image
        ids = lambda *a, **kw: [  # noqa: E731
            c["card_id"] for c in self.tools.find_movers("user-a", *a, direction="up", **kw)["cards"]
        ]
        self.assertEqual(ids({"set": "Evolving Skies"}), ["es-mon"])
        self.assertEqual(ids({"set": "Evolving Skies"}, include_energy_trainers=True),
                         ["es-energy", "es-cheap", "es-mon"])
        self.assertEqual(ids({"set": "Evolving Skies", "price_max_usd": 10}), ["es-cheap"])
        self.assertEqual(ids({"text": "Fairy Energy"}), ["es-energy"])
        self.holding("user-a", "es-energy")
        self.assertEqual(ids(owned="owned"), ["es-energy"])
        outcome = AssistantToolbox(self.tools).run(
            "find_movers", {"direction": "up", "filter": {"set": "Evolving Skies"}, "include_energy_trainers": True},
            owner_user_id="user-a",
        )
        self.assertEqual([c["card_id"] for c in outcome.content["cards"]], ["es-energy", "es-cheap", "es-mon"])

    def test_japanese_only_when_asked(self) -> None:
        self.seed_set()
        result = self.tools.find_movers(
            "user-a", {"set": "Evolving Skies", "language": "Japanese"}, direction="down"
        )
        self.assertEqual([c["card_id"] for c in result["cards"]], ["es-jp"])

    def test_rarity_scope_and_price_filter(self) -> None:
        self.card("sir-1", rarity="Special Illustration Rare", set_name="Surging Sparks", set_id="sv8")
        self.path("sir-1", 50.0, 80.0, days=7, step=1)
        self.card("sir-2", rarity="Special Illustration Rare", set_name="Prismatic", set_id="sv8pt5")
        self.path("sir-2", 400.0, 500.0, days=7, step=1)
        self.card("rare-1", set_name="Surging Sparks", set_id="sv8")
        self.path("rare-1", 10.0, 50.0, days=7, step=1)
        result = self.tools.find_movers("user-a", {"rarity_bucket": ["sir"]}, direction="up", window="7d")
        self.assertEqual([c["card_id"] for c in result["cards"]], ["sir-1", "sir-2"])
        capped = self.tools.find_movers("user-a", {"rarity_bucket": ["sir"], "price_max_usd": 100}, direction="up",
                                        window="7d")
        self.assertEqual([c["card_id"] for c in capped["cards"]], ["sir-1"])

    def test_partial_window_note(self) -> None:
        self.card("young")
        self.path("young", 50.0, 80.0, days=60)
        result = self.tools.find_movers("user-a", {"set": "Evolving Skies"}, direction="up", window="1y")
        self.assertEqual(len(result["cards"]), 1)
        self.assertFalse(result["cards"][0]["covers_full_window"])
        self.assertEqual(result["cards"][0]["days_covered"], 60)
        self.assertIn("covers_full_window", result["note"])

    def test_scope_required_and_up_points_to_trends(self) -> None:
        with self.assertRaises(ToolInputError) as up:
            self.tools.find_movers("user-a", {"game": "pokemon"}, direction="up")
        self.assertIn("get_market_trends", str(up.exception))
        with self.assertRaises(ToolInputError) as down:
            self.tools.find_movers("user-a", None, direction="down")
        self.assertIn("needs a scope", str(down.exception))
        for bad in ({"direction": "sideways"}, {"window": "5y"}, {"owned": "not_owned"}, {"rank_by": "x"},
                    {"limit": 11}, {"card_filter": {"set": "Evolving Skies", "scene": ["beach"]}}):
            kwargs = {"card_filter": {"set": "Evolving Skies"}, "direction": "down", **bad}
            with self.assertRaises(ToolInputError):
                self.tools.find_movers("user-a", **kwargs)

    def test_owned_scope_is_owner_scoped(self) -> None:
        self.seed_set()
        self.holding("user-a", "es-1")
        self.holding("user-a", "bs-1")
        self.holding("user-b", "es-2")
        mine = self.tools.find_movers("user-a", None, direction="down", owned="owned")
        self.assertEqual([c["card_id"] for c in mine["cards"]], ["bs-1", "es-1"])
        scoped = self.tools.find_movers("user-a", {"set": "Evolving Skies"}, direction="down", owned="owned")
        self.assertEqual([c["card_id"] for c in scoped["cards"]], ["es-1"])
        self.assertEqual(self.tools.find_movers("user-c", None, direction="down", owned="owned")["cards"], [])

    def test_empty_scope_note(self) -> None:
        self.card("flat")
        result = self.tools.find_movers("user-a", {"set": "Evolving Skies"}, direction="down")
        self.assertEqual(result["cards"], [])
        self.assertIn("note", result)

    def test_scan_cap(self) -> None:
        self.seed_set()
        original = scoped_movers.MAX_SCANNED_CARDS
        scoped_movers.MAX_SCANNED_CARDS = 2
        self.addCleanup(setattr, scoped_movers, "MAX_SCANNED_CARDS", original)
        result = self.tools.find_movers("user-a", {"set": "Evolving Skies"}, direction="down")
        self.assertEqual(result["scanned_cards"], 2)
        self.assertEqual(result["capped_at"], 2)
        self.assertIn("highest-priced", result["note"])

    def test_tier_exposure(self) -> None:
        self.assertTrue(USER_POLICY.allows_tool("find_movers"))
        self.assertFalse(PUBLIC_POLICY.allows_tool("find_movers"))

    def test_assistant_tool_tiles_and_compact_payload(self) -> None:
        self.seed_set()
        outcome = AssistantToolbox(self.tools).run(
            "find_movers", {"filter": {"set": "Evolving Skies", "product": "single"}, "direction": "down"},
            owner_user_id="user-a",
        )
        self.assertFalse(outcome.is_error, outcome.content)
        self.assertEqual(outcome.cards[0]["card_id"], "es-1")
        self.assertNotIn("image_small_url", outcome.content["cards"][0])
        small = compact_result("find_movers", outcome.content, {"filter": {"set": "Evolving Skies"}})
        card = small["cards"][0]
        for key in ("card_id", "name", "start_usd", "end_usd", "change_usd", "change_pct", "start_date"):
            self.assertIn(key, card)
        for key in ("price_usd", "end_date", "covers_full_window", "days_covered"):
            self.assertNotIn(key, card)
        self.assertEqual(small["top_by_usd"][0], {"card_id": "es-2", "name": "Card es-2", "change_usd": -200,
                                                  "change_pct": -20})
        self.assertEqual((small["window"], small["direction"], small["ranked_by"]), ("30d", "down", "pct"))
        error = AssistantToolbox(self.tools).run("find_movers", {"direction": "up"}, owner_user_id="user-a")
        self.assertTrue(error.is_error)
        self.assertIn("get_market_trends", error.content["error"])


class AssistantDefinitionTests(unittest.TestCase):
    def test_definition_and_routing(self) -> None:
        by_name = {tool["name"]: tool for tool in TOOL_DEFINITIONS}
        tool = by_name["find_movers"]
        self.assertFalse(tool.get("strict"))  # carries a CardFilter
        self.assertIn("find_movers", READ_TOOLS)
        self.assertIn("find_movers", RANKING_TOOLS)
        self.assertEqual(tool["input_schema"]["required"], ["direction"])
        description = tool["description"]
        for phrase in ("dropped", "rose the most", "get_market_trends", "get_portfolio_summary", "window_label"):
            self.assertIn(phrase, description)
        self.assertIn("find_movers", by_name["get_portfolio_summary"]["description"])

    def test_schema_never_enum_under_type_list(self) -> None:
        def walk(node):
            if isinstance(node, dict):
                if isinstance(node.get("type"), list):
                    self.assertNotIn("enum", node)
                for value in node.values():
                    walk(value)
            elif isinstance(node, list):
                for value in node:
                    walk(value)

        walk([tool["input_schema"] for tool in TOOL_DEFINITIONS])

    def test_movers_answers_cap_tiles_at_three(self) -> None:
        tiles = [{"card_id": f"c{i}", "name": f"Card {i}"} for i in range(5)]
        kept, _, _ = apply_question_rules(
            tiles, [], None, question="Which Evolving Skies card dropped the most this month?", text="Card 0 fell.",
            pool=tiles, holding_refs=[], language_pairs={}, tools_used={"find_movers"},
        )
        self.assertLessEqual(len(kept), 3)
        self.assertEqual(kept[0]["card_id"], "c0")


if __name__ == "__main__":
    unittest.main()
