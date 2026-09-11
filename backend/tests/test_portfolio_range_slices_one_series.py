"""Every chart range is a SLICE of one series, and must agree with computing it.

Each range used to be its own full replay of every holding against every day's
prices. On production that measured 2.3-8.9s per range, so flicking between 1W
and 3M and 1Y cost 20-30s and a cold open ran close to a minute (user,
2026-09-11). The ranges all end today and differ only in where they start, and
everything the summary needs from the newest day — the coverage counts and the
live-only value the delta subtracts — is the same whichever start you pick. So
one computation answers all six.

This file is the safety net for that equivalence: a slice must return exactly
what the old per-range computation returned. It is asserted range by range
against `deck_history` itself rather than against recorded numbers, so the two
paths cannot drift.
"""

from __future__ import annotations

import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_ROOT.parent
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from catalog_tools import (  # noqa: E402
    RAW_PRICING_MODE,
    apply_schema,
    connect,
    upsert_card,
    upsert_deck_entry,
    upsert_price_history_daily,
)
from request_auth import RequestIdentity  # noqa: E402
from server import SpotlightScanService, _apply_price_history_cells_schema_patch  # noqa: E402

SCRYDEX = "scrydex"
USER = "user-slices"
# Long enough that 1W, 1M and 3M all land on genuinely different baselines —
# a window where every range clamps to the same first day would pass this test
# without testing anything.
HISTORY_DAYS = 140
RANGE_LABELS = ("1W", "30D", "90D", "YTD", "1Y", "ALL")


class PortfolioRangeSliceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.database_path = Path(self.tempdir.name) / "slices.sqlite"
        connection = connect(self.database_path)
        apply_schema(connection, BACKEND_ROOT / "schema.sql")
        _apply_price_history_cells_schema_patch(connection)

        today = datetime.now(timezone.utc).date()
        self.floor_date = today - timedelta(days=HISTORY_DAYS - 1)

        # Two cards on DIFFERENT price curves, so a slice that silently reused
        # another range's baseline would show up as a wrong number rather than
        # coincidentally matching.
        for card_id, base_price, slope in (("slice-a", 10.0, 0.25), ("slice-b", 40.0, -0.1)):
            upsert_card(
                connection,
                card_id=card_id,
                name=f"Card {card_id}",
                set_name="Base Set",
                number="1/102",
                rarity="Common",
                variant="Raw",
                language="English",
                source_provider=SCRYDEX,
                source_record_id=card_id,
            )
            for offset in range(HISTORY_DAYS):
                market = round(base_price + slope * offset, 2)
                upsert_price_history_daily(
                    connection,
                    card_id=card_id,
                    pricing_mode=RAW_PRICING_MODE,
                    provider=SCRYDEX,
                    price_date=(self.floor_date + timedelta(days=offset)).isoformat(),
                    currency_code="USD",
                    variant="Holofoil",
                    condition="NM",
                    low_price=market - 1,
                    market_price=market,
                    mid_price=market,
                    high_price=market + 1,
                    direct_low_price=market - 2,
                    trend_price=market,
                    payload={"provider": SCRYDEX, "variantKey": "holofoil"},
                )
            upsert_deck_entry(
                connection,
                card_id=card_id,
                variant_name="Holofoil",
                condition="NM",
                quantity=2,
                owner_user_id=USER,
                added_at=(self.floor_date - timedelta(days=5)).isoformat(),
            )
        connection.commit()
        connection.close()

        self.service = SpotlightScanService(self.database_path, REPO_ROOT)
        self.addCleanup(self.service.connection.close)

    def _identity(self) -> RequestIdentity:
        return RequestIdentity(user_id=USER, auth_source="test")

    def _direct(self, label: str) -> dict:
        return self.service.deck_history(days=365, range_label=label, time_zone_name="UTC")

    def _sliced(self, label: str, all_history: dict) -> dict:
        return self.service._portfolio_history_range_from_series(
            all_history,
            range_label=label,
            time_zone_name="UTC",
            earliest_at=self.service._portfolio_earliest_activity_at(),
        )

    def test_every_range_slice_matches_computing_that_range(self) -> None:
        with self.service.request_identity_context(self._identity()):
            all_history = self._direct("ALL")
            for label in RANGE_LABELS:
                with self.subTest(range=label):
                    direct = self._direct(label)
                    sliced = self._sliced(label, all_history)

                    self.assertEqual(
                        [point["date"] for point in sliced["points"]],
                        [point["date"] for point in direct["points"]],
                        "sliced window must cover exactly the same days",
                    )
                    for key in (
                        "currentValue",
                        "startValue",
                        "deltaValue",
                        "deltaPercent",
                        "currentCostBasisValue",
                        "startCostBasisValue",
                        "deltaCostBasisValue",
                    ):
                        self.assertEqual(
                            sliced["summary"][key],
                            direct["summary"][key],
                            f"{label}: {key} drifted between the slice and the computation",
                        )
                    self.assertEqual(sliced["coverage"], direct["coverage"])
                    self.assertEqual(sliced["range"], direct["range"])

    def test_the_short_ranges_really_do_differ(self) -> None:
        """Guards the test above from passing vacuously.

        If the fixture's history were short enough that every range clamped to
        the same first day, the equality assertions would hold no matter how
        wrong the slicing was.
        """
        with self.service.request_identity_context(self._identity()):
            baselines = {label: self._direct(label)["summary"]["startValue"] for label in ("1W", "30D", "90D")}
        self.assertEqual(len(set(baselines.values())), 3, f"ranges must differ: {baselines}")

    def test_the_dashboard_computes_the_series_once_for_many_ranges(self) -> None:
        """The point of the change: six ranges, one replay.

        Counted at `deck_history`, which is the expensive call — a regression
        that reverted to per-range computation would show up here as six.
        """
        calls: list[str | None] = []
        original = self.service.deck_history

        def counting(*args, **kwargs):
            calls.append(kwargs.get("range_label"))
            return original(*args, **kwargs)

        self.service.deck_history = counting  # type: ignore[method-assign]
        self.addCleanup(lambda: setattr(self.service, "deck_history", original))

        with self.service.request_identity_context(self._identity()):
            payload = self.service._compute_portfolio_dashboard(
                time_zone_name="UTC",
                range_keys=["1W", "1M", "3M", "YTD", "1Y", "ALL"],
            )

        self.assertEqual(calls, ["ALL"], f"expected one series computation, got {calls}")
        self.assertEqual(
            sorted(payload["ranges"].keys()),
            ["1M", "1W", "1Y", "3M", "ALL", "YTD"],
        )
        for key, bucket in payload["ranges"].items():
            self.assertTrue(bucket["history"]["points"], f"{key} came back with no points")

    def test_a_failed_series_still_renders_every_range(self) -> None:
        """Degrade to the old path rather than to a blank chart."""
        original = self.service._portfolio_all_history_cached

        def boom(**_kwargs):
            raise RuntimeError("series unavailable")

        self.service._portfolio_all_history_cached = boom  # type: ignore[method-assign]
        self.addCleanup(
            lambda: setattr(self.service, "_portfolio_all_history_cached", original)
        )

        with self.service.request_identity_context(self._identity()):
            payload = self.service._compute_portfolio_dashboard(
                time_zone_name="UTC", range_keys=["1W", "3M"]
            )

        self.assertIn("error", payload["sections"]["history.series"])
        for key in ("1W", "3M"):
            self.assertEqual(payload["sections"][f"history.{key}"], "ok")
            self.assertTrue(payload["ranges"][key]["history"]["points"])


if __name__ == "__main__":
    unittest.main()
