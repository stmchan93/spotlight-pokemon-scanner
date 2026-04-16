from __future__ import annotations

import unittest
from datetime import datetime, timezone
from pathlib import Path
import sys
from zoneinfo import ZoneInfo

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from vm_sync_schedule import cron_matches, should_run_now


class VMSyncScheduleTests(unittest.TestCase):
    def test_cron_matches_daily_local_time(self) -> None:
        dt = datetime(2026, 4, 15, 3, 0, tzinfo=ZoneInfo("America/Los_Angeles"))
        self.assertTrue(cron_matches(dt, "0 3 * * *"))
        self.assertFalse(cron_matches(dt.replace(minute=1), "0 3 * * *"))

    def test_cron_matches_day_of_week_or_day_of_month_semantics(self) -> None:
        monday = datetime(2026, 4, 20, 3, 0, tzinfo=ZoneInfo("America/Los_Angeles"))
        self.assertTrue(cron_matches(monday, "0 3 1 * 1"))

    def test_should_run_now_respects_timezone(self) -> None:
        utc_now = datetime(2026, 4, 15, 10, 0, tzinfo=timezone.utc)
        self.assertTrue(
            should_run_now(
                "0 3 * * *",
                "America/Los_Angeles",
                now_utc=utc_now,
            )
        )
        self.assertFalse(
            should_run_now(
                "0 3 * * *",
                "America/Los_Angeles",
                now_utc=utc_now.replace(hour=11),
            )
        )


if __name__ == "__main__":
    unittest.main()
