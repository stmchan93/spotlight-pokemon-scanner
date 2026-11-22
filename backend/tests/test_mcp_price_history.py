"""get_price_history: TCGplayer main-lane raw series, printing matching, graded history.

Seeds card_price_history_cell rows shaped like staging's base1-4 (Base Set
Charizard): Scrydex raw cells keyed by edition ('unlimitedHolofoil', ...) that stop
early, and TCGCSV raw_main cells keyed 'Holofoil' then 'Unlimited Holofoil'.
"""

from __future__ import annotations

import os
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

BACKEND_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_ROOT.parent
for path in (BACKEND_ROOT, BACKEND_ROOT / "tools"):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

from catalog_tools import apply_schema, connect, upsert_card, utc_now  # noqa: E402
from mcp_server.filters import ToolInputError  # noqa: E402
from mcp_server.readonly_service import ReadOnlySpotlightService  # noqa: E402
from mcp_server.tools import CollectionTools  # noqa: E402
from request_auth import RequestIdentity  # noqa: E402

USER = "user-a"


def _day(days_ago: int) -> str:
    return (datetime.now(timezone.utc).date() - timedelta(days=days_ago)).isoformat()


class PriceHistoryCase(unittest.TestCase):
    def setUp(self) -> None:
        env = mock.patch.dict(os.environ, {"RAW_MAIN_PRICE_SOURCE": "tcgcsv"})
        env.start()
        self.addCleanup(env.stop)
        self.tempdir = tempfile.TemporaryDirectory()
        db_path = Path(self.tempdir.name) / "mcp.sqlite"
        conn = connect(db_path)
        apply_schema(conn, BACKEND_ROOT / "schema.sql")
        conn.close()
        self.service = ReadOnlySpotlightService(db_path, REPO_ROOT)
        self.tools = CollectionTools(self.service)
        self.conn = self.service.connection
        self._seed()

    def tearDown(self) -> None:
        self.service.connection.close()
        self.tempdir.cleanup()

    def card(self, card_id: str, name: str, *, language: str = "English") -> None:
        upsert_card(
            self.conn, card_id=card_id, name=name, set_name="Base", number="4", rarity="Rare Holo",
            variant="Raw", language=language, source_provider="scrydex", source_record_id=card_id,
            set_id="base1", set_ptcgo_code="BS", set_release_date="1999-01-09", artist="Mitsuhiro Arita",
            supertype="Pokémon", national_pokedex_numbers=[6], image_url=f"https://img.example/{card_id}.png",
            source_payload={"id": card_id},
        )

    def snapshot(self, card_id: str, *, default_variant: str | None, main_variant: str | None) -> None:
        self.conn.execute(
            "INSERT INTO card_price_snapshots (card_id, provider, display_currency_code, default_raw_variant, "
            "main_raw_variant, updated_at) VALUES (?, 'scrydex', 'USD', ?, ?, ?)",
            (card_id, default_variant, main_variant, utc_now()),
        )

    def cell(self, card_id: str, days_ago: int, market: float, *, lane: str = "raw", variant: str = "",
             condition: str | None = "NM", grader: str | None = None, grade: str | None = None,
             currency: str = "USD", signed: int = 0, provider: str = "scrydex") -> None:
        if lane == "graded":
            condition = None
        cell_key = f"{lane}|{grader or ''}|{grade or ''}|{variant}|{condition or ''}|s{signed}"
        self.conn.execute(
            "INSERT INTO card_price_history_cell (card_id, provider, price_date, lane, cell_key, variant_key, "
            "condition, grader, grade, is_perfect, is_signed, is_error, currency_code, low, market, mid, high, "
            "direct_low, trend, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 0, ?, ?, ?, ?, ?, NULL, NULL, ?)",
            (card_id, provider, _day(days_ago), lane, cell_key, variant or None, condition, grader, grade, signed,
             currency, market, market, market, market, utc_now()),
        )

    def _seed(self) -> None:
        self.card("base1-4", "Charizard")
        self.snapshot("base1-4", default_variant="Unlimited Holofoil", main_variant="Holofoil")
        # Scrydex raw: stops 120 days ago. First Edition Shadowless has the most points (the old
        # arbitrary fallback); Unlimited is the printing the app quotes.
        for days in (200, 150, 120):
            self.cell("base1-4", days, 400.0 + days, variant="unlimitedHolofoil")
            self.cell("base1-4", days, 300.0 + days, variant="unlimitedHolofoil", condition="LP")
        for days in (210, 200, 180, 150, 130, 120):
            self.cell("base1-4", days, 9000.0, variant="firstEditionShadowlessHolofoil")
        # TCGCSV raw_main: 'Holofoil' 95..60 days ago, then 'Unlimited Holofoil' + an unrelated 'Metal'.
        for days in (95, 80, 60):
            self.cell("base1-4", days, 500.0 + days, lane="raw_main", variant="Holofoil", provider="tcgcsv")
        for days in (59, 20, 2):
            self.cell("base1-4", days, 600.0 + days, lane="raw_main", variant="Unlimited Holofoil", provider="tcgcsv")
            self.cell("base1-4", days, 50.0, lane="raw_main", variant="Metal", provider="tcgcsv")
        # Graded: stops 110 days ago (staging writes no graded cells since by design).
        for days in (150, 110):
            self.cell("base1-4", days, 5000.0 + days, lane="graded", variant="unlimitedHolofoil",
                      grader="PSA", grade="10")
            self.cell("base1-4", days, 99999.0, lane="graded", variant="unlimitedHolofoil",
                      grader="PSA", grade="10", signed=1)
            self.cell("base1-4", days, 70000.0, lane="graded", variant="firstEditionShadowlessHolofoil",
                      grader="PSA", grade="10")
            self.cell("base1-4", days, 1500.0, lane="graded", variant="unlimitedHolofoil",
                      grader="PSA", grade="9")
        # A JP card: yen cells never come back.
        self.card("jp-1", "Lizardon", language="Japanese")
        self.cell("jp-1", 10, 15000.0, variant="normal", currency="JPY")
        self.cell("jp-1", 10, 90000.0, lane="graded", variant="normal", grader="PSA", grade="10", currency="JPY")
        self.conn.commit()

    def call(self, **kwargs):
        with self.service.request_identity_context(RequestIdentity(user_id=USER, auth_source="test")):
            return self.tools.get_price_history(USER, **kwargs)


