import type {
  CalendarFeed,
  CalendarQuery,
  HotCards,
  HotCardsQuery,
  MetaExposure,
  MetaExposureQuery,
  MetaGroupDetail,
  MetaGroupDetailQuery,
  MetaPulse,
  MetaPulseQuery,
  NewsFeed,
  NewsFeedQuery,
  SetSpotlight,
  SetSpotlightQuery,
} from '@spotlight/api-client';

import { useAppServices } from '@/providers/app-providers';

import { useMetaFeedRead, type UseMetaFeedReadResult } from './use-meta-feed-read';

/*
  Staleness windows, matched to how often each payload is recomputed server
  side: meta pulse and set spotlight are nightly/weekly jobs (same 30 min as
  Top Trends), hot cards is a rolling 24h count, news polls hourly.
*/
export const META_PULSE_STALE_AFTER_MS = 30 * 60_000;
export const HOT_CARDS_STALE_AFTER_MS = 10 * 60_000;
export const SET_SPOTLIGHT_STALE_AFTER_MS = 30 * 60_000;
export const NEWS_FEED_STALE_AFTER_MS = 15 * 60_000;
// Exposure follows the viewer's collection, so it goes stale faster than the
// nightly market payloads it is joined to.
export const META_EXPOSURE_STALE_AFTER_MS = 5 * 60_000;
export const CALENDAR_STALE_AFTER_MS = 60 * 60_000;

/** How many dates the feed's Coming up block shows. */
export const CALENDAR_BLOCK_LIMIT = 3;

/** How many headlines the feed's Card news block shows. */
export const NEWS_FEED_BLOCK_LIMIT = 3;

// Stable cache key for a query: undefined/null fields drop out so `{}` and
// `{ game: undefined }` share one entry.
export function metaFeedCacheKey(read: string, query: object | undefined): string {
  const entries = Object.entries(query ?? {})
    .filter(([, value]) => value != null && value !== '')
    .sort(([a], [b]) => a.localeCompare(b));
  return entries.length === 0
    ? read
    : `${read}?${entries.map(([key, value]) => `${key}=${String(value)}`).join('&')}`;
}

export function useMetaPulse(query?: MetaPulseQuery): UseMetaFeedReadResult<MetaPulse> {
  return useMetaFeedRead(
    metaFeedCacheKey('metaPulse', query),
    (repository) => repository.fetchMetaPulse(query),
    META_PULSE_STALE_AFTER_MS,
  );
}

export function useHotCards(query?: HotCardsQuery): UseMetaFeedReadResult<HotCards> {
  return useMetaFeedRead(
    metaFeedCacheKey('hotCards', query),
    (repository) => repository.fetchHotCards(query),
    HOT_CARDS_STALE_AFTER_MS,
  );
}

export function useSetSpotlight(query?: SetSpotlightQuery): UseMetaFeedReadResult<SetSpotlight> {
  return useMetaFeedRead(
    metaFeedCacheKey('setSpotlight', query),
    (repository) => repository.fetchSetSpotlight(query),
    SET_SPOTLIGHT_STALE_AFTER_MS,
  );
}

/**
 * One page of the news feed for `query`. The feed block passes
 * `{ limit: NEWS_FEED_BLOCK_LIMIT }`; the News page can pass its own filters
 * and handle `nextCursor` paging itself.
 */
export function useNewsFeed(query?: NewsFeedQuery): UseMetaFeedReadResult<NewsFeed> {
  return useMetaFeedRead(
    metaFeedCacheKey('newsFeed', query),
    (repository) => repository.fetchNewsFeed(query),
    NEWS_FEED_STALE_AFTER_MS,
  );
}

export function useMetaGroupDetail(query: MetaGroupDetailQuery): UseMetaFeedReadResult<MetaGroupDetail> {
  return useMetaFeedRead(
    metaFeedCacheKey('metaGroup', query),
    (repository) => repository.fetchMetaGroupDetail(query),
    META_PULSE_STALE_AFTER_MS,
  );
}

/**
 * The viewer's own exposure is ACCOUNT data: its cache key carries the session
 * owner, so one account's holdings can never paint for another (the same rule
 * as every other owner-scoped cache — see `sessionOwnerKey`).
 */
export function metaExposureCacheKey(ownerKey: string, query?: MetaExposureQuery): string {
  return metaFeedCacheKey('metaExposure', { ...query, owner: ownerKey });
}

export function useMetaExposure(
  query?: MetaExposureQuery,
  options?: { enabled?: boolean },
): UseMetaFeedReadResult<MetaExposure> {
  const { sessionOwnerKey } = useAppServices();
  return useMetaFeedRead(
    metaExposureCacheKey(sessionOwnerKey, query),
    (repository) => repository.fetchMetaExposure(query),
    META_EXPOSURE_STALE_AFTER_MS,
    options?.enabled ?? true,
  );
}

export function useCalendar(query?: CalendarQuery): UseMetaFeedReadResult<CalendarFeed> {
  return useMetaFeedRead(
    metaFeedCacheKey('calendar', query),
    (repository) => repository.fetchCalendar(query),
    CALENDAR_STALE_AFTER_MS,
  );
}
