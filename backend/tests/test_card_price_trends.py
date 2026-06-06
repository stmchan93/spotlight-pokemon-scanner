from __future__ import annotations

import json
import sys
import tempfile
import unittest
from http import HTTPStatus
from pathlib import Path
from unittest.mock import Mock


BACKEND_ROOT = Path(__file__).resolve().parents[1]

if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from catalog_tools import (  # noqa: E402
    apply_schema,
    card_by_id,
    card_price_trend_list,
    card_text_from_card,
    connect,
    upsert_card,
    upsert_fx_rate_snapshot,
)
from server import SpotlightRequestHandler, SpotlightScanService  # noqa: E402

REPO_ROOT = BACKEND_ROOT.parent


_NOW = "2026-06-06T00:00:00Z"


def _graded_contexts(psa10: float, psa9: float) -> str:
    return json.dumps(
        {
            "graders": {
                "PSA": {
                    "10": [
                        {
                            "grader": "PSA",
                            "grade": "10",
                            "variant": "Holofoil",
                            "currencyCode": "USD",
                            "market": psa10,
                            "trendsPct": {"days7": 1.0, "days30": 5.0, "days90": 9.0},
                        }
                    ],
                    "9": [
                        {
                            "grader": "PSA",
                            "grade": "9",
                            "variant": "Holofoil",
                            "currencyCode": "USD",
                            "market": psa9,
                        }
                    ],
                }
            }
        }
    )


def _raw_contexts(nm: float, lp: float, dm: float) -> str:
    return json.dumps(
        {
            "variants": {
                "Normal": {
                    "variant": "Normal",
                    "variantKey": "normal",
                    "conditions": {
                        "LP": {"market": lp, "currencyCode": "USD"},
                        "NM": {"market": nm, "currencyCode": "USD"},
                        "DM": {"market": dm, "currencyCode": "USD"},
                    },
                }
            }
        }
    )


class CardPriceTrendsBuilderTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.connection = connect(Path(self.tempdir.name) / "trends.sqlite")
        apply_schema(self.connection, BACKEND_ROOT / "schema.sql")
        upsert_card(
            self.connection,
            card_id="t1",
            name="Test Pokemon",
            set_name="Set",
            number="14",
            rarity="Rare Holo",
            variant="Raw",
            language="English",
            supertype="Pokémon",
            subtypes=["Stage 1"],
            types=["Grass"],
            source_payload={
                "supertype": "Pokémon",
                "hp": "60",
                "number": "14",
                "rarity": "Rare Holo",
                "subtypes": ["Stage 1"],
                "types": ["Grass"],
                "retreat_cost": ["Colorless"],
                "weaknesses": [{"type": "Fire", "value": "×2"}],
                "resistances": [],
                "abilities": [{"type": "Ability", "name": "Test Power", "text": "Do a thing."}],
                "attacks": [
                    {"name": "Tackle", "cost": ["Grass"], "damage": "20", "text": "Hit."},
                    {"name": "Guard", "cost": [], "text": "No damage."},
                ],
            },
        )
        # Insert daily history out of date order to confirm ASC ordering.
        for price_date, psa10, psa9, nm in (
            ("2026-06-03", 100.0, 50.0, 10.0),
            ("2026-06-01", 80.0, 40.0, 8.0),
            ("2026-06-02", 90.0, 45.0, 9.0),
        ):
            self.connection.execute(
                """
                INSERT INTO card_price_history_daily (
                    card_id, provider, price_date,
                    graded_contexts_json, raw_contexts_json,
                    display_currency_code, updated_at
                ) VALUES (?,?,?,?,?,?,?)
                """,
                (
                    "t1",
                    "scrydex",
                    price_date,
                    _graded_contexts(psa10, psa9),
                    _raw_contexts(nm, nm - 2, nm - 5),
                    "USD",
                    _NOW,
                ),
            )
        # Current snapshot.
        self.connection.execute(
            """
            INSERT INTO card_price_snapshots (
                card_id, provider, graded_contexts_json, raw_contexts_json,
                display_currency_code, updated_at
            ) VALUES (?,?,?,?,?,?)
            """,
            ("t1", "scrydex", _graded_contexts(110.0, 55.0), _raw_contexts(13.0, 11.0, 8.0), "USD", _NOW),
        )
        self.connection.commit()

    def tearDown(self) -> None:
        self.connection.close()
        self.tempdir.cleanup()

    def test_graded_trend_list_orders_grades_and_computes_trend(self) -> None:
        result = card_price_trend_list(self.connection, "t1", mode="graded", provider="scrydex")
        self.assertEqual(result["mode"], "graded")
        self.assertEqual(result["provider"], "ebay")
        self.assertEqual([row["key"] for row in result["rows"]], ["PSA 10", "PSA 9"])
        psa10 = result["rows"][0]
        self.assertEqual(psa10["label"], "PSA 10")
        self.assertEqual(psa10["points"], [80.0, 90.0, 100.0])
        self.assertEqual(psa10["currentPrice"], 110.0)
        self.assertAlmostEqual(psa10["trendPct"], 25.0)
        self.assertEqual(psa10["currencyCode"], "USD")

    def test_graded_grader_filter(self) -> None:
        result = card_price_trend_list(self.connection, "t1", mode="graded", provider="scrydex", grader="BGS")
        self.assertEqual(result["rows"], [])

    def test_raw_trend_list_orders_conditions_with_full_labels(self) -> None:
        result = card_price_trend_list(self.connection, "t1", mode="raw", provider="scrydex")
        self.assertEqual(result["mode"], "raw")
        self.assertEqual(result["provider"], "tcgplayer")
        self.assertEqual([row["key"] for row in result["rows"]], ["NM", "LP", "DM"])
        self.assertEqual(
            [row["label"] for row in result["rows"]],
            ["Near Mint", "Lightly Played", "Damaged"],
        )
        nm = result["rows"][0]
        self.assertEqual(nm["points"], [8.0, 9.0, 10.0])
        self.assertEqual(nm["currentPrice"], 13.0)


class CardTextBuilderTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.connection = connect(Path(self.tempdir.name) / "card-text.sqlite")
        apply_schema(self.connection, BACKEND_ROOT / "schema.sql")

    def tearDown(self) -> None:
        self.connection.close()
        self.tempdir.cleanup()

    def test_pokemon_card_text_populated(self) -> None:
        upsert_card(
            self.connection,
            card_id="poke-1",
            name="Test",
            set_name="Set",
            number="14",
            rarity="Rare Holo",
            variant="Raw",
            language="English",
            supertype="Pokémon",
            subtypes=["Stage 1"],
            types=["Grass"],
            source_payload={
                "supertype": "Pokémon",
                "hp": "60",
                "number": "14",
                "rarity": "Rare Holo",
                "subtypes": ["Stage 1"],
                "types": ["Grass"],
                "retreat_cost": ["Colorless"],
                "weaknesses": [{"type": "Fire", "value": "×2"}],
                "resistances": [{"type": "Water", "value": "-30"}],
                "abilities": [{"type": "Ability", "name": "Power", "text": "Effect."}],
                "attacks": [{"name": "Tackle", "cost": ["Grass"], "damage": "20", "text": "Hit."}],
            },
        )
        self.connection.commit()
        text = card_text_from_card(card_by_id(self.connection, "poke-1"))
        assert text is not None
        self.assertEqual(text["stage"], "Stage 1")
        self.assertEqual(text["hp"], "60")
        self.assertEqual(text["types"], ["Grass"])
        self.assertEqual(text["retreatCost"], ["Colorless"])
        self.assertEqual(text["weaknesses"], [{"type": "Fire", "value": "×2"}])
        self.assertEqual(text["resistances"], [{"type": "Water", "value": "-30"}])
        self.assertEqual(text["attacks"][0], {"name": "Tackle", "cost": ["Grass"], "damage": "20", "text": "Hit."})
        self.assertEqual(text["abilities"][0], {"name": "Power", "type": "Ability", "text": "Effect."})

    def test_non_pokemon_returns_none(self) -> None:
        upsert_card(
            self.connection,
            card_id="trainer-1",
            name="Potion",
            set_name="Set",
            number="1",
            rarity="Common",
            variant="Raw",
            language="English",
            supertype="Trainer",
            source_payload={"supertype": "Trainer"},
        )
        self.connection.commit()
        self.assertIsNone(card_text_from_card(card_by_id(self.connection, "trainer-1")))


