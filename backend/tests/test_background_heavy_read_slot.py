"""Background warming yields the disk to anyone actually using the app.

`prewarm_portfolio_dashboards` ran its cold reads OUTSIDE the heavy-read
semaphore, so on a 2-core box it could have a read in flight while both user
slots were also busy — three concurrent readers thrashing one disk, with users
queueing on a 3s acquire and getting "The server is busy right now. Please try
again." That is what a production redeploy looked like from the app (user,
2026-09-11).

The slot it takes now is NON-BLOCKING on purpose: a user's acquire waits up to
3s, and warming must never be the thing it waits behind. A skipped section is
warmed by the first real request anyway — the cost lands on one request instead
of on everyone.
"""

from __future__ import annotations

import sys
import threading
import unittest
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

import server  # noqa: E402


class BackgroundHeavyReadSlotTests(unittest.TestCase):
    def setUp(self) -> None:
        self._original = server._heavy_read_semaphore
        self.addCleanup(self._restore)

    def _restore(self) -> None:
        server._heavy_read_semaphore = self._original

    def test_takes_a_slot_when_one_is_free_and_releases_it(self) -> None:
        server._heavy_read_semaphore = threading.BoundedSemaphore(2)

        with server._background_heavy_read_slot() as granted:
            self.assertTrue(granted)
            # Held: only one of the two slots is left.
            self.assertTrue(server._heavy_read_semaphore.acquire(blocking=False))
            server._heavy_read_semaphore.release()

        # Released on exit — both slots are back.
        self.assertTrue(server._heavy_read_semaphore.acquire(blocking=False))
        self.assertTrue(server._heavy_read_semaphore.acquire(blocking=False))

    def test_declines_rather_than_queueing_when_users_hold_every_slot(self) -> None:
        server._heavy_read_semaphore = threading.BoundedSemaphore(1)
        self.assertTrue(server._heavy_read_semaphore.acquire(blocking=False))

        # attempts=1 so the test doesn't sit through the real retry window; the
        # behaviour under test is that it GIVES UP instead of blocking a user.
        with server._background_heavy_read_slot(attempts=1) as granted:
            self.assertFalse(granted)

    def test_a_declined_slot_is_never_released_back(self) -> None:
        # Releasing a slot it never took would raise the ceiling for everyone —
        # BoundedSemaphore turns that into a ValueError, so prove it cannot.
        server._heavy_read_semaphore = threading.BoundedSemaphore(1)
        self.assertTrue(server._heavy_read_semaphore.acquire(blocking=False))

        with server._background_heavy_read_slot(attempts=1) as granted:
            self.assertFalse(granted)

        server._heavy_read_semaphore.release()
        with self.assertRaises(ValueError):
            server._heavy_read_semaphore.release()

    def test_retries_briefly_so_a_momentary_spike_does_not_skip_the_warm(self) -> None:
        server._heavy_read_semaphore = threading.BoundedSemaphore(1)
        self.assertTrue(server._heavy_read_semaphore.acquire(blocking=False))

        # A "user" finishes just after the first try fails.
        threading.Timer(0.05, server._heavy_read_semaphore.release).start()

        with server._background_heavy_read_slot(attempts=6, retry_wait_s=0.05) as granted:
            self.assertTrue(granted)


if __name__ == "__main__":
    unittest.main()
