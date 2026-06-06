import { useCallback, useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

import type { ScannerCardLanguage, ScannerMode } from '@spotlight/api-client';

export const SCANNER_TARGET_CONFIG_STORAGE_KEY = '@spotlight/scanner/target-config';

export type ScannerCondition = 'graded' | 'ungraded';
export type ScannerCardType = 'pokemon_en' | 'pokemon_jp';

export type ScannerTargetConfig = {
  condition: ScannerCondition;
  cardType: ScannerCardType;
};

const DEFAULT_CONFIG: ScannerTargetConfig = {
  condition: 'ungraded',
  cardType: 'pokemon_en',
};

/** Maps the user-facing condition onto the backend scan lane. */
export function scannerModeForCondition(condition: ScannerCondition): ScannerMode {
  return condition === 'graded' ? 'slabs' : 'raw';
}

/** Maps the user-facing card type onto the backend language hint. */
export function cardLanguageForCardType(cardType: ScannerCardType): ScannerCardLanguage {
  return cardType === 'pokemon_jp' ? 'japanese' : 'english';
}

/** Short label rendered in the scanner header pill — language only. */
export function scanTargetPillLabel(cardType: ScannerCardType, _condition: ScannerCondition): string {
  return cardType === 'pokemon_jp' ? 'Pokémon JP' : 'Pokémon EN';
}

const listeners = new Set<(config: ScannerTargetConfig) => void>();
let cachedConfig: ScannerTargetConfig = DEFAULT_CONFIG;
let hasHydratedCache = false;
let hydrationPromise: Promise<void> | null = null;

function isCondition(value: unknown): value is ScannerCondition {
  return value === 'graded' || value === 'ungraded';
}

function isCardType(value: unknown): value is ScannerCardType {
  return value === 'pokemon_en' || value === 'pokemon_jp';
}

function parseStoredValue(raw: string | null): ScannerTargetConfig {
  if (!raw) {
    return DEFAULT_CONFIG;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<ScannerTargetConfig> | null;
    return {
      condition: isCondition(parsed?.condition) ? parsed.condition : DEFAULT_CONFIG.condition,
      cardType: isCardType(parsed?.cardType) ? parsed.cardType : DEFAULT_CONFIG.cardType,
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

function notifyListeners(config: ScannerTargetConfig) {
  cachedConfig = config;
  for (const listener of listeners) {
    listener(config);
  }
}

async function hydrateCache(): Promise<void> {
  if (hasHydratedCache) {
    return;
  }

  if (!hydrationPromise) {
    hydrationPromise = (async () => {
      let stored = DEFAULT_CONFIG;
      try {
        const raw = await AsyncStorage.getItem(SCANNER_TARGET_CONFIG_STORAGE_KEY);
        stored = parseStoredValue(raw);
      } catch {
        stored = DEFAULT_CONFIG;
      } finally {
        // Only adopt the stored value if the user hasn't already made a
        // selection while the read was in flight — otherwise a slow read would
        // clobber a fast toggle change made right after launch.
        if (!hasHydratedCache) {
          cachedConfig = stored;
          hasHydratedCache = true;
        }
      }
    })();
  }

  await hydrationPromise;
}

async function persistConfig(config: ScannerTargetConfig): Promise<void> {
  try {
    await AsyncStorage.setItem(SCANNER_TARGET_CONFIG_STORAGE_KEY, JSON.stringify(config));
  } catch {
    // The in-memory cache still reflects the latest value so the UI stays
    // consistent during this session even when persistence fails.
  }
}

export type UseScannerTargetConfigResult = ScannerTargetConfig & {
  isHydrated: boolean;
  setCondition: (condition: ScannerCondition) => void;
  setCardType: (cardType: ScannerCardType) => void;
};

export function useScannerTargetConfig(): UseScannerTargetConfigResult {
  const [config, setConfigState] = useState<ScannerTargetConfig>(cachedConfig);
  const [isHydrated, setIsHydrated] = useState<boolean>(hasHydratedCache);

  useEffect(() => {
    let cancelled = false;

    if (!hasHydratedCache) {
      void hydrateCache().then(() => {
        if (!cancelled) {
          setConfigState(cachedConfig);
          setIsHydrated(true);
        }
      });
    } else {
      setConfigState(cachedConfig);
      setIsHydrated(true);
    }

    const listener = (next: ScannerTargetConfig) => {
      if (!cancelled) {
        setConfigState(next);
      }
    };
    listeners.add(listener);

    return () => {
      cancelled = true;
      listeners.delete(listener);
    };
  }, []);

  const setCondition = useCallback((condition: ScannerCondition) => {
    if (cachedConfig.condition === condition) {
      return;
    }
    // Mark hydrated so an in-flight read can't overwrite this explicit choice.
    hasHydratedCache = true;
    const next = { ...cachedConfig, condition };
    notifyListeners(next);
    void persistConfig(next);
  }, []);

  const setCardType = useCallback((cardType: ScannerCardType) => {
    if (cachedConfig.cardType === cardType) {
      return;
    }
    hasHydratedCache = true;
    const next = { ...cachedConfig, cardType };
    notifyListeners(next);
    void persistConfig(next);
  }, []);

  return {
    condition: config.condition,
    cardType: config.cardType,
    isHydrated,
    setCondition,
    setCardType,
  };
}

export function __resetScannerTargetConfigForTests(): void {
  cachedConfig = DEFAULT_CONFIG;
  hasHydratedCache = false;
  hydrationPromise = null;
  listeners.clear();
}
