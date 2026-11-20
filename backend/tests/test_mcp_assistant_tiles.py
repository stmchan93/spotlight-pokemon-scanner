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
from catalog_tools import upsert_card, utc_now  # noqa: E402

if HAVE_DEPS:
    from mcp_server.assistant.engine import SYSTEM_PROMPT
    from mcp_server.assistant.tools import (
        MAX_SPARKLINE_POINTS,
        MAX_WATCHLIST_TILES,
        TOOL_DEFINITIONS,
        AssistantToolbox,
        choose_tiles,
        clean_label,
        collapse_same_art,
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

    def test_selection_with_answer_is_final_and_label_persists(self) -> None:
        reply = self.reply(
            message(both_searches(), "tool_use"),
            message([text("Charizard ex is the cheap one at $8."), show("ssp-2", "made-up", label="  Cheapest\nex  ")],
                    "tool_use"),
            cmid="sel-1",
        )
        self.assertEqual(len(self.client.messages.calls), 2)  # no extra round after show_cards
        self.assertEqual(self.ids(reply["cards"]), ["ssp-2"])
        self.assertEqual(reply["cards"][0]["name"], "Charizard ex")
        self.assertEqual(reply["cards_label"], "Cheapest ex")
        self.assertIsNone(reply["cards_view_all"])
        self.assertEqual(reply["text"], "Charizard ex is the cheap one at $8.")
        row = self.conn.execute("SELECT cards_label, tools_used FROM assistant_messages WHERE id = ?",
                                (reply["id"],)).fetchone()
        self.assertEqual(row["cards_label"], "Cheapest ex")
        self.assertIn("show_cards", json.loads(row["tools_used"]))
        listed = self.http.get(f"/api/v1/assistant/threads/{reply['thread_id']}/messages",
                               headers=bearer(USER_A)).json()["messages"]
        self.assertEqual([m["cards_label"] for m in listed], [None, "Cheapest ex"])
        replay = self.ask(cmid="sel-1").json()["message"]
        self.assertEqual((replay["cards_label"], self.ids(replay["cards"])), ("Cheapest ex", ["ssp-2"]))

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
        self.assertEqual(line["range"], "1y")
        self.assertLessEqual(len(line["points"]), MAX_SPARKLINE_POINTS)
        self.assertGreater(len(line["points"]), 2)
        self.assertEqual((line["points"][0], line["points"][-1]), (400.0, 100.0))
        self.assertEqual(line["change_pct"], -75.0)
        self.assertNotIn("sparkline", by_id["ssp-2"])  # not from a lows/highs result


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


if __name__ == "__main__":
    unittest.main()