class CardPriceTrendsRouteTests(unittest.TestCase):
    def test_price_trends_route_dispatches_to_service(self) -> None:
        handler = SpotlightRequestHandler.__new__(SpotlightRequestHandler)
        handler.path = "/api/v1/cards/t1/price-trends?mode=graded&grader=PSA"
        handler.service = Mock()
        handler.service.card_price_trends.return_value = {
            "mode": "graded",
            "provider": "ebay",
            "rows": [],
        }
        captured: dict[str, object] = {}

        def write_json(status: HTTPStatus, payload: dict[str, object]) -> None:
            captured["status"] = status
            captured["payload"] = payload

        handler._write_json = write_json  # type: ignore[method-assign]
        handler.do_GET()

        handler.service.card_price_trends.assert_called_once_with(
            "t1",
            mode="graded",
            variant=None,
            grader="PSA",
        )
        self.assertEqual(captured["status"], HTTPStatus.OK)
        self.assertEqual(captured["payload"]["mode"], "graded")

    def test_price_trends_route_rejects_bad_mode(self) -> None:
        handler = SpotlightRequestHandler.__new__(SpotlightRequestHandler)
        handler.path = "/api/v1/cards/t1/price-trends?mode=bogus"
        handler.service = Mock()
        captured: dict[str, object] = {}

        def write_json(status: HTTPStatus, payload: dict[str, object]) -> None:
            captured["status"] = status
            captured["payload"] = payload

        handler._write_json = write_json  # type: ignore[method-assign]
        handler.do_GET()

        handler.service.card_price_trends.assert_not_called()
        self.assertEqual(captured["status"], HTTPStatus.BAD_REQUEST)


def _graded_contexts_jpy(psa10: float) -> str:
    return json.dumps(
        {
            "graders": {
                "PSA": {
                    "10": [
                        {
                            "grader": "PSA",
                            "grade": "10",
                            "variant": "Holofoil",
                            "currencyCode": "JPY",
                            "market": psa10,
                            "trendsPct": {"days7": 1.0, "days30": 5.0, "days90": 9.0},
                        }
                    ]
                }
            }
        }
    )


class JpyTrendFxConversionTests(unittest.TestCase):
    """End-to-end: JPY graded snapshots convert to USD via the service path."""

    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.database_path = Path(self.tempdir.name) / "trends-fx.sqlite"
        connection = connect(self.database_path)
        apply_schema(connection, BACKEND_ROOT / "schema.sql")
        upsert_card(
            connection,
            card_id="jp1",
            name="JP Pokemon",
            set_name="JP Set",
            number="14",
            rarity="Rare Holo",
            variant="Raw",
            language="Japanese",
            supertype="Pokémon",
        )
        # Seed a fresh JPY->USD FX snapshot so no network fetch happens.
        upsert_fx_rate_snapshot(
            connection,
            base_currency="JPY",
            quote_currency="USD",
            rate=0.0064,
            source="ecb",
            effective_at="2026-06-05",
            source_url="https://example.test/fx",
            payload={"seed": True},
        )
        # Daily history (JPY).
        for price_date, psa10 in (
            ("2026-06-01", 10000.0),
            ("2026-06-02", 11000.0),
            ("2026-06-03", 12000.0),
        ):
            connection.execute(
                """
                INSERT INTO card_price_history_daily (
                    card_id, provider, price_date,
                    graded_contexts_json, raw_contexts_json,
                    display_currency_code, updated_at
                ) VALUES (?,?,?,?,?,?,?)
                """,
                ("jp1", "scrydex", price_date, _graded_contexts_jpy(psa10), "{}", "JPY", _NOW),
            )
        connection.execute(
            """
            INSERT INTO card_price_snapshots (
                card_id, provider, graded_contexts_json, raw_contexts_json,
                display_currency_code, updated_at
            ) VALUES (?,?,?,?,?,?)
            """,
            ("jp1", "scrydex", _graded_contexts_jpy(13000.0), "{}", "JPY", _NOW),
        )
        connection.commit()
        connection.close()
        self.service = SpotlightScanService(self.database_path, REPO_ROOT)

    def tearDown(self) -> None:
        self.service.connection.close()
        self.tempdir.cleanup()

    def test_graded_price_trends_convert_current_price_and_points_to_usd(self) -> None:
        result = self.service.card_price_trends("jp1", mode="graded")
        self.assertIsNotNone(result)
        rows = result["rows"]
        self.assertEqual(len(rows), 1)
        row = rows[0]
        self.assertEqual(row["key"], "PSA 10")
        self.assertEqual(row["currencyCode"], "USD")
        # 13000 * 0.0064 = 83.2
        self.assertEqual(row["currentPrice"], 83.2)
        # [10000, 11000, 12000] * 0.0064
        self.assertEqual(row["points"], [64.0, 70.4, 76.8])

    def test_graded_card_detail_pricing_converts_to_usd(self) -> None:
        detail = self.service.card_detail("jp1", grader="PSA", grade="10")
        self.assertIsNotNone(detail)
        pricing = detail["card"].get("pricing")
        self.assertIsNotNone(pricing)
        self.assertEqual(pricing["currencyCode"], "USD")
        self.assertEqual(pricing["nativeCurrencyCode"], "JPY")
        self.assertEqual(pricing["nativeMarket"], 13000.0)
        self.assertEqual(pricing["market"], 83.2)
        self.assertTrue(pricing["displayIsConverted"])


if __name__ == "__main__":
    unittest.main()
