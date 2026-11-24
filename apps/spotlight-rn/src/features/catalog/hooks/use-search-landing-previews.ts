import { useEffect, useState } from 'react';

import type { CardGame, CatalogSearchResult, ExpansionRecord } from '@spotlight/api-client';

import type { CatalogSearchScope } from '@/features/catalog/hooks/use-catalog-card-search';
import { useAppServices } from '@/providers/app-providers';

/** A rail, not a page: VIEW ALL opens the rest. */
const RAIL_LIMIT = 10;
/** The set page's own ceiling — a set's secret rares sit at the end of it. */
const SET_CARDS_LIMIT = 1000;

export type SearchLandingRail = {
  results: CatalogSearchResult[];
  isLoading: boolean;
};

/**
 * SINGLES on the Search landing (Figma 6597:5654): the game's newest main set,
 * priciest cards first. There is no "every card in the game" browse endpoint
 * (card search needs text or a rarity), so the rail reads the set endpoint the
 * set page uses and walks `sourceSets` until one has cards.
 *
 * `set` is the set the cards came from — VIEW ALL opens it.
 */
export function useSinglesRail(
  game: CardGame,
  sourceSets: readonly ExpansionRecord[],
  /** ALL: the sets span games, so each is read under its own. */
  gameBySet?: Readonly<Record<string, CardGame>>,
) {
  const { spotlightRepository } = useAppServices();
  const sourceKey = sourceSets.map((set) => set.id).join('|');
  const [state, setState] = useState<{
    key: string;
    results: CatalogSearchResult[];
    set: ExpansionRecord | null;
    isLoading: boolean;
  }>({ key: '', results: [], set: null, isLoading: false });
  const scopeKey = `${game}::${sourceKey}`;

  useEffect(() => {
    if (!sourceKey) {
      setState({ key: scopeKey, results: [], set: null, isLoading: false });
      return;
    }
    let cancelled = false;
    setState((current) => (current.key === scopeKey ? current : { key: scopeKey, results: [], set: null, isLoading: true }));
    void (async () => {
      for (const set of sourceSets) {
        try {
          const cards = await spotlightRepository.listCardsInExpansion(set.id, '', SET_CARDS_LIMIT, gameBySet?.[set.id] ?? game);
          if (cancelled) {
            return;
          }
          if (cards.length > 0) {
            const priciest = [...cards]
              .sort((a, b) => (b.marketPrice ?? -1) - (a.marketPrice ?? -1))
              .slice(0, RAIL_LIMIT);
            setState({ key: scopeKey, results: priciest, set, isLoading: false });
            return;
          }
        } catch {
          // Try the next set; an empty rail hides itself.
        }
      }
      if (!cancelled) {
        setState({ key: scopeKey, results: [], set: null, isLoading: false });
      }
    })();
    return () => {
      cancelled = true;
    };
    // `sourceKey` stands in for `sourceSets`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game, scopeKey, sourceKey, spotlightRepository]);

  return state.key === scopeKey ? state : { results: [], set: null, isLoading: Boolean(sourceKey) };
}

/**
 * SEALED on the Search landing: the game's (or ALL games') sealed product with no query —
 * the same browse the Sealed chip runs (newest sets first).
 */
export function useSealedRail(game: CatalogSearchScope, enabled = true): SearchLandingRail {
  const { spotlightRepository } = useAppServices();
  const [state, setState] = useState<{ game: CatalogSearchScope | null; results: CatalogSearchResult[]; isLoading: boolean }>(
    { game: null, results: [], isLoading: false },
  );

  useEffect(() => {
    if (!enabled) {
      return;
    }
    let cancelled = false;
    setState((current) => (current.game === game ? current : { game, results: [], isLoading: true }));
    spotlightRepository
      .searchCatalogCardsPage('', RAIL_LIMIT, 0, { game, kind: 'sealed' })
      .then((page) => {
        if (!cancelled) {
          setState({ game, results: page.cards.filter((result) => result.productKind === 'sealed'), isLoading: false });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setState({ game, results: [], isLoading: false });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, game, spotlightRepository]);

  return state.game === game ? state : { results: [], isLoading: enabled };
}
