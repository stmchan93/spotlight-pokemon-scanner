import { useEffect, useRef, useState } from 'react';

import type { SpotlightEvent, SpotlightEventsFeed } from '@spotlight/api-client';

import { useMetaFeedRead } from '@/features/meta-feed/hooks/use-meta-feed-read';

// The list is hand-maintained server side and changes a few times a year.
export const SPOTLIGHT_EVENTS_STALE_AFTER_MS = 30 * 60_000;
const SPOTLIGHT_EVENTS_CACHE_KEY = 'spotlightEvents';

export type UseSpotlightEventsResult = {
  events: SpotlightEvent[];
  loading: boolean;
  /** The first read finished with nothing to show (error or route absent). */
  failed: boolean;
  refresh: () => Promise<void>;
};

/**
 * Shared cache with the detail page, so pushing an event paints instantly.
 * `useMetaFeedRead` logs failures instead of surfacing them, so "failed" is
 * inferred: a read finished and there is still no payload.
 */
export function useSpotlightEvents(): UseSpotlightEventsResult {
  const read = useMetaFeedRead<SpotlightEventsFeed>(
    SPOTLIGHT_EVENTS_CACHE_KEY,
    (repository) => repository.fetchSpotlightEvents(),
    SPOTLIGHT_EVENTS_STALE_AFTER_MS,
  );
  const [settled, setSettled] = useState(false);
  const wasLoadingRef = useRef(false);

  useEffect(() => {
    if (wasLoadingRef.current && !read.loading) {
      setSettled(true);
    }
    wasLoadingRef.current = read.loading;
  }, [read.loading]);

  return {
    events: read.data?.items ?? [],
    loading: read.loading,
    failed: settled && !read.loading && read.data == null,
    refresh: read.refresh,
  };
}

export function useSpotlightEvent(eventId: string): UseSpotlightEventsResult & { event: SpotlightEvent | null } {
  const result = useSpotlightEvents();
  return { ...result, event: result.events.find((item) => item.id === eventId) ?? null };
}
