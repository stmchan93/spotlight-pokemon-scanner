/* global __dirname */

const fs = require('node:fs');
const path = require('node:path');

const { expo: baseExpoConfig } = require('./app.json');

const LOCAL_OVERRIDES_PATH = path.resolve(
  __dirname,
  '..',
  '..',
  'Spotlight',
  'Config',
  'LocalOverrides.xcconfig',
);

const EXPO_EXTRA_ENV_MAPPINGS = [
  ['EXPO_PUBLIC_SPOTLIGHT_API_BASE_URL', 'spotlightApiBaseUrl'],
  ['EXPO_PUBLIC_SPOTLIGHT_SUPABASE_URL', 'spotlightSupabaseUrl'],
  ['EXPO_PUBLIC_SPOTLIGHT_SUPABASE_ANON_KEY', 'spotlightSupabaseAnonKey'],
  ['EXPO_PUBLIC_SPOTLIGHT_AUTH_REDIRECT_HOST', 'spotlightAuthRedirectHost'],
  ['EXPO_PUBLIC_SPOTLIGHT_AUTH_REDIRECT_URL', 'spotlightAuthRedirectUrl'],
  ['EXPO_PUBLIC_SPOTLIGHT_AUTH_SCHEME', 'spotlightAuthScheme'],
  ['EXPO_PUBLIC_SPOTLIGHT_STAGING_SMOKE_ENABLED', 'spotlightStagingSmokeEnabled'],
  ['EXPO_PUBLIC_SPOTLIGHT_SCANNER_SMOKE_ENABLED', 'spotlightScannerSmokeEnabled'],
  ['EXPO_PUBLIC_SPOTLIGHT_POSTHOG_API_KEY', 'spotlightPosthogApiKey'],
  ['EXPO_PUBLIC_SPOTLIGHT_POSTHOG_HOST', 'spotlightPosthogHost'],
  ['EXPO_PUBLIC_SPOTLIGHT_POSTHOG_ENABLED', 'spotlightPosthogEnabled'],
];

const PLACEHOLDER_ENV_VALUES = new Set([
  'https://api.example.com',
  'https://your-project-ref.supabase.co',
  'your-supabase-anon-or-publishable-key',
  'com.yourcompany.spotlight',
  'your-expo-account',
  '00000000-0000-0000-0000-000000000000',
]);

function parseDotenvEntries(source) {
  const entries = {};

  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    const normalizedLine = line.startsWith('export ') ? line.slice('export '.length).trim() : line;
    const separatorIndex = normalizedLine.indexOf('=');
    if (separatorIndex === -1) {
      continue;
    }

    const key = normalizedLine.slice(0, separatorIndex).trim();
    let value = normalizedLine.slice(separatorIndex + 1).trim();
    if (!key || !value) {
      continue;
    }

    if (value && lenLikeQuoted(value)) {
      value = value.slice(1, -1);
    }

    entries[key] = value;
  }

  return entries;
}

function lenLikeQuoted(value) {
  return value.length >= 2 && value[0] === value[value.length - 1] && ['"', "'"].includes(value[0]);
}

function resolveSpotlightEnvFilePath(env = process.env) {
  const explicitEnvFile = trimEnvValue(env.SPOTLIGHT_ENV_FILE);
  if (explicitEnvFile) {
    return path.resolve(__dirname, explicitEnvFile);
  }

  const appEnv = trimEnvValue(env.SPOTLIGHT_APP_ENV);
  if (!appEnv) {
    return '';
  }

  return path.resolve(__dirname, `.env.${appEnv}`);
}

function loadSpotlightEnvFileValues(env = process.env) {
  const envFilePath = resolveSpotlightEnvFilePath(env);
  if (!envFilePath || !fs.existsSync(envFilePath)) {
    return {};
  }

  return parseDotenvEntries(fs.readFileSync(envFilePath, 'utf8'));
}

function resolveSpotlightConfigEnv(env = process.env) {
  return {
    ...loadSpotlightEnvFileValues(env),
    ...env,
  };
}

function loadSpotlightReleaseOverridesFromEnv(env = process.env) {
  return {
    androidPackage: trimEnvValue(env.SPOTLIGHT_ANDROID_PACKAGE),
    easProjectId: trimEnvValue(env.SPOTLIGHT_EAS_PROJECT_ID),
    expoOwner: trimEnvValue(env.SPOTLIGHT_EXPO_OWNER),
    iosBundleIdentifier: trimEnvValue(env.SPOTLIGHT_IOS_BUNDLE_IDENTIFIER),
    scheme: trimEnvValue(env.SPOTLIGHT_APP_SCHEME),
    updateChannel: trimEnvValue(env.SPOTLIGHT_EAS_UPDATE_CHANNEL) || trimEnvValue(env.SPOTLIGHT_APP_ENV),
  };
}

