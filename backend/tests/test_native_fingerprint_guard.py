from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from tools.native_fingerprint_guard import (
    Fingerprint,
    diff_sources,
    evaluate_build,
    evaluate_update,
    load_records,
    lookup_record,
    main,
    save_records,
    with_record,
)


def fp(hash_: str = "aaa", *, platform: str = "ios", rv: str = "0.1.2", sources: dict | None = None) -> Fingerprint:
    return Fingerprint(platform=platform, runtime_version=rv, hash=hash_, sources=sources or {"dir:x": "1"})


def seeded(fingerprint: Fingerprint, environment: str = "staging") -> dict:
    return with_record({}, environment, fingerprint, via="build", git_commit="abc", recorded_at="2026-09-24T00:00:00+00:00")


class EvaluateUpdateTests(unittest.TestCase):
    def test_matching_fingerprint_passes(self) -> None:
        decision = evaluate_update(seeded(fp("aaa")), "staging", fp("aaa"), allow_seed=False)
        self.assertTrue(decision.ok)
        self.assertEqual(decision.status, "match")

    def test_changed_fingerprint_blocks_and_lists_changed_sources(self) -> None:
        records = seeded(fp("aaa", sources={"dir:node_modules/expo-camera": "1", "file:eas.json": "2"}))
        current = fp("bbb", sources={"dir:node_modules/expo-camera": "9", "dir:node_modules/expo-sqlite": "3", "file:eas.json": "2"})
        decision = evaluate_update(records, "staging", current, allow_seed=True)
        self.assertFalse(decision.ok)
        self.assertEqual(decision.status, "mismatch")
        self.assertIn("Native code changed since the 0.1.2 build (fingerprint bbb != aaa)", decision.message)
        self.assertIn("Bump runtimeVersion in apps/spotlight-rn/app.config.js and ship a native build first.", decision.message)
        self.assertIn("+ added    dir:node_modules/expo-sqlite", decision.message)
        self.assertIn("~ changed  dir:node_modules/expo-camera", decision.message)
        self.assertNotIn("eas.json", decision.message)

    def test_missing_record_blocks_unless_seeding(self) -> None:
        blocked = evaluate_update({}, "staging", fp("aaa"), allow_seed=False)
        self.assertFalse(blocked.ok)
        self.assertEqual(blocked.status, "missing")
        self.assertIn("record --environment staging --platform ios", blocked.message)

        seeding = evaluate_update({}, "staging", fp("aaa"), allow_seed=True)
        self.assertTrue(seeding.ok)
        self.assertEqual(seeding.status, "seed")

    def test_records_are_scoped_by_environment_runtime_and_platform(self) -> None:
        records = seeded(fp("aaa"))
        self.assertEqual(evaluate_update(records, "production", fp("aaa"), allow_seed=False).status, "missing")
        self.assertEqual(evaluate_update(records, "staging", fp("aaa", rv="0.1.3"), allow_seed=False).status, "missing")
        self.assertEqual(evaluate_update(records, "staging", fp("aaa", platform="android"), allow_seed=False).status, "missing")


class EvaluateBuildTests(unittest.TestCase):
    def test_first_build_on_a_runtime_is_allowed(self) -> None:
        self.assertEqual(evaluate_build({}, "staging", fp("aaa"), allow_overwrite=False).status, "new")

    def test_rebuild_with_same_native_code_is_allowed(self) -> None:
        self.assertEqual(evaluate_build(seeded(fp("aaa")), "staging", fp("aaa"), allow_overwrite=False).status, "match")

    def test_different_native_code_on_existing_runtime_is_blocked_unless_overwrite(self) -> None:
        records = seeded(fp("aaa"))
        blocked = evaluate_build(records, "staging", fp("bbb"), allow_overwrite=False)
        self.assertFalse(blocked.ok)
        self.assertIn("Bump runtimeVersion", blocked.message)
        self.assertIn("SPOTLIGHT_NATIVE_FINGERPRINT_OVERWRITE=1", blocked.message)
        self.assertEqual(evaluate_build(records, "staging", fp("bbb"), allow_overwrite=True).status, "overwrite")


class RecordTests(unittest.TestCase):
    def test_with_record_does_not_mutate_input_and_keeps_siblings(self) -> None:
        original = seeded(fp("aaa"))
        snapshot = json.loads(json.dumps(original))
        updated = with_record(original, "staging", fp("ccc", platform="android"), via="seed", git_commit=None, recorded_at="t")
        self.assertEqual(original, snapshot)
        self.assertEqual(lookup_record(updated, "staging", "0.1.2", "ios")["hash"], "aaa")
        self.assertEqual(lookup_record(updated, "staging", "0.1.2", "android")["via"], "seed")

    def test_diff_sources_reports_removed(self) -> None:
        self.assertEqual(diff_sources({"a": "1", "b": "2"}, {"a": "1"}), ["  - removed  b"])

    def test_round_trip_and_record_cli_from_saved_file(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            records_path = Path(tmp) / "records.json"
            self.assertEqual(load_records(records_path), {})
            saved = Path(tmp) / "fp.json"
            saved.write_text(json.dumps(fp("aaa").to_json()), encoding="utf-8")
            common = ["--environment", "staging", "--platform", "ios", "--records", str(records_path), "--from-file", str(saved)]

            self.assertEqual(main(["record", *common, "--via", "build"]), 0)
            self.assertEqual(lookup_record(load_records(records_path), "staging", "0.1.2", "ios")["hash"], "aaa")

            # A different fingerprint on the same runtime needs --force (or the build path).
            saved.write_text(json.dumps(fp("bbb").to_json()), encoding="utf-8")
            self.assertEqual(main(["record", *common]), 1)
            self.assertEqual(main(["record", *common, "--force"]), 0)
            self.assertEqual(lookup_record(load_records(records_path), "staging", "0.1.2", "ios")["hash"], "bbb")

            save_records(records_path, {})
            self.assertEqual(json.loads(records_path.read_text(encoding="utf-8")), {})


if __name__ == "__main__":
    unittest.main()
