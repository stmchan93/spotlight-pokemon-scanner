"""Expo push transport tests. Injected mock transport only — no network."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path
from typing import Any

BACKEND_ROOT = Path(__file__).resolve().parents[1]

if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

import expo_push  # noqa: E402
from expo_push import (  # noqa: E402
    DEAL_PUSH_TITLE,
    ERROR_DEVICE_NOT_REGISTERED,
    EXPO_PUSH_URL,
    EXPO_RECEIPTS_URL,
    MAX_MESSAGES_PER_REQUEST,
    OPS_PUSH_TITLE,
    SKIP_ALREADY_SENT,
    SKIP_INVALID_TOKEN,
    SKIP_NO_SIGNALS,
    SKIP_NO_TOKENS,
    SKIP_PREFS_OFF,
    WATCHLIST_DEEP_LINK,
    DealAlertPush,
    OpsAlertPush,
    build_deal_message,
    check_receipts,
    chunk_messages,
    deal_push_body,
    format_usd_cents,
    is_expo_push_token,
    ops_admin_user_ids,
    prefs_allow_deal_push,
    send_deal_alert_pushes,
    send_messages,
    send_ops_alert_pushes,
)


_REAL_DEFAULT_TRANSPORT = expo_push._default_transport


def setUpModule() -> None:
    """No test may reach exp.host. Any call that forgot to inject a transport
    blows up here instead of sending a real push."""

    def _forbidden(*args: Any, **kwargs: Any) -> Any:
        raise AssertionError("expo_push tests must inject a transport")

    expo_push._default_transport = _forbidden  # type: ignore[assignment]


def tearDownModule() -> None:
    expo_push._default_transport = _REAL_DEFAULT_TRANSPORT  # type: ignore[assignment]


def token(index: int) -> str:
    return f"ExponentPushToken[tok{index:04d}]"


class RecordingTransport:
    """Injected transport: records every (url, payload) and replays canned
    responses. ``ticket_factory`` builds one ticket per message so chunking is
    visible in the recorded calls."""

    def __init__(
        self,
        *,
        responses: list[Any] | None = None,
        raises: Exception | None = None,
    ) -> None:
        self.calls: list[tuple[str, Any]] = []
        self.responses = list(responses or [])
        self.raises = raises

    def __call__(self, url: str, payload: Any) -> Any:
        self.calls.append((url, payload))
        if self.raises is not None:
            raise self.raises
        if self.responses:
            return self.responses.pop(0)
        if url == EXPO_RECEIPTS_URL:
            return {"data": {value: {"status": "ok"} for value in payload["ids"]}}
        return {"data": [{"status": "ok", "id": f"t{i}"} for i in range(len(payload))]}

    @property
    def message_counts(self) -> list[int]:
        return [len(payload) for url, payload in self.calls if url == EXPO_PUSH_URL]


def deal(index: int = 0, **overrides: Any) -> DealAlertPush:
    payload: dict[str, Any] = {
        "alert_id": f"alert-{index}",
        "owner_user_id": f"owner-{index}",
        "card_name": "Mega Starmie ex",
        "total_cents": 3400,
        "discount_pct": 26.0,
        "card_id": f"card-{index}",
    }
    payload.update(overrides)
    return DealAlertPush(**payload)


class AlwaysClaims:
    """Stand-in for the caller's ``push_sent_at`` write. Records the order in
    which claims happened relative to transport calls."""

    def __init__(self, log: list[str], *, refuse: set[str] | None = None) -> None:
        self.log = log
        self.refuse = refuse or set()
        self.claimed: list[str] = []

    def __call__(self, reference_id: str) -> bool:
        if reference_id in self.refuse:
            self.log.append(f"claim-refused:{reference_id}")
            return False
        self.claimed.append(reference_id)
        self.log.append(f"claim:{reference_id}")
        return True


# --- copy / assembly ---------------------------------------------------------


class TestMessageAssembly(unittest.TestCase):
    def test_body_reads_like_product_copy(self) -> None:
        self.assertEqual(
            deal_push_body("Mega Starmie ex", 3400, 26.0),
            "Mega Starmie ex — $34, 26% under",
        )

    def test_body_keeps_cents_when_not_whole_dollars(self) -> None:
        self.assertEqual(format_usd_cents(3450), "$34.50")
        self.assertEqual(format_usd_cents(120000), "$1,200")
        self.assertEqual(
            deal_push_body("Umbreon VMAX", 3450, 12.4),
            "Umbreon VMAX — $34.50, 12% under",
        )

    def test_body_drops_the_percent_clause_when_there_is_no_discount(self) -> None:
        self.assertEqual(deal_push_body("Pikachu", 500, None), "Pikachu — $5")
        self.assertEqual(deal_push_body("  ", 500, 0.0), "A watched card — $5")

    def test_message_carries_watchlist_deep_link_and_alert_id(self) -> None:
        message = build_deal_message(token(1), deal(3))
        payload = message.as_payload()
        self.assertEqual(payload["to"], token(1))
        self.assertEqual(payload["title"], DEAL_PUSH_TITLE)
        self.assertEqual(payload["body"], "Mega Starmie ex — $34, 26% under")
        self.assertEqual(payload["data"]["url"], WATCHLIST_DEEP_LINK)
        self.assertEqual(payload["data"]["alertId"], "alert-3")
        self.assertEqual(payload["data"]["cardId"], "card-3")
        self.assertEqual(message.reference_id, "alert-3")

    def test_token_format_guard(self) -> None:
        self.assertTrue(is_expo_push_token("ExponentPushToken[abc]"))
        self.assertTrue(is_expo_push_token("ExpoPushToken[abc]"))
        self.assertFalse(is_expo_push_token("abc"))
        self.assertFalse(is_expo_push_token(None))

    def test_admin_user_ids_parse_from_a_comma_list(self) -> None:
        self.assertEqual(ops_admin_user_ids("a, b ,,c"), ("a", "b", "c"))
        self.assertEqual(ops_admin_user_ids(""), ())


# --- batching ----------------------------------------------------------------


class TestChunking(unittest.TestCase):
    def test_exactly_one_hundred_is_a_single_request(self) -> None:
        messages = [build_deal_message(token(i), deal(i)) for i in range(100)]
        self.assertEqual([len(c) for c in chunk_messages(messages)], [100])
        transport = RecordingTransport()
        result = send_messages(messages, transport=transport)
        self.assertEqual(transport.message_counts, [100])
        self.assertEqual(result.sent, 100)

    def test_one_over_the_boundary_splits(self) -> None:
        messages = [build_deal_message(token(i), deal(i)) for i in range(101)]
        transport = RecordingTransport()
        result = send_messages(messages, transport=transport)
        self.assertEqual(transport.message_counts, [100, 1])
        self.assertEqual(result.sent, 101)
        self.assertEqual(len(result.ticket_ids), 101)

    def test_well_above_the_boundary_chunks_evenly(self) -> None:
        messages = [build_deal_message(token(i), deal(i)) for i in range(250)]
        transport = RecordingTransport()
        send_messages(messages, transport=transport)
        self.assertEqual(transport.message_counts, [100, 100, 50])
        self.assertEqual(MAX_MESSAGES_PER_REQUEST, 100)

    def test_empty_message_list_never_touches_the_transport(self) -> None:
        transport = RecordingTransport()
        result = send_messages([], transport=transport)
        self.assertEqual(transport.calls, [])
        self.assertEqual((result.sent, result.failed), (0, 0))


# --- tickets -----------------------------------------------------------------


class TestTickets(unittest.TestCase):
    def test_device_not_registered_lands_in_the_revoke_list(self) -> None:
        messages = [
            build_deal_message(token(1), deal(1)),
            build_deal_message(token(2), deal(2)),
        ]
        transport = RecordingTransport(
            responses=[
                {
                    "data": [
                        {"status": "ok", "id": "ticket-1"},
                        {
                            "status": "error",
                            "message": "not a registered device",
                            "details": {"error": ERROR_DEVICE_NOT_REGISTERED},
                        },
                    ]
                }
            ]
        )
        result = send_messages(messages, transport=transport)
        self.assertEqual(result.sent, 1)
        self.assertEqual(result.failed, 1)
        self.assertEqual(result.tokens_to_revoke, (token(2),))
        self.assertEqual(result.ticket_ids, ("ticket-1",))
        self.assertEqual(result.tickets[0].reference_id, "alert-1")

    def test_other_ticket_errors_do_not_revoke_the_token(self) -> None:
        transport = RecordingTransport(
            responses=[
                {
                    "data": [
                        {
                            "status": "error",
                            "message": "too many",
                            "details": {"error": "MessageRateExceeded"},
                        }
                    ]
                }
            ]
        )
        result = send_messages([build_deal_message(token(1), deal(1))], transport=transport)
        self.assertEqual(result.failed, 1)
        self.assertEqual(result.tokens_to_revoke, ())

    def test_transport_exception_returns_a_structured_failure(self) -> None:
        transport = RecordingTransport(raises=RuntimeError("connection reset"))
        messages = [build_deal_message(token(i), deal(i)) for i in range(3)]
        result = send_messages(messages, transport=transport)  # must not raise
        self.assertEqual(result.sent, 0)
        self.assertEqual(result.failed, 3)
        self.assertEqual(result.tokens_to_revoke, ())
        self.assertIn("RuntimeError: connection reset", result.errors)

    def test_one_failing_chunk_does_not_stop_the_next(self) -> None:
        class FlakyTransport(RecordingTransport):
            def __call__(self, url: str, payload: Any) -> Any:
                self.calls.append((url, payload))
                if len(self.calls) == 1:
                    raise TimeoutError("slow")
                return {"data": [{"status": "ok", "id": "t"} for _ in payload]}

        messages = [build_deal_message(token(i), deal(i)) for i in range(150)]
        transport = FlakyTransport()
        result = send_messages(messages, transport=transport)
        self.assertEqual(result.failed, 100)
        self.assertEqual(result.sent, 50)

    def test_missing_ticket_body_is_a_failure_not_a_crash(self) -> None:
        transport = RecordingTransport(responses=[{"errors": [{"message": "boom"}]}])
        result = send_messages([build_deal_message(token(1), deal(1))], transport=transport)
        self.assertEqual(result.failed, 1)
        self.assertIn("boom", result.errors)


# --- user lane: prefs, skips, at-most-once -----------------------------------


class TestUserLane(unittest.TestCase):
    def test_sends_one_message_per_live_token(self) -> None:
        log: list[str] = []
        claim = AlwaysClaims(log)
        transport = RecordingTransport()
        result = send_deal_alert_pushes(
            [deal(1)],
            tokens_by_owner={"owner-1": [token(1), token(2)]},
            claim=claim,
            transport=transport,
        )
        self.assertEqual(result.sent, 2)
        self.assertEqual(transport.message_counts, [2])

    def test_empty_digest_sends_nothing(self) -> None:
        transport = RecordingTransport()
        result = send_deal_alert_pushes(
            [],
            tokens_by_owner={"owner-1": [token(1)]},
            claim=AlwaysClaims([]),
            transport=transport,
        )
        self.assertEqual(transport.calls, [])
        self.assertEqual(result.skipped_by_reason, {SKIP_NO_SIGNALS: 1})
        self.assertEqual(result.sent, 0)

    def test_no_tokens_skips_without_claiming(self) -> None:
        log: list[str] = []
        claim = AlwaysClaims(log)
        transport = RecordingTransport()
        result = send_deal_alert_pushes(
            [deal(1)],
            tokens_by_owner={},
            claim=claim,
            transport=transport,
        )
        self.assertEqual(transport.calls, [])
        self.assertEqual(result.skipped_by_reason, {SKIP_NO_TOKENS: 1})
        # Nothing was claimed, so push_sent_at stays NULL and a later run retries.
        self.assertEqual(claim.claimed, [])

    def test_prefs_off_skips_without_claiming(self) -> None:
        claim = AlwaysClaims([])
        transport = RecordingTransport()
        result = send_deal_alert_pushes(
            [deal(1)],
            tokens_by_owner={"owner-1": [token(1)]},
            prefs_by_owner={"owner-1": False},
            claim=claim,
            transport=transport,
        )
        self.assertEqual(transport.calls, [])
        self.assertEqual(result.skipped_by_reason, {SKIP_PREFS_OFF: 1})
        self.assertEqual(claim.claimed, [])

    def test_absent_prefs_row_defaults_on(self) -> None:
        self.assertTrue(prefs_allow_deal_push(None, "owner-1"))
        self.assertTrue(prefs_allow_deal_push({}, "owner-1"))
        self.assertTrue(prefs_allow_deal_push({"other": False}, "owner-1"))
        self.assertTrue(
            prefs_allow_deal_push({"owner-1": {"deal_alerts_enabled": 1}}, "owner-1")
        )
        self.assertFalse(
            prefs_allow_deal_push({"owner-1": {"deal_alerts_enabled": 0}}, "owner-1")
        )

    def test_malformed_token_is_revoked_and_skipped(self) -> None:
        transport = RecordingTransport()
        result = send_deal_alert_pushes(
            [deal(1)],
            tokens_by_owner={"owner-1": ["not-a-token"]},
            claim=AlwaysClaims([]),
            transport=transport,
        )
        self.assertEqual(transport.calls, [])
        self.assertEqual(result.tokens_to_revoke, ("not-a-token",))
        self.assertEqual(result.skipped_by_reason[SKIP_INVALID_TOKEN], 1)
        self.assertEqual(result.skipped_by_reason[SKIP_NO_TOKENS], 1)

    def test_a_refused_claim_is_never_dispatched(self) -> None:
        log: list[str] = []
        claim = AlwaysClaims(log, refuse={"alert-1"})
        transport = RecordingTransport()
        result = send_deal_alert_pushes(
            [deal(1), deal(2)],
            tokens_by_owner={"owner-1": [token(1)], "owner-2": [token(2)]},
            claim=claim,
            transport=transport,
        )
        self.assertEqual(result.skipped_by_reason, {SKIP_ALREADY_SENT: 1})
        self.assertEqual(result.sent, 1)
        sent_tokens = [message["to"] for message in transport.calls[0][1]]
        self.assertEqual(sent_tokens, [token(2)])

    def test_every_claim_precedes_every_dispatch(self) -> None:
        """The at-most-once contract: push_sent_at is written and committed
        before a message reaches the wire, so a crash mid-send loses a push
        instead of duplicating one."""
        log: list[str] = []
        claim = AlwaysClaims(log)

        def transport(url: str, payload: Any) -> Any:
            log.append(f"post:{len(payload)}")
            return {"data": [{"status": "ok", "id": "t"} for _ in payload]}

        send_deal_alert_pushes(
            [deal(1), deal(2)],
            tokens_by_owner={"owner-1": [token(1)], "owner-2": [token(2)]},
            claim=claim,
            transport=transport,
        )
        self.assertEqual(log, ["claim:alert-1", "claim:alert-2", "post:2"])
        first_post = next(i for i, entry in enumerate(log) if entry.startswith("post"))
        self.assertTrue(all(entry.startswith("claim") for entry in log[:first_post]))

    def test_transport_failure_does_not_raise_into_the_scan_job(self) -> None:
        result = send_deal_alert_pushes(
            [deal(1)],
            tokens_by_owner={"owner-1": [token(1)]},
            claim=AlwaysClaims([]),
            transport=RecordingTransport(raises=OSError("dns")),
        )
        self.assertEqual(result.sent, 0)
        self.assertEqual(result.failed, 1)
        self.assertTrue(result.errors)


# --- ops lane ----------------------------------------------------------------


class TestOpsLane(unittest.TestCase):
    def ops(self, index: int = 1) -> OpsAlertPush:
        return OpsAlertPush(
            ops_alert_id=f"ops-{index}",
            headline="eBay budget at 75%",
            kind="watch_cost_stage",
            stage="Amber",
        )

    def test_ops_push_ignores_user_notification_prefs(self) -> None:
        """Structural, not behavioural: there is no prefs parameter to pass."""
        import inspect

        params = inspect.signature(send_ops_alert_pushes).parameters
        self.assertNotIn("prefs_by_owner", params)
        transport = RecordingTransport()
        result = send_ops_alert_pushes(
            [self.ops()],
            admin_tokens=[token(9)],
            claim=AlwaysClaims([]),
            transport=transport,
        )
        self.assertEqual(result.sent, 1)
        message = transport.calls[0][1][0]
        self.assertEqual(message["title"], OPS_PUSH_TITLE)
        self.assertEqual(message["body"], "eBay budget at 75% (Amber)")
        self.assertEqual(message["data"]["type"], "ops_alert")
        self.assertEqual(message["data"]["opsAlertId"], "ops-1")

    def test_no_admin_tokens_is_a_clean_skip(self) -> None:
        transport = RecordingTransport()
        result = send_ops_alert_pushes(
            [self.ops(), self.ops(2)],
            admin_tokens=[],
            claim=AlwaysClaims([]),
            transport=transport,
        )
        self.assertEqual(transport.calls, [])
        self.assertEqual(result.skipped_by_reason, {SKIP_NO_TOKENS: 2})

    def test_no_ops_alerts_sends_nothing(self) -> None:
        transport = RecordingTransport()
        result = send_ops_alert_pushes(
            [],
            admin_tokens=[token(9)],
            claim=AlwaysClaims([]),
            transport=transport,
        )
        self.assertEqual(transport.calls, [])
        self.assertEqual(result.skipped_by_reason, {SKIP_NO_SIGNALS: 1})

    def test_claim_refusal_blocks_the_ops_dispatch_too(self) -> None:
        transport = RecordingTransport()
        result = send_ops_alert_pushes(
            [self.ops()],
            admin_tokens=[token(9)],
            claim=AlwaysClaims([], refuse={"ops-1"}),
            transport=transport,
        )
        self.assertEqual(transport.calls, [])
        self.assertEqual(result.skipped_by_reason, {SKIP_ALREADY_SENT: 1})


# --- receipts ----------------------------------------------------------------


class TestReceipts(unittest.TestCase):
    def test_failed_receipt_prunes_the_token(self) -> None:
        transport = RecordingTransport(
            responses=[
                {
                    "data": {
                        "r1": {"status": "ok"},
                        "r2": {
                            "status": "error",
                            "message": "gone",
                            "details": {"error": ERROR_DEVICE_NOT_REGISTERED},
                        },
                        "r3": {
                            "status": "error",
                            "message": "transient",
                            "details": {"error": "MessageTooBig"},
                        },
                    }
                }
            ]
        )
        result = check_receipts(
            ["r1", "r2", "r3"],
            tokens_by_receipt_id={"r1": token(1), "r2": token(2), "r3": token(3)},
            transport=transport,
        )
        self.assertEqual(transport.calls[0][0], EXPO_RECEIPTS_URL)
        self.assertEqual(transport.calls[0][1], {"ids": ["r1", "r2", "r3"]})
        self.assertEqual((result.checked, result.ok, result.failed), (3, 1, 2))
        self.assertEqual(result.tokens_to_revoke, (token(2),))

    def test_receipt_not_yet_available_stays_pending(self) -> None:
        transport = RecordingTransport(responses=[{"data": {"r1": {"status": "ok"}}}])
        result = check_receipts(["r1", "r2"], transport=transport)
        self.assertEqual(result.checked, 1)
        self.assertEqual(result.pending, ("r2",))

    def test_empty_id_list_never_touches_the_transport(self) -> None:
        transport = RecordingTransport()
        result = check_receipts([], transport=transport)
        self.assertEqual(transport.calls, [])
        self.assertEqual(result.checked, 0)

    def test_receipts_chunk_at_a_thousand(self) -> None:
        transport = RecordingTransport()
        ids = [f"r{i}" for i in range(1001)]
        check_receipts(ids, transport=transport)
        self.assertEqual([len(p["ids"]) for _, p in transport.calls], [1000, 1])

    def test_transport_exception_returns_structured_failure(self) -> None:
        transport = RecordingTransport(raises=RuntimeError("tls"))
        result = check_receipts(["r1"], transport=transport)  # must not raise
        self.assertEqual(result.pending, ("r1",))
        self.assertTrue(result.errors)
        self.assertEqual(result.tokens_to_revoke, ())


class TestNoNetworkByDefault(unittest.TestCase):
    def test_default_transport_is_only_built_when_there_is_work(self) -> None:
        """Guard against an accidental real POST from a no-op run."""
        calls: list[Any] = []

        def exploding(*args: Any, **kwargs: Any) -> Any:
            calls.append(args)
            raise AssertionError("network transport must not be constructed")

        original = expo_push._default_transport
        expo_push._default_transport = exploding  # type: ignore[assignment]
        try:
            send_messages([])
            send_deal_alert_pushes([], tokens_by_owner={}, claim=lambda _: True)
            send_ops_alert_pushes([], admin_tokens=[], claim=lambda _: True)
            check_receipts([])
        finally:
            expo_push._default_transport = original  # type: ignore[assignment]
        self.assertEqual(calls, [])


if __name__ == "__main__":
    unittest.main()
