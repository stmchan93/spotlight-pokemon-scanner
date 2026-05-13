import { useCallback, useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * AsyncStorage key for the optional vendor-configured suggested discount percent.
 *
 * Stored as a string ("0".."100") when set, removed when cleared. Treat a missing
 * value (or `null`) as "no suggested price configured" and render nothing.
 */
export const SUGGESTED_DISCOUNT_STORAGE_KEY = '@spotlight/pricing/suggested-discount-pct';

const listeners = new Set<(value: number | null) => void>();
let cachedValue: number | null = null;
let hasHydratedCache = false;
let hydrationPromise: Promise<void> | null = null;

function notifyListeners(value: number | null) {
  cachedValue = value;
  for (const listener of listeners) {
    listener(value);
  }
}

function parseStoredValue(raw: string | null): number | null {
  if (raw == null) {
    return null;
  }

  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed)) {
    return null;
  }

  if (parsed < 0 || parsed > 100) {
    return null;
  }

  return parsed;
}

async function hydrateCache(): Promise<void> {
  if (hasHydratedCache) {
    return;
  }

  if (!hydrationPromise) {
    hydrationPromise = (async () => {
      try {
        const raw = await AsyncStorage.getItem(SUGGESTED_DISCOUNT_STORAGE_KEY);
        cachedValue = parseStoredValue(raw);
      } catch {
        cachedValue = null;
      } finally {
        hasHydratedCache = true;
      }
    })();
  }

  await hydrationPromise;
}

async function persistValue(value: number | null): Promise<void> {
  try {
    if (value == null) {
      await AsyncStorage.removeItem(SUGGESTED_DISCOUNT_STORAGE_KEY);
      return;
    }
    await AsyncStorage.setItem(SUGGESTED_DISCOUNT_STORAGE_KEY, String(value));
  } catch {
    // Swallow storage failures — the in-memory cache still reflects the latest
    // value so the UI stays consistent during this session.
  }
}

export type UseSuggestedDiscountResult = {
  discountPct: number | null;
  setDiscountPct: (value: number | null) => void;
};

export function useSuggestedDiscount(): UseSuggestedDiscountResult {
  const [discountPct, setDiscountPctState] = useState<number | null>(cachedValue);

  useEffect(() => {
    let cancelled = false;

    if (!hasHydratedCache) {
      void hydrateCache().then(() => {
        if (!cancelled) {
          setDiscountPctState(cachedValue);
        }
      });
    } else {
      setDiscountPctState(cachedValue);
    }

    const listener = (value: number | null) => {
      if (!cancelled) {
        setDiscountPctState(value);
      }
    };
    listeners.add(listener);

    return () => {
      cancelled = true;
      listeners.delete(listener);
    };
  }, []);

  const setDiscountPct = useCallback((value: number | null) => {
    const normalized = normalizeDiscountInput(value);
    if (cachedValue === normalized) {
      return;
    }
    notifyListeners(normalized);
    void persistValue(normalized);
  }, []);

  return { discountPct, setDiscountPct };
}

/**
 * Coerce caller input into the valid range (integers 0–100) or `null`. Anything
 * outside the range — `NaN`, negatives, floats, values over 100 — becomes `null`
 * (i.e. "not configured").
 */
export function normalizeDiscountInput(value: number | null): number | null {
  if (value == null || !Number.isFinite(value)) {
    return null;
  }
  const rounded = Math.trunc(value);
  if (rounded < 0 || rounded > 100) {
    return null;
  }
  return rounded;
}

/**
 * Test-only helper. Resets the module-level cache so tests can rehydrate from
 * the mocked AsyncStorage in a deterministic order.
 */
export function __resetSuggestedDiscountCacheForTests(): void {
  cachedValue = null;
  hasHydratedCache = false;
  hydrationPromise = null;
  listeners.clear();
}
