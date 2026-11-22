"""Assistant card tiles = the cards the answer is about: show_cards selection
(server-resolved, never model-invented), the fallback without it, the section
label, same-artwork dedupe, near-low sparklines, and Watchlist previews."""

from __future__ import annotations

import json
import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT / "tests") not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT / "tests"))

from test_mcp_assistant import HAVE_DEPS, USER_A, AssistantCase, bearer, message, text, tool_use  # noqa: E402

import tag_card_art  # noqa: E402
from catalog_tools import upsert_card, upsert_runtime_setting, utc_now  # noqa: E402
from market_movers import LATEST_PAYLOAD_SETTING_KEY  # noqa: E402

if HAVE_DEPS:
    from mcp_server.assistant.engine import SYSTEM_PROMPT, strip_pseudo_calls
    from mcp_server.assistant.tools import (
        HOLDINGS_LABEL,
        MAX_SPARKLINE_POINTS,
        MAX_WATCHLIST_TILES,
        TOOL_DEFINITIONS,
        AssistantToolbox,
        apply_question_rules,
        card_refs,
        choose_tiles,
        movers_only,
        clean_label,
        collapse_same_art,
        covered_range,
        sparkline_fetch_range,
        named_refs,
        select_tiles,
        watchlist_order,
    )


def show(*card_ids: str, label: str | None = None, grader: str | None = None, grade: str | None = None,
         block_id: str = "show") -> Any:
    cards = [{"card_id": card_id, "variant": None, "grader": grader, "grade": grade} for card_id in card_ids]
    return tool_use("show_cards", {"cards": cards, "label": label}, block_id)


def both_searches() -> list[Any]:
    return [tool_use("search_cards", {"filter": {"text": "pikachu"}}, "s1"),
            tool_use("search_cards", {"filter": {"text": "charizard"}}, "s2")]


class TilesCase(AssistantCase):
    def _seed(self) -> None:
        super()._seed()
        self.card("ssp-4", "Pikachu ex", number="250")  # same-art English reprint of ssp-1
        upsert_card(
            self.conn, card_id="jp-1", name="Pikachu ex", set_name="Super Electric Breaker", number="132",
            rarity="Special Art Rare", variant="Raw", language="Japanese", source_provider="scrydex",
            source_record_id="jp-1", set_id="sv8", set_ptcgo_code="SV8", set_release_date="2024-10-18",
            artist="Arita", supertype="Pokémon", national_pokedex_numbers=[], image_url="https://img.example/jp-1.png",
            source_payload={"id": "jp-1"},
        )
        self.price("ssp-4", 60.0)
        tag_card_art.write_tagged_groups(
            self.conn,
            [{"art_group_id": "g-pika", "representative_card_id": "ssp-1",
              "members": {"ssp-1": "self", "ssp-4": "reprint_similar", "jp-1": "language_link"},
              "tags": {"scene": ["beach"]}, "rows": [("scene", "beach", None, 0.9)], "alt_text": None},
             {"art_group_id": "g-eevee", "representative_card_id": "ssp-3", "members": {"ssp-3": "self"},
              "tags": {}, "rows": [("scene", "beach", None, 0.9)], "alt_text": None}],
            model="test",
        )
        self.conn.commit()

    def history_cell(self, card_id: str, days_ago: int, market: float) -> None:
        day = (datetime.now(timezone.utc).date() - timedelta(days=days_ago)).isoformat()
        self.conn.execute(
            "INSERT INTO card_price_history_cell (card_id, provider, price_date, lane, cell_key, variant_key, "
            "condition, grader, grade, is_perfect, is_signed, is_error, currency_code, low, market, mid, high, "
            "direct_low, trend, updated_at) VALUES (?, 'scrydex', ?, 'raw', 'raw|||holofoil|NM|s0', 'holofoil', "
            "'NM', NULL, NULL, 0, 0, 0, 'USD', ?, ?, ?, ?, NULL, NULL, ?)",
            (card_id, day, market, market, market, market, utc_now()),
        )

    def reply(self, *script: Any, **ask_kwargs: Any) -> dict[str, Any]:
        self.client.queue(*script)
        response = self.ask(**ask_kwargs)
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()["message"]

    @staticmethod
    def ids(cards: list[dict[str, Any]]) -> list[str]:
        return [card["card_id"] for card in cards]


