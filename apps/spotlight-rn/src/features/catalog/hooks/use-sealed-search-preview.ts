import { useEffect, useState } from 'react';

import type { CatalogSearchResult } from '@spotlight/api-client';

import {
  DEBOUNCE_MS,
  MIN_QUERY_LENGTH,
} from '@/features/catalog/hooks/use-catalog-card-search';
import { useAppServices } from '@/providers/app-providers';

/**
 * A few sealed matches for a typed query, fetched beside the card search so
 * "ascended heroes" finds the product without tapping the Sealed chip first.
 * Same debounce and stale-response rule as `useCatalogCardSearch`.
 */

/** A row, not a page — "See all" hands off to the Sealed chip for the rest. */
const PREVIEW_LIMIT = 10;

export type SealedSearchPreview = {
  results: CatalogSearchResult[];
  /** In flight — the empty state waits on this so it never flashes first. */
  isLoading: boolean;
};

export function useSealedSearchPreview({
  query,
  enabled,
}: {
  query: string;
  enabled: boolean;
}): SealedSearchPreview {
  const { spotlightRepository } = useAppServices();
  const [results, setResults] = useState<CatalogSearchResult[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const trimmed = query.trim();
  const isActive = enabled && trimmed.length >= MIN_QUERY_LENGTH;

  useEffect(() => {
    // Drop the previous query's row at once rather than showing stale matches.
    setResults([]);
    if (!isActive) {
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    let isCancelled = false;
    const timeout = setTimeout(() => {
      void spotlightRepository
        .searchCatalogCardsPage(trimmed, PREVIEW_LIMIT, 0, { game: 'all', kind: 'sealed' })
        .then((page) => {
          if (isCancelled) {
            return;
          }
          // Guard the row against anything that isn't sealed product.
          setResults(page.cards.filter((result) => result.productKind === 'sealed'));
          setIsLoading(false);
        })
        .catch(() => {
          if (isCancelled) {
            return;
          }
          // The card search owns the error state; the row just stays hidden.
          setResults([]);
          setIsLoading(false);
        });
    }, DEBOUNCE_MS);

    return () => {
      isCancelled = true;
      clearTimeout(timeout);
    };
  }, [isActive, spotlightRepository, trimmed]);

  return { isLoading, results };
}
