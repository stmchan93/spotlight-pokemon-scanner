from __future__ import annotations

import sys
import tempfile
import unittest
from datetime import datetime, timezone
from http import HTTPStatus
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock
from urllib.parse import urlparse

BACKEND_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_ROOT.parent

if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

import vendor_offers  # noqa: E402
from catalog_tools import apply_schema, connect, upsert_card  # noqa: E402
from request_auth import RequestIdentity  # noqa: E402
from server import SpotlightRequestHandler, SpotlightScanService  # noqa: E402

T0 = datetime(2026, 11, 21, 18, 0, tzinfo=timezone.utc)


def _line(card_id: str, market: float | None, offer: float, **extra: object) -> dict[str, object]:
    return {"cardId": card_id, "marketUsd": market, "offerUsd": offer, "quantity": 1, **extra}


def _insert_cards(connection) -> None:
    for card_id, name, number in (("sv3pt5-199", "Charizard ex", "199/165"), ("base1-58", "Pikachu", "58/102")):
        upsert_card(
            connection,
            card_id=card_id,
            name=name,
            set_name="Test Set",
            number=number,
            rarity="Rare",
            variant="Raw",
            language="English",
            source_provider="scrydex",
            source_record_id=card_id,
            set_id="tst",
            set_ptcgo_code="TST",
            set_release_date="2026-01-01",
            source_payload={"id": card_id},
            image_small_url=f"https://images.example.com/{card_id}.png",
        )
    connection.commit()


class VendorSettingsAndMathTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.connection = connect(Path(self.tempdir.name) / "settings.sqlite")
        vendor_offers.ensure_schema(self.connection)

    def tearDown(self) -> None:
        self.connection.close()
        self.tempdir.cleanup()

    def test_defaults_follow_the_plan_decisions(self) -> None:
        defaults = vendor_offers.get_settings(self.connection, "vendor-a")
        self.assertTrue(defaults["tiersEnabled"])
        self.assertEqual(defaults["tiers"], {"bulk": 40, "under50": 60, "over50": 70, "slab": 70})
        self.assertEqual(defaults["bulkMaxUsd"], 5.0)
        self.assertEqual(defaults["sellPercent"], 100)
        self.assertEqual(defaults["buyPercent"], 70)

    def test_settings_patch_is_owner_scoped(self) -> None:
        saved = vendor_offers.set_settings(
            self.connection, "vendor-a", {"buyPercent": 65, "tiersEnabled": False, "tiers": {"slab": 85}}
        )
        self.assertEqual(saved["buyPercent"], 65)
        self.assertEqual(saved["tiers"]["slab"], 85)
        self.assertEqual(saved["tiers"]["bulk"], 40)  # untouched default
        again = vendor_offers.set_settings(self.connection, "vendor-a", {"sellPercent": 115})
        self.assertFalse(again["tiersEnabled"])  # earlier patch kept
        other = vendor_offers.get_settings(self.connection, "vendor-b")
        self.assertTrue(other["tiersEnabled"])
        self.assertEqual(other["buyPercent"], 70)

    def test_settings_validation(self) -> None:
        for bad in (
            {"buyPercent": 0}, {"buyPercent": 101}, {"sellPercent": 84}, {"sellPercent": 121},
            {"tiersEnabled": "yes"}, {"buyPercent": "70"}, {"tiers": {"bulk": -1}}, [],
        ):
            with self.assertRaises(ValueError, msg=bad):
                vendor_offers.set_settings(self.connection, "vendor-a", bad)

    def test_offer_math(self) -> None:
        tiered = vendor_offers.normalize_settings({})
        self.assertEqual(vendor_offers.offer_for_market(4.99, is_slab=False, settings=tiered), (2.0, "bulk"))
        self.assertEqual(vendor_offers.offer_for_market(5, is_slab=False, settings=tiered), (3.0, "under50"))
        self.assertEqual(vendor_offers.offer_for_market(49.99, is_slab=False, settings=tiered)[1], "under50")
        self.assertEqual(vendor_offers.offer_for_market(50, is_slab=False, settings=tiered), (35.0, "over50"))
        self.assertEqual(vendor_offers.offer_for_market(287.93, is_slab=False, settings=tiered), (201.55, "over50"))
        self.assertEqual(vendor_offers.offer_for_market(1.5, is_slab=True, settings=tiered), (1.05, "slab"))
        self.assertEqual(vendor_offers.offer_for_market(100, is_slab=False, settings=tiered, kind="sell"), (100.0, "sell"))
        flat = vendor_offers.normalize_settings({"tiersEnabled": False, "buyPercent": 65})
        self.assertEqual(vendor_offers.offer_for_market(10, is_slab=True, settings=flat), (6.5, "flat"))
        self.assertEqual(vendor_offers.offer_for_market(None, is_slab=False, settings=flat), (None, "none"))


class VendorBoughtTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        database_path = Path(self.tempdir.name) / "vendor.sqlite"
        connection = connect(database_path)
        apply_schema(connection, BACKEND_ROOT / "schema.sql")
        connection.close()
        self.service = SpotlightScanService(database_path, REPO_ROOT)
        self.connection = self.service.connection
        _insert_cards(self.connection)

    def tearDown(self) -> None:
        self.connection.close()
        self.tempdir.cleanup()

    def _record(self, owner: str, payload: dict):
        with self.service.request_identity_context(RequestIdentity(user_id=owner, auth_source="test")):
            return vendor_offers.record_purchases(self.connection, owner, payload, self.service.record_buy, now=T0)

    def _tray(self, batch: str = "batch-1") -> dict:
        return {
            "batchId": batch,
            "lines": [
                _line("sv3pt5-199", 287.93, 201.55, variantName="Holofoil", condition="near_mint", tier="over50"),
                _line("base1-58", 10.0, 6.0, quantity=2, condition="lightly_played", name="FAKE", imageUrl="https://x"),
            ],
        }

    def test_bought_records_buys_at_the_offer_price(self) -> None:
        result = self._record("vendor-a", self._tray())
        self.assertEqual(result["recordedLineIndexes"], [0, 1])
        rows = self.connection.execute(
            "SELECT card_id, quantity, cost_basis_cents FROM deck_entries WHERE owner_user_id = 'vendor-a' ORDER BY card_id"
        ).fetchall()
        self.assertEqual([tuple(r) for r in rows], [("base1-58", 2, 600), ("sv3pt5-199", 1, 20155)])
        buys = self.connection.execute(
            "SELECT COUNT(*) FROM deck_entry_events WHERE owner_user_id = 'vendor-a' AND event_kind = 'buy'"
        ).fetchone()[0]
        self.assertEqual(buys, 2)

    def test_retry_of_the_same_batch_never_double_buys(self) -> None:
        self._record("vendor-a", self._tray())
        retry = self._record("vendor-a", self._tray())
        self.assertEqual(retry["recordedLineIndexes"], [])
        self.assertEqual(retry["alreadyRecordedLineIndexes"], [0, 1])
        quantity = self.connection.execute(
            "SELECT quantity FROM deck_entries WHERE owner_user_id = 'vendor-a' AND card_id = 'base1-58'"
        ).fetchone()[0]
        self.assertEqual(quantity, 2)
        # Same batch id from another account is its own purchase.
        self.assertEqual(self._record("vendor-b", self._tray())["recordedLineIndexes"], [0, 1])

    def test_failed_buy_releases_the_claim(self) -> None:
        with self.assertRaises(RuntimeError):
            vendor_offers.record_purchases(
                self.connection, "vendor-a", self._tray(), Mock(side_effect=RuntimeError("down")), now=T0
            )
        self.assertEqual(self.connection.execute("SELECT COUNT(*) FROM vendor_purchases").fetchone()[0], 0)

    def test_rejects_bad_input(self) -> None:
        for payload in (
            {"lines": [_line("base1-58", 1, 1)]},  # no batchId
            {"batchId": "b", "lines": []},
            {"batchId": "b", "lines": [_line("not-a-card", 1, 1)]},
            {"batchId": "b", "lines": [_line("base1-58", 1, -1)]},
            {"batchId": "b", "lines": [{"cardId": "base1-58", "marketUsd": 1}]},  # no offer
            {"batchId": "b", "lines": [_line("base1-58", 1, 1)], "currencyCode": "JPY"},
            {"batchId": "b", "lines": [{**_line("base1-58", 1, 1), "quantity": 0}]},
        ):
            with self.assertRaises(ValueError, msg=payload):
                vendor_offers.record_purchases(self.connection, "vendor-a", payload, Mock())

    def test_bought_log_profit_catalog_names_and_owner_scope(self) -> None:
        self._record("vendor-a", self._tray())
        log = vendor_offers.bought_log(
            self.connection, "vendor-a", lambda line: 300.0 if line["cardId"] == "sv3pt5-199" else None
        )
        self.assertEqual(log["summary"]["count"], 2)
        self.assertEqual(log["currencyCode"], "USD")
        charizard = next(e for e in log["entries"] if e["cardId"] == "sv3pt5-199")
        self.assertEqual(
            (charizard["paidUsd"], charizard["marketAtBuyUsd"], charizard["currentValueUsd"], charizard["profitUsd"]),
            (201.55, 287.93, 300.0, 98.45),
        )
        self.assertEqual(charizard["boughtAt"], "2026-11-21T18:00:00Z")
        pikachu = next(e for e in log["entries"] if e["cardId"] == "base1-58")
        self.assertEqual(pikachu["name"], "Pikachu")  # catalog, not the client's "FAKE"
        self.assertEqual(pikachu["imageUrl"], "https://images.example.com/base1-58.png")
        self.assertEqual((pikachu["paidUsd"], pikachu["marketAtBuyUsd"]), (12.0, 20.0))
        self.assertIsNone(pikachu["profitUsd"])
        self.assertEqual(log["summary"]["paidUsd"], 213.55)
        self.assertEqual(vendor_offers.bought_log(self.connection, "vendor-b", lambda _l: None)["entries"], [])

    def test_account_deletion_covers_vendor_tables(self) -> None:
        self.assertEqual(
            {name for name, _ in vendor_offers.OWNER_SCOPED_TABLES}, {"vendor_purchases", "vendor_settings"}
        )


class VendorHttpTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.connection = connect(Path(self.tempdir.name) / "http.sqlite")
        apply_schema(self.connection, BACKEND_ROOT / "schema.sql")
        vendor_offers.ensure_schema(self.connection)
        _insert_cards(self.connection)

    def tearDown(self) -> None:
        self.connection.close()
        self.tempdir.cleanup()

    def _handler(self, path: str, *, body: object = None, user: str | None = "vendor-a"):
        handler = SpotlightRequestHandler.__new__(SpotlightRequestHandler)
        handler.path = path
        identity = RequestIdentity(user_id=user, auth_source="test") if user else None

        class _Ctx:
            def __enter__(self_inner):
                return None

            def __exit__(self_inner, *exc):
                return False

        handler.service = SimpleNamespace(
            connection=self.connection,
            request_identity_context=lambda _identity: _Ctx(),
            _current_owner_user_id=lambda: user,
            record_buy=Mock(return_value={"deckEntryID": "deck-1"}),
            _added_baseline_now=lambda *a, **k: (12.5, "2026-11-22"),
        )
        handler._require_request_identity = lambda: identity  # type: ignore[method-assign]
        handler._read_json_body = lambda: body  # type: ignore[method-assign]
        handler.writes = []
        handler._write_json = lambda status, payload: handler.writes.append((status, payload))  # type: ignore[method-assign]
        return handler

    def test_settings_routes(self) -> None:
        save = self._handler("/api/v1/me/vendor-settings", body={"buyPercent": 60})
        save.do_POST()
        self.assertEqual(save.writes[0][1]["settings"]["buyPercent"], 60)
        read = self._handler("/api/v1/me/vendor-settings")
        read.do_GET()
        self.assertEqual(read.writes[0][1]["settings"]["buyPercent"], 60)
        other = self._handler("/api/v1/me/vendor-settings", user="vendor-b")
        other.do_GET()
        self.assertEqual(other.writes[0][1]["settings"]["buyPercent"], 70)
        bad = self._handler("/api/v1/me/vendor-settings", body={"buyPercent": 500})
        bad.do_POST()
        self.assertEqual(bad.writes[0][0], HTTPStatus.BAD_REQUEST)

    def test_bought_post_then_log(self) -> None:
        post = self._handler("/api/v1/vendor/bought", body={"batchId": "b1", "lines": [_line("base1-58", 10, 6)]})
        post.do_POST()
        self.assertEqual(post.writes[0], (HTTPStatus.OK, post.writes[0][1]))
        self.assertEqual(post.writes[0][1]["recordedLineIndexes"], [0])
        self.assertEqual(post.service.record_buy.call_args[0][0]["unitPrice"], 6.0)
        self.assertEqual(post.service.record_buy.call_args[0][0]["costBasisPerUnit"], 6.0)
        log = self._handler("/api/v1/vendor/bought")
        log.do_GET()
        entry = log.writes[0][1]["entries"][0]
        self.assertEqual((entry["paidUsd"], entry["currentValueUsd"], entry["profitUsd"]), (6.0, 12.5, 6.5))
        other = self._handler("/api/v1/vendor/bought", user="vendor-b")
        other.do_GET()
        self.assertEqual(other.writes[0][1]["entries"], [])

    def test_requires_identity(self) -> None:
        anonymous = self._handler("/api/v1/vendor/bought", user=None)
        anonymous.do_GET()
        self.assertEqual(anonymous.writes, [])  # _require_request_identity already answered 401

    def test_unrelated_paths_fall_through(self) -> None:
        handler = self._handler("/api/v1/health")
        for path in ("/api/v1/health", "/o/abc", "/api/v1/vendor/offers"):
            self.assertFalse(vendor_offers.handle_http(handler, "GET", urlparse(path)))


if __name__ == "__main__":
    unittest.main()