class ShowCardsTests(TilesCase):
    def test_contract_is_strict_with_no_optional_params(self) -> None:
        tool = {t["name"]: t for t in TOOL_DEFINITIONS}["show_cards"]
        self.assertTrue(tool["strict"])
        schema = tool["input_schema"]
        self.assertEqual(set(schema["required"]), set(schema["properties"]))
        item = schema["properties"]["cards"]["items"]
        self.assertEqual(set(item["required"]), set(item["properties"]))
        self.assertIn("show_cards", SYSTEM_PROMPT)
        self.assertIn("Every card you name must be in it", SYSTEM_PROMPT)

    def test_selection_with_answer_is_final_and_model_label_dropped(self) -> None:
        reply = self.reply(
            message(both_searches(), "tool_use"),
            message([text("Charizard ex is the cheap one at $8."), show("ssp-2", "made-up", label="  Cheapest\nex  ")],
                    "tool_use"),
            cmid="sel-1",
        )
        self.assertEqual(len(self.client.messages.calls), 2)  # no extra round after show_cards
        self.assertEqual(self.ids(reply["cards"]), ["ssp-2"])
        self.assertEqual(reply["cards"][0]["name"], "Charizard ex")
        # Owner 2026-11-20: model-written tile headers are dropped; only server rules label tiles.
        self.assertIsNone(reply["cards_label"])
        self.assertIsNone(reply["cards_view_all"])
        self.assertEqual(reply["text"], "Charizard ex is the cheap one at $8.")
        row = self.conn.execute("SELECT cards_label, tools_used FROM assistant_messages WHERE id = ?",
                                (reply["id"],)).fetchone()
        self.assertIsNone(row["cards_label"])
        self.assertIn("show_cards", json.loads(row["tools_used"]))
        listed = self.http.get(f"/api/v1/assistant/threads/{reply['thread_id']}/messages",
                               headers=bearer(USER_A)).json()["messages"]
        self.assertEqual([m["cards_label"] for m in listed], [None, None])
        replay = self.ask(cmid="sel-1").json()["message"]
        self.assertEqual((replay["cards_label"], self.ids(replay["cards"])), (None, ["ssp-2"]))

    def test_lone_selection_round_reports_dropped_ids_and_is_free(self) -> None:
        self.build(max_tool_rounds=2)
        reply = self.reply(
            message(both_searches(), "tool_use"),
            message([show("ssp-1", "invented-9")], "tool_use"),
            message([text("Pikachu ex leads at $120.")]),
        )
        calls = self.client.messages.calls
        self.assertEqual(len(calls), 3)
        self.assertEqual(calls[2]["tool_choice"], {"type": "auto"})  # the show_cards round didn't spend budget
        result = json.loads(calls[2]["messages"][-1]["content"][0]["content"])
        self.assertEqual(result, {"shown": 1, "not_shown": ["invented-9"],
                                  "note": result["note"]})
        self.assertEqual(self.ids(reply["cards"]), ["ssp-1"])
        self.assertIsNone(reply["cards_label"])

    def test_empty_selection_shows_no_tiles(self) -> None:
        reply = self.reply(
            message(both_searches(), "tool_use"),
            message([text("SIR means Special Illustration Rare."), show()], "tool_use"),
        )
        self.assertEqual(reply["cards"], [])

    def test_scanned_and_earlier_cards_can_be_shown_without_a_lookup(self) -> None:
        reply = self.reply(message([text("Your Eevee is the one."), show("ssp-3")], "tool_use"),
                           context={"source": "scanner", "card_ids": ["ssp-3"]})
        self.assertEqual(self.ids(reply["cards"]), ["ssp-3"])
        self.assertEqual(reply["cards"][0]["name"], "Eevee")
        first = self.reply(
            message([tool_use("search_cards", {"filter": {"text": "charizard"}}, "s")], "tool_use"),
            message([text("Charizard ex is $8."), show("ssp-2")], "tool_use"),
        )
        follow = self.reply(message([text("Charizard ex again."), show("ssp-2", "ssp-1")], "tool_use"),
                            thread_id=first["thread_id"])
        self.assertEqual(self.ids(follow["cards"]), ["ssp-2"])  # ssp-1 was never looked up or shown

    def test_select_tiles_matches_slab_and_printing(self) -> None:
        refs = [
            {"card_id": "x", "name": "X", "variant": "Holofoil", "grader": None, "grade": None},
            {"card_id": "x", "name": "X", "variant": "Reverse Holofoil", "grader": None, "grade": None},
            {"card_id": "x", "name": "X", "grader": "PSA", "grade": "10", "price_usd": 999.0},
        ]
        tiles, dropped = select_tiles(
            [{"card_id": "x", "variant": None, "grader": "psa", "grade": "10"},
             {"card_id": "x", "variant": "reverse holofoil", "grader": None, "grade": None},
             {"card_id": "x", "variant": None, "grader": None, "grade": None},  # same raw tile again
             {"card_id": "nope", "variant": None, "grader": None, "grade": None}],
            refs,
        )
        self.assertEqual([(t["grader"], t.get("variant")) for t in tiles], [("PSA", None), (None, "Reverse Holofoil")])
        self.assertEqual(dropped, ["nope"])

    def test_get_card_slab_holdings_tile_apart_from_the_raw_copies(self) -> None:
        # 2 raw Torchics + a CGC 9: the slab gets its own tile (grader/grade, its own qty, no raw price).
        refs = card_refs({
            "card_id": "tor", "name": "Torchic", "set": "Set", "number": "1", "price_usd": 2.0,
            "my_holdings": [
                {"holding_id": "h1", "grader": None, "grade": None, "variant": "Normal", "quantity": 2},
                {"holding_id": "h2", "grader": "cgc", "grade": "9", "variant": "Normal", "quantity": 1},
            ],
        })
        self.assertEqual(
            [(r["grader"], r["grade"], r["quantity_owned"], r["price_usd"]) for r in refs],
            [(None, None, 2, 2.0), ("CGC", "9", 1, None)],
        )
        tiles, _ = select_tiles(
            [{"card_id": "tor", "variant": None, "grader": None, "grade": None},
             {"card_id": "tor", "variant": None, "grader": "CGC", "grade": "9"}],
            refs,
        )
        self.assertEqual([t["grader"] for t in tiles], [None, "CGC"])

    def test_clean_label(self) -> None:
        self.assertEqual(clean_label("  Top holdings\n by value "), "Top holdings by value")
        self.assertIsNone(clean_label(None))
        self.assertIsNone(clean_label("<b>x</b>"))
        self.assertLessEqual(len(clean_label("x" * 100)), 40)


