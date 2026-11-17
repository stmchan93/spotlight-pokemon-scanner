"""Keep batch-job write transactions short and yield between them.

SQLite gives writers no fairness: a sync that commits and immediately re-takes
the write lock starves the backend's writers (busy_timeout 5s) and litestream's
checkpoint. Batch jobs commit through a WriteTxnPacer instead: commit once the
open transaction is older than a time budget, then sleep briefly so waiters get
in. Hold time is measured from the first `maybe_commit`/`mark_write` that sees
an open transaction, so it slightly under-counts the first statement.
"""

from __future__ import annotations

import os
import sqlite3
import time
from typing import Any, Callable


def _env_ms(name: str, default: float) -> float:
    raw = str(os.environ.get(name) or "").strip()
    try:
        return max(0.0, float(raw)) if raw else default
    except ValueError:
        return default


class WriteTxnPacer:
    def __init__(
        self,
        connection: sqlite3.Connection,
        *,
        budget_ms: float | None = None,
        yield_ms: float | None = None,
        clock: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self.connection = connection
        self.budget_s = (
            _env_ms("SPOTLIGHT_SYNC_TXN_BUDGET_MS", 250.0) if budget_ms is None else budget_ms
        ) / 1000.0
        self.yield_s = (
            _env_ms("SPOTLIGHT_SYNC_TXN_YIELD_MS", 75.0) if yield_ms is None else yield_ms
        ) / 1000.0
        self._clock = clock
        self._sleep = sleep
        self._txn_started_at: float | None = None
        self.commits = 0
        self.total_hold_s = 0.0
        self.longest_txn_s = 0.0

    def mark_write(self) -> None:
        """Call right before a write to start the hold clock accurately."""
        if self._txn_started_at is None:
            self._txn_started_at = self._clock()

    def maybe_commit(self, *, force: bool = False) -> bool:
        """Commit (and yield) when the open txn is over budget or `force`."""
        if not self.connection.in_transaction:
            self._txn_started_at = None
            return False
        if self._txn_started_at is None:
            self._txn_started_at = self._clock()
        if not force and self._clock() - self._txn_started_at < self.budget_s:
            return False
        self.commit()
        return True

    def commit(self, *, yield_after: bool = True) -> None:
        """Commit now (no-op without an open txn), record the hold, then yield."""
        started = self._txn_started_at
        self._txn_started_at = None
        if not self.connection.in_transaction:
            return
        self.connection.commit()
        held = max(0.0, self._clock() - started) if started is not None else 0.0
        self.commits += 1
        self.total_hold_s += held
        self.longest_txn_s = max(self.longest_txn_s, held)
        if yield_after and self.yield_s > 0:
            self._sleep(self.yield_s)

    def stats(self) -> dict[str, Any]:
        return {
            "write_txns": self.commits,
            "write_lock_hold_ms": round(self.total_hold_s * 1000.0, 1),
            "longest_txn_ms": round(self.longest_txn_s * 1000.0, 1),
        }