function normalizeXcconfigValue(value) {
  return value
    .trim()
    .replace(/^"(.*)"$/, '$1')
    .replace(':/$()/', '://');
}

function parseXcconfigEntries(source) {
  const entries = {};

  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('//')) {
      continue;
    }

    const separatorIndex = line.indexOf('=');
    if (separatorIndex === -1) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim();
    if (!key || !value) {
      continue;
    }

    entries[key] = normalizeXcconfigValue(value);
  }

  return entries;
}

function trimEnvValue(value) {
  if (typeof value !== 'string') {
    return '';
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }

  return PLACEHOLDER_ENV_VALUES.has(trimmed) ? '' : trimmed;
}

function loadSpotlightExpoExtraFromEnv(env = process.env) {
  const extra = {};

  for (const [envKey, extraKey] of EXPO_EXTRA_ENV_MAPPINGS) {
    const value = trimEnvValue(env[envKey]);
    if (value) {
      extra[extraKey] = value;
    }
  }

  return extra;
}

function loadSpotlightExpoExtraFromXcconfig(overridesPath = LOCAL_OVERRIDES_PATH) {
  if (!fs.existsSync(overridesPath)) {
    return {};
  }

  const localOverrides = parseXcconfigEntries(fs.readFileSync(overridesPath, 'utf8'));
  const extra = {};

  if (localOverrides.SPOTLIGHT_LOCAL_DEVICE_API_BASE_URL) {
    extra.spotlightApiBaseUrl = localOverrides.SPOTLIGHT_LOCAL_DEVICE_API_BASE_URL;
  }

  if (localOverrides.SPOTLIGHT_SUPABASE_URL) {
    extra.spotlightSupabaseUrl = localOverrides.SPOTLIGHT_SUPABASE_URL;
  }

  if (localOverrides.SPOTLIGHT_SUPABASE_ANON_KEY) {
    extra.spotlightSupabaseAnonKey = localOverrides.SPOTLIGHT_SUPABASE_ANON_KEY;
  }

  if (localOverrides.SPOTLIGHT_AUTH_REDIRECT_HOST) {
    extra.spotlightAuthRedirectHost = localOverrides.SPOTLIGHT_AUTH_REDIRECT_HOST;
  }

  return extra;
}

function loadSpotlightExpoExtra(overridesPath = LOCAL_OVERRIDES_PATH, env = process.env) {
  return {
    ...loadSpotlightExpoExtraFromXcconfig(overridesPath),
    ...loadSpotlightExpoExtraFromEnv(env),
  };
}

function getPluginIdentifier(pluginEntry) {
  return Array.isArray(pluginEntry) ? pluginEntry[0] : pluginEntry;
}

function withPlugin(existingPlugins, pluginEntry) {
  const nextPlugins = [...existingPlugins];
  const pluginIdentifier = getPluginIdentifier(pluginEntry);
  const existingIndex = nextPlugins.findIndex((entry) => getPluginIdentifier(entry) === pluginIdentifier);

  if (existingIndex >= 0) {
    nextPlugins[existingIndex] = pluginEntry;
    return nextPlugins;
  }

  nextPlugins.push(pluginEntry);
  return nextPlugins;
}

const SPOTLIGHT_DISPLAY_NAME_SUFFIX_BY_ENV = {
  production: '',
  staging: ' β', // "Ekalight β"
  development: ' Dev', // "Ekalight Dev"
};

function resolveSpotlightDisplayNameForEnv(resolvedAppEnv, baseName) {
  const name = typeof baseName === 'string' && baseName.length > 0 ? baseName : 'Ekalight';
  const key = trimEnvValue(resolvedAppEnv);
  const suffix = SPOTLIGHT_DISPLAY_NAME_SUFFIX_BY_ENV[key] ?? '';
  return `${name}${suffix}`;
}

