import { useCallback, useEffect, useRef, useState } from 'react';

import type { CardGame, CatalogSearchResult, RarityFilterBucket } from '@spotlight/api-client';

import { capturePostHogEvent } from '@/lib/observability/posthog';
import { useAppServices } from '@/providers/app-providers';

/**
 * Typed card search, shared by every catalog surface that offers a search box.
 *
 * It lives here because the search follows you DOWN the browse flow: the games
 * grid, one game's set list, and eventually a set all carry the same field, and
 * three copies of debounce-plus-paging would drift apart within a week. The
 * only thing that differs between them is `scope` — which catalog the query
 * asks — and that is exactly one argument.
 */

// Results load a page at a time as the user scrolls, so an artist search
// surfaces ALL of a prolific illustrator's cards, not just the first page.
const PAGE_SIZE = 30;
/** Long enough that typing "charizard" costs one request, not nine. */
const DEBOUNCE_MS = 275;
/** One letter matches most of the catalog; two is where a query means something. */
const MIN_QUERY_LENGTH = 2;

export type CatalogSearchScope = CardGame | 'all';

export type CatalogCardSearch = {
  query: string;
  setQuery: (value: string) => void;
  /** True when the box (or a rarity chip) holds enough to be a real search. */
  hasActiveQuery: boolean;
  results: CatalogSearchResult[];
  /** First page in flight. */
  isLoading: boolean;
  /** A later page in flight; the loaded results stay on screen. */
  isLoadingMore: boolean;
  /** A search has settled — the difference between "no results yet" and "none". */
  hasSearched: boolean;
  errorMessage: string;
  hasMore: boolean;
  loadMore: () => void;
  /** Re-run the current query after a failure. */
  retry: () => void;
};

export type UseCatalogCardSearchOptions = {
  /**
   * Which catalog to ask. `'all'` interleaves every game and is what a typed
   * query on the top-level search sends: someone typing a card's name is naming
   * the card, not the lane their camera is in. Naming one game scopes the
   * query, which is what a search shown INSIDE that game should do.
   */
  scope: CatalogSearchScope;
  /** Single-select rarity chip, when the surface offers one. */
  rarityBucket?: RarityFilterBucket | null;
  initialQuery?: string;
};

export function useCatalogCardSearch({
  scope,
  rarityBucket = null,
  initialQuery = '',
}: UseCatalogCardSearchOptions): CatalogCardSearch {
  const { spotlightRepository } = useAppServices();

  const [query, setQuery] = useState(initialQuery);
  const [results, setResults] = useState<CatalogSearchResult[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [hasMore, setHasMore] = useState(false);
  const [revision, setRevision] = useState(0);
  // The query the loaded results belong to — guards against a late page from a
  // previous query being appended after the query changed.
  const activeQueryRef = useRef('');

  useEffect(() => {
    setQuery(initialQuery);
  }, [initialQuery]);

  const trimmed = query.trim();
  // A rarity chip alone is a valid search (browse-by-rarity, no text).
  const hasActiveQuery = trimmed.length >= MIN_QUERY_LENGTH || rarityBucket != null;
  // Text and chip form ONE logical search; the key is what a late page is
  // checked against.
  const searchKey = `${scope}::${trimmed}::${rarityBucket ?? ''}`;

  useEffect(() => {
    if (!hasActiveQuery) {
      setResults([]);
      setHasSearched(false);
      setIsLoading(false);
      setIsLoadingMore(false);
      setErrorMessage('');
      setHasMore(false);
      activeQueryRef.current = '';
      return;
    }

    setHasSearched(false);
    setErrorMessage('');

    let isCancelled = false;
    const timeout = setTimeout(() => {
      setIsLoading(true);
      void spotlightRepository
        .searchCatalogCardsPage(trimmed, PAGE_SIZE, 0, {
          game: scope,
          ...(rarityBucket ? { rarityBucket } : {}),
        })
        .then((page) => {
          if (isCancelled) {
            return;
          }
          activeQueryRef.current = searchKey;
          /*
            Fired on the SETTLED query only. The query text deliberately does
            not travel: `cardname` is already on the observability redact list,
            so shipping the same string under a friendlier key would just route
            around that decision. What this answers is "how often does search
            come back empty", and `scope` says which surface asked.
          */
          capturePostHogEvent('catalog_search_performed', {
            has_rarity_filter: rarityBucket != null,
            query_length: trimmed.length,
            result_count: page.cards.length,
            scope,
          });
          setResults(page.cards);
          setHasMore(page.hasMore);
          setIsLoadingMore(false);
          setHasSearched(true);
          setIsLoading(false);
        })
        .catch(() => {
          if (isCancelled) {
            return;
          }
          setResults([]);
          setHasMore(false);
          setIsLoadingMore(false);
          setHasSearched(true);
          setIsLoading(false);
          setErrorMessage('Search unavailable right now. Try again in a moment.');
        });
    }, DEBOUNCE_MS);

    return () => {
      isCancelled = true;
      clearTimeout(timeout);
    };
    // `searchKey` already folds in scope, text and chip.
  }, [hasActiveQuery, revision, searchKey, rarityBucket, scope, spotlightRepository, trimmed]);

  const loadMore = useCallback(() => {
    if (!hasActiveQuery || isLoading || isLoadingMore || !hasMore) {
      return;
    }
    setIsLoadingMore(true);
    const offset = results.length;
    void spotlightRepository
      .searchCatalogCardsPage(trimmed, PAGE_SIZE, offset, {
        game: scope,
        ...(rarityBucket ? { rarityBucket } : {}),
      })
      .then((page) => {
        // Drop the page if the query, chip or scope changed while it flew.
        if (activeQueryRef.current !== searchKey) {
          return;
        }
        setResults((previous) => {
          const seen = new Set(previous.map((item) => item.id));
          return [...previous, ...page.cards.filter((card) => !seen.has(card.id))];
        });
        setHasMore(page.hasMore);
        setIsLoadingMore(false);
      })
      .catch(() => {
        if (activeQueryRef.current !== searchKey) {
          return;
        }
        // Stop paginating on error; the loaded results stay visible.
        setHasMore(false);
        setIsLoadingMore(false);
      });
  }, [
    hasActiveQuery,
    hasMore,
    isLoading,
    isLoadingMore,
    rarityBucket,
    results.length,
    scope,
    searchKey,
    spotlightRepository,
    trimmed,
  ]);

  const retry = useCallback(() => setRevision((value) => value + 1), []);

  return {
    errorMessage,
    hasActiveQuery,
    hasMore,
    hasSearched,
    isLoading,
    isLoadingMore,
    loadMore,
    query,
    results,
    retry,
    setQuery,
  };
}
