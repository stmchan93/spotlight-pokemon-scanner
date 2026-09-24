import { useCallback, useEffect, useRef, useState } from 'react';

import type { SpotlightRepository } from '@spotlight/api-client';

import { useAppServices } from '@/providers/app-providers';

export type UseMetaFeedReadResult<T> = {
  /**
   * Last good payload for this key — shared across mounts, so a remount paints
   * instantly. `null` both before the first read lands and when the server has
   * the feature switched off; either way the block renders nothing.
   */
  data: T | null;
  /** A read is in flight. Blocks don't skeleton on it (no placeholder flash). */
  loading: boolean;
  /** Unconditional refetch (pull-to-refresh). Never throws. */
  refresh: () => Promise<void>;
  /** Refetch only if the last successful read is older than the window. */
  refreshIfStale: () => void;
};

/**
 * The shared read loop behind the meta feed hooks, mirroring `useTopMovers`:
 * the payload lives in `AppServices.metaFeedCache` under `cacheKey`, is only
 * written on success (a failed read keeps what was shown), is latest-request-
 * wins, and re-validates on mount through the staleness check. Failures are
 * logged, not surfaced — these blocks are decoration on the feed.
 */
export function useMetaFeedRead<T>(
  cacheKey: string,
  read: (repository: SpotlightRepository) => Promise<T | null>,
  staleAfterMs: number,
): UseMetaFeedReadResult<T> {
  const { spotlightRepository, metaFeedCache, setMetaFeedCacheEntry } = useAppServices();
  const [loading, setLoading] = useState(false);
  const lastFetchedAtRef = useRef(0);
  const fetchTokenRef = useRef(0);
  const mountedRef = useRef(true);
  // The read closure is rebuilt every render; the key is what identifies it.
  const readRef = useRef(read);
  readRef.current = read;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // A new key (different query) is a different payload: forget the old stamp.
  useEffect(() => {
    lastFetchedAtRef.current = 0;
  }, [cacheKey]);

  const refresh = useCallback(async () => {
    const token = ++fetchTokenRef.current;
    setLoading(true);
    try {
      const next = await readRef.current(spotlightRepository);
      if (token !== fetchTokenRef.current || !mountedRef.current) {
        return;
      }
      setMetaFeedCacheEntry(cacheKey, next);
      lastFetchedAtRef.current = Date.now();
    } catch (error) {
      console.warn(`[meta-feed] ${cacheKey} fetch failed`, error);
    } finally {
      if (token === fetchTokenRef.current && mountedRef.current) {
        setLoading(false);
      }
    }
  }, [cacheKey, setMetaFeedCacheEntry, spotlightRepository]);

  const refreshIfStale = useCallback(() => {
    if (Date.now() - lastFetchedAtRef.current >= staleAfterMs) {
      void refresh();
    }
  }, [refresh, staleAfterMs]);

  useEffect(() => {
    refreshIfStale();
  }, [refreshIfStale]);

  const cached = metaFeedCache[cacheKey];
  return {
    data: cached === undefined ? null : (cached as T | null),
    loading,
    refresh,
    refreshIfStale,
  };
}
