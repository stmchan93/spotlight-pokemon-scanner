import { useCallback, useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

export const PORTFOLIO_VIEW_MODE_STORAGE_KEY = '@spotlight/portfolio/view-mode';

export type PortfolioViewMode = 'grid' | 'list';

const DEFAULT_VIEW_MODE: PortfolioViewMode = 'grid';

const listeners = new Set<(value: PortfolioViewMode) => void>();
let cachedViewMode: PortfolioViewMode = DEFAULT_VIEW_MODE;
let hasHydratedCache = false;
let hydrationPromise: Promise<void> | null = null;

function isViewMode(value: unknown): value is PortfolioViewMode {
  return value === 'grid' || value === 'list';
}

function parseStoredValue(raw: string | null): PortfolioViewMode {
  if (!raw) {
    return DEFAULT_VIEW_MODE;
  }
  // The value is persisted as a bare string ('grid' | 'list'), but accept a
  // JSON-encoded variant defensively so older / future formats don't crash.
  const trimmed = raw.trim();
  if (isViewMode(trimmed)) {
    return trimmed;
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return isViewMode(parsed) ? parsed : DEFAULT_VIEW_MODE;
  } catch {
    return DEFAULT_VIEW_MODE;
  }
}

function notifyListeners(value: PortfolioViewMode) {
  cachedViewMode = value;
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
      let stored: PortfolioViewMode = DEFAULT_VIEW_MODE;
      try {
        const raw = await AsyncStorage.getItem(PORTFOLIO_VIEW_MODE_STORAGE_KEY);
        stored = parseStoredValue(raw);
      } catch {
        stored = DEFAULT_VIEW_MODE;
      } finally {
        // Only adopt the stored value if the user hasn't already toggled while
        // the read was in flight — otherwise a slow read would clobber a fast
        // toggle made right after launch.
        if (!hasHydratedCache) {
          cachedViewMode = stored;
          hasHydratedCache = true;
        }
      }
    })();
  }

  await hydrationPromise;
}

async function persistViewMode(value: PortfolioViewMode): Promise<void> {
  try {
    await AsyncStorage.setItem(PORTFOLIO_VIEW_MODE_STORAGE_KEY, value);
  } catch {
    // In-memory cache still reflects the latest value so the UI stays
    // consistent during this session even when persistence fails.
  }
}

export type UsePortfolioViewModeResult = {
  viewMode: PortfolioViewMode;
  isHydrated: boolean;
  setViewMode: (next: PortfolioViewMode) => void;
  toggleViewMode: () => void;
};

export function usePortfolioViewMode(): UsePortfolioViewModeResult {
  const [viewMode, setViewModeState] = useState<PortfolioViewMode>(cachedViewMode);
  const [isHydrated, setIsHydrated] = useState<boolean>(hasHydratedCache);

  useEffect(() => {
    let cancelled = false;

    if (!hasHydratedCache) {
      void hydrateCache().then(() => {
        if (!cancelled) {
          setViewModeState(cachedViewMode);
          setIsHydrated(true);
        }
      });
    } else {
      setViewModeState(cachedViewMode);
      setIsHydrated(true);
    }

    const listener = (next: PortfolioViewMode) => {
      if (!cancelled) {
        setViewModeState(next);
      }
    };
    listeners.add(listener);

    return () => {
      cancelled = true;
      listeners.delete(listener);
    };
  }, []);

  const setViewMode = useCallback((next: PortfolioViewMode) => {
    if (cachedViewMode === next) {
      return;
    }
    // Mark hydrated so an in-flight read can't overwrite this explicit choice.
    hasHydratedCache = true;
    notifyListeners(next);
    void persistViewMode(next);
  }, []);

  const toggleViewMode = useCallback(() => {
    const next: PortfolioViewMode = cachedViewMode === 'grid' ? 'list' : 'grid';
    hasHydratedCache = true;
    notifyListeners(next);
    void persistViewMode(next);
  }, []);

  return {
    viewMode,
    isHydrated,
    setViewMode,
    toggleViewMode,
  };
}

export function __resetPortfolioViewModeForTests(): void {
  cachedViewMode = DEFAULT_VIEW_MODE;
  hasHydratedCache = false;
  hydrationPromise = null;
  listeners.clear();
}
