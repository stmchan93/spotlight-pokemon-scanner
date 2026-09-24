import { useEffect, useRef, useState } from 'react';

import type {
  CalendarFeed,
  CalendarQuery,
  MetaGroupDetail,
  MetaGroupDetailQuery,
  MetaPulse,
  MetaPulseQuery,
  NewsFeed,
  NewsFeedQuery,
  SetSpotlight,
  SetSpotlightQuery,
} from '@spotlight/api-client';

import {
  metaFeedCacheKey,
  useCalendar,
  useMetaGroupDetail,
  useMetaPulse,
  useNewsFeed,
  useSetSpotlight,
} from '@/features/meta-feed/hooks/use-meta-feed';
import type { UseMetaFeedReadResult } from '@/features/meta-feed/hooks/use-meta-feed-read';
import { useAppServices } from '@/providers/app-providers';

/**
 * - `ready`: data on screen (possibly refreshing)
 * - `loading`: first read for this query in flight, nothing cached
 * - `disabled`: the server answered 404 "disabled" (feature flag off)
 * - `error`: the read failed and nothing is cached for this query
 */
export type MetaPageStatus = 'ready' | 'loading' | 'disabled' | 'error';

export type MetaPageData<T> = {
  data: T | null;
  loading: boolean;
  refresh: () => Promise<void>;
  status: MetaPageStatus;
};

/**
 * The feed hooks swallow failures (right for decorative blocks) and fold
 * "never loaded" and "flag off" into `data: null`. A full page has to tell
 * loading, off and failed apart, so this reads the shared cache entry directly
 * — `undefined` = never landed, `null` = disabled — and tracks whether a read
 * for the current key has finished.
 */
function usePageStatus<T>(read: string, query: object, result: UseMetaFeedReadResult<T>): MetaPageData<T> {
  const { metaFeedCache } = useAppServices();
  const key = metaFeedCacheKey(read, query);
  const entry = metaFeedCache[key];
  const [settledKey, setSettledKey] = useState<string | null>(null);
  const sawLoadingRef = useRef<string | null>(null);

  useEffect(() => {
    if (result.loading) {
      sawLoadingRef.current = key;
    } else if (sawLoadingRef.current === key) {
      setSettledKey(key);
    }
  }, [key, result.loading]);

  let status: MetaPageStatus;
  if (result.data != null) {
    status = 'ready';
  } else if (entry === null) {
    status = 'disabled';
  } else if (settledKey === key && !result.loading) {
    status = 'error';
  } else {
    status = 'loading';
  }

  return { data: result.data, loading: result.loading, refresh: result.refresh, status };
}

export function useMetaPageData(query: MetaPulseQuery): MetaPageData<MetaPulse> {
  return usePageStatus('metaPulse', query, useMetaPulse(query));
}

export function useSetSpotlightPageData(query: SetSpotlightQuery): MetaPageData<SetSpotlight> {
  return usePageStatus('setSpotlight', query, useSetSpotlight(query));
}

export function useNewsPageData(query: NewsFeedQuery): MetaPageData<NewsFeed> {
  return usePageStatus('newsFeed', query, useNewsFeed(query));
}

export function useMetaGroupPageData(query: MetaGroupDetailQuery): MetaPageData<MetaGroupDetail> {
  return usePageStatus('metaGroup', query, useMetaGroupDetail(query));
}

export function useCalendarPageData(query: CalendarQuery): MetaPageData<CalendarFeed> {
  return usePageStatus('calendar', query, useCalendar(query));
}
