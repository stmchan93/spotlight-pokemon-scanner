import { useCallback, useEffect, useMemo, useState } from 'react';

import { CARD_GAMES, type CardGame, type ExpansionRecord } from '@spotlight/api-client';

import { withLoadDeadline } from '@/lib/load-deadline';
import { useForegroundRefetch } from '@/lib/use-foreground-refetch';
import { useAppServices } from '@/providers/app-providers';

export const GAME_EXPANSIONS_ERROR = 'Could not load sets. Check your connection and try again.';

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
  // Games whose own read failed while others answered: their tile is missing,
  // and the per-game set list must say "couldn't load", not "no sets".
  const [failedGames, setFailedGames] = useState<readonly CardGame[]>([]);
  const [lastLoadedAt, setLastLoadedAt] = useState<number | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const reload = useCallback(() => setReloadToken((token) => token + 1), []);

  useEffect(() => {
    if (!enabled) {
      return undefined;
    }
    let cancelled = false;
    setIsLoading(true);
    setError('');

    // Bounded: the whole fan-out gives up after the user-load deadline.
    void withLoadDeadline(Promise.all(
      CARD_GAMES.map(async (game) => {
        try {
          return { expansions: await spotlightRepository.listExpansions(game), game, ok: true as const };
        } catch {
          return { expansions: [] as ExpansionRecord[], game, ok: false as const };
        }
      }),
    ))
      .then((results) => {
        if (cancelled) {
          return;
        }
        const next: GameExpansions = {};
        results.forEach(({ expansions, game }) => {
          next[game] = expansions;
        });
        const failed = results.filter((result) => !result.ok).map((result) => result.game);
        const anySets = results.some((result) => result.expansions.length > 0);
        setByGame(next);
        setFailedGames(failed);
        // Every game failed, or the ones that answered have nothing to show.
        if (failed.length > 0 && !anySets) {
          setError(GAME_EXPANSIONS_ERROR);
        } else {
          setLastLoadedAt(Date.now());
        }
        setHasLoaded(true);
        setIsLoading(false);
      })
      .catch(() => {
        if (cancelled) {
          return;
        }
        setError(GAME_EXPANSIONS_ERROR);
        setHasLoaded(true);
        setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [enabled, reloadToken, spotlightRepository]);

  useForegroundRefetch({
    enabled,
    failed: Boolean(error) || failedGames.length > 0,
    isLoading,
    lastLoadedAt,
    onRefetch: reload,
  });

  // Games with no sets at all are dropped rather than shown as an empty tile —
  // production has not had the multi-game catalog migration yet, so four of the
  // five are legitimately absent there.
  const games = useMemo(
    () => CARD_GAMES.filter((game) => (byGame[game]?.length ?? 0) > 0),
    [byGame],
  );

  return { byGame, error, failedGames, games, hasLoaded, isLoading, reload };
}