class FallbackTests(TilesCase):
    def test_tiles_follow_cards_named_in_text(self) -> None:
        search = message(both_searches(), "tool_use")
        reply = self.reply(search, message([text("Charizard ex is only $8.")]))
        self.assertEqual(self.ids(reply["cards"]), ["ssp-2"])
        self.assertIsNone(reply["cards_label"])
        search = message(both_searches(), "tool_use")
        reply = self.reply(search, message([text("Here are a few ex cards.")]))
        self.assertEqual(set(self.ids(reply["cards"])), {"ssp-1", "ssp-2", "jp-1"})  # old list (ssp-4 = reprint)

    def test_named_refs_number_and_longer_name(self) -> None:
        refs = [{"card_id": "a", "name": "Pikachu ex", "number": "238"},
                {"card_id": "b", "name": "Pikachu ex", "number": "250"},
                {"card_id": "c", "name": "Pikachu", "number": "58"}]
        self.assertEqual([r["card_id"] for r in named_refs(refs, "Pikachu ex (#250/191) is up.")], ["b"])
        self.assertEqual([r["card_id"] for r in named_refs(refs, "Pikachu  ex is up.")], ["a", "b"])
        self.assertEqual([r["card_id"] for r in named_refs(refs, "Pikachu ex beats Pikachu.")], ["a", "b", "c"])
        self.assertEqual(named_refs(refs, "Nothing named."), [])

    def test_chart_keeps_one_matching_tile(self) -> None:
        for days in (60, 30, 1):
            self.history_cell("ssp-1", days, 100.0 + days)
        self.conn.commit()
        reply = self.reply(
            message([*both_searches(), tool_use("get_price_history", {"card_id": "ssp-1"}, "h")], "tool_use"),
            message([text("It slid about 30% over two months.")]),
        )
        self.assertEqual(len(reply["charts"]), 1)
        self.assertEqual(self.ids(reply["cards"]), ["ssp-1"])
        # An explicit selection that forgets the charted card still gets its tile (first);
        # another card the text names stays.
        reply = self.reply(
            message([tool_use("get_price_history", {"card_id": "ssp-1"}, "h"),
                     tool_use("search_cards", {"filter": {"text": "charizard"}}, "s")], "tool_use"),
            message([text("Charizard ex is $8."), show("ssp-2")], "tool_use"),
        )
        self.assertEqual(self.ids(reply["cards"]), ["ssp-1", "ssp-2"])


class SameArtTests(TilesCase):
    def test_art_search_keeps_one_printing_per_artwork(self) -> None:
        outcome = AssistantToolbox(self.tools).run("search_cards", {"filter": {"scene": ["beach"]}}, owner_user_id=USER_A)
        self.assertFalse(outcome.is_error, outcome.content)
        ids = [item["card_id"] for item in outcome.content["results"]]
        self.assertEqual(sorted(ids), ["ssp-1", "ssp-3"])
        self.assertEqual(outcome.content["same_art_printings_hidden"], 2)
        self.assertEqual(sorted(card["card_id"] for card in outcome.cards), ["ssp-1", "ssp-3"])

    def test_art_search_accepts_game_and_product_scope(self) -> None:
        # "cards" means product=single; art search must not reject it as an unknown key.
        toolbox = AssistantToolbox(self.tools)
        outcome = toolbox.run("search_cards", {"filter": {"scene": ["beach"], "game": "pokemon", "product": "single"}},
                              owner_user_id=USER_A)
        self.assertFalse(outcome.is_error, outcome.content)
        self.assertEqual(sorted(item["card_id"] for item in outcome.content["results"]), ["ssp-1", "ssp-3"])
        outcome = toolbox.run("search_cards", {"filter": {"scene": ["beach"], "game": "onepiece"}}, owner_user_id=USER_A)
        self.assertTrue(outcome.is_error)

    def test_grading_upside_compares_at_most_three_candidates(self) -> None:
        outcome = AssistantToolbox(self.tools).run(
            "grading_upside", {"card_ids": ["ssp-1", "ssp-2", "ssp-3", "ssp-4"]}, owner_user_id=USER_A)
        self.assertFalse(outcome.is_error, outcome.content)
        self.assertEqual(sorted(card["card_id"] for card in outcome.content["cards"]), ["ssp-1", "ssp-2", "ssp-3"])

    def test_collapse_prefers_language_and_keeps_slot(self) -> None:
        groups = {"jp-1": "g", "ssp-1": "g", "ssp-3": "e"}
        items = [{"card_id": "jp-1", "language": "Japanese"}, {"card_id": "ssp-3"}, {"card_id": "ssp-1", "language": "English"}]
        kept, hidden = collapse_same_art(items, groups, preferred_language="English")
        self.assertEqual(([i["card_id"] for i in kept], hidden), (["ssp-1", "ssp-3"], 1))
        kept, _ = collapse_same_art(items, groups, across_languages=False)
        self.assertEqual([i["card_id"] for i in kept], ["jp-1", "ssp-3", "ssp-1"])

    def test_tiles_drop_same_language_reprints_but_keep_counterparts_and_grades(self) -> None:
        cards = AssistantToolbox(self.tools).finalize_cards([
            {"card_id": "ssp-1", "name": "Pikachu ex"},
            {"card_id": "ssp-4", "name": "Pikachu ex"},
            {"card_id": "jp-1", "name": "Pikachu ex", "language": "Japanese"},
            {"card_id": "ssp-1", "name": "Pikachu ex", "grader": "PSA", "grade": "10"},
        ])
        self.assertEqual([(c["card_id"], c.get("grader")) for c in cards],
                         [("ssp-1", None), ("jp-1", None), ("ssp-1", "PSA")])


    def test_imageless_card_shows_no_tile_unless_its_a_proposal(self) -> None:
        # Owner 2026-11-20: a tile with no photo is not shown; the large image is the fallback.
        self.conn.execute("UPDATE cards SET image_url = NULL, image_small_url = NULL WHERE id = 'ssp-3'")
        self.conn.execute(
            "UPDATE cards SET image_url = 'https://img.example/big.png', image_small_url = NULL WHERE id = 'ssp-2'"
        )
        toolbox = AssistantToolbox(self.tools)
        refs = [{"card_id": "ssp-2", "name": "Charizard ex"}, {"card_id": "ssp-3", "name": "Eevee"}]
        cards = toolbox.finalize_cards([dict(ref) for ref in refs])
        self.assertEqual([(c["card_id"], c["image_small_url"]) for c in cards],
                         [("ssp-2", "https://img.example/big.png")])
        kept = toolbox.finalize_cards([dict(ref) for ref in refs], keep_imageless={"ssp-3"})
        self.assertEqual(self.ids(kept), ["ssp-2", "ssp-3"])

    def test_model_label_never_reaches_the_tiles(self) -> None:
        reply = self.reply(
            message(both_searches(), "tool_use"),
            message([text("Charizard ex is up 12%."), show("ssp-2", label="Rising Pokémon sets")], "tool_use"),
        )
        self.assertEqual(self.ids(reply["cards"]), ["ssp-2"])
        self.assertIsNone(reply["cards_label"])
        show_cards = {t["name"]: t for t in TOOL_DEFINITIONS}["show_cards"]
        self.assertIn("label: always null", show_cards["description"])
        self.assertNotIn("Add a short label", SYSTEM_PROMPT)

    def test_list_bullets_get_bold_name_price_and_percent(self) -> None:
        reply = self.reply(
            message(both_searches(), "tool_use"),
            message([text("Two cards dipped lately.\n\n- Charizard ex (151): $8.00, down 12%\n"
                          "- **Eevee** (151): **$1,234.50**, -8%"), show("ssp-2", "ssp-3")], "tool_use"),
        )
        self.assertIn("- **Charizard ex** (151): **$8.00**, down **12%**", reply["text"])
        self.assertIn("- **Eevee** (151): **$1,234.50**, **-8%**", reply["text"])
        self.assertTrue(reply["text"].startswith("Two cards dipped lately."))


