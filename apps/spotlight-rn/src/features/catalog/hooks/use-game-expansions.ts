import { useCallback, useEffect, useMemo, useState } from 'react';

import { CARD_GAMES, type CardGame, type ExpansionRecord } from '@spotlight/api-client';

import { useAppServices } from '@/providers/app-providers';

export type GameExpansions = Partial<Record<CardGame, ExpansionRecord[]>>;

/**
 * Every game's sets, for the browse grid.
 *
 * ONE CALL PER GAME, IN PARALLEL. The expansions endpoint is deliberately
 * single-game — the emptiness check that triggers a first-run sync has to be
 * per game, or `?game=onepiece` against a populated Pokémon table skips its own
 * sync and gets served Pokémon's list. So there is no `game=all` to ask for,
 * and the grid fans out instead. Five small reads, resolved together.
 *
 * The whole map is loaded up front because the game tiles draw their mosaic
 * from each game's own set logos: the grid cannot render until every game has
 * answered, and drilling into one is then instant.
 */
export function useGameExpansions(enabled = true) {
  const { spotlightRepository } = useAppServices();
  const [byGame, setByGame] = useState<GameExpansions>({});
  const [isLoading, setIsLoading] = useState(enabled);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [error, setError] = useState('');
  const [reloadToken, setReloadToken] = useState(0);

  const reload = useCallback(() => setReloadToken((token) => token + 1), []);

  useEffect(() => {
    if (!enabled) {
      return undefined;
    }
    let cancelled = false;
    setIsLoading(true);
    setError('');

    void Promise.all(
      CARD_GAMES.map(async (game) => [game, await spotlightRepository.listExpansions(game)] as const),
    )
      .then((pairs) => {
        if (cancelled) {
          return;
        }
        const next: GameExpansions = {};
        pairs.forEach(([game, expansions]) => {
          next[game] = expansions;
        });
        setByGame(next);
        setHasLoaded(true);
        setIsLoading(false);
      })
      .catch(() => {
        if (cancelled) {
          return;
        }
        setError('Could not load sets. Try again in a moment.');
        setHasLoaded(true);
        setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [enabled, reloadToken, spotlightRepository]);

  // Games with no sets at all are dropped rather than shown as an empty tile —
  // production has not had the multi-game catalog migration yet, so four of the
  // five are legitimately absent there.
  const games = useMemo(
    () => CARD_GAMES.filter((game) => (byGame[game]?.length ?? 0) > 0),
    [byGame],
  );

  return { byGame, error, games, hasLoaded, isLoading, reload };
}

/**
 * The languages a game's sets actually span, in display order. The set browser
 * only draws a tab row when this has more than one entry: today Pokémon is the
 * only game with both an English and a Japanese catalog, and a one-tab row is a
 * control that does nothing.
 */
export function expansionLanguages(expansions: readonly ExpansionRecord[]): string[] {
  const seen = new Set<string>();
  expansions.forEach((expansion) => {
    const language = (expansion.language ?? '').trim();
    if (language) {
      seen.add(language);
    }
  });
  // English first when present; everything else alphabetical behind it.
  return [...seen].sort((left, right) => {
    if (left === 'English') return -1;
    if (right === 'English') return 1;
    return left.localeCompare(right);
  });
}
