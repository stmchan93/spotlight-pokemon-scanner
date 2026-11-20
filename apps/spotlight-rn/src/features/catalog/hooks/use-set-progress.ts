import { useEffect, useMemo, useState } from 'react';

import type { CardGame, SetProgress } from '@spotlight/api-client';

import { ownedCountsByExpansion } from '@/features/catalog/set-progress';
import { useAppServices } from '@/providers/app-providers';

/**
 * The signed-in user's owned-card count per set, for one game.
 *
 * OWNER-SCOPED: results are held per `sessionOwnerKey::game`, so an account
 * switch never paints the previous account's progress. Re-read on every
 * `dataVersion` bump — that is the app's "collection changed" signal (the set
 * page bumps it when you leave after +/−), so the list is current on return.
 * Not persisted: it is one cheap grouped query.
 */
export function useSetProgress(game: CardGame) {
  const { dataVersion, sessionOwnerKey, spotlightRepository } = useAppServices();
  const scopeKey = `${sessionOwnerKey}::${game}`;
  const [byScope, setByScope] = useState<Record<string, SetProgress>>({});

  useEffect(() => {
    let cancelled = false;
    void spotlightRepository.getSetProgress(game)
      .then((progress) => {
        if (!cancelled) {
          setByScope((current) => ({ ...current, [scopeKey]: progress }));
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [dataVersion, game, scopeKey, spotlightRepository]);

  const progress = byScope[scopeKey] ?? null;
  const ownedByExpansion = useMemo(() => ownedCountsByExpansion(progress), [progress]);
  return { ownedByExpansion, hasLoaded: progress !== null };
}