class BoldBulletBackstopTests(unittest.TestCase):
    def test_bolds_only_bullets_with_figures(self) -> None:
        from mcp_server.assistant.length_guard import bold_bullet_figures, word_count

        cases = {
            "- Plasma Storm: up 67%": "- **Plasma Storm**: up **67%**",
            "- Ascended Heroes \u2014 down 24%": "- **Ascended Heroes** \u2014 down **24%**",
            "- **Dusknoir** (DP33): $33.79, up +315%": "- **Dusknoir** (DP33): **$33.79**, up **+315%**",
            "- Open the Scan tab: point the camera": "- Open the Scan tab: point the camera",
            "Prices fell 12% to $5.": "Prices fell 12% to $5.",
            "- **Lugia** (HGSS02): raw **$485.99** \u00b7 no sale": "- **Lugia** (HGSS02): raw **$485.99** \u00b7 no sale",
            "- Up 12% at $40 for the set": "- Up **12%** at **$40** for the set",
        }
        for raw, want in cases.items():
            with self.subTest(raw=raw):
                out = bold_bullet_figures(raw)
                self.assertEqual(out, want)
                self.assertEqual(word_count(out), word_count(raw))  # bold never costs words



class SparklineTests(TilesCase):
    def test_near_low_tiles_carry_a_compact_series(self) -> None:
        for days in range(300, -1, -1):
            self.history_cell("ssp-1", days, 100.0 + days)
        now = utc_now()
        self.conn.execute(
            "INSERT INTO price_lows_runs (window_days, version, as_of_date, computed_at, stored_count, elapsed_ms) "
            "VALUES (365, 't', ?, ?, 1, 1)", (now[:10], now))
        self.conn.execute(
            "INSERT INTO price_lows (window_days, card_id, game, source, variant, price_usd, low_usd, high_usd, "
            "pct_below_high, pct_above_low, days_covered, at_window_low, rank, as_of_date) "
            "VALUES (365, 'ssp-1', 'pokemon', 'scrydex', 'holofoil', 100, 100, 400, 75, 0, 300, 1, 1, ?)",
            (now[:10],))
        self.conn.commit()
        reply = self.reply(
            message([tool_use("find_price_lows", {"window": "1y"}, "l"),
                     tool_use("search_cards", {"filter": {"text": "charizard"}}, "s")], "tool_use"),
            message([text("Pikachu ex sits at its 1-year low; Charizard ex is $8."), show("ssp-1", "ssp-2")], "tool_use"),
        )
        by_id = {card["card_id"]: card for card in reply["cards"]}
        line = by_id["ssp-1"]["sparkline"]
        # 300 days of history asked for 1y: labelled (and drawn) as the longest range it covers.
        self.assertEqual(line["range"], "90d")
        self.assertLessEqual(len(line["points"]), MAX_SPARKLINE_POINTS)
        self.assertGreater(len(line["points"]), 2)
        self.assertEqual(line["points"][-1], 100.0)
        self.assertGreaterEqual(line["points"][0], 185.0)
        self.assertLessEqual(line["points"][0], 190.0)
        self.assertNotIn("sparkline", by_id["ssp-2"])  # listed, but no stored history to draw

    def test_every_card_in_a_list_answer_gets_a_sparkline(self) -> None:
        # Owner 2026-11-21: one big chart + plain tiles for a 3-card answer. A list answer's
        # cards all get a compact series, also the charted one and the one from a plain search.
        for card_id, base in (("ssp-1", 100.0), ("ssp-2", 50.0), ("ssp-3", 20.0)):
            for days in range(100, -1, -1):
                self.history_cell(card_id, days, base + days / 10)
        self.conn.commit()
        reply = self.reply(
            message([tool_use("get_price_history", {"card_id": "ssp-1", "range": "90d"}, "h"),
                     tool_use("search_cards", {"filter": {"text": "charizard"}}, "s1"),
                     tool_use("search_cards", {"filter": {"text": "eevee"}}, "s2")], "tool_use"),
            message([text("- **Pikachu ex** fell.\n- **Charizard ex** fell.\n- **Eevee** fell."),
                     show("ssp-1", "ssp-2", "ssp-3")], "tool_use"),
        )
        self.assertEqual(self.ids(reply["cards"]), ["ssp-1", "ssp-2", "ssp-3"])
        for card in reply["cards"]:
            with self.subTest(card=card["card_id"]):
                line = card["sparkline"]
                self.assertEqual(line["range"], "90d")
                self.assertLessEqual(len(line["points"]), MAX_SPARKLINE_POINTS)
                self.assertLess(line["change_pct"], 0)
        # The big chart stays in the payload (older apps); the app draws rows for a list.
        self.assertEqual([chart["card_id"] for chart in reply["charts"]], ["ssp-1"])

    def test_single_card_chart_answer_gets_no_extra_series(self) -> None:
        for days in range(100, -1, -1):
            self.history_cell("ssp-1", days, 100.0 + days / 10)
        self.conn.commit()
        reply = self.reply(
            message([tool_use("get_price_history", {"card_id": "ssp-1", "range": "90d"}, "h")], "tool_use"),
            message([text("**Pikachu ex** is down 9% over 3 months, now $100."), show("ssp-1")], "tool_use"),
        )
        self.assertEqual(self.ids(reply["cards"]), ["ssp-1"])
        self.assertNotIn("sparkline", reply["cards"][0])
        self.assertEqual(len(reply["charts"]), 1)

    def test_full_year_series_keeps_1y_label(self) -> None:
        for days in range(366, -1, -1):
            self.history_cell("ssp-1", days, 100.0 + days)
        line = AssistantToolbox(self.tools).sparkline(USER_A, "ssp-1", range_key="1y", variant=None)
        self.assertEqual(line["range"], "1y")

    def test_61_day_series_asked_for_1y_is_labelled_30d(self) -> None:
        for days in range(61, -1, -1):
            self.history_cell("ssp-1", days, 100.0 + days)
        line = AssistantToolbox(self.tools).sparkline(USER_A, "ssp-1", range_key="1y", variant=None)
        self.assertEqual(line["range"], "30d")
        self.assertLessEqual(line["points"][0], 130.0)  # only the past 30 days are drawn

    def test_covered_range_never_labels_an_uncovered_range(self) -> None:
        today = datetime(2026, 11, 20).date()
        pts = [{"date": (today - timedelta(days=d)).isoformat(), "usd": float(d)} for d in range(85, -1, -1)]
        self.assertEqual(covered_range(pts, max_days=365, today=today)[0], "90d")  # within the 7-day slack
        self.assertEqual(covered_range(pts[-20:], max_days=365, today=today)[0], "7d")
        self.assertEqual(covered_range(pts, max_days=30, today=today)[0], "30d")
        self.assertEqual(covered_range(pts[-1:], max_days=365, today=today), (None, []))

    def test_market_trends_tiles_get_sparklines(self) -> None:
        for days in range(40, -1, -1):
            self.history_cell("ssp-1", days, 10.0 + days)
        payload = {"windowDays": 30, "asOfDate": utc_now()[:10], "games": [{"game": "pokemon", "items": [
            {"cardId": "ssp-1", "priceNow": 10.0, "priceThen": 40.0, "changePercent": 315.0, "currencyCode": "USD"},
        ]}]}
        upsert_runtime_setting(self.conn, key=LATEST_PAYLOAD_SETTING_KEY, value={"version": "v", "payload": payload})
        self.conn.commit()
        reply = self.reply(
            message([tool_use("get_market_trends", {}, "t")], "tool_use"),
            message([text("Pikachu ex is up 315% over 30 days. This is past price data, not a prediction."),
                     show("ssp-1")], "tool_use"),
        )
        line = {card["card_id"]: card for card in reply["cards"]}["ssp-1"]["sparkline"]
        self.assertEqual(line["range"], "30d")

    def test_fetch_range_per_tool(self) -> None:
        self.assertEqual(sparkline_fetch_range("get_market_trends", {"cards_window_days": 10}), "30d")
        self.assertEqual(sparkline_fetch_range("find_movers", {"window": "7d"}), "30d")
        self.assertEqual(sparkline_fetch_range("find_price_lows", {"window": "1y"}), "1y")
        self.assertIsNone(sparkline_fetch_range("get_market_trends", {}))


