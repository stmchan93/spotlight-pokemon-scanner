"""The one-time condition-history seed replays snapshot contexts into daily
history for the newer games — and ONLY does that.

Pinned separately because each failure hurts differently:

  * the seeded card gets a real daily row AND per-condition raw-lane cells (the
    empty-chart fix itself);
  * the TCGCSV-owned ``raw_main`` cell for the same (card, day) survives — the
    Scrydex-shaped rewrite deletes ``lane != 'raw_main'`` only;
  * a card with empty contexts is skipped, not seeded as an all-NULL day;
  * ``--dry-run`` writes nothing at all;
  * games outside ``--games`` (Pokémon) are untouched, and the snapshots the
    seed reads from are byte-identical afterwards.

No HTTP anywhere: the seed is a pure SQLite replay, which is the whole point
(0 Scrydex credits).
"""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from catalog_tools import (  # noqa: E402
    GAME_ONE_PIECE,
    GAME_POKEMON,
    apply_schema,
    connect,
    upsert_card,
    upsert_price_snapshot,
)
from seed_condition_history_from_snapshots import seed_condition_history  # noqa: E402
from server import _apply_price_history_cells_schema_patch  # noqa: E402

PRICE_DATE = "2026-08-28"

# Snapshot-shaped contexts: variants[<label>] -> {variantKey, conditions[<cond>]}.
OP_RAW_CONTEXTS = {
    "variants": {
        "Normal": {
            "variant": "Normal",
            "variantKey": "normal",
            "conditions": {
                "NM": {"currencyCode": "USD", "low": 4.0, "market": 5.0, "mid": 5.5, "high": 7.0},
                "LP": {"currencyCode": "USD", "market": 3.5},
            },
        }
    }
}


class SeedConditionHistoryTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.database_path = Path(self.tempdir.name) / "seed.sqlite"
        self.connection = connect(self.database_path)
        self.addCleanup(self.connection.close)
        apply_schema(self.connection, BACKEND_ROOT / "schema.sql")
        _apply_price_history_cells_schema_patch(self.connection)
        for card_id, game in (("OP01-001", GAME_ONE_PIECE), ("base1-4", GAME_POKEMON)):
            upsert_card(
                self.connection,
                card_id=card_id,
                game=game,
                name="Test Card",
                set_name="Test Set",
                number="1/1",
                rarity="Rare",
                variant="Raw",
                language="English",
                source_provider="scrydex",
                source_record_id=card_id,
            )
        self.connection.commit()

    def _snapshot(self, card_id: str, raw_contexts) -> None:
        upsert_price_snapshot(
            self.connection,
            card_id=card_id,
            provider="scrydex",
            display_currency_code="USD",
            raw_contexts=raw_contexts,
        )
        self.connection.commit()

    def _seed(self, *, games: list[str] | None = None, dry_run: bool = False) -> dict:
        return seed_condition_history(
            database_path=self.database_path,
            games=games or [GAME_ONE_PIECE],
            price_date=PRICE_DATE,
            dry_run=dry_run,
        )

    def _daily_row(self, card_id: str):
        return self.connection.execute(
            "SELECT * FROM card_price_history_daily WHERE card_id = ? AND price_date = ?",
            (card_id, PRICE_DATE),
        ).fetchone()

    def _cells(self, card_id: str) -> dict[str, dict]:
        rows = self.connection.execute(
            "SELECT * FROM card_price_history_cell WHERE card_id = ? AND price_date = ?",
            (card_id, PRICE_DATE),
        ).fetchall()
        return {str(r["cell_key"]): {k: r[k] for k in r.keys()} for r in rows}

    def test_seeds_daily_row_and_raw_condition_cells_for_a_one_piece_card(self) -> None:
        self._snapshot("OP01-001", OP_RAW_CONTEXTS)
        summary = self._seed()

        self.assertEqual(summary["games"][GAME_ONE_PIECE]["cardsSeeded"], 1)
        row = self._daily_row("OP01-001")
        self.assertIsNotNone(row)
        self.assertEqual(row["display_currency_code"], "USD")
        self.assertEqual(row["default_raw_market_price"], 5.0)

        cells = self._cells("OP01-001")
        self.assertIn("raw|normal|NM", cells)
        self.assertIn("raw|normal|LP", cells)
        self.assertEqual(cells["raw|normal|NM"]["market"], 5.0)
        self.assertEqual(cells["raw|normal|LP"]["market"], 3.5)

        # Idempotent: a second run merges into the same (card, day) instead of
        # duplicating cells.
        self._seed()
        self.assertEqual(len(self._cells("OP01-001")), 2)

    def test_spares_an_existing_raw_main_cell_on_the_same_day(self) -> None:
        self._snapshot("OP01-001", OP_RAW_CONTEXTS)
        self.connection.execute(
            """
            INSERT INTO card_price_history_cell (
                card_id, provider, price_date, lane, cell_key,
                variant_key, condition, currency_code, market, updated_at
            ) VALUES (?, 'tcgcsv', ?, 'raw_main', 'raw_main|Normal|NM', 'Normal', 'NM', 'USD', 4.75, ?)
            """,
            ("OP01-001", PRICE_DATE, "2026-08-28T00:00:00Z"),
        )
        self.connection.commit()

        self._seed()

        cells = self._cells("OP01-001")
        self.assertIn("raw_main|Normal|NM", cells)
        self.assertEqual(cells["raw_main|Normal|NM"]["market"], 4.75)
        self.assertEqual(cells["raw_main|Normal|NM"]["provider"], "tcgcsv")

    def test_skips_cards_whose_snapshot_carries_no_contexts(self) -> None:
        # A snapshot row can exist with '{}' contexts (e.g. headline-only data);
        # seeding it would create an all-NULL history day.
        self._snapshot("OP01-001", None)
        summary = self._seed()

        self.assertEqual(summary["games"][GAME_ONE_PIECE]["cardsSeeded"], 0)
        self.assertEqual(summary["games"][GAME_ONE_PIECE]["cardsSkippedEmpty"], 1)
        self.assertIsNone(self._daily_row("OP01-001"))
        self.assertEqual(self._cells("OP01-001"), {})

    def test_dry_run_counts_but_writes_nothing(self) -> None:
        self._snapshot("OP01-001", OP_RAW_CONTEXTS)
        summary = self._seed(dry_run=True)

        self.assertEqual(summary["games"][GAME_ONE_PIECE]["cardsSeeded"], 1)
        self.assertTrue(summary["dryRun"])
        self.assertIsNone(self._daily_row("OP01-001"))
        self.assertEqual(self._cells("OP01-001"), {})

    def test_games_outside_the_list_and_the_snapshots_themselves_are_untouched(self) -> None:
        self._snapshot("OP01-001", OP_RAW_CONTEXTS)
        self._snapshot("base1-4", OP_RAW_CONTEXTS)
        snapshot_before = self.connection.execute(
            "SELECT raw_contexts_json, graded_contexts_json, updated_at FROM card_price_snapshots WHERE card_id = 'OP01-001'"
        ).fetchone()

        self._seed(games=[GAME_ONE_PIECE])

        # The Pokémon card was not in --games: no seeded day.
        self.assertIsNone(self._daily_row("base1-4"))
        snapshot_after = self.connection.execute(
            "SELECT raw_contexts_json, graded_contexts_json, updated_at FROM card_price_snapshots WHERE card_id = 'OP01-001'"
        ).fetchone()
        self.assertEqual(tuple(snapshot_before), tuple(snapshot_after))


if __name__ == "__main__":
    unittest.main()
