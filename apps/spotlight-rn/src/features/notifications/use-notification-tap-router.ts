import type { NotificationResponse } from 'expo-notifications';
import { useRootNavigationState, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';

import { useAppServices } from '@/providers/app-providers';
import { useAuth } from '@/providers/auth-provider';
import {
  parseNotificationRoute,
  pushOpenedAnalyticsProps,
  type NotificationRoute,
} from '@/features/notifications/notification-routing';
import { loadNotificationsModule } from '@/features/notifications/notifications-module';
import { AnalyticsEvent } from '@/lib/observability/analytics-events';
import { capturePostHogEvent } from '@/lib/observability/posthog';
import { debugTrace } from '@/lib/observability/debug-trace';

/**
 * Routes a TAPPED notification, from the root layout.
 *
 * Two arrival paths, and both are needed:
 *
 * - WARM — `addNotificationResponseReceivedListener` fires while the JS context
 *   is alive (foreground or backgrounded-but-running).
 * - COLD — a tap that LAUNCHES the app happens before any listener exists, so
 *   the response is only recoverable from `getLastNotificationResponseAsync`.
 *   Without it, tapping a deal alert from a killed app just opens the home tab
 *   and the deal is lost.
 *
 * They overlap: a cold start can deliver the same response through both, so
 * taps are deduped by the notification's request identifier.
 *
 * Navigation is HELD until the root navigator exists and the user is signed in.
 * Pushing a route before the navigator mounts is a silent no-op, and pushing
 * `/wishlist` at someone sitting on the sign-in screen would be worse than
 * doing nothing.
 */
// Module scope, not a ref: a cold-start navigation can remount the whole app
// tree inside the same JS runtime, and a per-mount memory then re-read the
// launch notification and navigated again — forever (the 2026-09-24 push-tap
// flicker: signed-in state flipping ~3x/s until force-quit).
const handledNotificationIds = new Set<string>();

export function __resetNotificationTapRouterForTests(): void {
  handledNotificationIds.clear();
}

export function useNotificationTapRouter(): void {
  const router = useRouter();
  const navigationState = useRootNavigationState();
  const { spotlightRepository } = useAppServices();
  const auth = useAuth();

  const isNavigatorReady = Boolean(navigationState?.key);
  const isSignedIn = Boolean(auth.currentUser) && !auth.isGuest;

  const pendingRef = useRef<NotificationRoute | null>(null);
  // Bumped rather than storing the route in state: the flush effect has to
  // re-run for a REPEAT tap on the same alert too, and an identical route
  // object would not retrigger it.
  const [pendingVersion, setPendingVersion] = useState(0);

  const enqueueResponse = useCallback((response: NotificationResponse | null) => {
    if (!response) {
      return;
    }
    const identifier = response.notification?.request?.identifier ?? null;
    debugTrace('push_enqueue', { has_identifier: Boolean(identifier), seen: identifier ? handledNotificationIds.has(identifier) : false, handled_count: handledNotificationIds.size });
    if (identifier) {
      if (handledNotificationIds.has(identifier)) {
        return;
      }
      handledNotificationIds.add(identifier);
    }
    // The launch response is sticky for the life of the process; once handled,
    // clear it so no later mount can replay it.
    clearLaunchResponse();
    const data = response.notification?.request?.content?.data;
    const route = parseNotificationRoute(data);
    if (!route) {
      return;
    }
    capturePostHogEvent(AnalyticsEvent.pushOpened, pushOpenedAnalyticsProps(data));
    pendingRef.current = route;
    setPendingVersion((version) => version + 1);
  }, []);

  useEffect(() => {
    debugTrace('push_router_mounted');
    const Notifications = loadNotificationsModule();
    if (!Notifications) {
      return;
    }
    let cancelled = false;
    void Notifications.getLastNotificationResponseAsync()
      .then((response) => {
        if (!cancelled) {
          enqueueResponse(response);
        }
      })
      .catch(() => {
        // No launch notification, or the module could not read it.
      });
    return () => {
      cancelled = true;
    };
  }, [enqueueResponse]);

  useEffect(() => {
    // A binary without the native module has no notifications to route.
    const Notifications = loadNotificationsModule();
    if (!Notifications) {
      return;
    }
    const subscription = Notifications.addNotificationResponseReceivedListener(enqueueResponse);
    return () => {
      subscription.remove();
    };
  }, [enqueueResponse]);

  useEffect(() => {
    const route = pendingRef.current;
    if (!route || !isNavigatorReady || !isSignedIn) {
      return;
    }
    pendingRef.current = null;
    debugTrace('push_flush', { url_length: route.url.length });
    // `as never`: the payload's url is a runtime string, so it cannot satisfy
    // typed routes' literal union. It is validated in `parseNotificationRoute`.
    router.push(route.url as never);
    if (route.alertId) {
      // AFTER the push, and not awaited: `tappedAt` is the column the deal
      // radar's whole product read is computed from, and the server dedupes, so
      // every tap sends one. Losing the write must never cost the navigation.
      void spotlightRepository.markDealAlertTapped(route.alertId);
    }
  }, [isNavigatorReady, isSignedIn, pendingVersion, router, spotlightRepository]);
}

function clearLaunchResponse(): void {
  const Notifications = loadNotificationsModule();
  try {
    if (Notifications && typeof Notifications.clearLastNotificationResponse === 'function') {
      Notifications.clearLastNotificationResponse();
    } else if (Notifications && typeof Notifications.clearLastNotificationResponseAsync === 'function') {
      void Notifications.clearLastNotificationResponseAsync().catch(() => {});
    }
  } catch {
    // Best-effort: the id set above already stops a replay in this process.
  }
}
