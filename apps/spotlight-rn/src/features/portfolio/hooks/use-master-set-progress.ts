import { useCallback, useEffect, useRef, useState } from 'react';

import { CARD_GAMES, type CardGame, type ExpansionRecord } from '@spotlight/api-client';

import { buildMasterSetRows, type MasterSetRow } from '@/features/portfolio/master-set';
import { withLoadDeadline } from '@/lib/load-deadline';
import { useAppServices } from '@/providers/app-providers';

export type MasterSetStatus = 'idle' | 'loading' | 'ready' | 'error';

type ScopedRows = { scopeKey: string; rows: MasterSetRow[] };

/**
 * Home → MASTER SET's data: every set the signed-in user owns cards from, in
 * every game, with completion.
 *
 * `getSetProgress` is one grouped query per game and never throws, so all
 * games are asked (five small reads). Set records (`listExpansions`) are only
 * fetched for games that came back with sets, and kept for the session — the
 * catalog is not per-user, and re-pulling hundreds of sets on every collection
 * change would be the expensive half of this tab.
 *
 * OWNER-SCOPED like `useSetProgress`: rows are tagged with `sessionOwnerKey`,
 * so an account switch never paints the previous account's sets. Re-read on
 * every `dataVersion` bump (the app's "collection changed" signal). `enabled`
 * defers everything until the tab is first opened.
 */
export function useMasterSetProgress(enabled: boolean) {
  const { dataVersion, sessionOwnerKey, spotlightRepository } = useAppServices();
  const [scoped, setScoped] = useState<ScopedRows | null>(null);
  const [status, setStatus] = useState<MasterSetStatus>('idle');
  const [reloadToken, setReloadToken] = useState(0);
  const expansionsByGameRef = useRef<Partial<Record<CardGame, ExpansionRecord[]>>>({});

  useEffect(() => {
    if (!enabled) {
      return undefined;
    }
    let cancelled = false;
    setStatus('loading');
    void withLoadDeadline((async () => {
      const progress = await Promise.all(CARD_GAMES.map((game) => spotlightRepository.getSetProgress(game)
        .then((value) => ({ game, value }))));
      const owned = progress.filter(({ value }) => value.sets.length > 0);
      const inputs = await Promise.all(owned.map(async ({ game, value }) => {
        let expansions = expansionsByGameRef.current[game];
        if (!expansions) {
          expansions = await spotlightRepository.listExpansions(game);
          expansionsByGameRef.current[game] = expansions;
        }
        return { game, progress: value, expansions };
      }));
      return buildMasterSetRows(inputs);
    })())
      .then((rows) => {
        if (!cancelled) {
          setScoped({ scopeKey: sessionOwnerKey, rows });
          setStatus('ready');
        }
      })
      .catch(() => {
        if (!cancelled) {
          setStatus('error');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [dataVersion, enabled, reloadToken, sessionOwnerKey, spotlightRepository]);

  // 'loading' in the same batch as the bump, so a caller's pull-to-refresh
  // spinner never sees a stale 'ready' before the effect re-runs.
  const reload = useCallback(() => {
    setStatus('loading');
    setReloadToken((token) => token + 1);
  }, []);
  const rows = scoped?.scopeKey === sessionOwnerKey ? scoped.rows : null;
  return { rows, status, reload };
}
