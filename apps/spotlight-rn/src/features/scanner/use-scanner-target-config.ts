import { useCallback, useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  CARD_GAMES,
  DEFAULT_CARD_GAME,
  gameDisplayName,
  gameHasLanguageLanes,
  type CardGame,
  type ScannerCardLanguage,
  type ScannerMode,
} from '@spotlight/api-client';

export const SCANNER_TARGET_CONFIG_STORAGE_KEY = '@spotlight/scanner/target-config';

export type ScannerCondition = 'graded' | 'ungraded';

export type { ScannerCardLanguage };

/**
 * The scanner's active lane: a GAME plus the LANGUAGE of that game's catalog.
 *
 * These were one flat enum (`'pokemon_en' | 'pokemon_jp'`) while Pokémon was the
 * only game. With five games a compound string per (game × language) is a
 * combinatorial set that every consumer has to re-parse, so game and language
 * are now separate fields — and only the game whose catalog is actually split by
 * language (`gameHasLanguageLanes`) ever varies the language.
 */
export type ScannerLane = {
  game: CardGame;
  language: ScannerCardLanguage;
};

export type ScannerTargetConfig = {
  condition: ScannerCondition;
  lane: ScannerLane;
};

// Scanning is now always raw/visual: grading moved to the product detail page,
// so the scanner no longer exposes a Graded/Ungraded toggle. We keep `condition`
// in the shape (hard-pinned to 'ungraded') and migrate any persisted 'graded'
// value so returning users aren't stuck in graded. The slab lane + the
// `scannerModeForCondition` mapping are kept dormant pending the PDP-grading flow.
const FORCED_CONDITION: ScannerCondition = 'ungraded';

export const DEFAULT_SCANNER_LANE: ScannerLane = {
  game: DEFAULT_CARD_GAME,
  language: 'english',
};

const DEFAULT_CONFIG: ScannerTargetConfig = {
  condition: FORCED_CONDITION,
  lane: DEFAULT_SCANNER_LANE,
};

/**
 * Every lane the scanner can offer, in picker order: each game once, except the
 * games whose catalog is split by language, which contribute one lane per
 * language. Derived from the capability table so adding a game to
 * `CARD_GAME_CAPABILITIES` adds its lane here (and therefore to the sheet)
 * without touching any component.
 */
export const SCANNER_LANES: readonly ScannerLane[] = CARD_GAMES.flatMap((game) => (
  gameHasLanguageLanes(game)
    ? ([
      { game, language: 'english' },
      { game, language: 'japanese' },
    ] as ScannerLane[])
    : ([{ game, language: 'english' }] as ScannerLane[])
));

/**
 * Stable identity for a lane — also its React key and testID suffix. Language is
 * only part of the key for games that have a language split, so Pokémon keeps
 * its shipped `pokemon-en` / `pokemon-jp` ids and every other game is just its
 * game id.
 */
export function scannerLaneKey(lane: ScannerLane): string {
  return gameHasLanguageLanes(lane.game)
    ? `${lane.game}-${lane.language === 'japanese' ? 'jp' : 'en'}`
    : lane.game;
}

export function isSameScannerLane(left: ScannerLane, right: ScannerLane): boolean {
  return scannerLaneKey(left) === scannerLaneKey(right);
}

/** Maps the user-facing condition onto the backend scan lane. */
export function scannerModeForCondition(condition: ScannerCondition): ScannerMode {
  return condition === 'graded' ? 'slabs' : 'raw';
}

/**
 * The authoritative `preferred_language` hint sent with a scan, or null for a
 * game whose catalog is not split by language. Null rather than `'english'`
 * there on purpose: the user never chose a language for those games, so the
 * backend should not apply a language filter on their behalf. Pokémon always
 * sends its selected language, exactly as before.
 */
export function scanCardLanguageForLane(lane: ScannerLane): ScannerCardLanguage | null {
  return gameHasLanguageLanes(lane.game) ? lane.language : null;
}

/**
 * Label for a lane: the game's display name, suffixed with EN/JP only for games
 * that actually have both. Reads the name from the capability table so no
 * component ever spells a game out.
 */
export function scannerLaneLabel(lane: ScannerLane): string {
  const name = gameDisplayName(lane.game);
  if (!gameHasLanguageLanes(lane.game)) {
    return name;
  }
  return `${name} ${lane.language === 'japanese' ? 'JP' : 'EN'}`;
}

