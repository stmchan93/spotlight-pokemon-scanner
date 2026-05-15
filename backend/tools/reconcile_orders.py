"""Reconcile pending Stripe orders that may have missed their webhook.

For each row in `orders` with status `pending` older than --threshold-minutes,
fetch the Stripe Checkout Session and re-run the standard webhook handler if
Stripe says the session is paid or expired. This guards against the case where
Stripe's webhook delivery to our backend was flaky or our backend was down
during a retry window — `Risks #6` in
`docs/payments-mvp-plan-2026-05-15.md`.

Intended cron line (every 5 minutes):

    */5 * * * * cd /opt/spotlight \\
        && /opt/spotlight/.venv/bin/python backend/tools/reconcile_orders.py

CLI:

    python3 backend/tools/reconcile_orders.py [--dry-run] [--threshold-minutes 10]

The script is intentionally a thin CLI shim around
`StripePaymentsService.reconcile_pending_order` so that any future changes to
the webhook flow are picked up here automatically.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import traceback
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from server import (  # noqa: E402  (path setup above)
    SpotlightScanService,
    StripePaymentsService,
    bootstrap_backend,
)
from request_auth import RequestIdentity  # noqa: E402


def _service_identity() -> RequestIdentity:
    return RequestIdentity(user_id="reconcile-cron", auth_source="service_fallback")


def _iso_threshold(threshold_minutes: int) -> str:
    now = datetime.now(timezone.utc)
    cutoff = now - timedelta(minutes=max(1, int(threshold_minutes)))
    # utc_now() formatting is "YYYY-MM-DDTHH:MM:SS.ffffffZ"-ish; strftime
    # produces a comparable ISO string for the SQL `<=` query.
    return cutoff.strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def reconcile(
    *,
    dry_run: bool,
    threshold_minutes: int,
    database_path_override: str | None = None,
) -> dict[str, Any]:
    backend_root = BACKEND_ROOT
    repo_root = backend_root.parent
    database_path = bootstrap_backend(
        backend_root,
        database_path_override=database_path_override
        or os.environ.get("SPOTLIGHT_DATABASE_PATH"),
    )
    scan_service = SpotlightScanService(database_path, repo_root)
    payments = StripePaymentsService(scan_service)

    cutoff = _iso_threshold(threshold_minutes)
    results: list[dict[str, Any]] = []

    with scan_service.request_identity_context(_service_identity()):
        stale = payments.list_stale_pending_orders(older_than_iso=cutoff)
        for entry in stale:
            order_id = entry["orderID"]
            try:
                outcome = payments.reconcile_pending_order(order_id, dry_run=dry_run)
            except Exception as error:  # noqa: BLE001
                traceback.print_exc()
                outcome = {
                    "orderID": order_id,
                    "action": "error",
                    "error": f"{type(error).__name__}: {error}",
                }
            results.append(outcome)

    summary = {
        "cutoff": cutoff,
        "dryRun": dry_run,
        "totalCandidates": len(stale),
        "results": results,
    }
    print(json.dumps(summary, separators=(",", ":"), default=str))
    return summary


def _build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Reconcile pending Stripe orders")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Look up sessions but do not modify state.",
    )
    parser.add_argument(
        "--threshold-minutes",
        type=int,
        default=10,
        help="Only reconcile orders older than this many minutes (default 10).",
    )
    parser.add_argument(
        "--database-path",
        type=str,
        default=None,
        help="Override the backend SQLite database path (defaults to env or backend default).",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _build_arg_parser().parse_args(argv)
    reconcile(
        dry_run=bool(args.dry_run),
        threshold_minutes=int(args.threshold_minutes),
        database_path_override=args.database_path,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
