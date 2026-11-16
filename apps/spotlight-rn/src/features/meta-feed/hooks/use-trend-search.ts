import { useEffect, useRef, useState } from 'react';

import type { CardGame, MetaGroup } from '@spotlight/api-client';

import { useAppServices } from '@/providers/app-providers';

const DEBOUNCE_MS = 250;

export type TrendSearchState = {
  /** The trimmed query the results belong to ('' = not searching). */
  query: string;
  groups: MetaGroup[];
  loading: boolean;
  failed: boolean;
};

const IDLE: TrendSearchState = { query: '', groups: [], loading: false, failed: false };

/**
 * Market Watch's price-trend search. Local state on purpose, not the shared
 * meta-feed cache: every typed query would otherwise stay in app memory.
 * Debounced, latest-request-wins.
 */
export function useTrendSearch(rawQuery: string, game: CardGame, windowDays: number): TrendSearchState {
  const { spotlightRepository } = useAppServices();
  const query = rawQuery.trim();
  const [state, setState] = useState<TrendSearchState>(IDLE);
  const tokenRef = useRef(0);

  useEffect(() => {
    const token = ++tokenRef.current;
    if (!query) {
      setState(IDLE);
      return undefined;
    }
    setState((current) => ({ ...current, query, loading: true, failed: false }));
    const timer = setTimeout(() => {
      spotlightRepository
        .searchMetaTrends({ query, game, windowDays })
        .then((result) => {
          if (token === tokenRef.current) {
            setState({ query, groups: result?.groups ?? [], loading: false, failed: false });
          }
        })
        .catch(() => {
          if (token === tokenRef.current) {
            setState({ query, groups: [], loading: false, failed: true });
          }
        });
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [game, query, spotlightRepository, windowDays]);

  return state;
}