class WatchlistTests(TilesCase):
    def test_preview_sorted_capped_with_view_all(self) -> None:
        for index in range(10):
            card_id = f"w-{index}"
            self.card(card_id, f"Watch {index}", number=str(100 + index))
            self.price(card_id, float(10 + index))
            target = 1500 if index == 2 else None  # $15 target on a $12 card
            self.conn.execute(
                "INSERT INTO card_favorites (owner_user_id, card_id, variant_key, created_at, target_price_cents) "
                "VALUES (?, ?, '', ?, ?)", (USER_A, card_id, utc_now(), target))
        self.conn.commit()
        outcome = AssistantToolbox(self.tools).run("get_my_watchlist", {}, owner_user_id=USER_A)
        order = [item["card_id"] for item in outcome.content["items"]]
        self.assertEqual(order[:3], ["w-2", "w-9", "w-8"])
        reply = self.reply(
            message([tool_use("get_my_watchlist", {}, "w")], "tool_use"),
            message([text("You have 10 cards on your Watchlist; none is near a low.")]),
        )
        self.assertEqual(len(reply["cards"]), MAX_WATCHLIST_TILES)
        self.assertEqual(self.ids(reply["cards"])[:2], ["w-2", "w-9"])
        self.assertEqual(reply["cards_view_all"], {"screen": "watchlist", "total": 10})
        stored = self.conn.execute("SELECT cards_view_all_json FROM assistant_messages WHERE id = ?",
                                   (reply["id"],)).fetchone()[0]
        self.assertEqual(json.loads(stored), {"screen": "watchlist", "total": 10})

    def test_watchlist_order_unit(self) -> None:
        items = [{"card_id": "cheap", "price_usd": 1.0}, {"card_id": "none", "price_usd": None},
                 {"card_id": "far", "price_usd": 50.0, "target_price_usd": 10.0},
                 {"card_id": "near", "price_usd": 11.0, "target_price_usd": 10.0},
                 {"card_id": "pricey", "price_usd": 90.0}]
        self.assertEqual([i["card_id"] for i in watchlist_order(items)], ["near", "far", "pricey", "cheap", "none"])


def ref(card_id: str, name: str, number: str = "1", set_name: str = "Set", **extra: Any) -> dict[str, Any]:
    return {"card_id": card_id, "name": name, "number": number, "set": set_name, **extra}


