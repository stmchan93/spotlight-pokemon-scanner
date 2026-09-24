"""meta_pulse: group tagging rules, same-printing pairing, median over MOVED
cards only, value sums, thresholds, graded lane (incl. missing graded data →
null summary), headline fallbacks and the exact ``MetaPulse`` payload shape.
"""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from datetime import date, timedelta
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from catalog_tools import (  # noqa: E402
    apply_schema,
    connect,
    upsert_card,
    upsert_fx_rate_snapshot,
    utc_now,
)
from meta_pulse import (  # noqa: E402
    LANE_GRADED,
    LANE_RAW,
    CardInfo,
    PricePair,
    aggregate_groups,
    build_headline,
    build_meta_pulse_payload,
    compute_meta_pulse,
    ensure_schema,
    era_for_release_date,
    group_defs_for,
    is_gold_star,
    language_key,
    meta_pulse_version_token,
    normalize_grade,
    normalize_grader,
    spark_dates,
    tag_card,
)
from server import _apply_price_history_cells_schema_patch  # noqa: E402

TODAY = date(2026, 9, 20)

META_PULSE_KEYS = {
    "game", "windowDays", "lane", "availableWindows", "availableGames", "computedAt",
    "asOfDate", "headline", "summary", "groups", "ladders",
}
SUMMARY_KEYS = {
    "rawValueChangePercent", "rawValueChangeUsd", "gradedValueChangePercent",
    "gradedValueChangeUsd", "risingCount", "coolingCount",
}
GROUP_KEYS = {
    "groupKey", "label", "lane", "description", "medianChangePercent", "valueNow", "valueThen",
    "valueChangeUsd", "cardCount", "movedCardCount", "sparkPoints", "topCards",
}
CARD_KEYS = {
    "cardId", "game", "name", "number", "setName", "imageUrl", "lane", "grader", "grade",
    "population", "priceNow", "priceThen", "changePercent", "currencyCode",
}


def _d(days_ago: int) -> str:
    return (TODAY - timedelta(days=days_ago)).isoformat()


def _tags(**kwargs):
    info = CardInfo(card_id=kwargs.pop("card_id", "x"), game=kwargs.pop("game", "pokemon"),
                    name=kwargs.pop("name", "Card"), **kwargs)
    return tag_card(info)


