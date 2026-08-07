import type { ReactNode } from 'react';

import { PostHog, PostHogProvider } from 'posthog-react-native';
import type { CaptureEvent, PostHogEventProperties } from '@posthog/core';

import { PENDING_GUEST_USER_ID, type AppUser } from '@/features/auth/auth-models';
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

  // Event properties are scrubbed (they can carry scan payloads, URLs, card
  // ids…). `$set`/`$set_once` are NOT: they only ever carry the curated person
  // traits from getObservabilityUserTraits (email/name/flags), which exist
  // precisely to make the PostHog Persons UI human-readable — scrubbing them
  // stored literal "[redacted]" as every user's email.
  return {
    ...event,
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
    // Application Opened/Installed/Updated/Backgrounded/Became Active — pure
    // JS (AppState-based), OTA-safe. Required for real session/open counts and
    // retention metrics; without it only $screen approximates activity.
    captureAppLifecycleEvents: true,
    // Crash visibility without a separate crash reporter (no Sentry): PostHog's
    // built-in error tracking chains the global JS error handler and the
    // unhandled-rejection tracker, sending `$exception` events to Error Tracking.
    // `console: false` keeps dev console.error noise out of the crash feed; React
    // render errors are reported separately by AppErrorBoundary (which also shows
    // a recovery screen). Native (non-JS) crashes are out of scope.
    errorTracking: {
      autocapture: {
        uncaughtExceptions: true,
        unhandledRejections: true,
        console: false,
      },
    },
    // Session replay: record the FLOW (screens, taps, navigation) to see where
    // users drop off — NOT their content. Privacy-first masking: card scan images
    // and thumbnails are blocked out, and text inputs (email/password) are masked.
    // Only active where PostHog itself is (production). Free under 5k recordings/mo.
    enableSessionReplay: true,
    sessionReplayConfig: {
      maskAllImages: true,
      maskAllTextInputs: true,
      captureNetworkTelemetry: false,
    },
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

/**
 * Report a caught/boundary error to PostHog Error Tracking as a `$exception`
 * (shaped by the SDK's captureException). Used by AppErrorBoundary; global
 * uncaught errors and unhandled rejections are auto-captured via the client's
 * `errorTracking.autocapture` config.
 */
export function capturePostHogException(error: unknown, properties?: PostHogEventProperties) {
  const client = getPostHogClient();
  if (!client) {
    return;
  }

  client.captureException(error, buildTrackedPostHogProperties(properties));
}

export function capturePostHogScreen(name: string, properties?: PostHogEventProperties) {
  const client = getPostHogClient();
  if (!client) {
    return;
  }

  void client.screen(name, buildTrackedPostHogProperties(properties));
}

// Tracks whether this process ever identified a user, so the auth-sync effect
// firing with `null` during cold start (before the Supabase session restores)
// doesn't call reset(). Resetting on every launch minted a fresh anonymous
// distinct_id per app open — real users accumulated dozens of merged anon ids.
let hasIdentifiedUser = false;

export function identifyPostHogUser(user: AppUser | null) {
  const client = getPostHogClient();
  if (!client) {
    return;
  }

  // A pending guest's id is a placeholder shared by every device, so
  // identifying it would collapse all of them into ONE PostHog person and make
  // user counts meaningless. Leave them on their per-device anonymous
  // distinct_id; the real uuid arrives when the guest's first scan mints one.
  // Not a reset either — that would throw the anonymous id away.
  if (user?.id === PENDING_GUEST_USER_ID) {
    return;
  }

  if (!user) {
    if (!hasIdentifiedUser) {
      return;
    }
    hasIdentifiedUser = false;
    client.reset();
    registerBaseProperties(client);
    return;
  }

  hasIdentifiedUser = true;
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
