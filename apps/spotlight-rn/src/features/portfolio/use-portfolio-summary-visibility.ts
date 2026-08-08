import { useCallback, useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

export const PORTFOLIO_SUMMARY_HIDDEN_STORAGE_KEY = '@spotlight/portfolio/summary-hidden';

const listeners = new Set<(hidden: boolean) => void>();
let cachedValue = false;
let hasHydratedCache = false;
let hydrationPromise: Promise<void> | null = null;
// Set the first time the owner toggles in this session. The read from disk is
// async, so a tap that lands before it resolves would otherwise be overwritten
// by the older stored value — the toggle visibly springing back, which reads as
// "it doesn't stick".
let hasLocalWrite = false;

function notifyListeners(value: boolean) {
  cachedValue = value;
  hasLocalWrite = true;
  for (const listener of listeners) {
    listener(value);
  }
}

function parseStoredValue(raw: string | null): boolean {
  return raw === '1';
}

async function hydrateCache(): Promise<void> {
  if (hasHydratedCache) {
    return;
  }

  if (!hydrationPromise) {
    hydrationPromise = (async () => {
      try {
        const raw = await AsyncStorage.getItem(PORTFOLIO_SUMMARY_HIDDEN_STORAGE_KEY);
        if (!hasLocalWrite) {
          cachedValue = parseStoredValue(raw);
        }
      } catch {
        if (!hasLocalWrite) {
          cachedValue = false;
        }
      } finally {
        hasHydratedCache = true;
      }
    })();
  }

  await hydrationPromise;
}

async function persistValue(value: boolean): Promise<void> {
  try {
    if (value) {
      await AsyncStorage.setItem(PORTFOLIO_SUMMARY_HIDDEN_STORAGE_KEY, '1');
    } else {
      await AsyncStorage.removeItem(PORTFOLIO_SUMMARY_HIDDEN_STORAGE_KEY);
    }
  } catch {
    // The in-memory cache still reflects the latest value so the UI stays
    // consistent during this session even when persistence fails.
  }
}

export type UsePortfolioSummaryVisibilityResult = {
  isHidden: boolean;
  setHidden: (value: boolean) => void;
  toggle: () => void;
};

export function usePortfolioSummaryVisibility(): UsePortfolioSummaryVisibilityResult {
  const [isHidden, setHiddenState] = useState<boolean>(cachedValue);

  useEffect(() => {
    let cancelled = false;

    if (!hasHydratedCache) {
      void hydrateCache().then(() => {
        if (!cancelled) {
          setHiddenState(cachedValue);
        }
      });
    } else {
      setHiddenState(cachedValue);
    }

    const listener = (value: boolean) => {
      if (!cancelled) {
        setHiddenState(value);
      }
    };
    listeners.add(listener);

    return () => {
      cancelled = true;
      listeners.delete(listener);
    };
  }, []);

  const setHidden = useCallback((value: boolean) => {
    if (cachedValue === value) {
      return;
    }
    notifyListeners(value);
    void persistValue(value);
  }, []);

  const toggle = useCallback(() => {
    const next = !cachedValue;
    notifyListeners(next);
    void persistValue(next);
  }, []);

  return { isHidden, setHidden, toggle };
}

export function __resetPortfolioSummaryVisibilityForTests(): void {
  cachedValue = false;
  hasHydratedCache = false;
  hydrationPromise = null;
  hasLocalWrite = false;
  listeners.clear();
}