class TaggingTests(unittest.TestCase):
    def test_era_boundaries_and_formats(self) -> None:
        self.assertEqual(era_for_release_date("1999/01/09"), "vintage")
        self.assertEqual(era_for_release_date("2002-12-31"), "vintage")
        self.assertEqual(era_for_release_date("2003-01-01"), "ex_era")
        self.assertEqual(era_for_release_date("2007-12-31T00:00:00Z"), "ex_era")
        self.assertIsNone(era_for_release_date("2008-01-01"))
        self.assertIsNone(era_for_release_date(None))
        self.assertIsNone(era_for_release_date("soon"))

    def test_language_gold_star_and_grade_normalization(self) -> None:
        self.assertEqual(language_key("Japanese"), "jp")
        self.assertEqual(language_key("English"), "en")
        self.assertEqual(language_key(None), "en")
        self.assertTrue(is_gold_star("Umbreon ☆", "Rare Holo"))
        self.assertTrue(is_gold_star("Rayquaza Star", "Rare Holo Star"))
        self.assertFalse(is_gold_star("Pikachu", "2 Star"))  # JP rarity tier, not a Gold Star
        self.assertFalse(is_gold_star("Starmie", "Rare"))
        self.assertEqual(normalize_grade("10.0"), "10")
        self.assertEqual(normalize_grade("9.50"), "9.5")
        self.assertEqual(normalize_grader("beckett"), "BGS")
        self.assertEqual(normalize_grader("psa"), "PSA")

    def test_raw_groups_from_rules(self) -> None:
        tags = _tags(rarity="Special Illustration Rare", language="Japanese", release_date="2024-01-26")
        keys = {g.key for g in group_defs_for(tags, lane=LANE_RAW)}
        self.assertEqual(keys, {"sir:raw", "japanese:raw"})
        promo = _tags(rarity="Promo", language="Japanese", release_date="2001-01-01")
        keys = {g.key for g in group_defs_for(promo, lane=LANE_RAW)}
        self.assertEqual(keys, {"vintage:raw", "promo:raw", "jp_promo:raw", "japanese:raw"})

    def test_graded_tiers_and_pop_bands(self) -> None:
        tags = _tags(name="Lugia", rarity="Rare Holo", release_date="2002-09-15")
        groups = group_defs_for(tags, lane=LANE_GRADED, grader="PSA", grade="10", population=37)
        keys = {g.key for g in groups}
        self.assertEqual(
            keys,
            {"vintage:graded:psa10", "vintage:graded:psa10:pop_le_200", "vintage:graded:psa10:pop_le_50"},
        )
        labels = {g.key: g.label for g in groups}
        self.assertEqual(labels["vintage:graded:psa10:pop_le_50"], "Vintage PSA 10 · pop ≤ 50")
        # Unknown pop → no pop band; PSA 9 → only the psa9 tier.
        keys = {g.key for g in group_defs_for(tags, lane=LANE_GRADED, grader="PSA", grade="10", population=None)}
        self.assertEqual(keys, {"vintage:graded:psa10"})
        keys = {g.key for g in group_defs_for(tags, lane=LANE_GRADED, grader="PSA", grade="9.0", population=5)}
        self.assertEqual(keys, {"vintage:graded:psa9"})

    def test_gold_star_rule_and_game_scoping(self) -> None:
        star = _tags(name="Umbreon ☆", rarity="Rare Holo Star", release_date="2005-05-04")
        keys = {g.key for g in group_defs_for(star, lane=LANE_GRADED, grader="PSA", grade="10", population=120)}
        self.assertIn("gold_star:graded:psa10", keys)
        self.assertIn("ex_era:graded:psa10:pop_le_200", keys)
        # Pop bands and Gold Stars are Pokémon-only.
        op = _tags(game="onepiece", name="Luffy ☆", rarity="Secret Rare", release_date="2001-01-01")
        keys = {g.key for g in group_defs_for(op, lane=LANE_GRADED, grader="PSA", grade="10", population=10)}
        self.assertEqual(keys, {"vintage:graded:psa10", "secret:graded:psa10"})


def _pair(card_id: str, then: float, now: float, lane: str = LANE_RAW, **kwargs) -> PricePair:
    return PricePair(card_id=card_id, game="pokemon", lane=lane, price_then=then, price_now=now, **kwargs)


class AggregationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.vintage = _tags(rarity="Rare Holo", release_date="1999-01-09")

    def test_median_over_moved_cards_and_value_sums(self) -> None:
        pairs = [_pair(f"flat{i}", 10.0, 10.0) for i in range(4)]
        pairs += [_pair("m1", 10.0, 11.0), _pair("m2", 10.0, 12.0), _pair("m3", 10.0, 13.0),
                  _pair("m4", 10.0, 9.0), _pair("m5", 20.0, 30.0), _pair("m6", 100.0, 150.0)]
        tags = {p.card_id: self.vintage for p in pairs}
        groups, totals = aggregate_groups(pairs, tags)
        group = next(g for g in groups if g.group_key == "vintage:raw")
        # Moved pcts: 10, 20, 30, -10, 50, 50 → median 25 (flat cards ignored).
        self.assertAlmostEqual(group.median_change_pct, 25.0)
        self.assertEqual((group.card_count, group.moved_card_count), (10, 6))
        self.assertAlmostEqual(group.value_then, 40.0 + 40.0 + 20.0 + 100.0)
        self.assertAlmostEqual(group.value_now, 40.0 + 11 + 12 + 13 + 9 + 30 + 150)
        # Top cards: biggest $ contributors in the group's direction only.
        self.assertEqual([p.card_id for p in group.top_pairs], ["m6", "m5", "m3", "m2", "m1"])
        self.assertEqual(totals[("pokemon", LANE_RAW)].paired, 10)

    def test_thresholds(self) -> None:
        few = [_pair(f"c{i}", 10.0, 11.0 + i) for i in range(7)]
        groups, _ = aggregate_groups(few, {p.card_id: self.vintage for p in few})
        self.assertEqual(groups, [])  # 7 < min group size
        mostly_flat = [_pair(f"f{i}", 10.0, 10.0) for i in range(10)]
        mostly_flat += [_pair("a", 10.0, 12.0), _pair("b", 10.0, 13.0)]
        groups, _ = aggregate_groups(mostly_flat, {p.card_id: self.vintage for p in mostly_flat})
        self.assertEqual(groups, [])  # only 2 moved

    def test_cooling_group_top_cards_are_fallers(self) -> None:
        pairs = [_pair(f"d{i}", 20.0, 18.0 - i) for i in range(8)] + [_pair("up", 20.0, 40.0)]
        groups, _ = aggregate_groups(pairs, {p.card_id: self.vintage for p in pairs})
        group = groups[0]
        self.assertLess(group.median_change_pct, 0)
        self.assertNotIn("up", [p.card_id for p in group.top_pairs])
        self.assertEqual(group.top_pairs[0].card_id, "d7")

    def test_spark_dates_keep_ends_and_cap_points(self) -> None:
        dates = spark_dates(TODAY - timedelta(days=90), TODAY)
        self.assertEqual(len(dates), 30)
        self.assertEqual((dates[0], dates[-1]), (_d(90), _d(0)))
        self.assertEqual(len(spark_dates(TODAY - timedelta(days=7), TODAY)), 8)


class HeadlineTests(unittest.TestCase):
    @staticmethod
    def _g(label: str, pct: float) -> dict:
        return {"label": label, "medianChangePercent": pct, "groupKey": label, "lane": "raw"}

    def test_riser_and_cooler_with_graded_comparison(self) -> None:
        headline = build_headline(
            [self._g("Vintage PSA 10 · pop ≤ 50", 18.4), self._g("Special Illustration Rare", -4.1)],
            {"rawValueChangePercent": 1.8, "gradedValueChangePercent": 6.1}, 7,
        )
        self.assertEqual(
            headline["title"],
            "Vintage PSA 10 · pop ≤ 50 is running. Special Illustration Rare is cooling.",
        )
        self.assertEqual(
            headline["body"],
            "Vintage PSA 10 · pop ≤ 50 gained 18.4% this week. Graded value is up 6.1% while raw is up 1.8%.",
        )

    def test_fallbacks(self) -> None:
        only_up = build_headline([self._g("Vintage", 4.0)], {"rawValueChangePercent": -0.5,
                                                              "gradedValueChangePercent": None}, 30)
        self.assertEqual(only_up["title"], "Vintage is running.")
        self.assertEqual(only_up["body"], "Vintage gained 4% this month. Raw value is down 0.5%.")
        only_down = build_headline([self._g("Promos", -3.0)], {"rawValueChangePercent": None,
                                                               "gradedValueChangePercent": None}, 90)
        self.assertEqual(only_down["title"], "Promos is cooling.")
        self.assertEqual(only_down["body"], "Promos slipped 3% over 90 days.")
        flat = build_headline([self._g("Vintage", 0.2)], {}, 7)
        self.assertEqual(flat["title"], "Prices are holding steady.")
        empty = build_headline([], {}, 7)
        self.assertEqual(empty["title"], "Not enough price history yet.")


class ComputeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.connection = connect(Path(self.tempdir.name) / "meta.sqlite")
        self.addCleanup(self.connection.close)
        apply_schema(self.connection, BACKEND_ROOT / "schema.sql")
        _apply_price_history_cells_schema_patch(self.connection)
        upsert_fx_rate_snapshot(self.connection, base_currency="JPY", quote_currency="USD",
                                rate=0.0067, source="test")
        self.connection.commit()

    # --- seeding ----------------------------------------------------------

    def _card(self, card_id: str, *, rarity: str = "Rare Holo", release: str = "1999/01/09",
              language: str = "English", game: str = "pokemon", name: str | None = None) -> None:
        upsert_card(
            self.connection, card_id=card_id, name=name or card_id.title(), set_name="Base Set",
            number="4/102", rarity=rarity, variant="Raw", language=language, game=game,
            source_provider="scrydex", source_record_id=card_id, set_release_date=release,
            image_small_url=f"https://img/{card_id}.png",
        )

    def _raw(self, card_id: str, days_ago: int, price: float, variant: str = "Holofoil") -> None:
        self.connection.execute(
            "INSERT INTO card_price_history_daily (card_id, provider, price_date, display_currency_code, "
            "main_raw_market_price, main_raw_variant, updated_at) VALUES (?, 'scrydex', ?, 'USD', ?, ?, ?) "
            "ON CONFLICT(card_id, price_date) DO UPDATE SET main_raw_market_price = excluded.main_raw_market_price, "
            "main_raw_variant = excluded.main_raw_variant",
            (card_id, _d(days_ago), price, variant, utc_now()),
        )

    def _graded(self, card_id: str, days_ago: int, price: float, *, grader: str = "PSA", grade: str = "10",
                signed: int = 0, variant: str = "holofoil", currency: str = "USD") -> None:
        self.connection.execute(
            "INSERT INTO card_price_history_cell (card_id, provider, price_date, lane, cell_key, variant_key, "
            "grader, grade, is_perfect, is_signed, is_error, currency_code, market, updated_at) "
            "VALUES (?, 'scrydex', ?, 'graded', ?, ?, ?, ?, 0, ?, 0, ?, ?, ?)",
            (card_id, _d(days_ago), f"graded|{grader}|{grade}|{variant}|p0s{signed}e0", variant,
             grader, grade, signed, currency, price, utc_now()),
        )

    def _population(self, card_id: str, psa10: int) -> None:
        self.connection.execute(
            "INSERT INTO card_price_snapshots (card_id, provider, display_currency_code, population_json, "
            "updated_at) VALUES (?, 'scrydex', 'USD', ?, ?)",
            (card_id, json.dumps({"PSA": {"totalPopulation": psa10 * 3, "grades": {"10": psa10}}}), utc_now()),
        )

    def _seed_vintage_raw(self, count: int = 10, *, history_days: int = 30) -> None:
        for i in range(count):
            card_id = f"v{i}"
            self._card(card_id)
            then = 10.0 + i
            now = then * (1.10 if i % 2 == 0 else 1.0)  # half move +10%, half flat
            for days_ago in range(history_days, -1, -1):
                self._raw(card_id, days_ago, then if days_ago > 3 else now)

    def _compute(self, **kwargs):
        self.connection.commit()
        return compute_meta_pulse(self.connection, today=TODAY, **kwargs)

    # --- tests --------------------------------------------------------------

    def test_raw_group_end_to_end_and_payload_shape(self) -> None:
        self._seed_vintage_raw()
        result = self._compute(games=["pokemon"])
        self.assertEqual(result["status"], "ok")
        payload = build_meta_pulse_payload(self.connection, game="pokemon", window_days=7, lane="all")
        self.assertEqual(set(payload), META_PULSE_KEYS)
        self.assertEqual(set(payload["summary"]), SUMMARY_KEYS)
        self.assertEqual(set(payload["headline"]), {"title", "body"})
        self.assertEqual(payload["asOfDate"], TODAY.isoformat())
        self.assertEqual(payload["availableWindows"], [7, 30])  # only 30 days of history
        self.assertEqual(payload["availableGames"], ["pokemon"])
        group = next(g for g in payload["groups"] if g["groupKey"] == "vintage:raw")
        self.assertEqual(set(group), GROUP_KEYS)
        self.assertEqual(group["label"], "Vintage")
        self.assertEqual(group["description"], "pre-2003 · 10 cards")
        self.assertEqual((group["cardCount"], group["movedCardCount"]), (10, 5))
        self.assertAlmostEqual(group["medianChangePercent"], 10.0)
        value_then = sum(10.0 + i for i in range(10))
        value_now = sum((10.0 + i) * (1.10 if i % 2 == 0 else 1.0) for i in range(10))
        self.assertAlmostEqual(group["valueThen"], round(value_then, 2))
        self.assertAlmostEqual(group["valueNow"], round(value_now, 2))
        self.assertAlmostEqual(group["valueChangeUsd"], round(value_now - value_then, 2))
        self.assertEqual(group["sparkPoints"][0], 100.0)
        self.assertAlmostEqual(group["sparkPoints"][-1], round(value_now / value_then * 100, 2))
        self.assertEqual(len(group["sparkPoints"]), 8)
        self.assertEqual(len(group["topCards"]), 5)
        card = group["topCards"][0]
        self.assertEqual(set(card), CARD_KEYS)
        self.assertEqual((card["cardId"], card["lane"], card["grader"]), ("v8", "raw", None))
        # No graded data anywhere → graded summary null, no graded sentence.
        summary = payload["summary"]
        self.assertIsNone(summary["gradedValueChangePercent"])
        self.assertIsNone(summary["gradedValueChangeUsd"])
        self.assertAlmostEqual(summary["rawValueChangePercent"], round((value_now - value_then) / value_then * 100, 1))
        self.assertEqual(summary["risingCount"], len(payload["groups"]))
        self.assertEqual(payload["headline"]["title"], f"{payload['groups'][0]['label']} is running.")
        self.assertNotIn("Graded", payload["headline"]["body"])
        self.assertIsNotNone(meta_pulse_version_token(self.connection))
        # Unavailable window → empty groups, null summary, fallback headline.
        payload90 = build_meta_pulse_payload(self.connection, game="pokemon", window_days=90)
        self.assertEqual(payload90["groups"], [])
        self.assertIsNone(payload90["summary"]["rawValueChangePercent"])
        self.assertEqual(payload90["headline"]["title"], "Not enough price history yet.")

    def test_printing_switch_is_not_paired(self) -> None:
        self._seed_vintage_raw(count=8)
        self._card("switch")
        self._raw("switch", 7, 40.0, variant="Normal")
        self._raw("switch", 0, 400.0, variant="Holofoil")
        self._compute(games=["pokemon"])
        payload = build_meta_pulse_payload(self.connection, game="pokemon", window_days=7)
        group = next(g for g in payload["groups"] if g["groupKey"] == "vintage:raw")
        self.assertEqual(group["cardCount"], 8)
        self.assertNotIn("switch", [c["cardId"] for c in group["topCards"]])

    def test_graded_lane_pop_bands_ladder_and_filters(self) -> None:
        self._seed_vintage_raw()
        for i in range(10):
            card_id = f"v{i}"
            self._population(card_id, 30 if i < 8 else 500)
            then = 100.0 + i * 10
            for days_ago in range(0, 31):
                self._graded(card_id, days_ago, then if days_ago > 3 else then * 1.2)
                self._graded(card_id, days_ago, 50.0 if days_ago > 3 else 50.0 + i + 1, grade="9")
            # Signed slabs never count.
            self._graded(card_id, 7, 10.0, signed=1)
            self._graded(card_id, 0, 9000.0, signed=1)
        result = self._compute(games=["pokemon"])
        self.assertEqual(result["gradedPairs"]["7"], 20)
        payload = build_meta_pulse_payload(self.connection, game="pokemon", window_days=7)
        keys = {g["groupKey"]: g for g in payload["groups"]}
        self.assertEqual(keys["vintage:graded:psa10"]["cardCount"], 10)
        self.assertAlmostEqual(keys["vintage:graded:psa10"]["medianChangePercent"], 20.0)
        self.assertEqual(keys["vintage:graded:psa10:pop_le_50"]["cardCount"], 8)
        self.assertEqual(keys["vintage:graded:psa10:pop_le_50"]["label"], "Vintage PSA 10 · pop ≤ 50")
        top = keys["vintage:graded:psa10:pop_le_50"]["topCards"][0]
        self.assertEqual((top["grader"], top["grade"], top["population"], top["lane"]), ("PSA", "10", 30, "graded"))
        self.assertLessEqual(top["priceNow"], 1000.0)  # the $9,000 signed cell is ignored
        self.assertIsNotNone(payload["summary"]["gradedValueChangePercent"])
        self.assertIn("Graded value is up", payload["headline"]["body"])
        # Ladder rungs in rule order, raw first.
        ladder = next(l for l in payload["ladders"] if l["title"] == "Vintage: raw vs graded")
        self.assertEqual([r["label"] for r in ladder["rungs"]], ["Raw NM", "PSA 9", "PSA 10", "PSA 10 · pop ≤ 50"])
        self.assertEqual(set(ladder["rungs"][0]), {"label", "lane", "medianChangePercent"})
        # Groups sorted by median desc.
        medians = [g["medianChangePercent"] for g in payload["groups"]]
        self.assertEqual(medians, sorted(medians, reverse=True))
        # Lane filter.
        raw_only = build_meta_pulse_payload(self.connection, game="pokemon", window_days=7, lane="raw")
        self.assertEqual({g["lane"] for g in raw_only["groups"]}, {"raw"})
        self.assertEqual(raw_only["ladders"], [])
        graded_only = build_meta_pulse_payload(self.connection, game="pokemon", window_days=7, lane="graded")
        self.assertEqual({g["lane"] for g in graded_only["groups"]}, {"graded"})

    def test_stale_history_is_not_a_trend_and_rerun_is_idempotent(self) -> None:
        self._seed_vintage_raw()
        stale = compute_meta_pulse(self.connection, today=TODAY + timedelta(days=10))
        self.assertEqual(stale["status"], "stale")
        self.assertEqual(self._compute()["status"], "ok")
        self.assertEqual(self._compute()["status"], "ok")
        count = self.connection.execute(
            "SELECT COUNT(*) FROM meta_pulse_groups WHERE group_key = 'vintage:raw' AND window_days = 7"
        ).fetchone()[0]
        self.assertEqual(count, 1)

    def test_groups_capped_per_direction_counts_use_all(self) -> None:
        ensure_schema(self.connection)
        now = utc_now()
        self.connection.execute(
            "INSERT INTO meta_pulse_runs VALUES ('pokemon', ?, 7, 'raw', 100, 50, 1000, 900, 25, ?)",
            (TODAY.isoformat(), now),
        )
        pcts = [float(p) for p in range(1, 14)] + [float(-p) for p in range(1, 13)]  # 13 up, 12 down
        for i, pct in enumerate(pcts):
            self.connection.execute(
                "INSERT INTO meta_pulse_groups VALUES ('pokemon', ?, 7, 'raw', ?, ?, ?, 'desc', ?, "
                "110, 100, 10, 10, 5, '[]', ?)",
                (TODAY.isoformat(), f"g{i}", f"seg{i}", f"Group {i}", pct, now),
            )
        self.connection.commit()
        payload = build_meta_pulse_payload(self.connection, game="pokemon", window_days=7)
        medians = [g["medianChangePercent"] for g in payload["groups"]]
        self.assertEqual(medians, [float(p) for p in range(13, 3, -1)] + [float(-p) for p in range(3, 13)])
        self.assertEqual((payload["summary"]["risingCount"], payload["summary"]["coolingCount"]), (13, 12))
        self.assertEqual(payload["headline"]["title"], "Group 12 is running. Group 24 is cooling.")
        uncapped = build_meta_pulse_payload(
            self.connection, game="pokemon", window_days=7, max_groups_per_direction=None
        )
        self.assertEqual(len(uncapped["groups"]), 25)

    def test_empty_database(self) -> None:
        self.assertEqual(self._compute()["status"], "no_history")
        payload = build_meta_pulse_payload(self.connection, game="onepiece", window_days=30, lane="bogus")
        self.assertEqual(set(payload), META_PULSE_KEYS)
        self.assertEqual((payload["game"], payload["lane"], payload["groups"]), ("onepiece", "all", []))
        self.assertIsNone(payload["asOfDate"])


if __name__ == "__main__":
    unittest.main()
