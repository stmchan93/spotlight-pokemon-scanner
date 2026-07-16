"""Tests for the "Since You Added It" baseline (deck_entries / card_favorites
``added_market_price`` + ``added_market_date``).

Covers: write-time capture (INSERT sets the baseline, the UPDATE branch of
upsert_deck_entry preserves it), favorite-toggle capture, the list serializers'
``sinceAdded*`` + spark field emissions (including NULL passthrough), and the
one-shot ops backfill (nearest-on-or-before resolution, pre-history fallback to
the earliest tracked price, dryRun writes nothing, runtime-flag idempotence,
and cross-owner isolation).
"""

from __future__ import annotations

import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_ROOT.parent

if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from catalog_tools import (  # noqa: E402
    RAW_PRICING_MODE,
    apply_schema,
    connect,
    runtime_setting,
    upsert_card,
    upsert_deck_entry,
    upsert_price_history_daily,
    upsert_price_snapshot,
)
from request_auth import RequestIdentity  # noqa: E402
from server import ADDED_BASELINE_BACKFILL_FLAG, SpotlightScanService  # noqa: E402

SCRYDEX = "scrydex"


def _today_iso() -> str:
    return datetime.now(timezone.utc).date().isoformat()


class SinceAddedBaselineTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.database_path = Path(self.tempdir.name) / "since-added.sqlite"
        connection = connect(self.database_path)
        apply_schema(connection, BACKEND_ROOT / "schema.sql")
        connection.close()
        self.service = SpotlightScanService(self.database_path, REPO_ROOT)
        self.addCleanup(self.service.connection.close)

    def _identity(self, user_id: str) -> RequestIdentity:
        return RequestIdentity(user_id=user_id, auth_source="test")

    def _insert_card(self, card_id: str, name: str = "Pikachu") -> None:
        upsert_card(
            self.service.connection,
            card_id=card_id,
            name=name,
            set_name="Base Set",
            number="58/102",
            rarity="Rare",
            variant="Raw",
            language="English",
            source_provider=SCRYDEX,
            source_record_id=card_id,
            set_id="bs",
            set_ptcgo_code="BS",
            set_release_date="1999-01-09",
            source_payload={"id": card_id},
        )
        self.service.connection.commit()

    def _seed_snapshot(self, card_id: str, market: float) -> None:
        upsert_price_snapshot(
            self.service.connection,
            card_id=card_id,
            provider=SCRYDEX,
            pricing_mode=RAW_PRICING_MODE,
            currency_code="USD",
            variant="Normal",
            condition="NM",
            low_price=market - 1,
            market_price=market,
            mid_price=market,
            high_price=market + 1,
        )
        self.service.connection.commit()

    def _seed_history(self, card_id: str, price_date: str, market: float) -> None:
        upsert_price_history_daily(
            self.service.connection,
            card_id=card_id,
            pricing_mode=RAW_PRICING_MODE,
            provider=SCRYDEX,
            price_date=price_date,
            currency_code="USD",
            variant="Normal",
            condition="NM",
            low_price=market - 1,
            market_price=market,
            mid_price=market,
            high_price=market + 1,
        )
        self.service.connection.commit()

    def _deck_row(self, deck_entry_id: str):
        return self.service.connection.execute(
            "SELECT added_market_price, added_market_date, added_at FROM deck_entries WHERE id = ?",
            (deck_entry_id,),
        ).fetchone()

    def _favorite_baseline_row(self, owner_user_id: str, card_id: str):
        return self.service.connection.execute(
            """
            SELECT added_market_price, added_market_date
            FROM card_favorites
            WHERE owner_user_id = ? AND card_id = ?
            """,
            (owner_user_id, card_id),
        ).fetchone()

    # --- Write-time capture -------------------------------------------------

    def test_record_buy_insert_sets_baseline_and_readd_preserves_it(self) -> None:
        self._insert_card("pika-1")
        self._seed_snapshot("pika-1", market=10.0)

        with self.service.request_identity_context(self._identity("user-a")):
            first = self.service.record_buy(
                {"cardID": "pika-1", "quantity": 1, "unitPrice": 4.0, "currencyCode": "USD"}
            )
        row = self._deck_row(first["deckEntryID"])
        self.assertEqual(row["added_market_price"], 10.0)
        self.assertEqual(row["added_market_date"], _today_iso())

        # Price moves, then more copies of the SAME identity are added: the
        # UPDATE branch must keep the ORIGINAL baseline (position opened at the
        # first add).
        self._seed_snapshot("pika-1", market=25.0)
        with self.service.request_identity_context(self._identity("user-a")):
            second = self.service.record_buy(
                {"cardID": "pika-1", "quantity": 2, "unitPrice": 6.0, "currencyCode": "USD"}
            )
        self.assertEqual(second["deckEntryID"], first["deckEntryID"])
        row = self._deck_row(first["deckEntryID"])
        self.assertEqual(row["added_market_price"], 10.0)

    def test_upsert_deck_entry_insert_sets_and_update_preserves_baseline(self) -> None:
        self._insert_card("pika-2")
        deck_entry_id = upsert_deck_entry(
            self.service.connection,
            owner_user_id="user-a",
            card_id="pika-2",
            quantity=1,
            added_market_price=7.5,
            added_market_date="2026-06-01",
        )
        self.service.connection.commit()
        row = self._deck_row(deck_entry_id)
        self.assertEqual(row["added_market_price"], 7.5)
        self.assertEqual(row["added_market_date"], "2026-06-01")

        # The UPDATE branch must NOT touch the baseline even when new values
        # are supplied.
        same_id = upsert_deck_entry(
            self.service.connection,
            owner_user_id="user-a",
            card_id="pika-2",
            quantity=1,
            added_market_price=99.0,
            added_market_date="2026-07-01",
        )
        self.service.connection.commit()
        self.assertEqual(same_id, deck_entry_id)
        row = self._deck_row(deck_entry_id)
        self.assertEqual(row["added_market_price"], 7.5)
        self.assertEqual(row["added_market_date"], "2026-06-01")

    def test_unpriced_card_add_leaves_baseline_null(self) -> None:
        self._insert_card("nopriced-1")
        with self.service.request_identity_context(self._identity("user-a")):
            result = self.service.record_buy(
                {"cardID": "nopriced-1", "quantity": 1, "unitPrice": 3.0, "currencyCode": "USD"}
            )
        row = self._deck_row(result["deckEntryID"])
        self.assertIsNone(row["added_market_price"])
        self.assertIsNone(row["added_market_date"])

    def test_favorite_toggle_sets_baseline(self) -> None:
        self._insert_card("fav-1")
        self._seed_snapshot("fav-1", market=12.5)

        with self.service.request_identity_context(self._identity("user-a")):
            self.service.set_card_favorite("fav-1", is_favorite=True)
        row = self._favorite_baseline_row("user-a", "fav-1")
        self.assertEqual(row["added_market_price"], 12.5)
        self.assertEqual(row["added_market_date"], _today_iso())

        # Unfavorite drops the row; re-favoriting captures a FRESH baseline.
        self._seed_snapshot("fav-1", market=20.0)
        with self.service.request_identity_context(self._identity("user-a")):
            self.service.set_card_favorite("fav-1", is_favorite=False)
            self.service.set_card_favorite("fav-1", is_favorite=True)
        row = self._favorite_baseline_row("user-a", "fav-1")
        self.assertEqual(row["added_market_price"], 20.0)

    # --- Serializer emissions -----------------------------------------------

    def test_deck_entries_serializer_emits_since_added_and_spark_fields(self) -> None:
        self._insert_card("serve-1")
        self._seed_snapshot("serve-1", market=10.0)
        with self.service.request_identity_context(self._identity("user-a")):
            self.service.record_buy(
                {"cardID": "serve-1", "quantity": 1, "unitPrice": 8.0, "currencyCode": "USD"}
            )
        # Price rises after the add; the row must report +5.0 / +50% since added.
        self._seed_snapshot("serve-1", market=15.0)
        self._seed_history("serve-1", "2026-06-01", market=10.0)
        self._seed_history("serve-1", "2026-06-02", market=20.0)
        self._seed_history("serve-1", "2026-06-03", market=15.0)

        with self.service.request_identity_context(self._identity("user-a")):
            payload = self.service.deck_entries(limit=10, include_inactive=True)

        entry = payload["entries"][0]
        self.assertEqual(entry["sinceAddedChangeAmount"], 5.0)
        self.assertEqual(entry["sinceAddedChangePercent"], 50.0)
        self.assertEqual(entry["sinceAddedBaselineDate"], _today_iso())
        # Sparkline: oldest -> newest, trend over the window endpoints.
        self.assertEqual(entry["sparkPoints"], [10.0, 20.0, 15.0])
        self.assertEqual(entry["sparkTrendPct"], 50.0)
        self.assertLessEqual(len(entry["sparkPoints"]), 20)

    def test_deck_entries_serializer_null_passthrough(self) -> None:
        self._insert_card("null-1")
        self._insert_card("dated-1")
        # No pricing anywhere: every since-added/spark field must be null.
        upsert_deck_entry(
            self.service.connection,
            owner_user_id="user-a",
            card_id="null-1",
            quantity=1,
        )
        # Baseline present but the card is CURRENTLY unpriced: no arithmetic,
        # but the honest baseline date still passes through.
        upsert_deck_entry(
            self.service.connection,
            owner_user_id="user-a",
            card_id="dated-1",
            quantity=1,
            added_market_price=5.0,
            added_market_date="2026-06-01",
        )
        self.service.connection.commit()

        with self.service.request_identity_context(self._identity("user-a")):
            payload = self.service.deck_entries(limit=10, include_inactive=True)

        by_card = {entry["card"]["id"]: entry for entry in payload["entries"]}
        null_entry = by_card["null-1"]
        self.assertIsNone(null_entry["sinceAddedChangeAmount"])
        self.assertIsNone(null_entry["sinceAddedChangePercent"])
        self.assertIsNone(null_entry["sinceAddedBaselineDate"])
        self.assertIsNone(null_entry["sparkPoints"])
        self.assertIsNone(null_entry["sparkTrendPct"])
        dated_entry = by_card["dated-1"]
        self.assertIsNone(dated_entry["sinceAddedChangeAmount"])
        self.assertIsNone(dated_entry["sinceAddedChangePercent"])
        self.assertEqual(dated_entry["sinceAddedBaselineDate"], "2026-06-01")

    def test_card_favorites_serializer_emits_since_added_and_spark_fields(self) -> None:
        self._insert_card("favserve-1")
        self._insert_card("favnull-1")
        self._seed_snapshot("favserve-1", market=10.0)
        with self.service.request_identity_context(self._identity("user-a")):
            self.service.set_card_favorite("favserve-1", is_favorite=True)
            self.service.set_card_favorite("favnull-1", is_favorite=True)
        self._seed_snapshot("favserve-1", market=15.0)
        self._seed_history("favserve-1", "2026-06-01", market=10.0)
        self._seed_history("favserve-1", "2026-06-02", market=15.0)

        with self.service.request_identity_context(self._identity("user-a")):
            payload = self.service.card_favorites()

        by_card = {entry["card"]["id"]: entry for entry in payload["entries"]}
        priced = by_card["favserve-1"]
        self.assertEqual(priced["sinceAddedChangeAmount"], 5.0)
        self.assertEqual(priced["sinceAddedChangePercent"], 50.0)
        self.assertEqual(priced["sinceAddedBaselineDate"], _today_iso())
        self.assertEqual(priced["sparkPoints"], [10.0, 15.0])
        self.assertEqual(priced["sparkTrendPct"], 50.0)
        unpriced = by_card["favnull-1"]
        self.assertIsNone(unpriced["sinceAddedChangeAmount"])
        self.assertIsNone(unpriced["sinceAddedChangePercent"])
        self.assertIsNone(unpriced["sinceAddedBaselineDate"])
        self.assertIsNone(unpriced["sparkPoints"])
        self.assertIsNone(unpriced["sparkTrendPct"])

    def test_owned_favorite_row_uses_owned_entry_baseline(self) -> None:
        # Lane/precedence rule (2026-07-16 +116% bug): when a favorited card is
        # OWNED, the wishlist row's since-added must come from the owned deck
        # entry's baseline (same numbers as the Collection row), never the
        # favorite-day baseline.
        self._insert_card("own-fav-1")
        self._seed_snapshot("own-fav-1", market=10.0)
        with self.service.request_identity_context(self._identity("user-a")):
            self.service.record_buy(
                {"cardID": "own-fav-1", "quantity": 1, "unitPrice": 9.0, "currencyCode": "USD"}
            )  # deck baseline captured at 10.0
        self._seed_snapshot("own-fav-1", market=15.0)
        with self.service.request_identity_context(self._identity("user-a")):
            self.service.set_card_favorite("own-fav-1", is_favorite=True)  # favorite baseline 15.0
        self._seed_snapshot("own-fav-1", market=18.0)

        with self.service.request_identity_context(self._identity("user-a")):
            payload = self.service.card_favorites(limit=10)
        entry = payload["entries"][0]
        # vs the OWNED baseline (10.0): +8.0 / +80% — NOT vs the favorite's 15.0.
        self.assertEqual(entry["sinceAddedChangeAmount"], 8.0)
        self.assertEqual(entry["sinceAddedChangePercent"], 80.0)

    def test_backfill_repair_favorites_raw_lane_overwrites(self) -> None:
        self._insert_card("fav-repair-1")
        self._seed_snapshot("fav-repair-1", market=12.5)
        self._seed_history("fav-repair-1", _today_iso(), market=12.5)
        with self.service.request_identity_context(self._identity("user-a")):
            self.service.set_card_favorite("fav-repair-1", is_favorite=True)
        # Corrupt the stored baseline (simulates an owned-lane capture).
        self.service.connection.execute(
            "UPDATE card_favorites SET added_market_price = 999.0 WHERE card_id = ?",
            ("fav-repair-1",),
        )
        self.service.connection.commit()

        summary = self.service.backfill_added_baselines(repair_favorites_raw_lane=True)
        self.assertEqual(summary["favoritesResolved"], 1)
        row = self._favorite_baseline_row("user-a", "fav-repair-1")
        self.assertEqual(row["added_market_price"], 12.5)
        # Repair runs must NOT set the one-shot flag.
        from server import ADDED_BASELINE_BACKFILL_FLAG
        from catalog_tools import runtime_setting
        self.assertIsNone(runtime_setting(self.service.connection, ADDED_BASELINE_BACKFILL_FLAG))

    # --- PDP favoriteContext ---------------------------------------------------

    def test_card_detail_emits_favorite_context_with_arithmetic(self) -> None:
        self._insert_card("pdpfav-1")
        self._seed_snapshot("pdpfav-1", market=10.0)
        with self.service.request_identity_context(self._identity("user-a")):
            self.service.set_card_favorite("pdpfav-1", is_favorite=True)
        # Price rises after the favorite; the PDP must report +5.0 / +50%.
        self._seed_snapshot("pdpfav-1", market=15.0)

        with self.service.request_identity_context(self._identity("user-a")):
            detail = self.service.card_detail("pdpfav-1")

        context = detail["favoriteContext"]
        self.assertIsNotNone(context)
        self.assertIsNotNone(context["favoritedAt"])
        self.assertEqual(context["favoritedAt"], detail["favoritedAt"])
        self.assertEqual(context["sinceAddedChangeAmount"], 5.0)
        self.assertEqual(context["sinceAddedChangePercent"], 50.0)
        self.assertEqual(context["sinceAddedBaselineDate"], _today_iso())

    def test_card_detail_favorite_context_null_when_unfavorited(self) -> None:
        self._insert_card("pdpfav-2")
        self._seed_snapshot("pdpfav-2", market=10.0)

        with self.service.request_identity_context(self._identity("user-a")):
            detail = self.service.card_detail("pdpfav-2")

        self.assertIsNone(detail["favoriteContext"])

    def test_card_detail_favorite_context_null_baseline_keeps_favorited_at(self) -> None:
        self._insert_card("pdpfav-3")
        # Favorited while UNPRICED: baseline columns stay NULL, so the context
        # carries favoritedAt but no arithmetic.
        with self.service.request_identity_context(self._identity("user-a")):
            self.service.set_card_favorite("pdpfav-3", is_favorite=True)
        self._seed_snapshot("pdpfav-3", market=15.0)

        with self.service.request_identity_context(self._identity("user-a")):
            detail = self.service.card_detail("pdpfav-3")

        context = detail["favoriteContext"]
        self.assertIsNotNone(context)
        self.assertIsNotNone(context["favoritedAt"])
        self.assertIsNone(context["sinceAddedChangeAmount"])
        self.assertIsNone(context["sinceAddedChangePercent"])
        self.assertIsNone(context["sinceAddedBaselineDate"])

    def test_card_detail_favorite_context_isolated_per_owner(self) -> None:
        self._insert_card("pdpfav-4")
        self._seed_snapshot("pdpfav-4", market=10.0)
        with self.service.request_identity_context(self._identity("user-b")):
            self.service.set_card_favorite("pdpfav-4", is_favorite=True)

        # User B's favorite must NOT leak into user A's detail.
        with self.service.request_identity_context(self._identity("user-a")):
            detail = self.service.card_detail("pdpfav-4")

        self.assertIsNone(detail["favoriteContext"])
        self.assertFalse(detail["isFavorite"])

    # --- One-time ops backfill ----------------------------------------------

    def test_backfill_resolves_nearest_on_or_before_add_date(self) -> None:
        self._insert_card("bf-1")
        self._seed_history("bf-1", "2026-06-01", market=10.0)
        self._seed_history("bf-1", "2026-06-05", market=20.0)
        self._seed_history("bf-1", "2026-06-10", market=30.0)
        deck_entry_id = upsert_deck_entry(
            self.service.connection,
            owner_user_id="user-a",
            card_id="bf-1",
            quantity=1,
            added_at="2026-06-07T12:00:00Z",
        )
        self.service.connection.commit()

        summary = self.service.backfill_added_baselines()

        self.assertEqual(summary["deckEntriesResolved"], 1)
        row = self._deck_row(deck_entry_id)
        self.assertEqual(row["added_market_price"], 20.0)
        self.assertEqual(row["added_market_date"], "2026-06-05")
        self.assertIsNotNone(
            runtime_setting(self.service.connection, ADDED_BASELINE_BACKFILL_FLAG)
        )

    def test_backfill_pre_history_add_falls_back_to_earliest_price(self) -> None:
        self._insert_card("bf-2")
        self._seed_history("bf-2", "2026-06-01", market=10.0)
        self._seed_history("bf-2", "2026-06-05", market=20.0)
        deck_entry_id = upsert_deck_entry(
            self.service.connection,
            owner_user_id="user-a",
            card_id="bf-2",
            quantity=1,
            added_at="2026-05-01T12:00:00Z",
        )
        self.service.connection.commit()

        self.service.backfill_added_baselines()

        row = self._deck_row(deck_entry_id)
        self.assertEqual(row["added_market_price"], 10.0)
        # The honest baseline date is the first tracked day, not the add day.
        self.assertEqual(row["added_market_date"], "2026-06-01")

    def test_backfill_unresolvable_row_stays_null(self) -> None:
        self._insert_card("bf-3")
        self._insert_card("bf-priced")
        self._seed_history("bf-priced", "2026-06-01", market=5.0)
        deck_entry_id = upsert_deck_entry(
            self.service.connection,
            owner_user_id="user-a",
            card_id="bf-3",
            quantity=1,
            added_at="2026-06-02T12:00:00Z",
        )
        self.service.connection.commit()

        summary = self.service.backfill_added_baselines()

        self.assertEqual(summary["deckEntriesUnresolved"], 1)
        row = self._deck_row(deck_entry_id)
        self.assertIsNone(row["added_market_price"])
        self.assertIsNone(row["added_market_date"])

    def test_backfill_dry_run_writes_nothing_and_leaves_flag_unset(self) -> None:
        self._insert_card("bf-4")
        self._seed_history("bf-4", "2026-06-01", market=10.0)
        deck_entry_id = upsert_deck_entry(
            self.service.connection,
            owner_user_id="user-a",
            card_id="bf-4",
            quantity=1,
            added_at="2026-06-02T12:00:00Z",
        )
        self.service.connection.commit()

        summary = self.service.backfill_added_baselines(dry_run=True)

        self.assertTrue(summary["dryRun"])
        self.assertEqual(summary["deckEntriesResolved"], 1)
        row = self._deck_row(deck_entry_id)
        self.assertIsNone(row["added_market_price"])
        self.assertIsNone(
            runtime_setting(self.service.connection, ADDED_BASELINE_BACKFILL_FLAG)
        )

        # A real run after the dry run still performs the writes.
        self.service.backfill_added_baselines()
        row = self._deck_row(deck_entry_id)
        self.assertEqual(row["added_market_price"], 10.0)

    def test_backfill_is_one_shot_via_runtime_flag(self) -> None:
        self._insert_card("bf-5")
        self._seed_history("bf-5", "2026-06-01", market=10.0)
        first = self.service.backfill_added_baselines()
        self.assertFalse(first["skipped"])

        # A NULL-baseline row created AFTER the flag is set must not be touched
        # by a re-run.
        deck_entry_id = upsert_deck_entry(
            self.service.connection,
            owner_user_id="user-a",
            card_id="bf-5",
            quantity=1,
            added_at="2026-06-02T12:00:00Z",
        )
        self.service.connection.commit()
        second = self.service.backfill_added_baselines()
        self.assertTrue(second["skipped"])
        row = self._deck_row(deck_entry_id)
        self.assertIsNone(row["added_market_price"])

    def test_backfill_covers_favorites_and_isolates_owners(self) -> None:
        self._insert_card("bf-6")
        self._seed_history("bf-6", "2026-06-01", market=10.0)
        self._seed_history("bf-6", "2026-06-05", market=20.0)
        entry_a = upsert_deck_entry(
            self.service.connection,
            owner_user_id="user-a",
            card_id="bf-6",
            quantity=1,
            added_at="2026-06-02T12:00:00Z",
        )
        entry_b = upsert_deck_entry(
            self.service.connection,
            owner_user_id="user-b",
            card_id="bf-6",
            quantity=1,
            added_at="2026-06-06T12:00:00Z",
        )
        self.service.connection.execute(
            "INSERT INTO card_favorites (owner_user_id, card_id, created_at) VALUES (?, ?, ?)",
            ("user-a", "bf-6", "2026-06-02T12:00:00Z"),
        )
        self.service.connection.execute(
            "INSERT INTO card_favorites (owner_user_id, card_id, created_at) VALUES (?, ?, ?)",
            ("user-b", "bf-6", "2026-06-06T12:00:00Z"),
        )
        self.service.connection.commit()

        summary = self.service.backfill_added_baselines()

        self.assertEqual(summary["deckEntriesResolved"], 2)
        self.assertEqual(summary["favoritesResolved"], 2)
        # Same card, different owners/add dates: each row gets ITS OWN baseline.
        row_a = self._deck_row(entry_a)
        row_b = self._deck_row(entry_b)
        self.assertEqual(row_a["added_market_price"], 10.0)
        self.assertEqual(row_a["added_market_date"], "2026-06-01")
        self.assertEqual(row_b["added_market_price"], 20.0)
        self.assertEqual(row_b["added_market_date"], "2026-06-05")
        fav_a = self._favorite_baseline_row("user-a", "bf-6")
        fav_b = self._favorite_baseline_row("user-b", "bf-6")
        self.assertEqual(fav_a["added_market_price"], 10.0)
        self.assertEqual(fav_b["added_market_price"], 20.0)


if __name__ == "__main__":
    unittest.main()
