#!/usr/bin/env python3
"""Daily post-show booth recaps (docs/booth-posts-vendor-spec-2026-10-29.md).

Finds shows that ended yesterday (in each show's timezone, with a short
lookback for missed ticks) and calls Supabase `send_booth_recaps` for each with
the service role. Idempotent: the SQL skips any claimer already recapped for
that show, so re-running is safe.

    python3 backend/send_booth_recaps.py                 # cron
    python3 backend/send_booth_recaps.py --event <id>    # one show, by hand
    python3 backend/send_booth_recaps.py --dry-run
"""

from __future__ import annotations

import argparse
import logging
import sqlite3
import sys
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parent
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

import booth_admin  # noqa: E402
import spotlight_events  # noqa: E402
import spotlight_events_admin  # noqa: E402

log = logging.getLogger("send_booth_recaps")


def run(*, event_id: str | None = None, dry_run: bool = False) -> int:
    """Recaps sent. Shows that fail are logged and skipped so one bad show can't block the rest."""
    if event_id:
        events = [e for e in spotlight_events.load_events(include_hidden=True) if e["id"] == event_id]
        if not events:
            log.error("unknown event %s", event_id)
            return 0
    else:
        events = booth_admin.recap_due_events()
    if not events:
        log.info("no shows ended yesterday")
        return 0
    total = 0
    for event in events:
        name = booth_admin.event_name(event)
        if dry_run:
            log.info("dry run: would send recaps for %s (%s)", event["id"], name)
            continue
        try:
            sent = booth_admin.send_recaps(event["id"], name)
        except booth_admin.BoothAdminError as error:
            log.error("recaps for %s failed: %s", event["id"], error)
            continue
        log.info("recaps for %s (%s): %d sent", event["id"], name, sent)
        total += sent
    return total


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--event", help="send for this show id instead of the ones that ended yesterday")
    parser.add_argument("--database-path", help="SQLite path, for shows added or edited in /admin/events")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")

    if not args.dry_run and not booth_admin.configured():
        # Same greppable shape as the moderation worker; exit 0 so cron doesn't mail.
        log.warning("booth recaps disabled: missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY")
        return 0
    if args.database_path and Path(args.database_path).exists():
        database_path = args.database_path
        spotlight_events.configure_admin(
            spotlight_events_admin.EventsAdmin(lambda: sqlite3.connect(database_path))
        )
    run(event_id=args.event, dry_run=args.dry_run)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
