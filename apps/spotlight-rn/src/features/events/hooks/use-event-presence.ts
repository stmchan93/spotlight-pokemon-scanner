import { useCallback, useState } from 'react';
import { useFocusEffect } from 'expo-router';

import { fetchBrowsingNow, touchEventPresence } from '@/features/events/booth-service';

export const EVENT_PRESENCE_INTERVAL_MS = 60_000;

/**
 * Heartbeats this viewer onto the show while the page is focused and returns
 * how many people are browsing it now (null until known or when unavailable).
 */
export function useEventPresence(eventId: string): number | null {
  const [browsingNow, setBrowsingNow] = useState<number | null>(null);

  useFocusEffect(
    useCallback(() => {
      if (!eventId) {
        return undefined;
      }
      let active = true;
      const tick = () => {
        touchEventPresence(eventId);
        void fetchBrowsingNow(eventId).then((count) => {
          if (active) {
            setBrowsingNow(count);
          }
        });
      };
      tick();
      const timer = setInterval(tick, EVENT_PRESENCE_INTERVAL_MS);
      return () => {
        active = false;
        clearInterval(timer);
      };
    }, [eventId]),
  );

  return browsingNow;
}
