import type { ReactNode } from 'react';

import { PostHog, PostHogProvider } from 'posthog-react-native';
import type { CaptureEvent, PostHogEventProperties } from '@posthog/core';

import type { AppUser } from '@/features/auth/auth-models';
import { resolveRuntimeBoolean, resolveRuntimeValue } from '@/lib/runtime-config';

import {
  getObservabilityAppContext,
  getObservabilityUserTraits,
  getPostHogCustomAppProperties,
} from './context';
import { scrubObservabilityValue } from './privacy';

const posthogApiKey = resolveRuntimeValue(
  ['EXPO_PUBLIC_SPOTLIGHT_POSTHOG_API_KEY'],
  ['spotlightPosthogApiKey'],
);

const posthogHost = resolveRuntimeValue(
  ['EXPO_PUBLIC_SPOTLIGHT_POSTHOG_HOST'],
  ['spotlightPosthogHost'],
) || 'https://us.i.posthog.com';

const posthogEnabled = resolveRuntimeBoolean(
  ['EXPO_PUBLIC_SPOTLIGHT_POSTHOG_ENABLED'],
  ['spotlightPosthogEnabled'],
  false,
);

const posthogAppContext = getObservabilityAppContext();
const shouldEnablePostHog = process.env.NODE_ENV !== 'test' && posthogEnabled && Boolean(posthogApiKey);

let posthogClient: PostHog | null | undefined;

function buildBaseProperties() {
  return {
    app_env: posthogAppContext.appEnv,
    app_version: posthogAppContext.appVersion,
    build_number: posthogAppContext.buildNumber,
    platform: posthogAppContext.platform,
  } satisfies PostHogEventProperties;
}

function scrubPostHogProperties(properties?: PostHogEventProperties) {
  if (!properties) {
    return undefined;
  }

  return scrubObservabilityValue(properties) as PostHogEventProperties;
}

function scrubPostHogEvent(event: CaptureEvent | null) {
  if (!event) {
    return null;
  }

  return {
    ...event,
    $set: scrubPostHogProperties(event.$set),
    $set_once: scrubPostHogProperties(event.$set_once),
    properties: scrubPostHogProperties(event.properties),
  };
}

function buildTrackedPostHogProperties(properties?: PostHogEventProperties) {
  return {
    ...buildBaseProperties(),
    ...scrubPostHogProperties(properties),
  };
}

function registerBaseProperties(client: PostHog) {
  void client.register(buildBaseProperties());
}

function createPostHogClient() {
  if (!shouldEnablePostHog || !posthogApiKey) {
    return null;
  }

  const client = new PostHog(posthogApiKey, {
    host: posthogHost,
    persistence: 'file',
    disabled: !shouldEnablePostHog,
    flushAt: 20,
    flushInterval: 30000,
    maxBatchSize: 50,
    maxQueueSize: 500,
    requestTimeout: 10000,
    fetchRetryCount: 2,
    defaultOptIn: true,
    sendFeatureFlagEvent: false,
    preloadFeatureFlags: false,
    disableRemoteConfig: true,
    disableSurveys: true,
    captureAppLifecycleEvents: false,
    enableSessionReplay: false,
    personProfiles: 'identified_only',
    setDefaultPersonProperties: false,
    customAppProperties: getPostHogCustomAppProperties(),
    before_send: scrubPostHogEvent,
  });

  registerBaseProperties(client);
  return client;
}

export function getPostHogClient() {
  if (posthogClient === undefined) {
    posthogClient = createPostHogClient();
  }

  return posthogClient;
}

export function capturePostHogEvent(event: string, properties?: PostHogEventProperties) {
  const client = getPostHogClient();
  if (!client) {
    return;
  }

  client.capture(event, buildTrackedPostHogProperties(properties));
}

export function capturePostHogScreen(name: string, properties?: PostHogEventProperties) {
  const client = getPostHogClient();
  if (!client) {
    return;
  }

  void client.screen(name, buildTrackedPostHogProperties(properties));
}

export function identifyPostHogUser(user: AppUser | null) {
  const client = getPostHogClient();
  if (!client) {
    return;
  }

  if (!user) {
    client.reset();
    registerBaseProperties(client);
    return;
  }

  client.identify(user.id, {
    ...getObservabilityUserTraits(user),
  });
}

export function PostHogAppProvider({ children }: { children: ReactNode }) {
  const client = getPostHogClient();

  if (!client) {
    return <>{children}</>;
  }

  return (
    <PostHogProvider autocapture={false} client={client}>
      {children}
    </PostHogProvider>
  );
}
