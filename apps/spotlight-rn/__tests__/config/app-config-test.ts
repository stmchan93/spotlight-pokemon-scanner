const {
  buildExpoConfig,
  buildExpoConfigForEnv,
  loadSpotlightEnvFileValues,
  loadSpotlightReleaseOverridesFromEnv,
  parseDotenvEntries,
  resolveSpotlightConfigEnv,
  resolveSpotlightEnvFilePath,
  loadSpotlightExpoExtra,
  loadSpotlightExpoExtraFromEnv,
  loadSpotlightExpoExtraFromXcconfig,
  normalizeXcconfigValue,
  parseXcconfigEntries,
} = require('../../app.config.js');

describe('app config local overrides bridge', () => {
  it('parses dotenv-style env files', () => {
    expect(parseDotenvEntries(`
      # comment
      EXPO_PUBLIC_SPOTLIGHT_API_BASE_URL=https://api.example.com
      export SPOTLIGHT_IOS_BUNDLE_IDENTIFIER=com.looty.spotlight
    `)).toEqual({
      EXPO_PUBLIC_SPOTLIGHT_API_BASE_URL: 'https://api.example.com',
      SPOTLIGHT_IOS_BUNDLE_IDENTIFIER: 'com.looty.spotlight',
    });
  });

  it('normalizes escaped xcconfig URLs', () => {
    expect(normalizeXcconfigValue('https:/$()/lvnjshymwvagwadqeofm.supabase.co')).toBe(
      'https://lvnjshymwvagwadqeofm.supabase.co',
    );
    expect(normalizeXcconfigValue('http:/$()/Stephens-MacBook-Pro.local:8788/')).toBe(
      'http://Stephens-MacBook-Pro.local:8788/',
    );
  });

  it('parses relevant xcconfig entries', () => {
    const entries = parseXcconfigEntries(`
      // comment
      SPOTLIGHT_LOCAL_DEVICE_API_BASE_URL = http:/$()/Stephens-MacBook-Pro.local:8788/
      SPOTLIGHT_SUPABASE_URL = https:/$()/lvnjshymwvagwadqeofm.supabase.co
      SPOTLIGHT_SUPABASE_ANON_KEY = sb_publishable_123
      SPOTLIGHT_AUTH_REDIRECT_HOST = login-callback
    `);

    expect(entries).toEqual({
      SPOTLIGHT_AUTH_REDIRECT_HOST: 'login-callback',
      SPOTLIGHT_LOCAL_DEVICE_API_BASE_URL: 'http://Stephens-MacBook-Pro.local:8788/',
      SPOTLIGHT_SUPABASE_ANON_KEY: 'sb_publishable_123',
      SPOTLIGHT_SUPABASE_URL: 'https://lvnjshymwvagwadqeofm.supabase.co',
    });
  });

  it('maps local overrides into Expo extra values', () => {
    const extra = loadSpotlightExpoExtraFromXcconfig('/virtual/LocalOverrides.xcconfig');
    expect(extra).toEqual({});

    const fs = require('node:fs');
    const existsSpy = jest.spyOn(fs, 'existsSync').mockReturnValue(true);
    const readSpy = jest.spyOn(fs, 'readFileSync').mockReturnValue(`
      SPOTLIGHT_LOCAL_DEVICE_API_BASE_URL = http:/$()/Stephens-MacBook-Pro.local:8788/
      SPOTLIGHT_SUPABASE_URL = https:/$()/lvnjshymwvagwadqeofm.supabase.co
      SPOTLIGHT_SUPABASE_ANON_KEY = sb_publishable_123
      SPOTLIGHT_AUTH_REDIRECT_HOST = login-callback
    `);

    expect(loadSpotlightExpoExtraFromXcconfig('/virtual/LocalOverrides.xcconfig')).toEqual({
      spotlightApiBaseUrl: 'http://Stephens-MacBook-Pro.local:8788/',
      spotlightAuthRedirectHost: 'login-callback',
      spotlightSupabaseAnonKey: 'sb_publishable_123',
      spotlightSupabaseUrl: 'https://lvnjshymwvagwadqeofm.supabase.co',
    });

    existsSpy.mockRestore();
    readSpy.mockRestore();
  });

  it('maps Expo public env vars into Expo extra values', () => {
    expect(loadSpotlightExpoExtraFromEnv({})).toEqual({});

    expect(loadSpotlightExpoExtraFromEnv({
      EXPO_PUBLIC_SPOTLIGHT_API_BASE_URL: 'http://10.0.2.2:8788',
      EXPO_PUBLIC_SPOTLIGHT_SUPABASE_URL: 'https://env.supabase.co',
      EXPO_PUBLIC_SPOTLIGHT_SUPABASE_ANON_KEY: 'sb_publishable_env',
      EXPO_PUBLIC_SPOTLIGHT_AUTH_REDIRECT_HOST: 'android-callback',
      EXPO_PUBLIC_SPOTLIGHT_AUTH_REDIRECT_URL: 'spotlight://android-callback',
      EXPO_PUBLIC_SPOTLIGHT_AUTH_SCHEME: 'spotlight',
      EXPO_PUBLIC_SPOTLIGHT_POSTHOG_API_KEY: 'phc_test_123',
      EXPO_PUBLIC_SPOTLIGHT_POSTHOG_HOST: 'https://us.i.posthog.com',
      EXPO_PUBLIC_SPOTLIGHT_POSTHOG_ENABLED: '1',
      EXPO_PUBLIC_SPOTLIGHT_SCANNER_SMOKE_ENABLED: '1',
    })).toEqual({
      spotlightApiBaseUrl: 'http://10.0.2.2:8788',
      spotlightAuthRedirectHost: 'android-callback',
      spotlightAuthRedirectUrl: 'spotlight://android-callback',
      spotlightAuthScheme: 'spotlight',
      spotlightPosthogApiKey: 'phc_test_123',
      spotlightPosthogEnabled: '1',
      spotlightPosthogHost: 'https://us.i.posthog.com',
      spotlightScannerSmokeEnabled: '1',
      spotlightSupabaseAnonKey: 'sb_publishable_env',
      spotlightSupabaseUrl: 'https://env.supabase.co',
    });
  });

  it('resolves environment-specific env file paths', () => {
    expect(resolveSpotlightEnvFilePath({})).toBe('');
    expect(resolveSpotlightEnvFilePath({
      SPOTLIGHT_APP_ENV: 'production',
    })).toEqual(expect.stringMatching(/\.env\.production$/));
    expect(resolveSpotlightEnvFilePath({
      SPOTLIGHT_ENV_FILE: './custom.env',
    })).toEqual(expect.stringMatching(/custom\.env$/));
  });

  it('loads app env file values when SPOTLIGHT_APP_ENV is set', () => {
    const fs = require('node:fs');
    const existsSpy = jest.spyOn(fs, 'existsSync').mockReturnValue(true);
    const readSpy = jest.spyOn(fs, 'readFileSync').mockReturnValue(`
      EXPO_PUBLIC_SPOTLIGHT_API_BASE_URL=https://api.example.com
      SPOTLIGHT_IOS_BUNDLE_IDENTIFIER=com.looty.spotlight
    `);

    expect(loadSpotlightEnvFileValues({
      SPOTLIGHT_APP_ENV: 'staging',
    })).toEqual({
      EXPO_PUBLIC_SPOTLIGHT_API_BASE_URL: 'https://api.example.com',
      SPOTLIGHT_IOS_BUNDLE_IDENTIFIER: 'com.looty.spotlight',
    });

    existsSpy.mockRestore();
    readSpy.mockRestore();
  });

  it('prefers shell env over app env file values', () => {
    const fs = require('node:fs');
    const existsSpy = jest.spyOn(fs, 'existsSync').mockReturnValue(true);
    const readSpy = jest.spyOn(fs, 'readFileSync').mockReturnValue(`
      EXPO_PUBLIC_SPOTLIGHT_API_BASE_URL=https://staging.example.com
      SPOTLIGHT_IOS_BUNDLE_IDENTIFIER=com.looty.staging
    `);

    expect(resolveSpotlightConfigEnv({
      SPOTLIGHT_APP_ENV: 'staging',
      EXPO_PUBLIC_SPOTLIGHT_API_BASE_URL: 'https://override.example.com',
    })).toEqual(expect.objectContaining({
      EXPO_PUBLIC_SPOTLIGHT_API_BASE_URL: 'https://override.example.com',
      SPOTLIGHT_IOS_BUNDLE_IDENTIFIER: 'com.looty.staging',
      SPOTLIGHT_APP_ENV: 'staging',
    }));

    existsSpy.mockRestore();
    readSpy.mockRestore();
  });

  it('maps release-only env vars into native config overrides', () => {
    expect(loadSpotlightReleaseOverridesFromEnv({})).toEqual({
      androidPackage: '',
      easProjectId: '',
      expoOwner: '',
      iosBundleIdentifier: '',
      scheme: '',
      updateChannel: '',
    });

    expect(loadSpotlightReleaseOverridesFromEnv({
      SPOTLIGHT_ANDROID_PACKAGE: 'com.looty.spotlight',
      SPOTLIGHT_APP_SCHEME: 'looty',
      SPOTLIGHT_EAS_UPDATE_CHANNEL: 'staging',
      SPOTLIGHT_EAS_PROJECT_ID: '12345678-1234-1234-1234-1234567890ab',
      SPOTLIGHT_EXPO_OWNER: 'looty',
      SPOTLIGHT_IOS_BUNDLE_IDENTIFIER: 'com.looty.spotlight',
    })).toEqual({
      androidPackage: 'com.looty.spotlight',
      easProjectId: '12345678-1234-1234-1234-1234567890ab',
      expoOwner: 'looty',
      iosBundleIdentifier: 'com.looty.spotlight',
      scheme: 'looty',
      updateChannel: 'staging',
    });
  });

  it('ignores placeholder release env vars', () => {
    expect(loadSpotlightReleaseOverridesFromEnv({
      SPOTLIGHT_ANDROID_PACKAGE: 'com.yourcompany.spotlight',
      SPOTLIGHT_EAS_PROJECT_ID: '00000000-0000-0000-0000-000000000000',
      SPOTLIGHT_EXPO_OWNER: 'your-expo-account',
      SPOTLIGHT_IOS_BUNDLE_IDENTIFIER: 'com.yourcompany.spotlight',
    })).toEqual({
      androidPackage: '',
      easProjectId: '',
      expoOwner: '',
      iosBundleIdentifier: '',
      scheme: '',
      updateChannel: '',
    });
  });

  it('prefers Expo public env vars over xcconfig fallback values', () => {
    const fs = require('node:fs');
    const existsSpy = jest.spyOn(fs, 'existsSync').mockReturnValue(true);
    const readSpy = jest.spyOn(fs, 'readFileSync').mockReturnValue(`
      SPOTLIGHT_LOCAL_DEVICE_API_BASE_URL = http:/$()/Stephens-MacBook-Pro.local:8788/
      SPOTLIGHT_SUPABASE_URL = https:/$()/lvnjshymwvagwadqeofm.supabase.co
      SPOTLIGHT_SUPABASE_ANON_KEY = sb_publishable_local
      SPOTLIGHT_AUTH_REDIRECT_HOST = login-callback
    `);

    expect(loadSpotlightExpoExtra('/virtual/LocalOverrides.xcconfig', {
      EXPO_PUBLIC_SPOTLIGHT_API_BASE_URL: 'http://10.0.2.2:8788',
      EXPO_PUBLIC_SPOTLIGHT_SUPABASE_URL: 'https://env.supabase.co',
      EXPO_PUBLIC_SPOTLIGHT_SUPABASE_ANON_KEY: 'sb_publishable_env',
      EXPO_PUBLIC_SPOTLIGHT_AUTH_REDIRECT_HOST: 'android-callback',
    })).toEqual({
      spotlightApiBaseUrl: 'http://10.0.2.2:8788',
      spotlightAuthRedirectHost: 'android-callback',
      spotlightSupabaseAnonKey: 'sb_publishable_env',
      spotlightSupabaseUrl: 'https://env.supabase.co',
    });

    existsSpy.mockRestore();
    readSpy.mockRestore();
  });

  it('ignores placeholder Expo public env vars and falls back to xcconfig values', () => {
    const fs = require('node:fs');
    const existsSpy = jest.spyOn(fs, 'existsSync').mockReturnValue(true);
    const readSpy = jest.spyOn(fs, 'readFileSync').mockReturnValue(`
      SPOTLIGHT_LOCAL_DEVICE_API_BASE_URL = http:/$()/Stephens-MacBook-Pro.local:8788/
      SPOTLIGHT_SUPABASE_URL = https:/$()/lvnjshymwvagwadqeofm.supabase.co
      SPOTLIGHT_SUPABASE_ANON_KEY = sb_publishable_local
      SPOTLIGHT_AUTH_REDIRECT_HOST = login-callback
    `);

    expect(loadSpotlightExpoExtra('/virtual/LocalOverrides.xcconfig', {
      EXPO_PUBLIC_SPOTLIGHT_API_BASE_URL: 'https://api.example.com',
      EXPO_PUBLIC_SPOTLIGHT_SUPABASE_URL: 'https://your-project-ref.supabase.co',
      EXPO_PUBLIC_SPOTLIGHT_SUPABASE_ANON_KEY: 'your-supabase-anon-or-publishable-key',
      EXPO_PUBLIC_SPOTLIGHT_AUTH_REDIRECT_HOST: 'login-callback',
    })).toEqual({
      spotlightApiBaseUrl: 'http://Stephens-MacBook-Pro.local:8788/',
      spotlightAuthRedirectHost: 'login-callback',
      spotlightSupabaseAnonKey: 'sb_publishable_local',
      spotlightSupabaseUrl: 'https://lvnjshymwvagwadqeofm.supabase.co',
    });

    existsSpy.mockRestore();
    readSpy.mockRestore();
  });

  it('builds Expo config with release overrides layered on top of app.json', () => {
    const previousEnv = {
      EXPO_PUBLIC_SPOTLIGHT_API_BASE_URL: process.env.EXPO_PUBLIC_SPOTLIGHT_API_BASE_URL,
      SPOTLIGHT_ANDROID_PACKAGE: process.env.SPOTLIGHT_ANDROID_PACKAGE,
      SPOTLIGHT_APP_ENV: process.env.SPOTLIGHT_APP_ENV,
      SPOTLIGHT_APP_SCHEME: process.env.SPOTLIGHT_APP_SCHEME,
      SPOTLIGHT_EAS_UPDATE_CHANNEL: process.env.SPOTLIGHT_EAS_UPDATE_CHANNEL,
      SPOTLIGHT_EAS_PROJECT_ID: process.env.SPOTLIGHT_EAS_PROJECT_ID,
      SPOTLIGHT_EXPO_OWNER: process.env.SPOTLIGHT_EXPO_OWNER,
      SPOTLIGHT_IOS_BUNDLE_IDENTIFIER: process.env.SPOTLIGHT_IOS_BUNDLE_IDENTIFIER,
    };

    process.env.EXPO_PUBLIC_SPOTLIGHT_API_BASE_URL = 'https://api.looty.app';
    process.env.SPOTLIGHT_ANDROID_PACKAGE = 'com.looty.spotlight';
    process.env.SPOTLIGHT_APP_SCHEME = 'looty';
    process.env.SPOTLIGHT_EAS_UPDATE_CHANNEL = 'staging';
    process.env.SPOTLIGHT_EAS_PROJECT_ID = '12345678-1234-1234-1234-1234567890ab';
    process.env.SPOTLIGHT_EXPO_OWNER = 'looty';
    process.env.SPOTLIGHT_IOS_BUNDLE_IDENTIFIER = 'com.looty.spotlight';

    const config = buildExpoConfig();

    expect(config.owner).toBe('looty');
    expect(config.scheme).toBe('looty');
    expect(config.ios?.bundleIdentifier).toBe('com.looty.spotlight');
    expect(config.android?.package).toBe('com.looty.spotlight');
    expect(config.extra?.spotlightApiBaseUrl).toBe('https://api.looty.app');
    expect(config.extra?.spotlightAuthScheme).toBe('looty');
    expect(config.extra?.eas?.projectId).toBe('12345678-1234-1234-1234-1234567890ab');
    expect(config.updates?.requestHeaders?.['expo-channel-name']).toBe('staging');

    Object.assign(process.env, previousEnv);
  });

  it('builds Expo config from an environment-specific env file', () => {
    const fs = require('node:fs');
    const existsSpy = jest.spyOn(fs, 'existsSync').mockReturnValue(true);
    const readSpy = jest.spyOn(fs, 'readFileSync').mockReturnValue(`
      EXPO_PUBLIC_SPOTLIGHT_API_BASE_URL=https://api.looty.app
      EXPO_PUBLIC_SPOTLIGHT_SUPABASE_URL=https://sb.looty.app
      EXPO_PUBLIC_SPOTLIGHT_SUPABASE_ANON_KEY=sb_key
      SPOTLIGHT_IOS_BUNDLE_IDENTIFIER=com.looty.production
      SPOTLIGHT_EXPO_OWNER=looty
      SPOTLIGHT_EAS_PROJECT_ID=12345678-1234-1234-1234-1234567890ab
    `);

    const config = buildExpoConfigForEnv({
      SPOTLIGHT_APP_ENV: 'production',
    }, '/virtual/LocalOverrides.xcconfig');

    expect(config.ios?.bundleIdentifier).toBe('com.looty.production');
    expect(config.owner).toBe('looty');
    expect(config.extra?.spotlightApiBaseUrl).toBe('https://api.looty.app');
    expect(config.extra?.spotlightAppEnv).toBe('production');
    expect(config.extra?.spotlightSupabaseUrl).toBe('https://sb.looty.app');
    expect(config.extra?.eas?.projectId).toBe('12345678-1234-1234-1234-1234567890ab');
    expect(config.updates?.requestHeaders?.['expo-channel-name']).toBe('production');

    existsSpy.mockRestore();
    readSpy.mockRestore();
  });

  it('adds localization plugin with PostHog observability env values', () => {
    const config = buildExpoConfigForEnv({
      EXPO_PUBLIC_SPOTLIGHT_POSTHOG_API_KEY: 'phc_test_123',
      EXPO_PUBLIC_SPOTLIGHT_POSTHOG_ENABLED: '1',
      EXPO_PUBLIC_SPOTLIGHT_POSTHOG_HOST: 'https://us.i.posthog.com',
    }, '/virtual/LocalOverrides.xcconfig');

    expect(config.extra).toEqual(expect.objectContaining({
      spotlightPosthogApiKey: 'phc_test_123',
      spotlightPosthogEnabled: '1',
      spotlightPosthogHost: 'https://us.i.posthog.com',
    }));
    expect(config.plugins).toEqual(expect.arrayContaining([
      'expo-localization',
    ]));
  });
});
