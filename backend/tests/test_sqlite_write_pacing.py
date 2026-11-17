"""Batch-job write pacing (sqlite_write_pacing) and the WAL autocheckpoint env."""

from __future__ import annotations

import os
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from catalog_tools import apply_schema, connect  # noqa: E402
from sealed_products import upsert_sealed_products  # noqa: E402
from sqlite_write_pacing import WriteTxnPacer  # noqa: E402


class FakeClock:
    def __init__(self) -> None:
        self.now = 0.0
        self.sleeps: list[float] = []

    def __call__(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        self.now += seconds


class WriteTxnPacerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.connection = sqlite3.connect(":memory:")
        self.connection.execute("CREATE TABLE t (v INTEGER)")
        self.connection.commit()
        self.clock = FakeClock()

    def tearDown(self) -> None:
        self.connection.close()

    def _pacer(self, **kwargs: float) -> WriteTxnPacer:
        return WriteTxnPacer(
            self.connection, budget_ms=kwargs.get("budget_ms", 250), yield_ms=kwargs.get("yield_ms", 75),
            clock=self.clock, sleep=self.clock.sleep,
        )

    def _write(self, pacer: WriteTxnPacer, cost_s: float) -> None:
        pacer.mark_write()
        self.connection.execute("INSERT INTO t VALUES (1)")
        self.clock.now += cost_s

    def test_commits_once_budget_is_spent_and_yields(self) -> None:
        pacer = self._pacer()
        committed = []
        for _ in range(10):
            self._write(pacer, 0.1)
            committed.append(pacer.maybe_commit())
        # 0.1s per write, 0.25s budget: commit on every 3rd write.
        self.assertEqual(committed, [False, False, True] * 3 + [False])
        self.assertEqual(self.clock.sleeps, [0.075] * 3)
        self.assertTrue(self.connection.in_transaction)
        pacer.commit(yield_after=False)
        self.assertFalse(self.connection.in_transaction)
        stats = pacer.stats()
        self.assertEqual(stats["write_txns"], 4)
        self.assertAlmostEqual(stats["longest_txn_ms"], 300.0, places=3)
        self.assertAlmostEqual(stats["write_lock_hold_ms"], 1000.0, places=3)
        self.assertEqual(self.connection.execute("SELECT COUNT(*) FROM t").fetchone()[0], 10)

    def test_force_commits_under_budget(self) -> None:
        pacer = self._pacer()
        self._write(pacer, 0.01)
        self.assertTrue(pacer.maybe_commit(force=True))
        self.assertFalse(self.connection.in_transaction)

    def test_no_open_txn_is_a_noop(self) -> None:
        pacer = self._pacer()
        self.assertFalse(pacer.maybe_commit(force=True))
        pacer.commit()
        self.assertEqual(self.clock.sleeps, [])
        self.assertEqual(pacer.stats()["write_txns"], 0)

    def test_env_defaults(self) -> None:
        with mock.patch.dict(os.environ, {"SPOTLIGHT_SYNC_TXN_BUDGET_MS": "100", "SPOTLIGHT_SYNC_TXN_YIELD_MS": "bad"}):
            pacer = WriteTxnPacer(self.connection)
        self.assertAlmostEqual(pacer.budget_s, 0.1)
        self.assertAlmostEqual(pacer.yield_s, 0.075)

    def test_sealed_upsert_commits_between_rows_with_a_pacer(self) -> None:
        with tempfile.TemporaryDirectory() as tempdir:
            path = Path(tempdir) / "sealed.sqlite"
            connection = connect(path)
            apply_schema(connection, BACKEND_ROOT / "schema.sql")
            connection.commit()
            pacer = WriteTxnPacer(connection, budget_ms=0, yield_ms=0)
            rows = [
                (3, {"groupId": 1, "name": "Base Set"},
                 {"productId": 1000 + i, "name": f"Base Set Booster Box {i}", "extendedData": []})
                for i in range(5)
            ]
            stats = upsert_sealed_products(connection, rows, pacer=pacer)
            pacer.commit(yield_after=False)
            count = connection.execute("SELECT COUNT(*) FROM cards").fetchone()[0]
            connection.close()
        self.assertEqual(stats["upserted"], count)
        if stats["upserted"]:
            self.assertGreaterEqual(pacer.commits, stats["upserted"])


class WalAutocheckpointEnvTests(unittest.TestCase):
    def _autocheckpoint(self, env: dict[str, str]) -> int:
        with tempfile.TemporaryDirectory() as tempdir, mock.patch.dict(os.environ, env, clear=False):
            if "SPOTLIGHT_SQLITE_WAL_AUTOCHECKPOINT" not in env:
                os.environ.pop("SPOTLIGHT_SQLITE_WAL_AUTOCHECKPOINT", None)
            connection = connect(Path(tempdir) / "wal.sqlite")
            try:
                return int(connection.execute("PRAGMA wal_autocheckpoint").fetchone()[0])
            finally:
                connection.close()

    def test_default_is_unchanged(self) -> None:
        self.assertEqual(self._autocheckpoint({}), 1000)

    def test_zero_disables_for_litestream(self) -> None:
        self.assertEqual(self._autocheckpoint({"SPOTLIGHT_SQLITE_WAL_AUTOCHECKPOINT": "0"}), 0)

    def test_custom_and_invalid_values(self) -> None:
        self.assertEqual(self._autocheckpoint({"SPOTLIGHT_SQLITE_WAL_AUTOCHECKPOINT": "4000"}), 4000)
        self.assertEqual(self._autocheckpoint({"SPOTLIGHT_SQLITE_WAL_AUTOCHECKPOINT": "nope"}), 1000)


if __name__ == "__main__":
    unittest.main()