@unittest.skipUnless(HAVE_DEPS, "assistant deps missing")
class ChooseTilesTests(unittest.TestCase):
    """Tile discipline in code: what the answer is about, whatever the model selected."""

    KYOGRE = [ref("bw5-104", "Kyogre-EX", "104/108", "Dark Explorers"), ref("xy5-148", "Kyogre-EX", "148/160", "Primal Clash"),
              ref("xy5-54", "Kyogre-EX", "54/160", "Primal Clash")]

    @staticmethod
    def ids(tiles: list[dict[str, Any]]) -> list[str]:
        return [tile["card_id"] for tile in tiles]

    @staticmethod
    def chart(card_id: str) -> dict[str, Any]:
        return {"card_id": card_id, "variant": None, "grader": None, "grade": None, "points": []}

    def test_chart_shows_only_the_charted_card(self) -> None:
        charizards = [ref("sv3pt5-199", "Charizard ex", "199/165", "151"), ref("sv3pt5-183", "Charizard ex", "183/165", "151"),
                      ref("sv3pt5-6", "Charizard ex", "006/165", "151")]
        tiles, charts = choose_tiles(None, charizards, "Charizard ex 151 #199 is down 31% since April.",
                                     [self.chart("sv3pt5-199")])
        self.assertEqual(self.ids(tiles), ["sv3pt5-199"])
        self.assertEqual(len(charts), 1)
        # The model's selection of other printings is dropped too.
        tiles, _ = choose_tiles(list(self.KYOGRE), self.KYOGRE, "Kyogre-EX held near $319, then jumped.",
                                [self.chart("bw5-104")])
        self.assertEqual(self.ids(tiles), ["bw5-104"])

    def test_two_charts_narrow_to_the_printing_the_text_pins(self) -> None:
        tiles, charts = choose_tiles(
            list(self.KYOGRE[:2]), self.KYOGRE, "The Dark Explorers Kyogre-EX (104/108) is worth $504.",
            [self.chart("bw5-104"), self.chart("xy5-148")],
        )
        self.assertEqual(self.ids(tiles), ["bw5-104"])
        self.assertEqual([chart["card_id"] for chart in charts], ["bw5-104"])

    def test_chart_keeps_the_scanned_card(self) -> None:
        refs = [ref("sv2a_ja-201", "Charizard ex", "201/165", "Pokémon Card 151"), ref("sv3pt5-199", "Charizard ex", "199/165", "151")]
        tiles, _ = choose_tiles(list(refs), refs, "The English counterpart is Charizard ex #199/165.",
                                [self.chart("sv3pt5-199")], keep_ids={"sv2a_ja-201"})
        self.assertEqual(self.ids(tiles), ["sv3pt5-199", "sv2a_ja-201"])

    def test_named_cards_cap_the_selection(self) -> None:
        refs = [ref("bw5-104", "Kyogre-EX"), ref("base2-11", "Snorlax"), ref("base1-6", "Gyarados"),
                ref("base2-12", "Vaporeon"), ref("swsh8b_ja-77", "Mimikyu VMAX")]
        tiles, _ = choose_tiles(list(refs), refs, "Kyogre-EX (+$18.49) and Snorlax (+$11.79) led; Gyarados gained 14%.", [])
        self.assertEqual(self.ids(tiles), ["bw5-104", "base2-11", "base1-6"])

    def test_named_card_missing_from_selection_is_added(self) -> None:
        refs = [ref("base4-10", "Mewtwo", "10/130", "Base Set 2"), ref("smp-SM77", "Mewtwo", "SM77"),
                ref("dp5-97", "Garchomp LV.X", "97/100", "Majestic Dawn"), ref("xy7-68", "Lugia-EX")]
        tiles, _ = choose_tiles([refs[0], refs[1], refs[3]], refs,
                                "Base Set 2 Mewtwo hit $164.96 and Majestic Dawn Garchomp LV.X $379.", [])
        self.assertEqual(self.ids(tiles), ["base4-10", "dp5-97"])

    def test_top_n_keeps_one_printing_per_name_unless_pinned(self) -> None:
        refs = [ref("p-107", "Pikachu ex", "107"), ref("p-109", "Pikachu ex", "109"), ref("e-108", "Espeon ex", "108"),
                ref("b-4", "Blastoise", "4/165")]
        tiles, _ = choose_tiles(list(refs), refs, "Pikachu ex and Espeon ex sit near their lows.", [])
        self.assertEqual(self.ids(tiles), ["p-107", "e-108"])
        tiles, _ = choose_tiles(list(refs), refs, "Pikachu ex #109 and Espeon ex sit near their lows.", [])
        self.assertEqual(self.ids(tiles), ["p-109", "e-108"])

    def test_set_pins_a_printing_the_number_does_not(self) -> None:
        refs = [ref("sv3pt5-199", "Charizard ex", "199/165", "151"),
                ref("sv3-223", "Charizard ex", "223/197", "Obsidian Flames"), ref("xy5-54", "Kyogre-EX", "54/160")]
        text = "The 151 Charizard ex (#199/165) is worth the most. The Obsidian Flames Charizard ex is $84 and Kyogre-EX $19."
        tiles, _ = choose_tiles(list(refs), refs, text, [])
        self.assertEqual(self.ids(tiles), ["sv3pt5-199", "sv3-223", "xy5-54"])

    def test_names_without_tiles_resolve_from_tool_results(self) -> None:
        refs = [ref("lorcana~FBL-242", "Mickey Mouse", "242/204", "Fabled"),
                ref("lorcana~WILD-241", "Buzz Lightyear", "241/204", "Wilds Unknown"),
                ref("lorcana~C1-5", "Mickey Mouse", "5/C1", "Challenge Promos", grader="CGC", grade="9.5"),
                ref("lorcana~FBL-111", "Mickey Mouse", "111/204", "Fabled", grader="BGS", grade="10")]
        text = "Mickey Mouse from Fabled (#242/204) leads raw; Buzz Lightyear follows. Graded: Mickey Mouse (#5/C1) CGC 9.5."
        expected = ["lorcana~FBL-242", "lorcana~WILD-241", "lorcana~C1-5"]
        self.assertEqual(self.ids(choose_tiles([], refs, text, [])[0]), expected)  # show_cards picked nothing
        self.assertEqual(self.ids(choose_tiles(None, refs, text, [])[0]), expected)  # show_cards never called
        # Pinned by set: the Fabled BGS 10 slab stays out unless the text names BGS.
        text = "Mickey Mouse from Fabled leads raw at $4,167, then Buzz Lightyear. Top graded: Challenge Promos Mickey Mouse, CGC 9.5."
        self.assertEqual(self.ids(choose_tiles([], refs, text, [])[0]), expected)

    def test_asking_to_choose_keeps_candidates(self) -> None:
        refs = [ref("c1", "Charizard", "4/102", "Base"), ref("c2", "Charizard", "11/108"), ref("c3", "Charizard ex", "199/165")]
        tiles, _ = choose_tiles(list(refs), refs, "There are many Charizard printings. Which set or number do you mean?", [])
        self.assertEqual(self.ids(tiles), ["c1", "c2", "c3"])
        # An offer ending in "?" is not a choice question.
        tiles, _ = choose_tiles(list(refs), refs, "Base Charizard (4/102) is $400. Want me to watch it?", [])
        self.assertEqual(self.ids(tiles), ["c1"])

    def test_watchlist_preview_and_browse_examples_keep_the_list(self) -> None:
        refs = [ref(f"w{i}", f"Card {chr(65 + i)}") for i in range(5)]
        ids = {r["card_id"] for r in refs}
        tiles, _ = choose_tiles(None, refs, "Card A is your priciest at $67.", [], watchlist_ids=ids)
        self.assertEqual(len(tiles), 5)
        tiles, _ = choose_tiles(list(refs), refs, "Here are cozy sleeping cards, including Card A and Card B.", [],
                                list_ids=ids)
        self.assertEqual(len(tiles), 5)
        # Not a browse list (e.g. near-lows): the examples marker doesn't widen it.
        tiles, _ = choose_tiles(list(refs), refs, "Several cards are near lows, including Card A.", [])
        self.assertEqual(self.ids(tiles), ["w0"])

    def test_list_answers_keep_the_list_and_its_stated_size(self) -> None:
        refs = [ref(f"s{i}", f"Card {chr(65 + i)}") for i in range(8)]
        ids = {r["card_id"] for r in refs}
        text = "There are 169 under $50; the priciest eight are led by Card A."
        self.assertEqual(len(choose_tiles(list(refs), refs, text, [], list_ids=ids)[0]), 8)
        tiles, _ = choose_tiles(list(refs), refs, "Here are your top three, led by Card A.", [], list_ids=ids)
        self.assertEqual(self.ids(tiles), ["s0", "s1", "s2"])
        # The user asked for five: five tiles even though the answer names one.
        tiles, _ = choose_tiles(list(refs), refs, "Your top holding is Card A.", [],
                                question="What are my 5 most valuable cards?")
        self.assertEqual(self.ids(tiles), ["s0", "s1", "s2", "s3", "s4"])

    def test_no_names_keeps_selection_and_proposals_always_show(self) -> None:
        refs = [ref("a", "Alpha"), ref("b", "Beta"), ref("c", "Gamma")]
        tiles, _ = choose_tiles([refs[0], refs[1]], refs, "Here are 2 under $20.", [])
        self.assertEqual(self.ids(tiles), ["a", "b"])
        tiles, _ = choose_tiles([refs[0]], refs, "Alpha is ready to confirm.", [], always_ids={"c"})
        self.assertEqual(self.ids(tiles), ["a", "c"])

    def test_select_tiles_accepts_an_id_without_its_game_prefix(self) -> None:
        refs = [ref("lorcana~FBL-242", "Mickey Mouse")]
        tiles, dropped = select_tiles([{"card_id": "FBL-242", "variant": None, "grader": None, "grade": None}], refs)
        self.assertEqual((self.ids(tiles), dropped), (["lorcana~FBL-242"], []))


