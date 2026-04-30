from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path


TESTS_ROOT = Path(__file__).resolve().parent
BACKEND_ROOT = TESTS_ROOT.parent
REPO_ROOT = BACKEND_ROOT.parent

if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from tools.raw_visual_release_gate import (  # noqa: E402
    evaluate_release_gate,
    infer_suite_name,
    load_inferred_scorecards,
)


class RawVisualReleaseGateTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.root = Path(self.tempdir.name)

    def tearDown(self) -> None:
        self.tempdir.cleanup()

    def _fixture_roots(self, suite_name: str) -> list[str]:
        if suite_name == "legacy":
            return [str(REPO_ROOT / "qa" / "raw-footer-layout-check")]
        if suite_name == "expansion":
            return [str(Path.home() / "spotlight-datasets" / "raw-visual-expansion-holdouts")]
        if suite_name == "mixed":
            return [
                str(REPO_ROOT / "qa" / "raw-footer-layout-check"),
                str(Path.home() / "spotlight-datasets" / "raw-visual-expansion-holdouts"),
            ]
        raise AssertionError(f"unexpected suite {suite_name}")

    def _scorecard(
        self,
        suite_name: str,
        *,
        visual_top1: int = 10,
        visual_top5: int = 12,
        visual_top10: int = 14,
        hybrid_top1: int = 11,
        hybrid_top5: int = 13,
        supported: int = 20,
        unsupported: int = 0,
        top_k: int = 10,
    ) -> dict[str, object]:
        return {
            "fixtureRoots": self._fixture_roots(suite_name),
            "topK": top_k,
            "providerSupportedFixtureCount": supported,
            "providerUnsupportedFixtureCount": unsupported,
            "visualTop1PassCount": visual_top1,
            "visualTop5ContainsTruthCount": visual_top5,
            "visualTop10ContainsTruthCount": visual_top10,
            "hybridTop1PassCount": hybrid_top1,
            "hybridTop5ContainsTruthCount": hybrid_top5,
        }

    def _scorecard_set(self, **overrides: dict[str, int]) -> dict[str, dict[str, object]]:
        payloads: dict[str, dict[str, object]] = {}
        for suite_name in ("legacy", "expansion", "mixed"):
            payload = self._scorecard(suite_name)
            payload.update(overrides.get(suite_name, {}))
            payloads[suite_name] = payload
        return payloads

    def _write_scorecard(self, file_name: str, payload: dict[str, object]) -> Path:
        path = self.root / file_name
        path.write_text(json.dumps(payload, indent=2) + "\n")
        return path

    def test_infers_legacy_expansion_and_mixed_suites_from_fixture_roots(self) -> None:
        legacy_path = self._write_scorecard("legacy.json", self._scorecard("legacy"))
        expansion_path = self._write_scorecard("expansion.json", self._scorecard("expansion"))
        mixed_path = self._write_scorecard("mixed.json", self._scorecard("mixed"))

        loaded = load_inferred_scorecards([legacy_path, expansion_path, mixed_path])

        self.assertEqual(sorted(loaded.keys()), ["expansion", "legacy", "mixed"])
        self.assertEqual(infer_suite_name(loaded["legacy"], path=legacy_path), "legacy")
        self.assertEqual(infer_suite_name(loaded["expansion"], path=expansion_path), "expansion")
        self.assertEqual(infer_suite_name(loaded["mixed"], path=mixed_path), "mixed")

    def test_release_gate_passes_with_primary_improvement_and_no_regressions(self) -> None:
        active = self._scorecard_set()
        candidate = self._scorecard_set(
            mixed={
                "visualTop10ContainsTruthCount": 15,
                "hybridTop1PassCount": 12,
            }
        )

        decision = evaluate_release_gate(
            active_scorecards=active,
            candidate_scorecards=candidate,
        )

        self.assertTrue(decision["passed"])
        self.assertEqual(decision["decision"], "promote")
        self.assertEqual(decision["failureCount"] if "failureCount" in decision else decision["summary"]["failureCount"], 0)
        self.assertIn("mixed: visualTop10ContainsTruthCount improved by +1", decision["primaryImprovementReasons"])
        self.assertIn("mixed: hybridTop1PassCount improved by +1", decision["primaryImprovementReasons"])

    def test_release_gate_fails_on_any_metric_regression(self) -> None:
        active = self._scorecard_set()
        candidate = self._scorecard_set(
            expansion={
                "hybridTop1PassCount": 12,
                "visualTop5ContainsTruthCount": 11,
            }
        )

        decision = evaluate_release_gate(
            active_scorecards=active,
            candidate_scorecards=candidate,
        )

        self.assertFalse(decision["passed"])
        self.assertEqual(decision["decision"], "reject")
        self.assertTrue(
            any("expansion: visualTop5ContainsTruthCount regressed by -1" in reason for reason in decision["failureReasons"])
        )

    def test_release_gate_fails_without_primary_improvement(self) -> None:
        active = self._scorecard_set()
        candidate = self._scorecard_set(
            legacy={
                "visualTop1PassCount": 11,
            }
        )

        decision = evaluate_release_gate(
            active_scorecards=active,
            candidate_scorecards=candidate,
        )

        self.assertFalse(decision["passed"])
        self.assertTrue(
            any("No primary improvement found" in reason for reason in decision["failureReasons"])
        )
        self.assertEqual(decision["summary"]["primaryImprovementCount"], 0)

    def test_release_gate_fails_on_fixture_count_or_topk_mismatch(self) -> None:
        active = self._scorecard_set()
        candidate = self._scorecard_set(
            legacy={
                "providerSupportedFixtureCount": 19,
            },
            mixed={
                "topK": 20,
                "hybridTop1PassCount": 12,
            },
        )

        decision = evaluate_release_gate(
            active_scorecards=active,
            candidate_scorecards=candidate,
        )

        self.assertFalse(decision["passed"])
        self.assertTrue(
            any("legacy: providerSupportedFixtureCount mismatch active=20 candidate=19" in reason for reason in decision["failureReasons"])
        )
        self.assertTrue(
            any("mixed: candidate topK must stay 10, got 20" in reason for reason in decision["failureReasons"])
        )


if __name__ == "__main__":
    unittest.main()
