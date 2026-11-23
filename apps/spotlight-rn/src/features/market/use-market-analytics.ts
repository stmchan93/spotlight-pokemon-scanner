import { useCallback, useEffect, useRef, useState } from 'react';

import type { CardGame, MarketAnalytics, MarketWindow } from '@spotlight/api-client';

import { useAppServices } from '@/providers/app-providers';

/** The payload changes with the daily price sync; half an hour is plenty fresh. */
export const MARKET_ANALYTICS_STALE_AFTER_MS = 30 * 60_000;

type CacheEntry = { data: MarketAnalytics; fetchedAt: number };

// Module-level so a remount (tab re-open, sign-in swap of the page) paints the
// last good payload at once while a fresh read runs. Keyed by game + window.
const cache = new Map<string, CacheEntry>();

function keyOf(game: CardGame, window: MarketWindow) {
  return `${game}|${window}`;
}

/** Test seam. */
export function clearMarketAnalyticsCache() {
  cache.clear();
}

export type UseMarketAnalyticsResult = {
  /** Last good payload for this game + window (null until the first read lands). */
  data: MarketAnalytics | null;
  loading: boolean;
  /** The last read failed and there is nothing cached to show. */
  failed: boolean;
  /** Unconditional refetch (pull-to-refresh, retry). Never throws. */
  refresh: () => Promise<void>;
};

export function useMarketAnalytics(game: CardGame, window: MarketWindow): UseMarketAnalyticsResult {
  const { spotlightRepository } = useAppServices();
  const key = keyOf(game, window);
  const [, setVersion] = useState(0);
  const [loadingKey, setLoadingKey] = useState<string | null>(null);
  const [failedKey, setFailedKey] = useState<string | null>(null);
  const tokenRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const load = useCallback(async (force: boolean) => {
    const entry = cache.get(key);
    if (!force && entry && Date.now() - entry.fetchedAt < MARKET_ANALYTICS_STALE_AFTER_MS) {
      return;
    }
    // Latest-request-wins: a slow read for the previous game must not land.
    const token = ++tokenRef.current;
    setLoadingKey(key);
    setFailedKey(null);
    try {
      const data = await spotlightRepository.getMarketAnalytics({ game, window });
      cache.set(key, { data, fetchedAt: Date.now() });
      if (mountedRef.current) {
        setVersion((version) => version + 1);
      }
    } catch (error) {
      console.warn('[market] analytics read failed', error);
      if (mountedRef.current && token === tokenRef.current) {
        setFailedKey(key);
      }
    } finally {
      if (mountedRef.current && token === tokenRef.current) {
        setLoadingKey(null);
      }
    }
  }, [game, key, spotlightRepository, window]);

  useEffect(() => {
    void load(false);
  }, [load]);

  const refresh = useCallback(() => load(true), [load]);
  const data = cache.get(key)?.data ?? null;

  return {
    data,
    loading: loadingKey === key,
    failed: failedKey === key && data == null,
    refresh,
  };
}
