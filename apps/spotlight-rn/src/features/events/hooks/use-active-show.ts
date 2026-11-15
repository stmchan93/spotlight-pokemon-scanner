import { useMemo, useState } from 'react';

import type { SpotlightEvent } from '@spotlight/api-client';

import { useSpotlightEvents } from '@/features/events/hooks/use-spotlight-events';
import { useSavedEvents } from '@/features/events/saved-events-store';
import { resolveRuntimeAppEnv } from '@/lib/runtime-config';

const STAGING = resolveRuntimeAppEnv() === 'staging';

/** `YYYY-MM-DD` for `now` in the show's own timezone; the device's day if the zone is unusable. */
export function eventLocalDate(timezone: string, now: Date): string {
  try {
    // en-CA formats as YYYY-MM-DD.
    return new Intl.DateTimeFormat('en-CA', {
      day: '2-digit',
      month: '2-digit',
      timeZone: timezone || undefined,
      year: 'numeric',
    }).format(now);
  } catch {
    const pad = (value: number) => String(value).padStart(2, '0');
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  }
}

function dayBefore(date: string): string {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, (day ?? 1) - 1)).toISOString().slice(0, 10);
}

/** Booth window: the setup day before the show through its last day, in the show's timezone. */
export function isInBoothWindow(
  event: Pick<SpotlightEvent, 'startDate' | 'endDate' | 'timezone'>,
  now: Date,
): boolean {
  if (!event.startDate || !event.endDate) {
    return false;
  }
  const today = eventLocalDate(event.timezone, now);
  return today >= dayBefore(event.startDate) && today <= event.endDate;
}

type PickOptions = {
  /** Booths need a floor map; a plain show tag doesn't. */
  mappedOnly?: boolean;
  /** With no show on, the latest mapped show stands in (so between-show testing works). */
  stagingFallback?: boolean;
};

/** The show in its window right now, or (staging only) the latest mapped show. */
export function pickActiveShow(
  events: readonly SpotlightEvent[],
  now: Date,
  { mappedOnly = false, stagingFallback = STAGING }: PickOptions = {},
): SpotlightEvent | null {
  const candidates = mappedOnly ? events.filter((item) => item.floorMapUrl != null) : events;
  const live = candidates.find((item) => isInBoothWindow(item, now));
  if (live || !stagingFallback) {
    return live ?? null;
  }
  return (
    [...events]
      .filter((item) => item.floorMapUrl != null)
      .sort((a, b) => (b.startDate ?? '').localeCompare(a.startDate ?? ''))[0] ?? null
  );
}

/** Whether posts can be tagged to this show now: in its window, or anything on staging. */
export function canTagShow(event: SpotlightEvent, now: Date, staging = STAGING): boolean {
  return staging || isInBoothWindow(event, now);
}

type UseActiveShowOptions = {
  /** A show the caller names (`/new-post?eventId=`): used only while it can be tagged. */
  eventId?: string | null;
  enabled?: boolean;
};

/** The show a post can be tagged to right now, or null. */
export function useActiveShow({ eventId, enabled = true }: UseActiveShowOptions = {}): SpotlightEvent | null {
  const { events } = useSpotlightEvents(enabled);
  // The window is a day wide; checking it once per mount is enough.
  const [now] = useState(() => new Date());
  return useMemo(() => {
    if (!enabled) {
      return null;
    }
    if (eventId) {
      const named = events.find((item) => item.id === eventId) ?? null;
      return named && canTagShow(named, now) ? named : null;
    }
    return pickActiveShow(events, now);
  }, [enabled, eventId, events, now]);
}

/**
 * The show the Home feed offers a chip for: the one in its window (staging:
 * the latest mapped show), else the soonest saved show that hasn't ended.
 */
export function pickFeedShow(
  events: readonly SpotlightEvent[],
  savedIds: ReadonlySet<string>,
  now: Date,
  stagingFallback = STAGING,
): SpotlightEvent | null {
  const active = pickActiveShow(events, now, { stagingFallback });
  if (active) {
    return active;
  }
  return (
    events
      .filter((item) => savedIds.has(item.id) && item.status !== 'past')
      .sort((a, b) => (a.startDate ?? '').localeCompare(b.startDate ?? ''))[0] ?? null
  );
}

export function useFeedShow(): SpotlightEvent | null {
  const { events } = useSpotlightEvents();
  const { savedIds } = useSavedEvents();
  const [now] = useState(() => new Date());
  return useMemo(() => pickFeedShow(events, savedIds, now), [events, now, savedIds]);
}
