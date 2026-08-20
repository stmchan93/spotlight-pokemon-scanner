import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, renderHook, waitFor } from '@testing-library/react-native';

import {
  SCANNER_LANES,
  SCANNER_TARGET_CONFIG_STORAGE_KEY,
  __resetScannerTargetConfigForTests,
  scanCardLanguageForLane,
  scanTargetFlag,
  scanTargetPillLabel,
  scannerLaneKey,
  scannerLaneLabel,
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
    expect(result.current.lane).toEqual({ game: 'pokemon', language: 'english' });
    await waitFor(() => expect(result.current.isHydrated).toBe(true));
  });

  it('persists lane updates and rehydrates them on a fresh mount', async () => {
    const first = renderHook(() => useScannerTargetConfig());

    act(() => {
      first.result.current.setLane({ game: 'pokemon', language: 'japanese' });
    });

    // Scanning is always raw now — condition stays pinned to ungraded.
    expect(first.result.current.condition).toBe('ungraded');
    expect(first.result.current.lane).toEqual({ game: 'pokemon', language: 'japanese' });

    await waitFor(async () => {
      const raw = await AsyncStorage.getItem(SCANNER_TARGET_CONFIG_STORAGE_KEY);
      expect(raw).toBe(
        JSON.stringify({ condition: 'ungraded', game: 'pokemon', language: 'japanese' }),
      );
    });

    // Simulate a fresh app launch: reset the in-memory cache but keep storage.
    __resetScannerTargetConfigForTests();
    const second = renderHook(() => useScannerTargetConfig());
    await waitFor(() => {
      expect(second.result.current.condition).toBe('ungraded');
      expect(second.result.current.lane).toEqual({ game: 'pokemon', language: 'japanese' });
    });
  });

  it('persists a non-Pokémon lane', async () => {
    const { result } = renderHook(() => useScannerTargetConfig());

    act(() => {
      result.current.setLane({ game: 'onepiece', language: 'english' });
    });

    await waitFor(async () => {
      const raw = await AsyncStorage.getItem(SCANNER_TARGET_CONFIG_STORAGE_KEY);
      expect(raw).toBe(
        JSON.stringify({ condition: 'ungraded', game: 'onepiece', language: 'english' }),
      );
    });

    __resetScannerTargetConfigForTests();
    const relaunched = renderHook(() => useScannerTargetConfig());
    await waitFor(() => {
      expect(relaunched.result.current.lane).toEqual({ game: 'onepiece', language: 'english' });
    });
  });

  // --- Migration off the pre-multi-game `cardType` string ---------------------
  // These are the whole reason the legacy branch exists: a returning user's
  // saved lane arrives in the old shape exactly once, and silently resetting
  // them to another lane is a real regression, not a cosmetic one.
  it('migrates a persisted pokemon_jp cardType so a JP scanner stays on JP', async () => {
    await AsyncStorage.setItem(
      SCANNER_TARGET_CONFIG_STORAGE_KEY,
      JSON.stringify({ condition: 'ungraded', cardType: 'pokemon_jp' }),
    );
    __resetScannerTargetConfigForTests();

    const { result } = renderHook(() => useScannerTargetConfig());
    await waitFor(() => {
      expect(result.current.lane).toEqual({ game: 'pokemon', language: 'japanese' });
    });
  });

  it('migrates a persisted pokemon_en cardType', async () => {
    await AsyncStorage.setItem(
      SCANNER_TARGET_CONFIG_STORAGE_KEY,
      JSON.stringify({ condition: 'ungraded', cardType: 'pokemon_en' }),
    );
    __resetScannerTargetConfigForTests();

    const { result } = renderHook(() => useScannerTargetConfig());
    await waitFor(() => {
      expect(result.current.lane).toEqual({ game: 'pokemon', language: 'english' });
    });
  });

  it('rewrites a migrated legacy value into the new shape on the next change', async () => {
    await AsyncStorage.setItem(
      SCANNER_TARGET_CONFIG_STORAGE_KEY,
      JSON.stringify({ condition: 'ungraded', cardType: 'pokemon_jp' }),
    );
    __resetScannerTargetConfigForTests();

    const { result } = renderHook(() => useScannerTargetConfig());
    await waitFor(() => expect(result.current.isHydrated).toBe(true));

    act(() => {
      result.current.setLane({ game: 'lorcana', language: 'english' });
    });

    await waitFor(async () => {
      const raw = await AsyncStorage.getItem(SCANNER_TARGET_CONFIG_STORAGE_KEY);
      expect(raw).toBe(
        JSON.stringify({ condition: 'ungraded', game: 'lorcana', language: 'english' }),
      );
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
      expect(result.current.lane).toEqual({ game: 'pokemon', language: 'japanese' });
    });
  });

  it.each([
    ['an unknown legacy cardType', JSON.stringify({ cardType: 'pokemon_de' })],
    ['an unknown game id', JSON.stringify({ game: 'digimon', language: 'english' })],
    ['a non-object payload', '"pokemon_jp"'],
    ['unparseable JSON', '{not json'],
  ])('falls back to the default lane for %s', async (_label, stored) => {
    await AsyncStorage.setItem(SCANNER_TARGET_CONFIG_STORAGE_KEY, stored);
    __resetScannerTargetConfigForTests();

    const { result } = renderHook(() => useScannerTargetConfig());
    await waitFor(() => expect(result.current.isHydrated).toBe(true));
    expect(result.current.condition).toBe('ungraded');
    expect(result.current.lane).toEqual({ game: 'pokemon', language: 'english' });
  });

  it('coerces a Japanese language stored against a game with no JP catalog', async () => {
    // Only Pokémon has a per-language catalog; a JP One Piece lane would scan
    // against an index that does not exist.
    await AsyncStorage.setItem(
      SCANNER_TARGET_CONFIG_STORAGE_KEY,
      JSON.stringify({ condition: 'ungraded', game: 'onepiece', language: 'japanese' }),
    );
    __resetScannerTargetConfigForTests();

    const { result } = renderHook(() => useScannerTargetConfig());
    await waitFor(() => {
      expect(result.current.lane).toEqual({ game: 'onepiece', language: 'english' });
    });
  });

  it('coerces a Japanese lane selected for a game with no JP catalog', async () => {
    const { result } = renderHook(() => useScannerTargetConfig());
    await waitFor(() => expect(result.current.isHydrated).toBe(true));

    act(() => {
      result.current.setLane({ game: 'gundam', language: 'japanese' });
    });

    expect(result.current.lane).toEqual({ game: 'gundam', language: 'english' });
  });

  it('broadcasts changes to every mounted consumer', async () => {
    const a = renderHook(() => useScannerTargetConfig());
    const b = renderHook(() => useScannerTargetConfig());
    await waitFor(() => expect(a.result.current.isHydrated).toBe(true));

    act(() => {
      a.result.current.setLane({ game: 'pokemon', language: 'japanese' });
    });

    expect(b.result.current.lane).toEqual({ game: 'pokemon', language: 'japanese' });
  });

  it('offers one lane per game, and a language lane only where a JP catalog exists', () => {
    expect(SCANNER_LANES.map(scannerLaneKey)).toEqual([
      'pokemon-en',
      'pokemon-jp',
      'onepiece',
      'lorcana',
      'riftbound',
      'gundam',
    ]);
    // Exactly one Japanese lane across every game: Pokémon's.
    expect(SCANNER_LANES.filter((lane) => lane.language === 'japanese')).toEqual([
      { game: 'pokemon', language: 'japanese' },
    ]);
  });

  it('maps the config onto backend lane + language + label', () => {
    // scannerModeForCondition stays exported (slab lane kept dormant), even
    // though the scanner now only ever feeds it 'ungraded'.
    expect(scannerModeForCondition('graded')).toBe('slabs');
    expect(scannerModeForCondition('ungraded')).toBe('raw');

    // Pokémon's labels and language hint are byte-identical to what shipped.
    expect(scanCardLanguageForLane({ game: 'pokemon', language: 'japanese' })).toBe('japanese');
    expect(scanCardLanguageForLane({ game: 'pokemon', language: 'english' })).toBe('english');
    expect(scanTargetPillLabel({ game: 'pokemon', language: 'japanese' })).toBe('Pokémon JP');
    expect(scanTargetPillLabel({ game: 'pokemon', language: 'english' })).toBe('Pokémon EN');
    expect(scanTargetFlag({ game: 'pokemon', language: 'japanese' })).toBe('jp');
    expect(scanTargetFlag({ game: 'pokemon', language: 'english' })).toBe('en');

    // A single-language game names itself, carries no flag, and sends no
    // language hint (the user never chose one).
    expect(scannerLaneLabel({ game: 'onepiece', language: 'english' })).toBe('One Piece');
    expect(scannerLaneLabel({ game: 'lorcana', language: 'english' })).toBe('Disney Lorcana');
    expect(scanTargetPillLabel({ game: 'lorcana', language: 'english' })).toBe('Disney Lorcana');
    expect(scanTargetFlag({ game: 'onepiece', language: 'english' })).toBeUndefined();
    expect(scanCardLanguageForLane({ game: 'onepiece', language: 'english' })).toBeNull();
  });
});
