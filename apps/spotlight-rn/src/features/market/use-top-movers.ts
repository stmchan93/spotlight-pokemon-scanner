import { useCallback, useEffect, useRef, useState } from 'react';

import type { TopMovers } from '@spotlight/api-client';

import { useAppServices } from '@/providers/app-providers';

/**
 * How old the Top Trends rail may be before returning to the feed refetches it.
 *
 * Much wider than the feed's own 30s: the movers are computed from the daily
 * price sync, so the payload changes once a day. Half an hour keeps a long
 * session from going stale across a sync without putting a round trip on every
 * tab bounce.
 */
export const TOP_MOVERS_STALE_AFTER_MS = 30 * 60_000;

export type UseTopMoversResult = {
  /** Last good payload — the shared cache, so a remount paints instantly. */
  movers: TopMovers | null;
  /** A read is in flight. Only worth a skeleton when `movers` is null. */
  loading: boolean;
  /** Unconditional refetch (pull-to-refresh). Never throws. */
  refresh: () => Promise<void>;
  /** Refetch only if the last successful read is older than the window. */
  refreshIfStale: () => void;
};

/**
 * Catalog-wide "Top Trends" market movers for the Home feed.
 *
 * The payload lives in `AppServices.topMoversCache` rather than local state so
 * it outlives this screen: a failed read keeps whatever was last shown (the
 * cache is only written on success), and the feed's next mount paints the
 * cached rail while a fresh read runs. Failures are logged, not surfaced — the
 * rail is decoration on the feed, and an error card in its place would read
 * louder than the content it replaces.
 */
export function useTopMovers(): UseTopMoversResult {
  const { spotlightRepository, topMoversCache, setTopMoversCache } = useAppServices();
  const [loading, setLoading] = useState(false);
  // When the displayed payload was fetched; drives the staleness check. Lives
  // with the hook (not the cache) so a remount re-validates the cached copy.
  const lastFetchedAtRef = useRef(0);
  // Latest-request-wins: a slow refresh must not overwrite a faster later one.
  const fetchTokenRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    const token = ++fetchTokenRef.current;
    setLoading(true);
    try {
      const next = await spotlightRepository.getTopMovers();
      if (token !== fetchTokenRef.current || !mountedRef.current) {
        return;
      }
      setTopMoversCache(next);
      lastFetchedAtRef.current = Date.now();
    } catch (error) {
      // Keep the cached payload on screen; the next focus/refresh retries.
      console.warn('[social] top movers fetch failed', error);
    } finally {
      if (token === fetchTokenRef.current && mountedRef.current) {
        setLoading(false);
      }
    }
  }, [setTopMoversCache, spotlightRepository]);

  const refreshIfStale = useCallback(() => {
    if (Date.now() - lastFetchedAtRef.current >= TOP_MOVERS_STALE_AFTER_MS) {
      void refresh();
    }
  }, [refresh]);

  // First read on mount. Goes through the staleness check so a repository
  // swap (sign-in) re-validates rather than blindly refetching.
  useEffect(() => {
    refreshIfStale();
  }, [refreshIfStale]);

  return { movers: topMoversCache, loading, refresh, refreshIfStale };
}