function buildExpoConfigForEnv(env = process.env, overridesPath = LOCAL_OVERRIDES_PATH) {
  const resolvedEnv = resolveSpotlightConfigEnv(env);
  const releaseOverrides = loadSpotlightReleaseOverridesFromEnv(resolvedEnv);
  const resolvedAppEnv = trimEnvValue(resolvedEnv.SPOTLIGHT_APP_ENV);
  const resolvedScheme = releaseOverrides.scheme || baseExpoConfig.scheme;
  const resolvedRuntimeVersion =
    typeof baseExpoConfig.runtimeVersion === 'string' && baseExpoConfig.runtimeVersion.trim().length > 0
      ? baseExpoConfig.runtimeVersion.trim()
      : baseExpoConfig.version;
  const extra = {
    ...(baseExpoConfig.extra ?? {}),
    ...loadSpotlightExpoExtra(overridesPath, resolvedEnv),
  };
  if (resolvedAppEnv) {
    extra.spotlightAppEnv = resolvedAppEnv;
  }
  if (!extra.spotlightAuthScheme && resolvedScheme) {
    extra.spotlightAuthScheme = resolvedScheme;
  }

  if (releaseOverrides.easProjectId) {
    extra.eas = {
      ...(extra.eas ?? {}),
      projectId: releaseOverrides.easProjectId,
    };
  }

  const ios = {
    ...(baseExpoConfig.ios ?? {}),
  };
  if (releaseOverrides.iosBundleIdentifier) {
    ios.bundleIdentifier = releaseOverrides.iosBundleIdentifier;
  }
  // No per-env iOS icon override: every environment uses the Icon Composer bundle
  // declared in app.json (`ios.icon: './assets/ekalight.icon'`). Staging and
  // production used to point at the flat `ekalight-e-icon.png` instead, which
  // meant iOS 26 applied its OWN Liquid Glass treatment to the artwork — the mark
  // came out washed-out gray with a specular glare across it. The .icon bundle is
  // the only way to say "no glass, no specular, no shadow" (see assets/ekalight.icon/
  // icon.json); the artwork is identical either way. The flat PNGs are still
  // generated by tools/generate_app_icons.py for Android and the Expo web/base icon.

  const android = {
    ...(baseExpoConfig.android ?? {}),
  };
  if (releaseOverrides.androidPackage) {
    android.package = releaseOverrides.androidPackage;
  }

  const updates = {
    ...(baseExpoConfig.updates ?? {}),
  };
  if (releaseOverrides.updateChannel) {
    updates.requestHeaders = {
      ...(updates.requestHeaders ?? {}),
      'expo-channel-name': releaseOverrides.updateChannel,
    };
  }

  let resolvedPlugins = withPlugin([...(baseExpoConfig.plugins ?? [])], 'expo-localization');
  resolvedPlugins = withPlugin(resolvedPlugins, [
    'expo-build-properties',
    {
      ios: {
        deploymentTarget: '15.5',
      },
      android: {
        // async-storage 3.x ships its `storage-android` artifact in a bundled
        // local maven repo that Expo prebuild does not auto-register on Android
        // (iOS uses CocoaPods, so it's unaffected). Point Gradle at it via an
        // absolute path computed from the workspace root so it resolves both
        // locally and on EAS.
        extraMavenRepos: [
          `file://${path.resolve(
            __dirname,
            '..',
            '..',
            'node_modules',
            '@react-native-async-storage',
            'async-storage',
            'android',
            'local_repo',
          )}`,
        ],
      },
    },
  ]);

  // Per-environment display name (home-screen / App Store label). Prod keeps the
  // clean brand name; non-prod builds are suffixed so testers can tell which app
  // they have installed when several coexist on one device.
  const resolvedName =
    resolveSpotlightDisplayNameForEnv(resolvedAppEnv, baseExpoConfig.name);

  const expoConfig = {
    ...baseExpoConfig,
    name: resolvedName,
    android,
    ios,
    plugins: resolvedPlugins,
    runtimeVersion: resolvedRuntimeVersion,
    scheme: resolvedScheme || undefined,
    updates,
    extra,
  };

  if (releaseOverrides.expoOwner) {
    expoConfig.owner = releaseOverrides.expoOwner;
  }

  return {
    ...expoConfig,
  };
}

function buildExpoConfig() {
  return buildExpoConfigForEnv(process.env, LOCAL_OVERRIDES_PATH);
}

module.exports = buildExpoConfig;
module.exports.buildExpoConfig = buildExpoConfig;
module.exports.buildExpoConfigForEnv = buildExpoConfigForEnv;
module.exports.parseDotenvEntries = parseDotenvEntries;
module.exports.resolveSpotlightEnvFilePath = resolveSpotlightEnvFilePath;
module.exports.loadSpotlightEnvFileValues = loadSpotlightEnvFileValues;
module.exports.resolveSpotlightConfigEnv = resolveSpotlightConfigEnv;
module.exports.normalizeXcconfigValue = normalizeXcconfigValue;
module.exports.parseXcconfigEntries = parseXcconfigEntries;
module.exports.loadSpotlightExpoExtraFromEnv = loadSpotlightExpoExtraFromEnv;
module.exports.loadSpotlightExpoExtraFromXcconfig = loadSpotlightExpoExtraFromXcconfig;
module.exports.loadSpotlightExpoExtra = loadSpotlightExpoExtra;
module.exports.loadSpotlightReleaseOverridesFromEnv = loadSpotlightReleaseOverridesFromEnv;
module.exports.getPluginIdentifier = getPluginIdentifier;
module.exports.resolveSpotlightDisplayNameForEnv = resolveSpotlightDisplayNameForEnv;
module.exports.withPlugin = withPlugin;