@unittest.skipUnless(HAVE_DEPS, "assistant deps missing")
class QuestionRuleTests(unittest.TestCase):
    """Question-shaped tile rules applied after choose_tiles (eval round 4)."""

    @staticmethod
    def ids(tiles: list[dict[str, Any]]) -> list[str]:
        return [tile["card_id"] for tile in tiles]

    def rules(self, tiles, question, text="", **kw):
        kw.setdefault("pool", list(tiles))
        kw.setdefault("holding_refs", [])
        kw.setdefault("language_pairs", {})
        return apply_question_rules(list(tiles), [], None, question=question, text=text, **kw)

    def test_collection_value_shows_top_holdings_by_value(self) -> None:
        holdings = [ref("a", "Alpha", price_usd=10.0, quantity_owned=1), ref("b", "Beta", price_usd=5.0, quantity_owned=6),
                    ref("c", "Gamma", price_usd=50.0, quantity_owned=1)]
        mover = ref("m", "Mover", price_usd=1.0, quantity_owned=1)
        tiles, _, label = self.rules([mover, holdings[0]], "What's my collection worth?", holding_refs=holdings)
        self.assertEqual((self.ids(tiles), label), (["c", "b", "a"], HOLDINGS_LABEL))
        # Not a value question: untouched.
        tiles, _, label = self.rules([mover], "What are my 5 most valuable cards?", holding_refs=holdings)
        self.assertEqual((self.ids(tiles), label), (["m"], None))

    def test_movers_and_ranking_answers_keep_three_named_in_text_order(self) -> None:
        names = ["Kyogre-EX", "Snorlax", "Gyarados", "Vaporeon", "Mimikyu VMAX"]
        cards = [ref(str(i), name) for i, name in enumerate(names)]
        text = "Snorlax and Kyogre-EX gained most; Mimikyu VMAX rose 30%."
        tiles, _, _ = self.rules(cards, "What were my biggest gainers this month?", text)
        self.assertEqual(self.ids(tiles), ["1", "0", "4"])
        tiles, _, _ = self.rules(cards, "Cards with new highs", text, tools_used={"find_new_highs"})
        self.assertEqual(len(tiles), 3)
        tiles, _, _ = self.rules(cards, "Show me Pikachu cards", text, tools_used={"search_cards"})
        self.assertEqual(len(tiles), 5)

    def test_ranking_cap_only_drops_unnamed_tiles(self) -> None:
        names = ["Kyogre-EX", "Snorlax", "Gyarados", "Vaporeon", "Mimikyu VMAX"]
        cards = [ref(str(i), name) for i, name in enumerate(names)]
        text = "Snorlax and Kyogre-EX gained most; Mimikyu VMAX rose 30%. Gyarados and Vaporeon also rose."
        tiles, _, _ = self.rules(cards, "What were my biggest gainers this month?", text)
        self.assertEqual(self.ids(tiles), ["1", "0", "4", "2", "3"])
        tiles, _, _ = self.rules(cards, "What's likely to go up?", "Snorlax leads.", tools_used={"get_market_trends"})
        self.assertEqual(self.ids(tiles), ["1", "0", "2"])

    def test_counterpart_question_shows_the_counterpart_plus_a_scanned_source(self) -> None:
        en = ref("sv3pt5-199", "Charizard ex", language="English")
        jp = ref("sv2a_ja-201", "Charizard ex", language="Japanese")
        pairs = {"sv3pt5-199": "sv2a_ja-201", "sv2a_ja-201": "sv3pt5-199"}
        tiles, _, _ = self.rules([jp, en], "Is there a Japanese version of Charizard ex 151 #199?", language_pairs=pairs)
        self.assertEqual(self.ids(tiles), ["sv2a_ja-201"])
        tiles, _, _ = self.rules([en], "What's the English version of this card?", language_pairs=pairs,
                                 pool=[en, jp], keep_ids={"sv2a_ja-201"})
        self.assertEqual(self.ids(tiles), ["sv2a_ja-201", "sv3pt5-199"])

    def test_singular_most_expensive_keeps_one_raw_and_one_graded_leader(self) -> None:
        cards = [ref("r1", "Rocks"), ref("r2", "Nami"), ref("g1", "Mickey", grader="PSA", grade="10"),
                 ref("g2", "Elsa", grader="PSA", grade="10")]
        tiles, _, _ = self.rules(cards, "What's the most expensive One Piece card?", tools_used={"search_cards"})
        self.assertEqual(self.ids(tiles), ["r1", "g1"])
        # Every card the text names stays a tile (the re-ask named the runners-up).
        text = "Rocks is the top single, ahead of Nami. The top slab is a PSA 10 Mickey."
        tiles, _, _ = self.rules(cards, "What's the most expensive One Piece card?", text, tools_used={"search_cards"})
        self.assertEqual(self.ids(tiles), ["r1", "r2", "g1"])
        tiles, _, _ = self.rules(cards, "What are the most expensive Lorcana cards?", tools_used={"search_cards"})
        self.assertEqual(len(tiles), 4)

    def test_proposals_are_left_alone(self) -> None:
        cards = [ref(str(i), f"Card {i}") for i in range(5)]
        tiles, _, _ = self.rules(cards, "Add my biggest gainers", always_ids={"0"})
        self.assertEqual(len(tiles), 5)

    def test_movers_only_drops_value_and_overall_change(self) -> None:
        summary = {"range": "30d", "value_usd": 100.0, "change_usd": -9.0, "change_pct": -9.0, "top_holdings": [{}],
                   "top_gainers": [{"card_id": str(i)} for i in range(5)], "top_losers": [], "movers_basis": "x"}
        out = movers_only(summary)
        self.assertEqual(set(out), {"range", "top_gainers", "top_losers", "movers_basis"})
        self.assertEqual(len(out["top_gainers"]), 3)

    def test_typed_tool_calls_are_stripped_from_the_answer(self) -> None:
        typed = ('Charizard ex is worth the most at $287.93.\n\n'
                 'show_cards(cards: [{card_id: "sv3pt5-199", variant: null}], label: "x (y)")')
        self.assertEqual(strip_pseudo_calls(typed), "Charizard ex is worth the most at $287.93.")


