from __future__ import annotations

import sys
import types
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1].parent
TOOLS_ROOT = REPO_ROOT / "tools"
if str(TOOLS_ROOT) not in sys.path:
    sys.path.insert(0, str(TOOLS_ROOT))

try:
    from import_confirmed_scans_to_training import assign_tier  # noqa: E402
    from export_scan_training_rows import deduplicate_bursts  # noqa: E402
    _IMPORT_ERROR: Exception | None = None
except Exception as exc:  # pragma: no cover - host dependency fallback
    assign_tier = None  # type: ignore[assignment]
    deduplicate_bursts = None  # type: ignore[assignment]
    _IMPORT_ERROR = exc


@unittest.skipIf(_IMPORT_ERROR is not None, f"scan-training bridge deps unavailable: {_IMPORT_ERROR}")
class AssignTierTests(unittest.TestCase):
    def test_deterministic_for_same_provider_and_batch(self) -> None:
        a = assign_tier("me3-60", "batch-1", 20, {})
        b = assign_tier("me3-60", "batch-1", 20, {})
        self.assertEqual(a, b)
        self.assertIn(a[0], {"tier2", "tier3"})
        self.assertTrue(a[1])  # newly assigned

    def test_existing_registry_tier_is_reused_never_reassigned(self) -> None:
        # Even with a tier2_pct that would hash differently, an existing entry wins.
        provider_cards = {"me3-60": {"tier": "tier2"}}
        tier, is_new = assign_tier("me3-60", "any-batch", 20, provider_cards)
        self.assertEqual(tier, "tier2")
        self.assertFalse(is_new)

    def test_tier2_pct_bounds_routing(self) -> None:
        # pct=0 => everything Tier 3; pct=100 => everything Tier 2.
        self.assertEqual(assign_tier("x-1", "b", 0, {})[0], "tier3")
        self.assertEqual(assign_tier("x-1", "b", 100, {})[0], "tier2")

    def test_split_is_stable_across_a_population(self) -> None:
        ids = [f"set-{i}" for i in range(400)]
        first = {i: assign_tier(i, "batch-7", 20, {})[0] for i in ids}
        second = {i: assign_tier(i, "batch-7", 20, {})[0] for i in ids}
        self.assertEqual(first, second)
        tier2 = sum(1 for t in first.values() if t == "tier2")
        # ~20% reserved for Tier 2; allow a wide band so the test isn't flaky.
        self.assertTrue(0.10 <= tier2 / len(ids) <= 0.30, f"tier2 share {tier2/len(ids):.2f}")


@unittest.skipIf(_IMPORT_ERROR is not None, f"scan-training bridge deps unavailable: {_IMPORT_ERROR}")
class DeduplicateBurstsTests(unittest.TestCase):
    @staticmethod
    def _row(scan_id: str, owner: str, predicted: str, created_at: str) -> dict[str, str]:
        return {
            "scan_id": scan_id,
            "owner_user_id": owner,
            "predicted_card_id": predicted,
            "created_at": created_at,
        }

    def test_drops_same_owner_card_within_window(self) -> None:
        rows = [
            self._row("s1", "u1", "me3-60", "2026-05-24T10:00:00Z"),
            self._row("s2", "u1", "me3-60", "2026-05-24T10:00:03Z"),  # within 5s -> dropped
            self._row("s3", "u1", "me3-60", "2026-05-24T10:00:30Z"),  # outside window -> kept
            self._row("s4", "u2", "me3-60", "2026-05-24T10:00:03Z"),  # different owner -> kept
            self._row("s5", "u1", "xy1-1", "2026-05-24T10:00:04Z"),   # different card -> kept
        ]
        kept, dropped = deduplicate_bursts(rows)
        kept_ids = {r["scan_id"] for r in kept}
        self.assertEqual(kept_ids, {"s1", "s3", "s4", "s5"})
        self.assertEqual([d["scanID"] for d in dropped], ["s2"])


if __name__ == "__main__":
    unittest.main()
