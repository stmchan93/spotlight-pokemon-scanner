import { useCallback, useState } from 'react';
import { useFocusEffect } from 'expo-router';

import { fetchTotalUnreadMessageCount } from '@/features/social/dm-service';

/**
 * Unread DM total for the messages bubble in the Social top bar.
 *
 * Same posture as `useUnreadNotificationCount`: read on FOCUS, never polled.
 * Coming back from the inbox (which marks threads read) is a focus, so that is
 * the moment the badge clears. Client-direct Supabase, no backend call.
 */
export function useUnreadMessageCount(): number {
  const [unreadCount, setUnreadCount] = useState(0);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      void fetchTotalUnreadMessageCount().then((count) => {
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
