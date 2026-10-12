"""tcgcsv_price_sync_health: the VM health check fails (and withholds the
dead-man's-switch ping) when the daily TCGplayer price sync has not succeeded
within the window, so a silently dead sync can't leave prices frozen."""
from __future__ import annotations

import os
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from catalog_tools import (  # noqa: E402
    PROVIDER_SYNC_STATUS_SUCCEEDED,
    apply_schema,
    connect,
    start_provider_sync_run,
    tcgcsv_price_sync_health,
    update_provider_sync_run,
)

ENABLED = {"TCGCSV_SYNC_ENABLED": "1"}


def _iso(hours_ago: float) -> str:
    return (datetime.now(timezone.utc) - timedelta(hours=hours_ago)).isoformat()


class TcgcsvPriceSyncHealthTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.connection = connect(Path(self.tempdir.name) / "health.sqlite")
        self.addCleanup(self.connection.close)
        apply_schema(self.connection, BACKEND_ROOT / "schema.sql")

    def _run(self, *, status: str, completed_hours_ago: float | None) -> None:
        run_id = start_provider_sync_run(
            self.connection, provider="tcgcsv", sync_scope="raw-main", page_size=0, scheduled_for=None,
        )
        update_provider_sync_run(
            self.connection,
            run_id,
            status=status,
            completed_at=_iso(completed_hours_ago) if completed_hours_ago is not None else None,
        )
        self.connection.commit()

    def test_recent_success_is_fresh(self):
        self._run(status=PROVIDER_SYNC_STATUS_SUCCEEDED, completed_hours_ago=3)
        with patch.dict(os.environ, ENABLED):
            health = tcgcsv_price_sync_health(self.connection)
        self.assertTrue(health["fresh"])
        self.assertAlmostEqual(health["hoursSinceSuccess"], 3, delta=0.2)

    def test_missed_day_is_stale(self):
        self._run(status=PROVIDER_SYNC_STATUS_SUCCEEDED, completed_hours_ago=40)
        with patch.dict(os.environ, ENABLED):
            self.assertFalse(tcgcsv_price_sync_health(self.connection)["fresh"])

    def test_never_succeeded_is_stale(self):
        self._run(status="failed", completed_hours_ago=1)
        with patch.dict(os.environ, ENABLED):
            health = tcgcsv_price_sync_health(self.connection)
        self.assertFalse(health["fresh"])
        self.assertIsNone(health["lastSucceededAt"])

    def test_in_flight_run_does_not_mask_recent_success(self):
        self._run(status=PROVIDER_SYNC_STATUS_SUCCEEDED, completed_hours_ago=20)
        self._run(status="running", completed_hours_ago=None)
        with patch.dict(os.environ, ENABLED):
            self.assertTrue(tcgcsv_price_sync_health(self.connection)["fresh"])

    def test_disabled_sync_never_alarms(self):
        with patch.dict(os.environ, {"TCGCSV_SYNC_ENABLED": "0"}):
            self.assertTrue(tcgcsv_price_sync_health(self.connection)["fresh"])


if __name__ == "__main__":
    unittest.main()
