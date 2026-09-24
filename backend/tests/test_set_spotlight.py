"""set_spotlight: weekly set pick (biggest |%| raw value move among sets with
enough priced cards, attention tie-break, no repeat of last week's set) and the
SetSpotlight payload (PSA 10 nulls without graded cells, top lists, callout,
collectors, news via news_feed.news_for_set, exact contract keys).
"""

from __future__ import annotations

import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

import news_feed  # noqa: E402
from catalog_tools import apply_schema, connect, upsert_card, upsert_expansion, utc_now  # noqa: E402
from server import _apply_price_history_cells_schema_patch  # noqa: E402
from set_spotlight import (  # noqa: E402
    build_set_spotlight_payload,
    compute_set_spotlight,
    ensure_schema,
    week_start_for,
)

NOW = datetime(2026, 9, 23, 12, 0, tzinfo=timezone.utc)
TODAY = NOW.date()

SET_SPOTLIGHT_KEYS = {"computedAt", "set", "topByPrice", "topMovers", "topPsa10", "callout", "videos", "news"}
SET_KEYS = {
    "setId", "game", "name", "code", "series", "releaseDate", "logoUrl", "cardCount",
    "valueNow", "valueChangePercent7d", "psa10ValueNow", "psa10ChangePercent7d", "collectorsCount",
}
CARD_KEYS = {"cardId", "name", "number", "imageUrl", "lane", "grader", "grade", "priceNow",
             "changePercent7d", "currencyCode"}


class SetSpotlightTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.connection = connect(Path(self.tempdir.name) / "set.sqlite")
        self.addCleanup(self.connection.close)
        apply_schema(self.connection, BACKEND_ROOT / "schema.sql")
        _apply_price_history_cells_schema_patch(self.connection)
        ensure_schema(self.connection)

    # --- seeding ------------------------------------------------------------

    def _set(self, set_id: str, *, cards: int, then: float, now: float, name: str | None = None) -> None:
        upsert_expansion(
            self.connection, expansion_id=set_id, name=name or set_id.upper(), series="Test Series",
            code=set_id.upper(), release_date="2021-10-08", logo_url=f"https://logo/{set_id}.png",
            game="pokemon",
        )
        for i in range(cards):
            card_id = f"{set_id}-{i}"
            upsert_card(
                self.connection, card_id=card_id, name=f"{set_id.upper()} Card {i}",
                set_name=name or set_id.upper(), number=f"{i}/{cards}", rarity="Rare", variant="Raw",
                language="English", source_provider="scrydex", source_record_id=card_id,
                set_id=set_id, image_small_url=f"https://img/{card_id}.png",
            )
            # Card i is priced (i+1)x the base so ordering is deterministic.
            self._daily(card_id, 7, then * (i + 1))
            self._daily(card_id, 0, now * (i + 1))

    def _daily(self, card_id: str, days_ago: int, price: float) -> None:
        self.connection.execute(
            "INSERT OR REPLACE INTO card_price_history_daily (card_id, provider, price_date, "
            "display_currency_code, main_raw_market_price, updated_at) VALUES (?, 'scrydex', ?, 'USD', ?, ?)",
            (card_id, (TODAY - timedelta(days=days_ago)).isoformat(), price, utc_now()),
        )

    def _cell(self, card_id: str, days_ago: int, market: float, *, grader: str = "PSA",
              grade: str = "10", variant: str = "holofoil", perfect: int = 0) -> None:
        price_date = (TODAY - timedelta(days=days_ago)).isoformat()
        self.connection.execute(
            "INSERT INTO card_price_history_cell (card_id, provider, price_date, lane, cell_key, "
            "variant_key, grader, grade, is_perfect, currency_code, market, updated_at) "
            "VALUES (?, 'scrydex', ?, 'graded', ?, ?, ?, ?, ?, 'USD', ?, ?)",
            (card_id, price_date, f"graded|{grader}|{grade}|{variant}|p{perfect}s0e0", variant,
             grader, grade, perfect, market, utc_now()),
        )

    def _view(self, user: str, card_id: str) -> None:
        at = NOW - timedelta(days=1)
        self.connection.execute(
            "INSERT INTO card_views (owner_user_id, card_id, viewed_on, viewed_at) VALUES (?, ?, ?, ?)",
            (user, card_id, at.date().isoformat(), at.isoformat()),
        )

    def _holding(self, entry_id: str, user: str, card_id: str, *, quantity: int = 1) -> None:
        self.connection.execute(
            "INSERT INTO deck_entries (id, owner_user_id, item_kind, card_id, quantity, added_at, updated_at) "
            "VALUES (?, ?, 'raw', ?, ?, ?, ?)",
            (entry_id, user, card_id, quantity, utc_now(), utc_now()),
        )

    def _compute(self, **kwargs):
        self.connection.commit()
        kwargs.setdefault("min_priced_cards", 20)
        kwargs.setdefault("min_set_value_usd", 25.0)
        return compute_set_spotlight(self.connection, now=NOW, **kwargs)

    # --- pick -------------------------------------------------------------

    def test_picks_biggest_absolute_move_with_enough_priced_cards(self) -> None:
        self._set("up", cards=25, then=10.0, now=12.0)       # +20%
        self._set("down", cards=25, then=10.0, now=7.0)      # -30%
        self._set("tiny", cards=10, then=10.0, now=30.0)     # +200% but too few cards
        summary = self._compute()
        self.assertEqual(summary["setId"], "down")
        self.assertAlmostEqual(summary["changePercent"], -30.0)

    def test_skips_last_weeks_pick_when_possible(self) -> None:
        self._set("up", cards=25, then=10.0, now=12.0)
        self._set("down", cards=25, then=10.0, now=7.0)
        last_week = week_start_for((NOW - timedelta(days=7)).date())
        self.connection.execute(
            "INSERT INTO set_spotlight_picks (week_start, set_id, game, picked_at, computed_at) "
            "VALUES (?, 'down', 'pokemon', ?, ?)",
            (last_week, utc_now(), utc_now()),
        )
        self.assertEqual(self._compute()["setId"], "up")

    def test_repeats_last_weeks_pick_when_it_is_the_only_candidate(self) -> None:
        self._set("down", cards=25, then=10.0, now=7.0)
        last_week = week_start_for((NOW - timedelta(days=7)).date())
        self.connection.execute(
            "INSERT INTO set_spotlight_picks (week_start, set_id, game, picked_at, computed_at) "
            "VALUES (?, 'down', 'pokemon', ?, ?)",
            (last_week, utc_now(), utc_now()),
        )
        self.assertEqual(self._compute()["setId"], "down")

    def test_tie_broken_by_recent_attention(self) -> None:
        self._set("aaa", cards=20, then=10.0, now=11.0)
        self._set("bbb", cards=20, then=10.0, now=11.0)
        self._view("u1", "bbb-0")
        self._view("u2", "bbb-3")
        self.assertEqual(self._compute()["setId"], "bbb")

    def test_pick_is_kept_for_the_week_unless_forced(self) -> None:
        self._set("up", cards=25, then=10.0, now=12.0)
        self.assertEqual(self._compute()["setId"], "up")
        self._set("down", cards=25, then=10.0, now=5.0)
        self.assertEqual(self._compute()["setId"], "up")
        self.assertEqual(self._compute(force_repick=True)["setId"], "down")
        rows = self.connection.execute("SELECT COUNT(*) FROM set_spotlight_picks").fetchone()[0]
        self.assertEqual(rows, 1)

    def test_no_qualifying_set_returns_none(self) -> None:
        self._set("tiny", cards=5, then=10.0, now=20.0)
        self.assertIsNone(self._compute())
        self.assertIsNone(build_set_spotlight_payload(self.connection))

    # --- payload ------------------------------------------------------------

    def test_payload_keys_and_psa10_nulls_without_graded_data(self) -> None:
        self._set("up", cards=25, then=10.0, now=12.0, name="Celebrations")
        self._compute()
        payload = build_set_spotlight_payload(self.connection)
        self.assertEqual(set(payload), SET_SPOTLIGHT_KEYS)
        self.assertEqual(set(payload["set"]), SET_KEYS)
        header = payload["set"]
        self.assertEqual(header["setId"], "up")
        self.assertEqual(header["name"], "Celebrations")
        self.assertEqual(header["cardCount"], 25)
        self.assertEqual(header["valueNow"], round(12.0 * sum(range(1, 26)), 2))
        self.assertEqual(header["valueChangePercent7d"], 20.0)
        self.assertIsNone(header["psa10ValueNow"])
        self.assertIsNone(header["psa10ChangePercent7d"])
        self.assertEqual(payload["topPsa10"], [])
        self.assertEqual(len(payload["topByPrice"]), 10)
        self.assertEqual(payload["topByPrice"][0]["cardId"], "up-24")
        for card in payload["topByPrice"] + payload["topMovers"]:
            self.assertEqual(set(card), CARD_KEYS)
            self.assertEqual(card["lane"], "raw")
            self.assertIsNone(card["grader"])
        self.assertEqual(payload["videos"], [])
        self.assertEqual(payload["news"], [])
        # Raw-mover callout when there is no PSA 10 data.
        self.assertIn("is up 20% this week", payload["callout"]["title"])

    def test_psa10_values_top_list_and_callout(self) -> None:
        self._set("up", cards=25, then=10.0, now=12.0, name="Celebrations")
        self._cell("up-3", 7, 100.0)
        self._cell("up-3", 0, 114.0)
        self._cell("up-5", 7, 200.0)
        self._cell("up-5", 0, 210.0)
        self._cell("up-5", 0, 999.0, perfect=1)  # perfect-10 cell is not a plain PSA 10
        self._cell("up-7", 0, 50.0, grader="CGC")  # other graders ignored
        self._compute()
        payload = build_set_spotlight_payload(self.connection)
        header = payload["set"]
        self.assertEqual(header["psa10ValueNow"], 324.0)
        self.assertEqual(header["psa10ChangePercent7d"], 8.0)
        self.assertEqual([c["cardId"] for c in payload["topPsa10"]], ["up-5", "up-3"])
        top = payload["topPsa10"][1]
        self.assertEqual((top["lane"], top["grader"], top["grade"]), ("graded", "PSA", "10"))
        self.assertEqual(top["changePercent7d"], 14.0)
        callout = payload["callout"]
        self.assertEqual(callout["cardId"], "up-3")
        self.assertEqual(callout["title"], "UP Card 3 PSA 10 is up 14% this week")
        self.assertIn("Raw copies +20.0%", callout["body"])

    def test_psa10_read_falls_back_when_graded_index_is_missing(self) -> None:
        self._set("up", cards=25, then=10.0, now=12.0)
        self._cell("up-3", 7, 100.0)
        self._cell("up-3", 0, 114.0)
        self.connection.execute("DROP INDEX idx_cell_graded_lookup")
        payload = build_set_spotlight_payload(self.connection, set_id="up")
        self.assertEqual(payload["set"]["psa10ValueNow"], 114.0)
        self.assertEqual(payload["set"]["psa10ChangePercent7d"], 14.0)

    def test_collectors_count_distinct_owners(self) -> None:
        self._set("up", cards=25, then=10.0, now=12.0)
        self._holding("e1", "u1", "up-0")
        self._holding("e2", "u1", "up-1")
        self._holding("e3", "u2", "up-2")
        self._holding("e4", "u3", "up-3", quantity=0)  # sold out of it
        payload = build_set_spotlight_payload(self.connection, set_id="up")
        self.assertEqual(payload["set"]["collectorsCount"], 2)

    def test_explicit_set_id_builds_on_demand_and_unknown_is_none(self) -> None:
        self._set("up", cards=25, then=10.0, now=12.0)
        self._set("other", cards=3, then=10.0, now=10.0)
        self._compute()
        payload = build_set_spotlight_payload(self.connection, set_id="other")
        self.assertEqual(payload["set"]["setId"], "other")
        self.assertEqual(payload["set"]["valueChangePercent7d"], 0.0)
        self.assertEqual(payload["topMovers"][0]["changePercent7d"], 0.0)
        self.assertIsNone(build_set_spotlight_payload(self.connection, set_id="nope"))

    def test_news_items_split_into_videos_and_news(self) -> None:
        self._set("up", cards=25, then=10.0, now=12.0)
        news_feed.ensure_schema(self.connection)
        rows = [
            # (id, kind, title, published_at, set_id, video)
            ("n1", "news", "Headline", "2026-09-22T00:00:00+00:00", "up", None),
            ("v1", "video", "Older, popular", "2026-09-20T00:00:00+00:00", "up",
             '{"channelTitle": "PokeRev", "durationSeconds": 600, "viewCount": 90000}'),
            ("v2", "video", "Newer, fewer views", "2026-09-22T00:00:00+00:00", "up",
             '{"channelTitle": "Other", "durationSeconds": 300, "viewCount": 100}'),
            ("n2", "news", "Other set", "2026-09-22T00:00:00+00:00", "other", None),
        ]
        self.connection.executemany(
            "INSERT INTO news_items (id, kind, source, title, url, published_at, game, set_id, "
            "card_ids, tags, video, fetched_at) "
            "VALUES (?, ?, 'src', ?, 'https://x', ?, 'pokemon', ?, '[]', '[\"Market\"]', ?, ?)",
            [(*row, utc_now()) for row in rows],
        )
        payload = build_set_spotlight_payload(self.connection, set_id="up")
        self.assertEqual([n["id"] for n in payload["news"]], ["n1"])
        # Videos by view count, not recency.
        self.assertEqual([v["id"] for v in payload["videos"]], ["v1", "v2"])
        self.assertEqual(payload["videos"][0]["video"]["channelTitle"], "PokeRev")
        self.assertEqual(payload["news"][0]["tags"], ["Market"])

    def test_no_news_table_reads_empty_without_creating_it(self) -> None:
        self._set("up", cards=25, then=10.0, now=12.0)
        payload = build_set_spotlight_payload(self.connection, set_id="up")
        self.assertEqual((payload["videos"], payload["news"]), ([], []))
        exists = self.connection.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'news_items'"
        ).fetchone()
        self.assertIsNone(exists)

if __name__ == "__main__":
    unittest.main()