class RawHistoryTests(PriceHistoryCase):
    def test_short_range_uses_tcgplayer_main_lane(self) -> None:
        history = self.call(card_id="base1-4", range_key="30d")
        self.assertEqual([p["date"] for p in history["points"]], [_day(20), _day(2)])
        self.assertEqual([p["usd"] for p in history["points"]], [620.0, 602.0])
        self.assertEqual(history["source"], "tcgplayer")
        self.assertEqual(history["variant"], "Unlimited Holofoil")
        self.assertEqual(history["as_of"], _day(2))
        self.assertEqual(history["days_since_as_of"], 2)

    def test_holofoil_and_unlimited_subtypes_are_one_printing(self) -> None:
        history = self.call(card_id="base1-4", range_key="90d")
        self.assertEqual([p["date"] for p in history["points"]], [_day(80), _day(60), _day(59), _day(20), _day(2)])
        self.assertNotIn(50.0, [p["usd"] for p in history["points"]])  # 'Metal' is another printing

    def test_1y_picks_main_printing_and_scrydex_only_before_tcgplayer(self) -> None:
        history = self.call(card_id="base1-4", range_key="1y")
        self.assertEqual(history["variant"], "Unlimited Holofoil")
        usd = [p["usd"] for p in history["points"]]
        self.assertNotIn(9000.0, usd)  # never First Edition Shadowless
        self.assertEqual(usd[:3], [600.0, 550.0, 520.0])  # Scrydex unlimited 200/150/120 days ago
        self.assertEqual(history["source"], "tcgplayer")
        self.assertEqual(
            history["sources"],
            [
                {"source": "scrydex", "from": _day(200), "through": _day(120)},
                {"source": "tcgplayer", "from": _day(95), "through": _day(2)},
            ],
        )
        self.assertIn("First Edition Shadowless Holofoil", history["available_variants"])

    def test_explicit_variant_and_unknown_variant(self) -> None:
        first = self.call(card_id="base1-4", range_key="1y", variant="firstEditionShadowlessHolofoil")
        self.assertEqual({p["usd"] for p in first["points"]}, {9000.0})
        self.assertEqual(first["source"], "scrydex")
        self.assertEqual(self.call(card_id="base1-4", range_key="1y", variant="unlimited")["variant"],
                         "Unlimited Holofoil")
        # An unknown printing falls back to the main one and says so (L013/L022).
        missing = self.call(card_id="base1-4", range_key="1y", variant="Reverse Holofoil")
        main = self.call(card_id="base1-4", range_key="1y")
        self.assertEqual((missing["variant"], missing["points"]), (main["variant"], main["points"]))
        self.assertIn("No 'Reverse Holofoil' printing", missing["variant_note"])
        self.assertNotIn("variant_note", main)

    def test_non_nm_is_scrydex_only(self) -> None:
        history = self.call(card_id="base1-4", range_key="1y", condition="LP")
        self.assertEqual([p["usd"] for p in history["points"]], [500.0, 450.0, 420.0])
        self.assertEqual(history["source"], "scrydex")
        self.assertEqual(history["days_since_as_of"], 120)

    def test_main_lane_flag_off_falls_back_to_scrydex(self) -> None:
        with mock.patch.dict(os.environ, {"RAW_MAIN_PRICE_SOURCE": "scrydex"}):
            history = self.call(card_id="base1-4", range_key="1y")
        self.assertEqual(history["source"], "scrydex")
        self.assertEqual([p["usd"] for p in history["points"]], [600.0, 550.0, 520.0])

    def test_yen_never_returned_and_errors(self) -> None:
        self.assertEqual(self.call(card_id="jp-1", range_key="30d")["points"], [])
        self.assertEqual(self.call(card_id="jp-1", range_key="30d", grader="PSA", grade="10")["points"], [])
        with self.assertRaises(ToolInputError):
            self.call(card_id="base1-4", condition="MINT")
        with self.assertRaises(ToolInputError):
            self.call(card_id="nope")
        with self.assertRaises(ToolInputError):
            self.call(card_id="base1-4", grader="PSA")