class EngineRuleTests(TilesCase):
    def test_scanned_cards_named_in_text_become_tiles(self) -> None:
        reply = self.reply(message([text("Your Eevee is worth the most.")]), text_value="Which of these is worth the most?",
                           context={"source": "scanner", "card_ids": ["ssp-3", "ssp-2"]})
        self.assertEqual(self.ids(reply["cards"]), ["ssp-3"])

    def test_answer_written_beside_the_last_lookup_is_kept(self) -> None:
        reply = self.reply(
            message([tool_use("search_cards", {"filter": {"text": "pikachu"}}, "s1")], "tool_use"),
            message([text("Pikachu ex is $120 now."), tool_use("search_cards", {"filter": {"text": "pikachu"}}, "s2")],
                    "tool_use"),
            message([]),
            text_value="How much is Pikachu ex 238?",
        )
        self.assertEqual(reply["text"], "Pikachu ex is $120 now.")

    def test_collection_value_tiles_are_top_holdings(self) -> None:
        reply = self.reply(message([tool_use("get_portfolio_summary", {"range": "30d"}, "p")], "tool_use"),
                           message([text("Your collection is worth $144.")]))
        self.assertEqual(reply["cards_label"], HOLDINGS_LABEL)
        values = [card["price_usd"] * (card.get("quantity_owned") or 1) for card in reply["cards"]]
        self.assertEqual(values, sorted(values, reverse=True))
        self.assertIn("ssp-1", self.ids(reply["cards"]))

    def test_slab_and_unit_price_sorts(self) -> None:
        box = AssistantToolbox(self.tools)
        slabs = box.run("get_my_collection", {"holding_type": "graded"}, owner_user_id=USER_A).content
        self.assertTrue(slabs["items"] and all(item["grader"] for item in slabs["items"]))
        by_price = box.run("get_my_collection", {"sort": "price_desc"}, owner_user_id=USER_A).content
        prices = [item["price_usd"] for item in by_price["items"] if item["price_usd"] is not None]
        self.assertEqual(prices, sorted(prices, reverse=True))
        self.assertNotIn("unpriced_count", by_price)


if __name__ == "__main__":
    unittest.main()
