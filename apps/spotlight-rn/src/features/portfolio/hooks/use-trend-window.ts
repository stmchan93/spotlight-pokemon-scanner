import { useCallback, useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

export const TREND_WINDOW_STORAGE_KEY = '@spotlight/portfolio/trend-window';

/**
 * Which baseline the collection/wishlist trend percents are relative to:
 * `'sinceAdded'` (total return since the card was added/wishlisted) or
 * `'30d'` (the last-30-days sparkline trend). Toggled by the shared
 * `TrendWindowTag` and consumed by rows AND grid tiles on both screens.
 */
export type TrendWindow = 'sinceAdded' | '30d';

const DEFAULT_TREND_WINDOW: TrendWindow = 'sinceAdded';

const listeners = new Set<(value: TrendWindow) => void>();
let cachedTrendWindow: TrendWindow = DEFAULT_TREND_WINDOW;
let hasHydratedCache = false;
let hydrationPromise: Promise<void> | null = null;

function isTrendWindow(value: unknown): value is TrendWindow {
  return value === 'sinceAdded' || value === '30d';
}

function parseStoredValue(raw: string | null): TrendWindow {
  if (!raw) {
    return DEFAULT_TREND_WINDOW;
  }
  // The value is persisted as a bare string ('sinceAdded' | '30d'), but accept
  // a JSON-encoded variant defensively so older / future formats don't crash.
  const trimmed = raw.trim();
  if (isTrendWindow(trimmed)) {
    return trimmed;
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return isTrendWindow(parsed) ? parsed : DEFAULT_TREND_WINDOW;
  } catch {
    return DEFAULT_TREND_WINDOW;
  }
}

function notifyListeners(value: TrendWindow) {
  cachedTrendWindow = value;
  for (const listener of listeners) {
    listener(value);
  }
}

async function hydrateCache(): Promise<void> {
  if (hasHydratedCache) {
    return;
  }

  if (!hydrationPromise) {
    hydrationPromise = (async () => {
      let stored: TrendWindow = DEFAULT_TREND_WINDOW;
      try {
        const raw = await AsyncStorage.getItem(TREND_WINDOW_STORAGE_KEY);
        stored = parseStoredValue(raw);
      } catch {
        stored = DEFAULT_TREND_WINDOW;
      } finally {
        // Only adopt the stored value if the user hasn't already toggled while
        // the read was in flight — otherwise a slow read would clobber a fast
        // toggle made right after launch.
        if (!hasHydratedCache) {
          cachedTrendWindow = stored;
          hasHydratedCache = true;
        }
      }
    })();
  }

  await hydrationPromise;
}

async function persistTrendWindow(value: TrendWindow): Promise<void> {
  try {
    await AsyncStorage.setItem(TREND_WINDOW_STORAGE_KEY, value);
  } catch {
    // In-memory cache still reflects the latest value so the UI stays
    // consistent during this session even when persistence fails.
  }
}

export type UseTrendWindowResult = {
  trendWindow: TrendWindow;
  isHydrated: boolean;
  setTrendWindow: (next: TrendWindow) => void;
  toggleTrendWindow: () => void;
};

export function useTrendWindow(): UseTrendWindowResult {
  const [trendWindow, setTrendWindowState] = useState<TrendWindow>(cachedTrendWindow);
  const [isHydrated, setIsHydrated] = useState<boolean>(hasHydratedCache);

  useEffect(() => {
    let cancelled = false;

    if (!hasHydratedCache) {
      void hydrateCache().then(() => {
        if (!cancelled) {
          setTrendWindowState(cachedTrendWindow);
          setIsHydrated(true);
        }
      });
    } else {
      setTrendWindowState(cachedTrendWindow);
      setIsHydrated(true);
    }

    const listener = (next: TrendWindow) => {
      if (!cancelled) {
        setTrendWindowState(next);
      }
    };
    listeners.add(listener);

    return () => {
      cancelled = true;
      listeners.delete(listener);
    };
  }, []);

  const setTrendWindow = useCallback((next: TrendWindow) => {
    if (cachedTrendWindow === next) {
      return;
    }
    // Mark hydrated so an in-flight read can't overwrite this explicit choice.
    hasHydratedCache = true;
    notifyListeners(next);
    void persistTrendWindow(next);
  }, []);

  const toggleTrendWindow = useCallback(() => {
    const next: TrendWindow = cachedTrendWindow === 'sinceAdded' ? '30d' : 'sinceAdded';
    hasHydratedCache = true;
    notifyListeners(next);
    void persistTrendWindow(next);
  }, []);

  return {
    trendWindow,
    isHydrated,
    setTrendWindow,
    toggleTrendWindow,
  };
}

/**
 * Pick the row/tile trend percent for the active window: the 30d sparkline
 * trend or the since-added total return. One shared expression so every
 * consumer (collection rows/tiles, wishlist rows/tiles) stays in lockstep.
 */
export function trendPercentForWindow(
  window: TrendWindow,
  entry: { sinceAddedChangePercent?: number | null; sparkTrendPct?: number | null },
): number | null {
  return window === '30d'
    ? entry.sparkTrendPct ?? null
    : entry.sinceAddedChangePercent ?? null;
}

export function __resetTrendWindowForTests(): void {
  cachedTrendWindow = DEFAULT_TREND_WINDOW;
  hasHydratedCache = false;
  hydrationPromise = null;
  listeners.clear();
}
