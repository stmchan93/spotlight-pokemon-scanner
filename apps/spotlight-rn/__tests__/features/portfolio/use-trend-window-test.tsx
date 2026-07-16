import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, renderHook, waitFor } from '@testing-library/react-native';

import {
  TREND_WINDOW_STORAGE_KEY,
  __resetTrendWindowForTests,
  trendPercentForWindow,
  useTrendWindow,
} from '@/features/portfolio/hooks/use-trend-window';

// In-memory AsyncStorage stand-in. State lives inside the factory so it is
// initialized when the hoisted mock first runs (a `mock`-prefixed outer var
// would still be in its TDZ at that point).
jest.mock('@react-native-async-storage/async-storage', () => {
  const store = new Map<string, string>();
  return {
    __esModule: true,
    default: {
      getItem: (key: string) => Promise.resolve(store.has(key) ? store.get(key)! : null),
      setItem: (key: string, value: string) => {
        store.set(key, value);
        return Promise.resolve();
      },
      removeItem: (key: string) => {
        store.delete(key);
        return Promise.resolve();
      },
      clear: () => {
        store.clear();
        return Promise.resolve();
      },
    },
  };
});

describe('useTrendWindow', () => {
  beforeEach(async () => {
    __resetTrendWindowForTests();
    await AsyncStorage.clear();
  });

  it('defaults to sinceAdded', async () => {
    const { result } = renderHook(() => useTrendWindow());

    expect(result.current.trendWindow).toBe('sinceAdded');
    await waitFor(() => expect(result.current.isHydrated).toBe(true));
    // Hydrating an empty store keeps the default.
    expect(result.current.trendWindow).toBe('sinceAdded');
  });

  it('persists a toggle and rehydrates it on a fresh mount', async () => {
    const first = renderHook(() => useTrendWindow());
    await waitFor(() => expect(first.result.current.isHydrated).toBe(true));

    act(() => {
      first.result.current.toggleTrendWindow();
    });
    expect(first.result.current.trendWindow).toBe('30d');

    await waitFor(async () => {
      const raw = await AsyncStorage.getItem(TREND_WINDOW_STORAGE_KEY);
      expect(raw).toBe('30d');
    });

    // Simulate a fresh app launch: reset the in-memory cache but keep storage.
    __resetTrendWindowForTests();
    const second = renderHook(() => useTrendWindow());
    await waitFor(() => {
      expect(second.result.current.trendWindow).toBe('30d');
    });
  });

  it('toggles back to sinceAdded on a second cycle', async () => {
    const { result } = renderHook(() => useTrendWindow());
    await waitFor(() => expect(result.current.isHydrated).toBe(true));

    act(() => {
      result.current.toggleTrendWindow();
    });
    expect(result.current.trendWindow).toBe('30d');

    act(() => {
      result.current.toggleTrendWindow();
    });
    expect(result.current.trendWindow).toBe('sinceAdded');

    await waitFor(async () => {
      const raw = await AsyncStorage.getItem(TREND_WINDOW_STORAGE_KEY);
      expect(raw).toBe('sinceAdded');
    });
  });

  it('keeps every mounted consumer in sync (Collection rows, tiles, Wishlist)', async () => {
    const first = renderHook(() => useTrendWindow());
    const second = renderHook(() => useTrendWindow());
    await waitFor(() => expect(first.result.current.isHydrated).toBe(true));
    await waitFor(() => expect(second.result.current.isHydrated).toBe(true));

    act(() => {
      first.result.current.setTrendWindow('30d');
    });

    expect(first.result.current.trendWindow).toBe('30d');
    expect(second.result.current.trendWindow).toBe('30d');

    act(() => {
      second.result.current.toggleTrendWindow();
    });

    expect(first.result.current.trendWindow).toBe('sinceAdded');
    expect(second.result.current.trendWindow).toBe('sinceAdded');
  });

  it('ignores an invalid stored value and falls back to the default', async () => {
    await AsyncStorage.setItem(TREND_WINDOW_STORAGE_KEY, 'weekly');
    const { result } = renderHook(() => useTrendWindow());

    await waitFor(() => expect(result.current.isHydrated).toBe(true));
    expect(result.current.trendWindow).toBe('sinceAdded');
  });

  it('a toggle made while hydration is in flight is not clobbered by the read', async () => {
    await AsyncStorage.setItem(TREND_WINDOW_STORAGE_KEY, 'sinceAdded');
    const { result } = renderHook(() => useTrendWindow());

    // Toggle immediately, before the async read resolves.
    act(() => {
      result.current.setTrendWindow('30d');
    });
    expect(result.current.trendWindow).toBe('30d');

    await waitFor(() => expect(result.current.isHydrated).toBe(true));
    expect(result.current.trendWindow).toBe('30d');
  });
});

describe('trendPercentForWindow', () => {
  const entry = { sinceAddedChangePercent: 31, sparkTrendPct: -4.2 };

  it('picks the since-added percent for the sinceAdded window', () => {
    expect(trendPercentForWindow('sinceAdded', entry)).toBe(31);
  });

  it('picks the 30d sparkline trend for the 30d window', () => {
    expect(trendPercentForWindow('30d', entry)).toBe(-4.2);
  });

  it('maps missing fields to null (row/tile hides the line)', () => {
    expect(trendPercentForWindow('sinceAdded', {})).toBeNull();
    expect(trendPercentForWindow('30d', { sinceAddedChangePercent: 5 })).toBeNull();
    expect(trendPercentForWindow('sinceAdded', { sinceAddedChangePercent: null })).toBeNull();
  });
});
