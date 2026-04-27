import Constants from 'expo-constants';

import { resolveSupabaseAuthConfig } from '@/lib/supabase';

type MockedExpoConstants = {
  expoConfig?: {
    extra?: Record<string, unknown>;
    scheme?: string | string[];
  };
};

const mockedConstants = Constants as unknown as MockedExpoConstants;

describe('resolveSupabaseAuthConfig', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
    };
    delete process.env.EXPO_PUBLIC_SPOTLIGHT_SUPABASE_URL;
    delete process.env.EXPO_PUBLIC_SUPABASE_URL;
    delete process.env.EXPO_PUBLIC_SPOTLIGHT_SUPABASE_ANON_KEY;
    delete process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
    delete process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
    delete process.env.EXPO_PUBLIC_SPOTLIGHT_AUTH_REDIRECT_URL;
    delete process.env.EXPO_PUBLIC_SUPABASE_REDIRECT_URL;
    delete process.env.EXPO_PUBLIC_SPOTLIGHT_AUTH_REDIRECT_HOST;
    delete process.env.EXPO_PUBLIC_SPOTLIGHT_AUTH_SCHEME;

    mockedConstants.expoConfig = {
      extra: {},
      scheme: 'spotlight',
    };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('falls back to Expo extra values from the local override bridge', () => {
    mockedConstants.expoConfig = {
      extra: {
        spotlightAuthRedirectHost: 'login-callback',
        spotlightSupabaseAnonKey: 'sb_publishable_local',
        spotlightSupabaseUrl: 'https://lvnjshymwvagwadqeofm.supabase.co',
      },
      scheme: 'spotlight',
    };

    expect(resolveSupabaseAuthConfig()).toEqual({
      anonKey: 'sb_publishable_local',
      configurationIssue: null,
      isConfigured: true,
      redirectURL: 'spotlight://login-callback',
      supabaseURL: 'https://lvnjshymwvagwadqeofm.supabase.co',
    });
  });

  it('still prefers explicit Expo public env vars over Expo extra values', () => {
    mockedConstants.expoConfig = {
      extra: {
        spotlightSupabaseAnonKey: 'sb_publishable_local',
        spotlightSupabaseUrl: 'https://local.supabase.co',
      },
      scheme: 'spotlight',
    };
    process.env.EXPO_PUBLIC_SPOTLIGHT_SUPABASE_URL = 'https://env.supabase.co';
    process.env.EXPO_PUBLIC_SPOTLIGHT_SUPABASE_ANON_KEY = 'sb_publishable_env';
    process.env.EXPO_PUBLIC_SPOTLIGHT_AUTH_REDIRECT_URL = 'spotlight://env-callback';

    expect(resolveSupabaseAuthConfig()).toEqual({
      anonKey: 'sb_publishable_env',
      configurationIssue: null,
      isConfigured: true,
      redirectURL: 'spotlight://env-callback',
      supabaseURL: 'https://env.supabase.co',
    });
  });

  it('ignores placeholder Expo public env vars and falls back to Expo extra values', () => {
    mockedConstants.expoConfig = {
      extra: {
        spotlightAuthRedirectHost: 'login-callback',
        spotlightSupabaseAnonKey: 'sb_publishable_local',
        spotlightSupabaseUrl: 'https://lvnjshymwvagwadqeofm.supabase.co',
      },
      scheme: 'spotlight',
    };
    process.env.EXPO_PUBLIC_SPOTLIGHT_SUPABASE_URL = 'https://your-project-ref.supabase.co';
    process.env.EXPO_PUBLIC_SPOTLIGHT_SUPABASE_ANON_KEY = 'your-supabase-anon-or-publishable-key';

    expect(resolveSupabaseAuthConfig()).toEqual({
      anonKey: 'sb_publishable_local',
      configurationIssue: null,
      isConfigured: true,
      redirectURL: 'spotlight://login-callback',
      supabaseURL: 'https://lvnjshymwvagwadqeofm.supabase.co',
    });
  });
});
