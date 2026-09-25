#!/usr/bin/env node
// Prints the native fingerprint of apps/spotlight-rn for one platform as JSON:
//   { platform, runtimeVersion, hash, sources: { "<type>:<id>": "<hex>" } }
//
// Run it with the SAME env run_mobile_eas.sh exports (SPOTLIGHT_APP_ENV, the
// resolved .env.<env> values, EXPO_NO_DOTENV=1) so app.config.js resolves the
// config an EAS build of that environment would. tools/native_fingerprint_guard.py
// owns the compare/record policy; this file only measures.
'use strict';

const fs = require('fs');
const path = require('path');

const APP_DIR = path.resolve(__dirname, '..', 'apps', 'spotlight-rn');
const appRequire = require('module').createRequire(path.join(APP_DIR, 'package.json'));

function parseArgs(argv) {
  const args = { platform: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--platform') {
      args.platform = argv[i + 1];
      i += 1;
    }
  }
  if (args.platform !== 'ios' && args.platform !== 'android') {
    throw new Error('Usage: native_fingerprint.cjs --platform <ios|android>');
  }
  return args;
}

async function main() {
  const { platform } = parseArgs(process.argv.slice(2));
  const { getConfig } = appRequire('@expo/config');
  const Fingerprint = appRequire('@expo/fingerprint');
  const { SourceSkips } = Fingerprint;

  const { exp } = getConfig(APP_DIR, { skipSDKVersionRequirement: true, isPublicConfig: false });
  const runtimeVersion =
    (exp[platform] && typeof exp[platform].runtimeVersion === 'string' && exp[platform].runtimeVersion) ||
    exp.runtimeVersion;
  if (typeof runtimeVersion !== 'string' || !runtimeVersion) {
    throw new Error(`runtimeVersion did not resolve to a string (got ${JSON.stringify(runtimeVersion)})`);
  }

  // Skip inputs that are either the record key itself or ride inside the OTA
  // manifest, so they can't false-positive a JS-only update:
  //   - version/buildNumber and the string runtimeVersion (the key we look up by)
  //   - expo.extra (served from the update manifest, not the binary)
  //   - package.json scripts and .gitignore (never reach the binary)
  const sourceSkips =
    SourceSkips.ExpoConfigVersions |
    SourceSkips.ExpoConfigRuntimeVersionIfString |
    SourceSkips.ExpoConfigExtraSection |
    SourceSkips.PackageJsonScriptsAll |
    SourceSkips.GitIgnore;

  // Apple targets (app extensions) live outside ios/ and node_modules, so the
  // default sourcers never see them. Hash the dir when it exists.
  const extraSources = [];
  if (platform === 'ios' && fs.existsSync(path.join(APP_DIR, 'targets'))) {
    extraSources.push({ type: 'dir', filePath: 'targets', reasons: ['appleTargets'] });
  }

  const fingerprint = await Fingerprint.createFingerprintAsync(APP_DIR, {
    platforms: [platform],
    sourceSkips,
    extraSources,
    silent: true,
  });

  const sources = {};
  for (const source of fingerprint.sources) {
    const key = source.type === 'contents' ? `contents:${source.id}` : `${source.type}:${source.filePath}`;
    sources[key] = source.hash;
  }

  process.stdout.write(
    `${JSON.stringify({ platform, runtimeVersion, hash: fingerprint.hash, sources })}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`native_fingerprint: ${error && error.stack ? error.stack : error}\n`);
  process.exit(1);
});
