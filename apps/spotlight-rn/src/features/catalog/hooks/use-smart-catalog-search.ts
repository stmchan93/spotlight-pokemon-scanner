import { useCallback, useEffect, useRef, useState } from 'react';

import {
  removeSmartSearchChip,
  type CatalogSearchResult,
  type SmartSearchChip,
  type SmartSearchInterpretation,
  type SmartSearchRequest,
} from '@spotlight/api-client';

import type { CatalogSearchScope } from '@/features/catalog/hooks/use-catalog-card-search';
import { classifySearchQuery, type SearchQueryKind } from '@/features/catalog/smart-search-query';
import { AnalyticsEvent } from '@/lib/observability/analytics-events';
import { capturePostHogEvent } from '@/lib/observability/posthog';
import { useAppServices } from '@/providers/app-providers';

/** A sentence takes longer to type than a name; wait for the pause (or the keyboard's Search). */
export const SMART_SEARCH_DEBOUNCE_MS = 700;
const PAGE_SIZE = 30;

type SmartState = {
  status: 'idle' | 'loading' | 'search' | 'fallback';
  interpretation: SmartSearchInterpretation | null;
  chips: SmartSearchChip[];
  results: CatalogSearchResult[];
  nextCursor: string | null;
  /** The server judged a natural-looking query to be a question. */
  isQuestion: boolean;
};

const IDLE: SmartState = {
  chips: [],
  interpretation: null,
  isQuestion: false,
  nextCursor: null,
  results: [],
  status: 'idle',
};

export type SmartCatalogSearch = {
  kind: SearchQueryKind;
  /** Smart results (and chips) replace the normal search's. */
  isActive: boolean;
  /** A natural query is waiting on its interpretation: the normal results stay hidden. */
  isLoading: boolean;
  /** Show the "Ask Ekalight" row. */
  isQuestion: boolean;
  chips: SmartSearchChip[];
  results: CatalogSearchResult[];
  hasMore: boolean;
  isLoadingMore: boolean;
  loadMore: () => void;
  /** Re-runs the search without the chip's field: no model call. */
  removeChip: (chip: SmartSearchChip) => void;
  /** Keyboard Search: skip the debounce. */
  submit: () => void;
};

/**
 * Natural-language search beside the normal catalog search. Only `natural`
 * queries call the server; plain ones never leave the normal 275ms path. Any
 * failure falls back silently: `isActive` stays false and the normal results show.
 */
export function useSmartCatalogSearch({
  enabled,
  query,
  scope,
}: {
  enabled: boolean;
  query: string;
  scope: CatalogSearchScope;
}): SmartCatalogSearch {
  const { spotlightRepository } = useAppServices();
  const trimmed = query.trim();
  const kind: SearchQueryKind = enabled ? classifySearchQuery(trimmed) : 'plain';
  const [state, setState] = useState<SmartState>(IDLE);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [submitted, setSubmitted] = useState<string | null>(null);
  // Only the newest request may land.
  const requestRef = useRef(0);
  const inFlightRef = useRef<string | null>(null);

  const run = useCallback(
    async (requestId: number, request: SmartSearchRequest, trigger: 'query' | 'chip') => {
      const startedAt = Date.now();
      try {
        const result = await spotlightRepository.smartSearchCatalog(request);
        if (requestId !== requestRef.current) {
          return;
        }
        const isSearch = result.intent === 'search' && result.interpretation != null;
        capturePostHogEvent(AnalyticsEvent.smartSearchPerformed, {
          chip_count: isSearch ? result.chips.length : 0,
          fell_back: !isSearch,
          intent: result.intent,
          latency_ms: Date.now() - startedAt,
          result_count: isSearch ? result.results.length : 0,
          trigger,
        });
        setState(isSearch
          ? {
            chips: result.chips,
            interpretation: result.interpretation,
            isQuestion: false,
            nextCursor: result.nextCursor,
            results: result.results,
            status: 'search',
          }
          : { ...IDLE, isQuestion: result.intent === 'question', status: 'fallback' });
      } catch {
        if (requestId !== requestRef.current) {
          return;
        }
        capturePostHogEvent(AnalyticsEvent.smartSearchPerformed, {
          chip_count: 0,
          fell_back: true,
          intent: 'error',
          latency_ms: Date.now() - startedAt,
          result_count: 0,
          trigger,
        });
        setState({ ...IDLE, status: 'fallback' });
      } finally {
        if (requestId === requestRef.current) {
          inFlightRef.current = null;
        }
      }
    },
    [spotlightRepository],
  );

  useEffect(() => {
    const requestId = ++requestRef.current;
    setIsLoadingMore(false);
    if (kind !== 'natural') {
      inFlightRef.current = null;
      setState(IDLE);
      return undefined;
    }
    setState({ ...IDLE, status: 'loading' });
    const timer = setTimeout(() => {
      inFlightRef.current = trimmed;
      void run(requestId, { game: scope, limit: PAGE_SIZE, query: trimmed }, 'query');
    }, submitted === trimmed ? 0 : SMART_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [kind, run, scope, submitted, trimmed]);

  const submit = useCallback(() => {
    if (kind === 'natural' && state.status === 'loading' && inFlightRef.current !== trimmed) {
      setSubmitted(trimmed);
    }
  }, [kind, state.status, trimmed]);

  const removeChip = useCallback(
    (chip: SmartSearchChip) => {
      if (state.status !== 'search' || !state.interpretation) {
        return;
      }
      const interpretation = removeSmartSearchChip(state.interpretation, chip);
      const requestId = ++requestRef.current;
      setIsLoadingMore(false);
      setState((previous) => ({
        ...previous,
        chips: previous.chips.filter((item) => item.id !== chip.id),
        interpretation,
        nextCursor: null,
      }));
      void run(requestId, { game: scope, interpretation, limit: PAGE_SIZE }, 'chip');
    },
    [run, scope, state.interpretation, state.status],
  );

  const loadMore = useCallback(() => {
    const { interpretation, nextCursor, status } = state;
    if (status !== 'search' || !interpretation || !nextCursor || isLoadingMore) {
      return;
    }
    const requestId = requestRef.current;
    setIsLoadingMore(true);
    void spotlightRepository
      .smartSearchCatalog({ cursor: nextCursor, game: scope, interpretation, limit: PAGE_SIZE })
      .then((page) => {
        if (requestId !== requestRef.current) {
          return;
        }
        setState((previous) => {
          const seen = new Set(previous.results.map((item) => item.id));
          return {
            ...previous,
            nextCursor: page.nextCursor,
            results: [...previous.results, ...page.results.filter((card) => !seen.has(card.id))],
          };
        });
        setIsLoadingMore(false);
      })
      .catch(() => {
        if (requestId !== requestRef.current) {
          return;
        }
        // Stop paging; the loaded results stay.
        setState((previous) => ({ ...previous, nextCursor: null }));
        setIsLoadingMore(false);
      });
  }, [isLoadingMore, scope, spotlightRepository, state]);

  return {
    chips: state.status === 'search' ? state.chips : [],
    hasMore: state.status === 'search' && state.nextCursor != null,
    isActive: state.status === 'search',
    isLoading: state.status === 'loading',
    isLoadingMore,
    isQuestion: kind === 'question' || state.isQuestion,
    kind,
    loadMore,
    removeChip,
    results: state.status === 'search' ? state.results : [],
    submit,
  };
}