class GradedHistoryTests(PriceHistoryCase):
    def test_graded_history_for_main_printing(self) -> None:
        history = self.call(card_id="base1-4", range_key="1y", grader="psa", grade="10.0")
        self.assertEqual((history["grader"], history["grade"], history["condition"]), ("PSA", "10", None))
        self.assertEqual([p["usd"] for p in history["points"]], [5150.0, 5110.0])  # no signed, no 1st Ed
        self.assertEqual(history["variant"], "Unlimited Holofoil")
        self.assertEqual(history["source"], "scrydex")
        self.assertEqual(history["as_of"], _day(110))
        self.assertEqual(history["days_since_as_of"], 110)

    def test_graded_other_grade_and_printing(self) -> None:
        self.assertEqual([p["usd"] for p in self.call(card_id="base1-4", range_key="1y", grader="PSA",
                                                      grade="9")["points"]], [1500.0, 1500.0])
        first = self.call(card_id="base1-4", range_key="1y", grader="PSA", grade="10", variant="1st Edition Shadowless")
        self.assertEqual({p["usd"] for p in first["points"]}, {70000.0})
        self.assertEqual(self.call(card_id="base1-4", range_key="30d", grader="PSA", grade="10")["points"], [])


class NoProviderCallsTests(PriceHistoryCase):
    def test_history_never_touches_providers(self) -> None:
        import scrydex_adapter

        boom = mock.Mock(side_effect=AssertionError("provider called"))
        with mock.patch.object(scrydex_adapter, "fetch_json", boom, create=True):
            self.call(card_id="base1-4", range_key="1y")
            self.call(card_id="base1-4", range_key="1y", grader="PSA", grade="10")
        boom.assert_not_called()


if __name__ == "__main__":
    unittest.main()
