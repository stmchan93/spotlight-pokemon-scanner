describe('posthog module', () => {
  const originalEnv = process.env;

  afterEach(() => {
    process.env = originalEnv;
    jest.resetModules();
    jest.clearAllMocks();
    jest.unmock('posthog-react-native');
    jest.unmock('@/lib/runtime-config');
    jest.unmock('@/lib/observability/context');
    jest.unmock('@/lib/observability/privacy');
  });

  function loadPostHogModule({
    enabled = true,
    apiKey = 'posthog-key',
    host = 'https://us.i.posthog.com',
    nodeEnv = 'development',
  }: {
    enabled?: boolean;
    apiKey?: string;
    host?: string;
    nodeEnv?: string;
  } = {}) {
    process.env = {
      ...originalEnv,
      NODE_ENV: nodeEnv,
    } as NodeJS.ProcessEnv;

    const register = jest.fn(async () => {});
    const capture = jest.fn();
    const screen = jest.fn(async () => {});
    const identify = jest.fn();
    const reset = jest.fn();
    const scrubObservabilityValue = jest.fn((value) => (
      value && typeof value === 'object'
        ? { ...value as Record<string, unknown>, scrubbed: true }
        : value
    ));

    jest.doMock('posthog-react-native', () => {
      const React = require('react') as typeof import('react');
      const PostHog = jest.fn().mockImplementation((_apiKey: string, config: Record<string, unknown>) => ({
        capture,
        config,
        identify,
        register,
        reset,
        screen,
      }));
      return {
        PostHog,
        PostHogProvider: ({
          autocapture,
          children,
          client,
        }: {
          autocapture: boolean;
          children: React.ReactNode;
          client: unknown;
        }) => React.createElement(React.Fragment, null, children),
      };
    });
    jest.doMock('@/lib/runtime-config', () => ({
      resolveRuntimeBoolean: jest.fn(() => enabled),
      resolveRuntimeValue: jest.fn((envKeys: string[]) => {
        if (envKeys.includes('EXPO_PUBLIC_SPOTLIGHT_POSTHOG_API_KEY')) {
          return apiKey;
        }

        if (envKeys.includes('EXPO_PUBLIC_SPOTLIGHT_POSTHOG_HOST')) {
          return host;
        }

        return '';
      }),
    }));
    jest.doMock('@/lib/observability/context', () => ({
      getObservabilityAppContext: jest.fn(() => ({
        appEnv: 'staging',
        appVersion: '1.2.3',
        buildNumber: '45',
        platform: 'ios',
      })),
      getObservabilityUserTraits: jest.fn((user) => ({
        labeler_enabled: user.labelerEnabled,
        name: user.displayName,
      })),
      getPostHogCustomAppProperties: jest.fn(() => ({
        expo_runtime: 'dev-client',
      })),
    }));
    jest.doMock('@/lib/observability/privacy', () => ({
      scrubObservabilityValue,
    }));

    let moduleExports: typeof import('@/lib/observability/posthog');
    let React: typeof import('react');
    jest.isolateModules(() => {
      React = require('react') as typeof import('react');
      moduleExports = require('@/lib/observability/posthog') as typeof import('@/lib/observability/posthog');
    });

    return {
      React: React!,
      capture,
      identify,
      moduleExports: moduleExports!,
      register,
      reset,
      screen,
      scrubObservabilityValue,
    };
  }

  it('stays disabled in test runtime and returns children without a provider wrapper', () => {
    const { React, capture, identify, moduleExports, register, screen } = loadPostHogModule({
      enabled: true,
      nodeEnv: 'test',
    });

    expect(moduleExports.getPostHogClient()).toBeNull();

    moduleExports.capturePostHogEvent('scanner_opened', { raw: true });
    moduleExports.capturePostHogScreen('scan');
    moduleExports.identifyPostHogUser(null);

    expect(capture).not.toHaveBeenCalled();
    expect(screen).not.toHaveBeenCalled();
    expect(identify).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();

    const element = moduleExports.PostHogAppProvider({
      children: React.createElement('Text', null, 'child'),
    });
    expect(element.props.children).toBeTruthy();
  });

  it('creates a client, registers base properties, and scrubs tracked events', () => {
    const { capture, moduleExports, register, screen, scrubObservabilityValue } = loadPostHogModule({
      enabled: true,
      nodeEnv: 'production',
    });

    const client = moduleExports.getPostHogClient();

    expect(client).not.toBeNull();
    expect(register).toHaveBeenCalledWith({
      app_env: 'staging',
      app_version: '1.2.3',
      build_number: '45',
      platform: 'ios',
    });

    moduleExports.capturePostHogEvent('scanner_opened', { source: 'camera' });
    expect(capture).toHaveBeenCalledWith('scanner_opened', {
      app_env: 'staging',
      app_version: '1.2.3',
      build_number: '45',
      platform: 'ios',
      scrubbed: true,
      source: 'camera',
    });

    moduleExports.capturePostHogScreen('scan', { section: 'tray' });
    expect(screen).toHaveBeenCalledWith('scan', {
      app_env: 'staging',
      app_version: '1.2.3',
      build_number: '45',
      platform: 'ios',
      scrubbed: true,
      section: 'tray',
    });

    const providerElement = moduleExports.PostHogAppProvider({
      children: 'content',
    });
    expect(providerElement.props.children).toBe('content');
    expect(providerElement.props.autocapture).toBe(false);
    expect(providerElement.props.client).toBe(client);
    expect((moduleExports.getPostHogClient() as any).config.customAppProperties).toEqual({
      expo_runtime: 'dev-client',
    });

    expect(scrubObservabilityValue).toHaveBeenCalled();
  });

  it('identifies and resets users, and exposes a scrubbed before_send hook', () => {
    const { identify, moduleExports, register, reset } = loadPostHogModule({
      enabled: true,
      nodeEnv: 'production',
    });

    const client = moduleExports.getPostHogClient() as {
      config?: { before_send?: (event: Record<string, unknown>) => Record<string, unknown> | null };
    };
    const beforeSend = client.config?.before_send;

    // Cold start: the auth-sync effect fires with null before the session
    // restores — must NOT reset (that would mint a new anonymous distinct_id
    // on every app launch).
    moduleExports.identifyPostHogUser(null);
    expect(reset).not.toHaveBeenCalled();

    // A PENDING guest (guest mode before its Supabase user is minted) carries a
    // placeholder id that is identical on every device. Identifying it would
    // merge every pending guest in the world into one person, so it is ignored
    // — and it must not reset the anonymous distinct_id either.
    moduleExports.identifyPostHogUser({
      adminEnabled: false,
      avatarURL: null,
      displayName: 'Guest',
      email: null,
      id: 'pending-guest',
      labelerEnabled: false,
      providers: [],
    });
    expect(identify).not.toHaveBeenCalled();
    expect(reset).not.toHaveBeenCalled();

    moduleExports.identifyPostHogUser({
      adminEnabled: false,
      avatarURL: null,
      displayName: 'Collector',
      email: 'collector@example.com',
      id: 'user-123',
      labelerEnabled: true,
      providers: ['google'],
    });
    expect(identify).toHaveBeenCalledWith('user-123', {
      labeler_enabled: true,
      name: 'Collector',
    });

    // Real sign-out after an identify DOES reset.
    moduleExports.identifyPostHogUser(null);
    expect(reset).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledTimes(2);

    // Event properties are scrubbed; $set/$set_once (curated person traits —
    // display name for a readable Persons UI; deliberately no email) pass
    // through untouched.
    expect(beforeSend?.({
      event: 'scan',
      properties: { secret: 'value' },
      $set: { name: 'Collector' },
      $set_once: { first_seen: 'today' },
    })).toEqual({
      $set: { name: 'Collector' },
      $set_once: { first_seen: 'today' },
      event: 'scan',
      properties: { scrubbed: true, secret: 'value' },
    });
  });
});
