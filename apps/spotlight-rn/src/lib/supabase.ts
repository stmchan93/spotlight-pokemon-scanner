import { AppState, Platform } from 'react-native';
import 'react-native-url-polyfill/auto';
import { createClient } from '@supabase/supabase-js';
import { makeRedirectUri } from 'expo-auth-session';

import { resolveExpoScheme, resolveRuntimeValue } from './runtime-config';

type SecureStoreModule = typeof import('expo-secure-store');
type WebBrowserModule = typeof import('expo-web-browser');

let secureStoreModule: SecureStoreModule | null = null;
let webBrowserModule: WebBrowserModule | null = null;

try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  secureStoreModule = require('expo-secure-store') as SecureStoreModule;
} catch {
  secureStoreModule = null;
}

try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  webBrowserModule = require('expo-web-browser') as WebBrowserModule;
} catch {
  webBrowserModule = null;
}

void webBrowserModule?.maybeCompleteAuthSession();

type SupabaseAuthConfig = {
  anonKey: string;
  configurationIssue: string | null;
  isConfigured: boolean;
  redirectURL: string;
  supabaseURL: string;
};

const memoryStorage = new Map<string, string>();

const secureStoreAdapter = {
  getItem: async (key: string) => {
    if (secureStoreModule) {
      return secureStoreModule.getItemAsync(key);
    }

    return memoryStorage.get(key) ?? null;
  },
  removeItem: async (key: string) => {
    if (secureStoreModule) {
      await secureStoreModule.deleteItemAsync(key);
      return;
    }

    memoryStorage.delete(key);
  },
  setItem: async (key: string, value: string) => {
    if (secureStoreModule) {
      await secureStoreModule.setItemAsync(key, value);
      return;
    }

    memoryStorage.set(key, value);
  },
};

let hasRegisteredAutoRefreshListener = false;

export function resolveSupabaseAuthConfig(): SupabaseAuthConfig {
  const supabaseURL = resolveRuntimeValue(
    [
      'EXPO_PUBLIC_SPOTLIGHT_SUPABASE_URL',
      'EXPO_PUBLIC_SUPABASE_URL',
    ],
    ['spotlightSupabaseUrl'],
  );
  const anonKey = resolveRuntimeValue(
    [
      'EXPO_PUBLIC_SPOTLIGHT_SUPABASE_ANON_KEY',
      'EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
      'EXPO_PUBLIC_SUPABASE_ANON_KEY',
    ],
    ['spotlightSupabaseAnonKey'],
  );
  const redirectHost = resolveRuntimeValue(
    ['EXPO_PUBLIC_SPOTLIGHT_AUTH_REDIRECT_HOST'],
    ['spotlightAuthRedirectHost'],
  ) || 'login-callback';
  const redirectURL = resolveRuntimeValue(
    [
      'EXPO_PUBLIC_SPOTLIGHT_AUTH_REDIRECT_URL',
      'EXPO_PUBLIC_SUPABASE_REDIRECT_URL',
    ],
    ['spotlightAuthRedirectUrl'],
  ) || makeRedirectUri({
    path: redirectHost,
    scheme: resolveExpoScheme(),
  });

  if (!supabaseURL) {
    return {
      anonKey,
      configurationIssue: 'Supabase URL is missing. Set EXPO_PUBLIC_SPOTLIGHT_SUPABASE_URL.',
      isConfigured: false,
      redirectURL,
      supabaseURL,
    };
  }

  if (!anonKey) {
    return {
      anonKey,
      configurationIssue: 'Supabase anon key is missing. Set EXPO_PUBLIC_SPOTLIGHT_SUPABASE_ANON_KEY.',
      isConfigured: false,
      redirectURL,
      supabaseURL,
    };
  }

  return {
    anonKey,
    configurationIssue: null,
    isConfigured: true,
    redirectURL,
    supabaseURL,
  };
}

export const supabaseAuthConfig = resolveSupabaseAuthConfig();

export const supabase = supabaseAuthConfig.isConfigured
  ? createClient(supabaseAuthConfig.supabaseURL, supabaseAuthConfig.anonKey, {
      auth: {
        ...(Platform.OS !== 'web' ? { storage: secureStoreAdapter } : {}),
        autoRefreshToken: true,
        detectSessionInUrl: false,
        persistSession: true,
      },
    })
  : null;

if (supabase && Platform.OS !== 'web' && !hasRegisteredAutoRefreshListener) {
  hasRegisteredAutoRefreshListener = true;
  AppState.addEventListener('change', (state) => {
    if (state === 'active') {
      void supabase.auth.startAutoRefresh();
    } else {
      void supabase.auth.stopAutoRefresh();
    }
  });
}
