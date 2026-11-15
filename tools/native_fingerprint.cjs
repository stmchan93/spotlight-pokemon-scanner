#!/usr/bin/env node
// Prints the native fingerprint of apps/spotlight-rn for one platform as JSON:
//   { platform, runtimeVersion, method, hash, sources: { "<type>:<id>": "<hex>" } }
//
// Run it with the SAME env run_mobile_eas.sh exports (SPOTLIGHT_APP_ENV, the
// resolved .env.<env> values, EXPO_NO_DOTENV=1) so app.config.js resolves the
// config an EAS build of that environment would. tools/native_fingerprint_guard.py
// owns the compare/record policy; this file only measures.
'use strict';

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const APP_DIR = path.join(REPO_ROOT, 'apps', 'spotlight-rn');
const appRequire = require('module').createRequire(path.join(APP_DIR, 'package.json'));

// Bump whenever a change here moves the hash of an unchanged tree (skips,
// transforms, extra sources). Records carry it; the guard refuses to compare
// across methods and asks for a re-record instead of reporting "native changed".
//   1: initial (records with no `method`)
//   2: repo root normalized out of contents sources; eas.json hashed without
//      EXPO_PUBLIC_* env
const FINGERPRINT_METHOD = 2;
const REPO_ROOT_PLACEHOLDER = '<repo-root>';

function repoRootVariants(repoRoot) {
  const variants = new Set([repoRoot]);
  try {
    variants.add(fs.realpathSync(repoRoot));
  } catch {
    // keep the resolved path only
  }
  // Longest first so a root that contains another is replaced whole.
  return [...variants].sort((a, b) => b.length - a.length);
}

// app.config.js builds an absolute path (expo-build-properties
// android.extraMavenRepos = file://<repo>/node_modules/...): Gradle needs it
// absolute at build time, but where the checkout lives is not native code.
// @expo/fingerprint only relativizes strings that START with the app dir, so a
// `file://` URL keeps the checkout path and every worktree hashed differently.
function replaceRepoRoot(text, roots) {
  let out = text;
  for (const root of roots) {
    out = out.split(root).join(REPO_ROOT_PLACEHOLDER);
  }
  return out;
}

function sortKeysDeep(value) {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeysDeep(value[key])]),
    );
  }
  return value;
}

function stripPublicEnv(node) {
  if (Array.isArray(node)) {
    node.forEach(stripPublicEnv);
    return;
  }
  if (!node || typeof node !== 'object') {
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === 'env' && value && typeof value === 'object' && !Array.isArray(value)) {
      for (const envKey of Object.keys(value)) {
        if (envKey.startsWith('EXPO_PUBLIC_')) {
          delete value[envKey];
        }
      }
    } else {
      stripPublicEnv(value);
    }
  }
}

// eas.json stays hashed, minus EXPO_PUBLIC_* build env. Why not skip the file:
// its build-profile env also carries SPOTLIGHT_IOS_BUNDLE_IDENTIFIER /
// SPOTLIGHT_ANDROID_PACKAGE / SPOTLIGHT_APP_SCHEME, which app.config.js turns
// into native fields — and a production fingerprint resolves its env from
// .env.production, not eas.json, so eas.json is the only place an EAS-build-
// side change to those shows up. It also holds build settings (channel, image,
// buildType). EXPO_PUBLIC_* are different: app.config.js copies them only into
// `extra` (already skipped) and Metro inlines them into the JS bundle, both of
// which an OTA replaces. If one is ever wired into a native field, that field
// still lands in the hashed expo config.
function normalizeEasJson(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return text; // unparseable: hash the raw bytes (fails closed)
  }
  if (parsed && typeof parsed === 'object') {
    stripPublicEnv(parsed.build);
  }
  return JSON.stringify(sortKeysDeep(parsed));
}

// Passed to @expo/fingerprint as `fileHookTransform`. It is called once for
// each `contents` source (whole text, isEndOfFile=true) and chunk-by-chunk for
// `file` sources (then once more with chunk=null at the end).
function createFileHookTransform(repoRoot = REPO_ROOT) {
  const roots = repoRootVariants(repoRoot);
  const easJsonChunks = [];
  return (source, chunk, isEndOfFile, encoding) => {
    if (source.type === 'contents') {
      return typeof chunk === 'string' ? replaceRepoRoot(chunk, roots) : chunk;
    }
    if (source.type === 'file' && source.filePath === 'eas.json') {
      if (chunk != null) {
        easJsonChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding || 'utf8'));
      }
      if (!isEndOfFile) {
        return null;
      }
      const text = Buffer.concat(easJsonChunks.splice(0)).toString('utf8');
      return normalizeEasJson(text);
    }
    return chunk;
  };
}

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

// Options for createFingerprintAsync. Exported so the tests hash with exactly
// what the guard uses. `repoRoot` is only overridden by tests.
function fingerprintOptions(platform, repoRoot = REPO_ROOT) {
  const { SourceSkips } = appRequire('@expo/fingerprint');

  // Skip inputs that are either the record key itself or ride inside the OTA
  // manifest, so they can't false-positive a JS-only update:
  //   - version/buildNumber and the string runtimeVersion (the key we look up by)
  //   - expo.extra (served from the update manifest, not the binary)
  //   - package.json scripts and .gitignore (never reach the binary)
  // The checkout path and EXPO_PUBLIC_* in eas.json are normalized away by
  // createFileHookTransform; everything else stays hashed.
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

  return {
    platforms: [platform],
    sourceSkips,
    extraSources,
    fileHookTransform: createFileHookTransform(repoRoot),
    silent: true,
  };
}

async function main() {
  const { platform } = parseArgs(process.argv.slice(2));
  const { getConfig } = appRequire('@expo/config');
  const Fingerprint = appRequire('@expo/fingerprint');

  const { exp } = getConfig(APP_DIR, { skipSDKVersionRequirement: true, isPublicConfig: false });
  const runtimeVersion =
    (exp[platform] && typeof exp[platform].runtimeVersion === 'string' && exp[platform].runtimeVersion) ||
    exp.runtimeVersion;
  if (typeof runtimeVersion !== 'string' || !runtimeVersion) {
    throw new Error(`runtimeVersion did not resolve to a string (got ${JSON.stringify(runtimeVersion)})`);
  }

  const fingerprint = await Fingerprint.createFingerprintAsync(APP_DIR, fingerprintOptions(platform));

  const sources = {};
  for (const source of fingerprint.sources) {
    const key = source.type === 'contents' ? `contents:${source.id}` : `${source.type}:${source.filePath}`;
    sources[key] = source.hash;
  }

  process.stdout.write(
    `${JSON.stringify({ platform, runtimeVersion, method: FINGERPRINT_METHOD, hash: fingerprint.hash, sources })}\n`,
  );
}

module.exports = {
  APP_DIR,
  FINGERPRINT_METHOD,
  REPO_ROOT,
  REPO_ROOT_PLACEHOLDER,
  createFileHookTransform,
  fingerprintOptions,
  normalizeEasJson,
  replaceRepoRoot,
};

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`native_fingerprint: ${error && error.stack ? error.stack : error}\n`);
    process.exit(1);
  });
}
