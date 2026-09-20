import * as Notifications from 'expo-notifications';
import { useRootNavigationState, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';

import { useAppServices } from '@/providers/app-providers';
import { useAuth } from '@/providers/auth-provider';
import {
  parseNotificationRoute,
  type NotificationRoute,
} from '@/features/notifications/notification-routing';

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
export function useNotificationTapRouter(): void {
  const router = useRouter();
  const navigationState = useRootNavigationState();
  const { spotlightRepository } = useAppServices();
  const auth = useAuth();

  const isNavigatorReady = Boolean(navigationState?.key);
  const isSignedIn = Boolean(auth.currentUser) && !auth.isGuest;

  const handledIdsRef = useRef<Set<string>>(new Set());
  const pendingRef = useRef<NotificationRoute | null>(null);
  // Bumped rather than storing the route in state: the flush effect has to
  // re-run for a REPEAT tap on the same alert too, and an identical route
  // object would not retrigger it.
  const [pendingVersion, setPendingVersion] = useState(0);

  const enqueueResponse = useCallback((response: Notifications.NotificationResponse | null) => {
    if (!response) {
      return;
    }
    const identifier = response.notification?.request?.identifier ?? null;
    if (identifier) {
      if (handledIdsRef.current.has(identifier)) {
        return;
      }
      handledIdsRef.current.add(identifier);
    }
    const route = parseNotificationRoute(response.notification?.request?.content?.data);
    if (!route) {
      return;
    }
    pendingRef.current = route;
    setPendingVersion((version) => version + 1);
  }, []);

  useEffect(() => {
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
