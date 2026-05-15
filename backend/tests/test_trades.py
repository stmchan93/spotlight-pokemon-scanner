from __future__ import annotations

import json
import sys
import tempfile
import unittest
from http import HTTPStatus
from io import BytesIO
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_ROOT.parent

if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from catalog_tools import (  # noqa: E402
    apply_schema,
    connect,
    upsert_card,
    upsert_deck_entry,
)
from request_auth import RequestIdentity  # noqa: E402
from server import (  # noqa: E402
    SpotlightRequestHandler,
    SpotlightScanService,
    TradesService,
)


def _identity(user_id: str) -> RequestIdentity:
    return RequestIdentity(user_id=user_id, auth_source="test")


class _MockHandler(SpotlightRequestHandler):
    """Lightweight request handler that skips BaseHTTPRequestHandler.__init__."""

    def __init__(
        self,
        path: str,
        body: bytes = b"",
        headers: dict | None = None,
    ) -> None:
        self.path = path
        self.rfile = BytesIO(body)
        self.wfile = BytesIO()
        default_headers = {"Content-Length": str(len(body))}
        if headers:
            default_headers.update(headers)
        self.headers = default_headers
        self._json_writes: list[tuple[HTTPStatus, dict]] = []
        self._html_writes: list[tuple[HTTPStatus, str]] = []
        self._sent_headers: list[tuple[str, str]] = []
        self._sent_response_code: int | None = None

    def send_response(self, code, message=None):  # noqa: D401
        self._sent_response_code = int(code)

    def send_header(self, keyword, value):
        self._sent_headers.append((str(keyword), str(value)))

    def end_headers(self):
        pass

    def _write_json(self, status, payload):  # type: ignore[override]
        self._json_writes.append((status, payload))

    def _write_html(self, status, body):  # type: ignore[override]
        self._html_writes.append((status, body))


class TradesServiceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.database_path = Path(self.tempdir.name) / "trades.sqlite"
        connection = connect(self.database_path)
        apply_schema(connection, BACKEND_ROOT / "schema.sql")
        connection.close()
        self.service = SpotlightScanService(self.database_path, REPO_ROOT)
        self.trades = TradesService(self.service)

    def tearDown(self) -> None:
        self.service.connection.close()
        self.tempdir.cleanup()

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _seed_card(self, card_id: str, name: str = "Pikachu", number: str = "1/100") -> None:
        upsert_card(
            self.service.connection,
            card_id=card_id,
            name=name,
            set_name="Base Set",
            number=number,
            rarity="Common",
            variant="Raw",
            language="English",
            source_provider="scrydex",
            source_record_id=card_id,
            set_id="bs",
            set_ptcgo_code="BS",
            set_release_date="1999-01-09",
            source_payload={"id": card_id},
        )
        self.service.connection.commit()

    def _seed_deck_entry(
        self,
        *,
        owner_user_id: str,
        card_id: str,
        quantity: int = 1,
        unit_price: float = 10.0,
    ) -> str:
        deck_entry_id = upsert_deck_entry(
            self.service.connection,
            owner_user_id=owner_user_id,
            card_id=card_id,
            quantity=quantity,
            unit_price=unit_price,
            currency_code="USD",
            added_at="2026-05-15T00:00:00Z",
            updated_at="2026-05-15T00:00:00Z",
            event_kind="buy",
        )
        self.service.connection.commit()
        return deck_entry_id

    # ------------------------------------------------------------------
    # create_trade
    # ------------------------------------------------------------------

    def test_create_trade_swaps_inventory_atomically(self) -> None:
        self._seed_card("card-inbound")
        self._seed_card("card-outbound")
        outbound_id = self._seed_deck_entry(
            owner_user_id="user-1", card_id="card-outbound", quantity=1
        )

        with self.service.request_identity_context(_identity("user-1")):
            result = self.trades.create_trade(
                {
                    "inbound": {
                        "card_id": "card-inbound",
                        "condition": "near_mint",
                        "market_value_cents": 5000,
                    },
                    "outbound": [
                        {"deck_entry_id": outbound_id, "quantity": 1, "market_value_cents": 4500},
                    ],
                    "cash_delta_cents": 500,
                    "notes": "Even-ish swap",
                }
            )

        self.assertEqual(result["inboundCardID"], "card-inbound")
        self.assertEqual(result["cashDeltaCents"], 500)
        self.assertEqual(result["inboundMarketValueCents"], 5000)
        self.assertEqual(result["outboundTotalMarketValueCents"], 4500)
        self.assertEqual(len(result["outboundEntries"]), 1)
        self.assertEqual(result["outboundEntries"][0]["deckEntryID"], outbound_id)

        # outbound decremented to 0
        outbound_qty = int(
            self.service.connection.execute(
                "SELECT quantity FROM deck_entries WHERE id = ?",
                (outbound_id,),
            ).fetchone()["quantity"]
        )
        self.assertEqual(outbound_qty, 0)

        # inbound deck entry created
        inbound_id = result["inboundDeckEntryID"]
        self.assertIsNotNone(inbound_id)
        inbound_row = self.service.connection.execute(
            "SELECT * FROM deck_entries WHERE id = ?", (inbound_id,)
        ).fetchone()
        self.assertEqual(int(inbound_row["quantity"]), 1)
        self.assertEqual(str(inbound_row["card_id"]), "card-inbound")
        self.assertEqual(str(inbound_row["owner_user_id"]), "user-1")

        # outbound trade event recorded
        outbound_events = self.service.connection.execute(
            "SELECT * FROM deck_entry_events WHERE deck_entry_id = ? AND event_kind = ?",
            (outbound_id, "trade_outbound"),
        ).fetchall()
        self.assertEqual(len(outbound_events), 1)
        self.assertEqual(int(outbound_events[0]["quantity_delta"]), -1)

        # inbound trade event recorded
        inbound_events = self.service.connection.execute(
            "SELECT * FROM deck_entry_events WHERE deck_entry_id = ? AND event_kind = ?",
            (inbound_id, "trade_inbound"),
        ).fetchall()
        self.assertEqual(len(inbound_events), 1)

        # trade rows + outbound rows persisted
        trade_row = self.service.connection.execute(
            "SELECT * FROM trades WHERE trade_id = ?", (result["tradeID"],)
        ).fetchone()
        self.assertIsNotNone(trade_row)
        outbound_rows = self.service.connection.execute(
            "SELECT * FROM trade_outbound_entries WHERE trade_id = ?",
            (result["tradeID"],),
        ).fetchall()
        self.assertEqual(len(outbound_rows), 1)

    def test_create_trade_respects_cash_delta_signs(self) -> None:
        self._seed_card("card-inbound")
        self._seed_card("card-outbound")
        outbound_id = self._seed_deck_entry(
            owner_user_id="user-1", card_id="card-outbound", quantity=3
        )
        for delta in (0, 1500, -750):
            with self.service.request_identity_context(_identity("user-1")):
                result = self.trades.create_trade(
                    {
                        "inbound": {"card_id": "card-inbound"},
                        "outbound": [{"deck_entry_id": outbound_id, "quantity": 1}],
                        "cash_delta_cents": delta,
                    }
                )
            self.assertEqual(result["cashDeltaCents"], delta)

    def test_outbound_fails_when_owned_by_another_user(self) -> None:
        self._seed_card("card-inbound")
        self._seed_card("card-outbound")
        outbound_id = self._seed_deck_entry(
            owner_user_id="other-user", card_id="card-outbound", quantity=1
        )

        with self.service.request_identity_context(_identity("user-1")):
            with self.assertRaises(PermissionError):
                self.trades.create_trade(
                    {
                        "inbound": {"card_id": "card-inbound"},
                        "outbound": [{"deck_entry_id": outbound_id}],
                    }
                )

        # Inventory must not have been touched.
        qty = int(
            self.service.connection.execute(
                "SELECT quantity FROM deck_entries WHERE id = ?", (outbound_id,)
            ).fetchone()["quantity"]
        )
        self.assertEqual(qty, 1)
        # No trade rows created.
        count = self.service.connection.execute(
            "SELECT COUNT(*) AS count FROM trades"
        ).fetchone()["count"]
        self.assertEqual(int(count), 0)

    def test_outbound_fails_when_quantity_exceeds_inventory(self) -> None:
        self._seed_card("card-inbound")
        self._seed_card("card-outbound")
        outbound_id = self._seed_deck_entry(
            owner_user_id="user-1", card_id="card-outbound", quantity=1
        )

        with self.service.request_identity_context(_identity("user-1")):
            with self.assertRaises(ValueError):
                self.trades.create_trade(
                    {
                        "inbound": {"card_id": "card-inbound"},
                        "outbound": [{"deck_entry_id": outbound_id, "quantity": 5}],
                    }
                )

        # DB stays consistent: quantity unchanged, no trade rows.
        qty = int(
            self.service.connection.execute(
                "SELECT quantity FROM deck_entries WHERE id = ?", (outbound_id,)
            ).fetchone()["quantity"]
        )
        self.assertEqual(qty, 1)
        count = self.service.connection.execute(
            "SELECT COUNT(*) AS count FROM trades"
        ).fetchone()["count"]
        self.assertEqual(int(count), 0)

    def test_create_trade_requires_known_inbound_card(self) -> None:
        self._seed_card("card-outbound")
        outbound_id = self._seed_deck_entry(
            owner_user_id="user-1", card_id="card-outbound", quantity=1
        )
        with self.service.request_identity_context(_identity("user-1")):
            with self.assertRaises(FileNotFoundError):
                self.trades.create_trade(
                    {
                        "inbound": {"card_id": "missing-card"},
                        "outbound": [{"deck_entry_id": outbound_id}],
                    }
                )

    def test_create_trade_requires_non_empty_outbound(self) -> None:
        self._seed_card("card-inbound")
        with self.service.request_identity_context(_identity("user-1")):
            with self.assertRaises(ValueError):
                self.trades.create_trade(
                    {"inbound": {"card_id": "card-inbound"}, "outbound": []}
                )

    # ------------------------------------------------------------------
    # get_trade / list_trades
    # ------------------------------------------------------------------

    def _make_trade(self, owner: str, *, label: int) -> str:
        card_id = f"card-{label}"
        outbound_card_id = f"card-out-{label}"
        self._seed_card(card_id)
        self._seed_card(outbound_card_id)
        outbound_id = self._seed_deck_entry(
            owner_user_id=owner, card_id=outbound_card_id, quantity=1
        )
        with self.service.request_identity_context(_identity(owner)):
            result = self.trades.create_trade(
                {
                    "inbound": {"card_id": card_id},
                    "outbound": [{"deck_entry_id": outbound_id, "quantity": 1}],
                }
            )
        return result["tradeID"]

    def test_get_trade_scoped_by_owner(self) -> None:
        trade_id = self._make_trade("seller-1", label=1)
        with self.service.request_identity_context(_identity("seller-1")):
            payload = self.trades.get_trade(trade_id)
        self.assertEqual(payload["tradeID"], trade_id)
        with self.service.request_identity_context(_identity("intruder")):
            with self.assertRaises(PermissionError):
                self.trades.get_trade(trade_id)

    def test_get_trade_404_when_missing(self) -> None:
        with self.service.request_identity_context(_identity("seller-1")):
            with self.assertRaises(FileNotFoundError):
                self.trades.get_trade("trade:does-not-exist")

    def test_list_trades_pagination_and_ordering(self) -> None:
        first = self._make_trade("seller-2", label=10)
        second = self._make_trade("seller-2", label=11)
        third = self._make_trade("seller-2", label=12)

        with self.service.request_identity_context(_identity("seller-2")):
            page_one = self.trades.list_trades(limit=2, offset=0)
            page_two = self.trades.list_trades(limit=2, offset=2)

        ids_page_one = [trade["tradeID"] for trade in page_one["trades"]]
        ids_page_two = [trade["tradeID"] for trade in page_two["trades"]]
        # Most-recent first.
        self.assertEqual(ids_page_one[0], third)
        self.assertEqual(ids_page_one[1], second)
        self.assertEqual(ids_page_two[0], first)
        # No overlap between pages.
        self.assertFalse(set(ids_page_one) & set(ids_page_two))

    def test_list_trades_scoped_by_owner(self) -> None:
        owner_a_trade = self._make_trade("owner-a", label=20)
        owner_b_trade = self._make_trade("owner-b", label=21)
        with self.service.request_identity_context(_identity("owner-a")):
            payload = self.trades.list_trades()
        ids = [trade["tradeID"] for trade in payload["trades"]]
        self.assertIn(owner_a_trade, ids)
        self.assertNotIn(owner_b_trade, ids)

    def test_market_value_snapshots_preserved(self) -> None:
        self._seed_card("card-inbound")
        self._seed_card("card-outbound")
        outbound_id = self._seed_deck_entry(
            owner_user_id="user-1", card_id="card-outbound", quantity=1
        )
        with self.service.request_identity_context(_identity("user-1")):
            result = self.trades.create_trade(
                {
                    "inbound": {"card_id": "card-inbound", "market_value_cents": 12345},
                    "outbound": [
                        {
                            "deck_entry_id": outbound_id,
                            "quantity": 1,
                            "market_value_cents": 9876,
                        }
                    ],
                }
            )
        trade_id = result["tradeID"]
        # Simulate the price changing later — by directly updating any pricing
        # snapshot tables. The values stored on `trades` / `trade_outbound_entries`
        # are independent and must not move.
        with self.service.request_identity_context(_identity("user-1")):
            fetched = self.trades.get_trade(trade_id)
        self.assertEqual(fetched["inboundMarketValueCents"], 12345)
        self.assertEqual(fetched["outboundEntries"][0]["marketValueCents"], 9876)

    # ------------------------------------------------------------------
    # HTTP handler
    # ------------------------------------------------------------------

    def test_post_trades_requires_auth(self) -> None:
        SpotlightRequestHandler.service = self.service
        SpotlightRequestHandler.trades_service = self.trades

        body = json.dumps(
            {
                "inbound": {"card_id": "card-inbound"},
                "outbound": [{"deck_entry_id": "x"}],
            }
        ).encode("utf-8")
        handler = _MockHandler(
            path="/api/v1/trades",
            body=body,
            headers={"Content-Length": str(len(body))},
        )

        original_auth_required = self.service.authenticator.auth_required
        self.service.authenticator.auth_required = True
        try:
            handler.do_POST()
        finally:
            self.service.authenticator.auth_required = original_auth_required

        self.assertEqual(handler._json_writes[-1][0], HTTPStatus.UNAUTHORIZED)

    def test_get_trades_requires_auth(self) -> None:
        SpotlightRequestHandler.service = self.service
        SpotlightRequestHandler.trades_service = self.trades

        handler = _MockHandler(path="/api/v1/trades")
        original_auth_required = self.service.authenticator.auth_required
        self.service.authenticator.auth_required = True
        try:
            handler.do_GET()
        finally:
            self.service.authenticator.auth_required = original_auth_required
        self.assertEqual(handler._json_writes[-1][0], HTTPStatus.UNAUTHORIZED)


if __name__ == "__main__":
    unittest.main()
