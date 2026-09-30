import Constants from 'expo-constants';

const PLACEHOLDER_RUNTIME_VALUES = new Set([
  'https://api.example.com',
  'https://your-project-ref.supabase.co',
  'your-supabase-anon-or-publishable-key',
  'com.yourcompany.spotlight',
  'your-expo-account',
  '00000000-0000-0000-0000-000000000000',
  // Turnstile site-key placeholder: until the real key is pasted into
  // eas.json / .env.production, captcha resolution stays disabled (tokenless).
  'TURNSTILE_SITE_KEY_TBD',
]);

function trimConfigValue(value: unknown) {
  if (typeof value !== 'string') {
    return '';
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }

  return PLACEHOLDER_RUNTIME_VALUES.has(trimmed) ? '' : trimmed;
}

function readExpoExtraValue(key: string) {
  const extra = (Constants.expoConfig?.extra ?? {}) as Record<string, unknown>;
  return trimConfigValue(extra[key]);
}

function parseBooleanValue(value: string) {
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }

  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }

  return null;
}

export function resolveRuntimeValue(envKeys: string[], extraKeys: string[] = []) {
  for (const key of envKeys) {
    const value = trimConfigValue(process.env[key]);
    if (value) {
      return value;
    }
  }

  for (const key of extraKeys) {
    const value = readExpoExtraValue(key);
    if (value) {
      return value;
    }
  }

  return '';
}

export function resolveRuntimeBoolean(envKeys: string[], extraKeys: string[] = [], fallback = false) {
  for (const key of envKeys) {
    const value = trimConfigValue(process.env[key]);
    if (value) {
      const parsed = parseBooleanValue(value);
      if (parsed != null) {
        return parsed;
      }
    }
  }

  for (const key of extraKeys) {
    const value = readExpoExtraValue(key);
    if (value) {
      const parsed = parseBooleanValue(value);
      if (parsed != null) {
        return parsed;
      }
    }
  }

  return fallback;
}

export function resolveRuntimeAppEnv() {
  const appEnv = resolveRuntimeValue([], ['spotlightAppEnv']);
  if (appEnv) {
    return appEnv;
  }

  return process.env.NODE_ENV === 'production' ? 'production' : 'development';
}

export function resolveStagingSmokeModeEnabled(options: { allowDevelopment?: boolean } = {}) {
  const smokeModeEnabled = resolveRuntimeBoolean(
    ['EXPO_PUBLIC_SPOTLIGHT_STAGING_SMOKE_ENABLED', 'EXPO_PUBLIC_SPOTLIGHT_SCANNER_SMOKE_ENABLED'],
    ['spotlightStagingSmokeEnabled', 'spotlightScannerSmokeEnabled'],
  );
  if (!smokeModeEnabled) {
    return false;
  }

  const runtimeAppEnv = resolveRuntimeAppEnv();
  return runtimeAppEnv === 'staging' || (options.allowDevelopment === true && __DEV__);
}

/**
 * Scanner surfaces (tray, change-card sheet, card page header) show the
 * matched art version's TCGplayer image (`matchedVariant.imageUrl`) instead of
 * the card's base art. Default ON (TCGplayer images approved for staging and
 * production); set the env to 0 to switch it off.
 */
export function resolveShowMatchedVariantImage() {
  return resolveRuntimeBoolean(
    ['EXPO_PUBLIC_SPOTLIGHT_SHOW_MATCHED_VARIANT_IMAGE'],
    ['spotlightShowMatchedVariantImage'],
    true,
  );
}

/**
 * The Social feed's market/news sections (Meta pulse + group pages, Hot on
 * Ekalight, Coming up + calendar, Set spotlight, Card news + News page).
 * Default ON; the production build sets it to 0, which hides the blocks, skips
 * their reads, and sends their routes back to the feed. Top Trends, posts and
 * market alerts are NOT behind it.
 */
// Market/news feed sections are hidden in staging and production builds; only
// local development shows them. Defaulted here, not in eas.json, because eas.json
// is a native-fingerprint input and editing it blocks OTAs.
export function resolveFeedMarketBlocksEnabled() {
  return resolveRuntimeBoolean(
    ['EXPO_PUBLIC_SPOTLIGHT_FEED_MARKET_BLOCKS'],
    ['spotlightFeedMarketBlocks'],
    resolveRuntimeAppEnv() === 'development',
  );
}

export function resolveExpoScheme() {
  const explicitScheme = resolveRuntimeValue(
    ['EXPO_PUBLIC_SPOTLIGHT_AUTH_SCHEME'],
    ['spotlightAuthScheme'],
  );
  if (explicitScheme) {
    return explicitScheme;
  }

  const configuredScheme = Constants.expoConfig?.scheme;
  if (typeof configuredScheme === 'string' && configuredScheme.trim()) {
    return configuredScheme.trim();
  }

  if (Array.isArray(configuredScheme)) {
    const firstScheme = configuredScheme.find((value): value is string => {
      return typeof value === 'string' && value.trim().length > 0;
    });
    if (firstScheme) {
      return firstScheme.trim();
    }
  }

  return 'spotlight';
}
