"""Watchlist empty state: watchlist_suggestions.py + GET /api/v1/watchlist/suggestions."""

from __future__ import annotations

import contextlib
import sys
import tempfile
import unittest
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import Mock

BACKEND_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_ROOT.parent
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from catalog_tools import apply_schema, connect, upsert_card, utc_now  # noqa: E402
from request_auth import RequestIdentity  # noqa: E402
from watchlist_suggestions import MAX_LIMIT, build_watchlist_suggestions, clamp_limit  # noqa: E402

NOW = datetime(2026, 9, 24, 12, 0, tzinfo=timezone.utc)


def _ago(**delta: float) -> str:
    return (NOW - timedelta(**delta)).isoformat()


class WatchlistSuggestionsTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.connection = connect(Path(self.tempdir.name) / "suggestions.sqlite")
        self.addCleanup(self.connection.close)
        apply_schema(self.connection, BACKEND_ROOT / "schema.sql")
        self._scan_seq = 0

    def _card(self, card_id: str, *, supertype: str = "Pokémon") -> None:
        upsert_card(self.connection, card_id=card_id, name=card_id.title(), set_name="Base Set", number="4/102",
                    rarity="Rare", variant="Raw", language="English", set_id="base1", supertype=supertype,
                    image_small_url=f"https://img/{card_id}/small")

    def _scan(self, owner: str, *, created_at: str, predicted: str | None = None,
              selected: str | None = None, confirmed: str | None = None) -> None:
        self._scan_seq += 1
        self.connection.execute(
            "INSERT INTO scan_events (scan_id, owner_user_id, created_at, request_json, response_json, "
            "predicted_card_id, selected_card_id, confirmed_card_id) VALUES (?, ?, ?, '{}', '{}', ?, ?, ?)",
            (f"scan-{self._scan_seq}", owner, created_at, predicted, selected, confirmed),
        )

    def _own(self, owner: str, card_id: str, *, quantity: int = 1) -> None:
        self.connection.execute(
            "INSERT INTO deck_entries (id, owner_user_id, item_kind, card_id, quantity, added_at, updated_at) "
            "VALUES (?, ?, 'raw', ?, ?, ?, ?)",
            (f"deck-{owner}-{card_id}", owner, card_id, quantity, utc_now(), utc_now()),
        )

    def _watch(self, owner: str, card_id: str) -> None:
        self.connection.execute(
            "INSERT INTO card_favorites (owner_user_id, card_id, variant_key, created_at) VALUES (?, ?, '', ?)",
            (owner, card_id, utc_now()),
        )

    def _ids(self, owner: str | None, **kwargs) -> list[str]:
        self.connection.commit()
        payload = build_watchlist_suggestions(self.connection, owner, now=NOW, **kwargs)
        return [item["cardId"] for item in payload["items"]]

    def test_owner_scoping(self) -> None:
        self._card("mine")
        self._card("theirs")
        self._scan("user-a", created_at=_ago(hours=1), predicted="mine")
        self._scan("user-b", created_at=_ago(minutes=5), predicted="theirs")
        self.assertEqual(self._ids("user-a"), ["mine"])
        self.assertEqual(self._ids("user-b"), ["theirs"])
        self.assertEqual(self._ids(None), [])
        self.assertEqual(self._ids(""), [])

    def test_excludes_owned_but_not_zero_quantity(self) -> None:
        for card_id in ("owned", "sold-out", "other-owner"):
            self._card(card_id)
            self._scan("user-a", created_at=_ago(hours=1), predicted=card_id)
        self._own("user-a", "owned")
        self._own("user-a", "sold-out", quantity=0)
        self._own("user-b", "other-owner")
        self.assertEqual(sorted(self._ids("user-a")), ["other-owner", "sold-out"])

    def test_excludes_watched_only_for_that_owner(self) -> None:
        for card_id in ("watched", "watched-by-b"):
            self._card(card_id)
            self._scan("user-a", created_at=_ago(hours=1), predicted=card_id)
        self._watch("user-a", "watched")
        self._watch("user-b", "watched-by-b")
        self.assertEqual(self._ids("user-a"), ["watched-by-b"])

    def test_excludes_sealed(self) -> None:
        self._card("etb", supertype="Sealed")
        self._card("single")
        self._scan("user-a", created_at=_ago(hours=2), predicted="etb")
        self._scan("user-a", created_at=_ago(hours=1), predicted="single")
        self.assertEqual(self._ids("user-a"), ["single"])

    def test_dedupe_newest_first_label_precedence_and_window(self) -> None:
        for card_id in ("old", "mid", "new", "predicted-only", "stale"):
            self._card(card_id)
        self._scan("user-a", created_at=_ago(days=3), predicted="old")
        self._scan("user-a", created_at=_ago(days=2), predicted="mid")
        self._scan("user-a", created_at=_ago(hours=1), predicted="old")  # rescanned → newest
        # confirmed beats selected beats predicted; blanks fall through.
        self._scan("user-a", created_at=_ago(hours=2), predicted="predicted-only", selected="", confirmed="new")
        self._scan("user-a", created_at=_ago(days=31), predicted="stale")
        self._scan("user-a", created_at=_ago(hours=3), predicted="unknown-card")
        self.assertEqual(self._ids("user-a"), ["old", "new", "mid"])

    def test_limit_clamp(self) -> None:
        for index in range(MAX_LIMIT + 3):
            card_id = f"card-{index:02d}"
            self._card(card_id)
            self._scan("user-a", created_at=_ago(minutes=index + 1), predicted=card_id)
        self.assertEqual(len(self._ids("user-a")), 6)
        self.assertEqual(self._ids("user-a", limit=2), ["card-00", "card-01"])
        self.assertEqual(len(self._ids("user-a", limit=99)), MAX_LIMIT)
        self.assertEqual(clamp_limit(0), 1)
        self.assertEqual(clamp_limit("nope"), 6)
        self.assertEqual(clamp_limit("3"), 3)

    def test_item_shape_and_price(self) -> None:
        self._card("base1-4")
        self._scan("user-a", created_at=_ago(hours=1), predicted="base1-4")
        self.connection.execute(
            "INSERT INTO card_price_history_daily (card_id, provider, price_date, display_currency_code, "
            "main_raw_market_price, updated_at) VALUES ('base1-4', 'scrydex', ?, 'USD', 412.5, ?)",
            (date.today().isoformat(), utc_now()),
        )
        self.connection.commit()
        payload = build_watchlist_suggestions(self.connection, "user-a", now=NOW)
        self.assertEqual(payload["limit"], 6)
        item = payload["items"][0]
        self.assertEqual(item["cardId"], "base1-4")
        self.assertEqual(item["setName"], "Base Set")
        self.assertEqual(item["number"], "4/102")
        self.assertEqual(item["imageUrl"], "https://img/base1-4/small")
        self.assertEqual(item["game"], "pokemon")
        self.assertEqual(item["language"], "English")
        self.assertEqual(item["priceNow"], 412.5)
        self.assertEqual(item["currencyCode"], "USD")


