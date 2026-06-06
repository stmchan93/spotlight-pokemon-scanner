import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, renderHook, waitFor } from '@testing-library/react-native';

import {
  SCANNER_TARGET_CONFIG_STORAGE_KEY,
  __resetScannerTargetConfigForTests,
  cardLanguageForCardType,
  scanTargetPillLabel,
  scannerModeForCondition,
  useScannerTargetConfig,
} from '@/features/scanner/use-scanner-target-config';

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

describe('useScannerTargetConfig', () => {
  beforeEach(async () => {
    __resetScannerTargetConfigForTests();
    await AsyncStorage.clear();
  });

  it('defaults to ungraded Pokémon EN', async () => {
    const { result } = renderHook(() => useScannerTargetConfig());
    expect(result.current.condition).toBe('ungraded');
    expect(result.current.cardType).toBe('pokemon_en');
    await waitFor(() => expect(result.current.isHydrated).toBe(true));
  });

  it('persists card-type updates and rehydrates them on a fresh mount', async () => {
    const first = renderHook(() => useScannerTargetConfig());

    act(() => {
      first.result.current.setCardType('pokemon_jp');
    });

    // Scanning is always raw now — condition stays pinned to ungraded.
    expect(first.result.current.condition).toBe('ungraded');
    expect(first.result.current.cardType).toBe('pokemon_jp');

    await waitFor(async () => {
      const raw = await AsyncStorage.getItem(SCANNER_TARGET_CONFIG_STORAGE_KEY);
      expect(raw).toBe(JSON.stringify({ condition: 'ungraded', cardType: 'pokemon_jp' }));
    });

    // Simulate a fresh app launch: reset the in-memory cache but keep storage.
    __resetScannerTargetConfigForTests();
    const second = renderHook(() => useScannerTargetConfig());
    await waitFor(() => {
      expect(second.result.current.condition).toBe('ungraded');
      expect(second.result.current.cardType).toBe('pokemon_jp');
    });
  });

  it('migrates a previously persisted graded condition to ungraded on hydrate', async () => {
    // A returning user who had selected Graded before grading moved to the PDP.
    await AsyncStorage.setItem(
      SCANNER_TARGET_CONFIG_STORAGE_KEY,
      JSON.stringify({ condition: 'graded', cardType: 'pokemon_jp' }),
    );
    __resetScannerTargetConfigForTests();

    const { result } = renderHook(() => useScannerTargetConfig());
    await waitFor(() => {
      expect(result.current.condition).toBe('ungraded');
      expect(result.current.cardType).toBe('pokemon_jp');
    });
  });

  it('broadcasts changes to every mounted consumer', async () => {
    const a = renderHook(() => useScannerTargetConfig());
    const b = renderHook(() => useScannerTargetConfig());
    await waitFor(() => expect(a.result.current.isHydrated).toBe(true));

    act(() => {
      a.result.current.setCardType('pokemon_jp');
    });

    expect(b.result.current.cardType).toBe('pokemon_jp');
  });

  it('maps the config onto backend lane + language + label', () => {
    // scannerModeForCondition stays exported (slab lane kept dormant), even
    // though the scanner now only ever feeds it 'ungraded'.
    expect(scannerModeForCondition('graded')).toBe('slabs');
    expect(scannerModeForCondition('ungraded')).toBe('raw');
    expect(cardLanguageForCardType('pokemon_jp')).toBe('japanese');
    expect(cardLanguageForCardType('pokemon_en')).toBe('english');
    expect(scanTargetPillLabel('pokemon_jp')).toBe('Pokémon JP');
    expect(scanTargetPillLabel('pokemon_en')).toBe('Pokémon EN');
  });
});
