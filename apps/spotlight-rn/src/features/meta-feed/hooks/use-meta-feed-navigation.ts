import { useMemo } from 'react';
import { useRouter } from 'expo-router';

import type { CalendarEvent, CardGame, MetaLaneFilter } from '@spotlight/api-client';

import { openLinkOut } from '@/features/meta-feed/screens/components/open-link-out';

export type MetaGroupRouteTarget = {
  groupKey: string;
  game: CardGame;
  windowDays: number;
  lane?: MetaLaneFilter;
};

/** Params for `/meta/group/[groupKey]`; the lane drops out when it is `all`. */
export function metaGroupRouteParams(target: MetaGroupRouteTarget): Record<string, string> {
  const params: Record<string, string> = {
    game: target.game,
    groupKey: target.groupKey,
    window: String(target.windowDays),
  };
  if (target.lane && target.lane !== 'all') {
    params.lane = target.lane;
  }
  return params;
}

/**
 * Where a Coming up date goes: a set we carry opens its spotlight page,
 * otherwise the official source opens in the in-app browser. Returns false
 * when there is nowhere to go.
 */
export function openCalendarEvent(
  event: CalendarEvent,
  openSet: (setId: string) => void,
  openLink: (url: string) => void = (url) => void openLinkOut(url),
): boolean {
  if (event.setId) {
    openSet(event.setId);
    return true;
  }
  if (event.url) {
    openLink(event.url);
    return true;
  }
  return false;
}

/**
 * Pushes for the meta feed pages. Cast like the other pushes in the app:
 * typed routes are generated at build time.
 */
export function useMetaFeedNavigation() {
  const router = useRouter();
  return useMemo(() => {
    const openSetSpotlight = (setId: string) =>
      router.push({ pathname: '/set-spotlight/[setId]', params: { setId } } as never);
    return {
      openCalendar: () => router.push('/calendar' as never),
      openCalendarEvent: (event: CalendarEvent) => openCalendarEvent(event, openSetSpotlight),
      openCard: (cardId: string) => router.push({ pathname: '/cards/[cardId]', params: { cardId } }),
      openMetaGroup: (target: MetaGroupRouteTarget) =>
        router.push({ pathname: '/meta/group/[groupKey]', params: metaGroupRouteParams(target) } as never),
      openSetSpotlight,
    };
  }, [router]);
}