/**
 * Short label rendered in the scanner header pill. It names the ACTIVE GAME, so
 * someone scanning in the Lorcana lane can see that at a glance rather than
 * discovering it from a wrong match.
 */
export function scanTargetPillLabel(lane: ScannerLane): string {
  return scannerLaneLabel(lane);
}

/**
 * The round flag shown next to the pill/row label, or undefined for games with
 * no language split (a flag there would claim a choice that doesn't exist).
 */
export function scanTargetFlag(lane: ScannerLane): 'en' | 'jp' | undefined {
  if (!gameHasLanguageLanes(lane.game)) {
    return undefined;
  }
  return lane.language === 'japanese' ? 'jp' : 'en';
}

const listeners = new Set<(config: ScannerTargetConfig) => void>();
let cachedConfig: ScannerTargetConfig = DEFAULT_CONFIG;
let hasHydratedCache = false;
let hydrationPromise: Promise<void> | null = null;

function isCardGame(value: unknown): value is CardGame {
  return typeof value === 'string' && (CARD_GAMES as readonly string[]).includes(value);
}

/**
 * Coerce a (game, language) pair to a lane we can actually scan: a language a
 * game has no catalog for falls back to English rather than being honoured.
 */
function resolveLane(game: CardGame, language: unknown): ScannerLane {
  const wantsJapanese = language === 'japanese' && gameHasLanguageLanes(game);
  return { game, language: wantsJapanese ? 'japanese' : 'english' };
}

/**
 * Pre-multi-game persisted lane. Shipped builds stored a flat
 * `cardType: 'pokemon_en' | 'pokemon_jp'`, so a returning user's saved lane
 * arrives in that shape exactly once — after which we rewrite the new shape.
 * Dropping this mapping would silently reset every Japanese scanner back to
 * English on upgrade.
 */
function laneFromLegacyCardType(value: unknown): ScannerLane | null {
  if (value === 'pokemon_en') {
    return { game: 'pokemon', language: 'english' };
  }
  if (value === 'pokemon_jp') {
    return { game: 'pokemon', language: 'japanese' };
  }
  return null;
}

type StoredConfig = {
  condition?: unknown;
  /** Current shape. */
  game?: unknown;
  language?: unknown;
  /** Pre-multi-game shape (see {@link laneFromLegacyCardType}). */
  cardType?: unknown;
};

function parseStoredValue(raw: string | null): ScannerTargetConfig {
  if (!raw) {
    return DEFAULT_CONFIG;
  }
  try {
    const parsed = JSON.parse(raw) as StoredConfig | null;
    const lane = isCardGame(parsed?.game)
      ? resolveLane(parsed.game, parsed?.language)
      : (laneFromLegacyCardType(parsed?.cardType) ?? DEFAULT_SCANNER_LANE);

    return {
      // Migrate any persisted 'graded' selection to the forced raw condition.
      condition: FORCED_CONDITION,
      lane,
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
    await AsyncStorage.setItem(
      SCANNER_TARGET_CONFIG_STORAGE_KEY,
      JSON.stringify({
        condition: config.condition,
        game: config.lane.game,
        language: config.lane.language,
      }),
    );
  } catch {
    // The in-memory cache still reflects the latest value so the UI stays
    // consistent during this session even when persistence fails.
  }
}

export type UseScannerTargetConfigResult = ScannerTargetConfig & {
  isHydrated: boolean;
  setLane: (lane: ScannerLane) => void;
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

  const setLane = useCallback((lane: ScannerLane) => {
    const nextLane = resolveLane(lane.game, lane.language);
    if (isSameScannerLane(cachedConfig.lane, nextLane)) {
      return;
    }
    hasHydratedCache = true;
    const next = { ...cachedConfig, lane: nextLane };
    notifyListeners(next);
    void persistConfig(next);
  }, []);

  return {
    condition: config.condition,
    lane: config.lane,
    isHydrated,
    setLane,
  };
}

export function __resetScannerTargetConfigForTests(): void {
  cachedConfig = DEFAULT_CONFIG;
  hasHydratedCache = false;
  hydrationPromise = null;
  listeners.clear();
}
