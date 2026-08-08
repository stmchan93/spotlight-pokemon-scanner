import { useCallback, useState } from 'react';
import { useFocusEffect } from 'expo-router';

import { fetchUnreadNotificationCount } from '@/features/social/social-service';

/**
 * Unread count for the bell badge in the Home top bar.
 *
 * Refreshed on FOCUS rather than on an interval: returning from the
 * notifications list (which marks everything read) is the moment the badge must
 * clear, and focus is exactly that moment. It also means no timer runs while the
 * user is elsewhere in the app.
 *
 * This is a client-direct Supabase count, not a backend call — it never touches
 * the VM, so polling it costs nothing on the resource that actually constrains
 * this app. `cancelled` guards the async set against a fast unmount.
 *
 * Shared because the same bar is now drawn by two screens (Home and Collection),
 * and a badge that cleared on one but not the other would read as a bug.
 */
export function useUnreadNotificationCount(): number {
  const [unreadCount, setUnreadCount] = useState(0);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      void fetchUnreadNotificationCount().then((count) => {
        if (!cancelled) {
          setUnreadCount(count);
        }
      });
      return () => {
        cancelled = true;
      };
    }, []),
  );

  return unreadCount;
}
