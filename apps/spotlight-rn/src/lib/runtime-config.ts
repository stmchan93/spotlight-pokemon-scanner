import Constants from 'expo-constants';

const PLACEHOLDER_RUNTIME_VALUES = new Set([
  'https://api.example.com',
  'https://your-project-ref.supabase.co',
  'your-supabase-anon-or-publishable-key',
  'com.yourcompany.spotlight',
  'your-expo-account',
  '00000000-0000-0000-0000-000000000000',
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
