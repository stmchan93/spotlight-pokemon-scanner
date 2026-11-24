import { useEffect, useMemo, useState } from 'react';

import type { CardGame, SetProgress } from '@spotlight/api-client';

import { ownedCountsByExpansion } from '@/features/catalog/set-progress';
import { useAppServices } from '@/providers/app-providers';

/**
 * The signed-in user's owned-card count per set, for one game or several
 * (Search's ALL chip reads every game and merges them).
 *
 * OWNER-SCOPED: results are held per `sessionOwnerKey::game`, so an account
 * switch never paints the previous account's progress. Re-read on every
 * `dataVersion` bump — that is the app's "collection changed" signal (the set
 * page bumps it when you leave after +/−), so the list is current on return.
 * Not persisted: it is one cheap grouped query per game.
 */
export function useSetProgress(scope: CardGame | readonly CardGame[]) {
  const { dataVersion, sessionOwnerKey, spotlightRepository } = useAppServices();
  const gamesKey = (typeof scope === 'string' ? [scope] : scope).join(',');
  const [byScope, setByScope] = useState<Record<string, SetProgress>>({});

  useEffect(() => {
    let cancelled = false;
    for (const game of gamesKey ? (gamesKey.split(',') as CardGame[]) : []) {
      const key = `${sessionOwnerKey}::${game}`;
      void spotlightRepository.getSetProgress(game)
        .then((progress) => {
          if (!cancelled) {
            setByScope((current) => ({ ...current, [key]: progress }));
          }
        })
        .catch(() => undefined);
    }
    return () => {
      cancelled = true;
    };
  }, [dataVersion, gamesKey, sessionOwnerKey, spotlightRepository]);

  const loaded = useMemo(
    () => (gamesKey ? gamesKey.split(',') : []).map((game) => byScope[`${sessionOwnerKey}::${game}`] ?? null),
    [byScope, gamesKey, sessionOwnerKey],
  );
  const ownedByExpansion = useMemo(
    () => Object.assign({}, ...loaded.map((progress) => ownedCountsByExpansion(progress))) as Record<string, number>,
    [loaded],
  );
  return { ownedByExpansion, hasLoaded: loaded.length > 0 && loaded.every((progress) => progress !== null) };
}