class WatchlistSuggestionsRouteTests(unittest.TestCase):
    def test_route_runs_inside_authenticated_request_context(self) -> None:
        from server import SpotlightRequestHandler

        identity = RequestIdentity(user_id="watch-user", auth_source="test")
        handler = SpotlightRequestHandler.__new__(SpotlightRequestHandler)
        handler.path = "/api/v1/watchlist/suggestions?limit=4"
        handler.service = Mock()
        handler.service.request_identity_context.return_value = contextlib.nullcontext()
        handler.service.watchlist_suggestions.return_value = {"items": [], "limit": 4}
        handler._require_request_identity = lambda: identity  # type: ignore[method-assign]
        handler._write_json = Mock()  # type: ignore[method-assign]

        handler.do_GET()

        handler.service.request_identity_context.assert_called_once_with(identity)
        handler.service.watchlist_suggestions.assert_called_once_with(limit="4")

    def test_route_requires_identity(self) -> None:
        from server import SpotlightRequestHandler

        handler = SpotlightRequestHandler.__new__(SpotlightRequestHandler)
        handler.path = "/api/v1/watchlist/suggestions"
        handler.service = Mock()
        handler._require_request_identity = lambda: None  # type: ignore[method-assign]
        handler._write_json = Mock()  # type: ignore[method-assign]

        handler.do_GET()

        handler.service.watchlist_suggestions.assert_not_called()


if __name__ == "__main__":
    unittest.main()
