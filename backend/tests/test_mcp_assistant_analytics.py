"""Per-turn PostHog cost event: shape, env tag, and never blocking chat."""

from __future__ import annotations

import asyncio
import os
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from mcp_server.assistant.analytics import EVENT_TURN, TurnAnalytics  # noqa: E402


class TurnAnalyticsTests(unittest.TestCase):
    def test_payload_tags_environment(self) -> None:
        analytics = TurnAnalytics(api_key="phc_test", host="https://ph.example/", environment="staging")
        body = analytics.payload("user-1", {"cost_usd": 0.001})
        self.assertEqual(body["event"], EVENT_TURN)
        self.assertEqual(body["distinct_id"], "user-1")
        self.assertEqual(body["properties"], {"environment": "staging", "cost_usd": 0.001})

    def test_disabled_without_key(self) -> None:
        with mock.patch.dict(os.environ, {"ASSISTANT_POSTHOG_API_KEY": ""}, clear=False):
            analytics = TurnAnalytics.from_env()
        self.assertFalse(analytics.enabled)
        analytics.capture("user-1", {"cost_usd": 1})  # no-op, no error

    def test_env_config(self) -> None:
        env = {"ASSISTANT_POSTHOG_API_KEY": "phc_x", "ASSISTANT_ANALYTICS_ENV": "production"}
        with mock.patch.dict(os.environ, env, clear=False):
            analytics = TurnAnalytics.from_env()
        self.assertTrue(analytics.enabled)
        self.assertEqual(analytics.environment, "production")

    def test_send_failure_is_swallowed(self) -> None:
        analytics = TurnAnalytics(api_key="phc_test", host="http://127.0.0.1:9", environment="staging")

        async def run() -> None:
            analytics.capture("user-1", {"cost_usd": 0.001})
            await asyncio.gather(*list(analytics._tasks))

        asyncio.run(run())  # connection refused must not raise

    def test_capture_outside_event_loop_is_noop(self) -> None:
        analytics = TurnAnalytics(api_key="phc_test", host="https://ph.example", environment="staging")
        analytics.capture("user-1", {"cost_usd": 0.001})
        self.assertEqual(len(analytics._tasks), 0)


if __name__ == "__main__":
    unittest.main()
