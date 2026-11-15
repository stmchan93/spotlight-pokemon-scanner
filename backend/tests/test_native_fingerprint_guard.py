from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from tools.native_fingerprint_guard import (
    APP_DIR,
    FINGERPRINT_SCRIPT,
    LEGACY_FINGERPRINT_METHOD,
    ROOT,
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


def fp(
    hash_: str = "aaa", *, platform: str = "ios", rv: str = "0.1.2", sources: dict | None = None, method: int = 2
) -> Fingerprint:
    return Fingerprint(platform=platform, runtime_version=rv, hash=hash_, sources=sources or {"dir:x": "1"}, method=method)


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


class MethodVersionTests(unittest.TestCase):
    def legacy_records(self) -> dict:
        # Shape of the records written before `method` existed.
        records = seeded(fp("aaa", rv="1.3.2"), environment="production")
        del records["production"]["1.3.2"]["ios"]["method"]
        return records

    def test_legacy_record_reads_as_method_1(self) -> None:
        record = lookup_record(self.legacy_records(), "production", "1.3.2", "ios")
        self.assertNotIn("method", record)
        legacy_payload = {"platform": "ios", "runtimeVersion": "1", "hash": "h"}
        self.assertEqual(Fingerprint.from_json(legacy_payload).method, LEGACY_FINGERPRINT_METHOD)

    def test_update_against_older_method_says_rerecord_not_native_changed(self) -> None:
        decision = evaluate_update(self.legacy_records(), "production", fp("bbb", rv="1.3.2"), allow_seed=True)
        self.assertFalse(decision.ok)
        self.assertEqual(decision.status, "method-mismatch")
        self.assertNotIn("Native code changed", decision.message)
        self.assertIn("fingerprint method 1; this tool uses method 2", decision.message)
        self.assertIn("says NOTHING about whether native code changed", decision.message)
        self.assertIn("Re-record it via `record --force` at the build's commit (abc)", decision.message)
        self.assertIn("worktree add /tmp/fp-production-1.3.2-ios abc", decision.message)
        self.assertIn(
            "record --environment production --platform ios --resolve-env --via build --force", decision.message
        )
        self.assertIn(".env.production", decision.message)

    def test_same_hash_but_different_method_is_still_not_a_match(self) -> None:
        decision = evaluate_update(self.legacy_records(), "production", fp("aaa", rv="1.3.2"), allow_seed=False)
        self.assertEqual(decision.status, "method-mismatch")

    def test_build_against_older_method_blocks_unless_overwrite(self) -> None:
        records = self.legacy_records()
        blocked = evaluate_build(records, "production", fp("bbb", rv="1.3.2"), allow_overwrite=False)
        self.assertEqual(blocked.status, "method-mismatch")
        self.assertIn("record --force", blocked.message)
        allowed = evaluate_build(records, "production", fp("bbb", rv="1.3.2"), allow_overwrite=True)
        self.assertEqual(allowed.status, "overwrite")

    def test_record_force_replaces_legacy_record_with_method(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            records_path = Path(tmp) / "records.json"
            save_records(records_path, self.legacy_records())
            saved = Path(tmp) / "fp.json"
            saved.write_text(json.dumps(fp("bbb", rv="1.3.2").to_json()), encoding="utf-8")
            common = ["--environment", "production", "--platform", "ios", "--records", str(records_path),
                      "--from-file", str(saved)]
            self.assertEqual(main(["record", *common]), 1)
            self.assertEqual(main(["record", *common, "--force"]), 0)
            records = load_records(records_path)
            record = lookup_record(records, "production", "1.3.2", "ios")
            self.assertEqual((record["hash"], record["method"]), ("bbb", 2))
            self.assertEqual(evaluate_update(records, "production", fp("bbb", rv="1.3.2"), allow_seed=False).status,
                             "match")


NODE = shutil.which("node")
HAS_FINGERPRINT_DEPS = (ROOT / "node_modules" / "@expo" / "fingerprint").exists()
NEEDS_NODE = unittest.skipUnless(NODE and HAS_FINGERPRINT_DEPS, "needs node + pnpm install (@expo/fingerprint)")

# Hashes real app.config.js output through @expo/fingerprint's own expo-config /
# eas.json sourcers and hasher, with the guard's exact options
# (fingerprintOptions), varying one thing at a time. It reaches into the
# package's build/ internals, so a @expo/fingerprint upgrade may need it updated.
HASH_HARNESS = r"""
const fs = require('fs');
const os = require('os');
const path = require('path');
const tools = require(process.env.FINGERPRINT_SCRIPT);
const appRequire = require('module').createRequire(path.join(tools.APP_DIR, 'package.json'));
const fpRoot = path.dirname(appRequire.resolve('@expo/fingerprint/package.json'));
const { normalizeOptionsAsync } = require(path.join(fpRoot, 'build/Options'));
const { getExpoConfigSourcesAsync, getEasBuildSourcesAsync } = require(path.join(fpRoot, 'build/sourcer/Expo'));
const { createFingerprintFromSourcesAsync } = require(path.join(fpRoot, 'build/hash/Hash'));
const { buildExpoConfigForEnv } = require(path.join(tools.APP_DIR, 'app.config.js'));

const BASE_ENV = {
  SPOTLIGHT_ENV_FILE: '/nonexistent/.env', // hermetic: no local .env.* file
  SPOTLIGHT_APP_ENV: 'production',
  SPOTLIGHT_IOS_BUNDLE_IDENTIFIER: 'com.ekalight.app',
  SPOTLIGHT_ANDROID_PACKAGE: 'com.ekalight.app',
  SPOTLIGHT_APP_SCHEME: 'spotlight',
  EXPO_PUBLIC_SPOTLIGHT_API_BASE_URL: 'https://api.ekalight.com',
};
const config = (env) => buildExpoConfigForEnv({ ...BASE_ENV, ...env }, '/nonexistent/overrides.xcconfig');
const OTHER_ROOT = '/Users/someone/elsewhere/spotlight-other-checkout';

async function configHash(exp, platform, { repoRoot = tools.REPO_ROOT, transform = true } = {}) {
  const raw = tools.fingerprintOptions(platform, repoRoot);
  if (!transform) delete raw.fileHookTransform;
  const opts = await normalizeOptionsAsync(tools.APP_DIR, raw);
  const sources = await getExpoConfigSourcesAsync(tools.APP_DIR, { exp }, [], opts);
  return (await createFingerprintFromSourcesAsync(sources, tools.APP_DIR, opts)).hash;
}

async function easHash(mutate) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-eas-'));
  const eas = JSON.parse(fs.readFileSync(path.join(tools.APP_DIR, 'eas.json'), 'utf8'));
  mutate(eas);
  fs.writeFileSync(path.join(dir, 'eas.json'), JSON.stringify(eas, null, 2));
  const opts = await normalizeOptionsAsync(tools.APP_DIR, tools.fingerprintOptions('ios'));
  const sources = await getEasBuildSourcesAsync(dir, opts);
  const hash = (await createFingerprintFromSourcesAsync(sources, dir, opts)).hash;
  fs.rmSync(dir, { recursive: true, force: true });
  return hash;
}

(async () => {
  const base = config({});
  const moved = JSON.parse(JSON.stringify(base).split(tools.REPO_ROOT).join(OTHER_ROOT));
  const withPlugin = config({});
  withPlugin.plugins = [...withPlugin.plugins, 'expo-camera'];
  const withIosPermission = config({});
  withIosPermission.ios = { ...withIosPermission.ios,
    infoPlist: { ...withIosPermission.ios.infoPlist, NSMicrophoneUsageDescription: 'Record audio' } };
  const withAndroidPermission = config({});
  withAndroidPermission.android = { ...withAndroidPermission.android,
    permissions: [...(withAndroidPermission.android.permissions || []), 'android.permission.RECORD_AUDIO'] };

  const out = {
    pathEmbedded: JSON.stringify(base).includes(tools.REPO_ROOT),
    ios: {
      base: await configHash(base, 'ios'),
      extraOnly: await configHash(config({
        EXPO_PUBLIC_SPOTLIGHT_API_BASE_URL: 'https://staging-api.ekalight.com',
        EXPO_PUBLIC_SPOTLIGHT_POSTHOG_API_KEY: 'phc_other',
      }), 'ios'),
      movedCheckout: await configHash(moved, 'ios', { repoRoot: OTHER_ROOT }),
      bundleId: await configHash(config({ SPOTLIGHT_IOS_BUNDLE_IDENTIFIER: 'com.ekalight.other' }), 'ios'),
      plugin: await configHash(withPlugin, 'ios'),
      permission: await configHash(withIosPermission, 'ios'),
      scheme: await configHash(config({ SPOTLIGHT_APP_SCHEME: 'spotlight,spotlight-prod' }), 'ios'),
    },
    android: {
      base: await configHash(base, 'android'),
      movedCheckout: await configHash(moved, 'android', { repoRoot: OTHER_ROOT }),
      baseUntransformed: await configHash(base, 'android', { transform: false }),
      movedUntransformed: await configHash(moved, 'android', { repoRoot: OTHER_ROOT, transform: false }),
      androidPackage: await configHash(config({ SPOTLIGHT_ANDROID_PACKAGE: 'com.ekalight.other' }), 'android'),
      permission: await configHash(withAndroidPermission, 'android'),
      mapsKey: await configHash(config({ GOOGLE_MAPS_ANDROID_API_KEY: 'AIza-test' }), 'android'),
    },
    eas: {
      base: await easHash(() => {}),
      publicEnv: await easHash((e) => {
        e.build.production.env.EXPO_PUBLIC_SPOTLIGHT_API_BASE_URL = 'https://elsewhere.example';
        e.build.staging.env.EXPO_PUBLIC_NEW_FLAG = '1';
      }),
      bundleId: await easHash((e) => { e.build.production.env.SPOTLIGHT_IOS_BUNDLE_IDENTIFIER = 'com.ekalight.other'; }),
      channel: await easHash((e) => { e.build.production.channel = 'production-2'; }),
      buildImage: await easHash((e) => { e.build.production.ios = { image: 'macos-sequoia-15.5-xcode-16.4' }; }),
    },
  };
  process.stdout.write(JSON.stringify(out));
})().catch((e) => {
  console.error(e && e.stack ? e.stack : e);
  process.exit(1);
});
"""


@NEEDS_NODE
class FingerprintHashingTests(unittest.TestCase):
    """What moves the hash and what doesn't, on the real app config."""

    h: dict

    @classmethod
    def setUpClass(cls) -> None:
        result = subprocess.run(
            [NODE, "-e", HASH_HARNESS],
            cwd=str(APP_DIR),
            env={**os.environ, "FINGERPRINT_SCRIPT": str(FINGERPRINT_SCRIPT)},
            capture_output=True,
            text=True,
            timeout=120,
        )
        if result.returncode != 0:
            raise AssertionError(f"hash harness failed:\n{result.stderr}")
        cls.h = json.loads(result.stdout)

    def test_extra_only_change_keeps_hash(self) -> None:
        self.assertEqual(self.h["ios"]["extraOnly"], self.h["ios"]["base"])

    def test_checkout_path_only_change_keeps_hash(self) -> None:
        self.assertTrue(self.h["pathEmbedded"], "config no longer embeds the repo path; revisit this test")
        self.assertEqual(self.h["ios"]["movedCheckout"], self.h["ios"]["base"])
        self.assertEqual(self.h["android"]["movedCheckout"], self.h["android"]["base"])
        # Without the normalization the same move does change it (the false positive this fixes).
        self.assertNotEqual(self.h["android"]["movedUntransformed"], self.h["android"]["baseUntransformed"])

    def test_native_config_changes_still_change_hash(self) -> None:
        for key in ("bundleId", "plugin", "permission", "scheme"):
            with self.subTest(platform="ios", change=key):
                self.assertNotEqual(self.h["ios"][key], self.h["ios"]["base"])
        for key in ("androidPackage", "permission", "mapsKey"):
            with self.subTest(platform="android", change=key):
                self.assertNotEqual(self.h["android"][key], self.h["android"]["base"])

    def test_eas_json_ignores_public_env_but_not_native_settings(self) -> None:
        self.assertEqual(self.h["eas"]["publicEnv"], self.h["eas"]["base"])
        for key in ("bundleId", "channel", "buildImage"):
            with self.subTest(change=key):
                self.assertNotEqual(self.h["eas"][key], self.h["eas"]["base"])


@NEEDS_NODE
class FingerprintScriptEndToEndTests(unittest.TestCase):
    """The real native_fingerprint.cjs on the real tree (about 2 s per run)."""

    def run_script(self, **env: str) -> dict:
        full_env = {
            **os.environ,
            "SPOTLIGHT_ENV_FILE": "/nonexistent/.env",
            "SPOTLIGHT_APP_ENV": "production",
            "EXPO_NO_DOTENV": "1",
            "SPOTLIGHT_IOS_BUNDLE_IDENTIFIER": "com.ekalight.app",
            "EXPO_PUBLIC_SPOTLIGHT_API_BASE_URL": "https://api.ekalight.com",
            **env,
        }
        result = subprocess.run(
            [NODE, str(FINGERPRINT_SCRIPT), "--platform", "ios"],
            cwd=str(APP_DIR), env=full_env, capture_output=True, text=True, timeout=120,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def test_output_carries_method_and_only_native_changes_move_it(self) -> None:
        base = self.run_script()
        self.assertEqual(Fingerprint.from_json(base).method, 2)
        staging_url = self.run_script(EXPO_PUBLIC_SPOTLIGHT_API_BASE_URL="https://staging-api.ekalight.com")
        self.assertEqual(staging_url["hash"], base["hash"])
        other_bundle = self.run_script(SPOTLIGHT_IOS_BUNDLE_IDENTIFIER="com.ekalight.other")
        self.assertNotEqual(other_bundle["hash"], base["hash"])


if __name__ == "__main__":
    unittest.main()
