import { useCallback, useEffect, useRef, useState } from 'react';

import type { UserProfile } from '@/features/auth/auth-models';
import { fetchSuggestedUsers, searchUsers } from '@/features/profile/profile-service';
import { AnalyticsEvent } from '@/lib/observability/analytics-events';
import { capturePostHogEvent } from '@/lib/observability/posthog';

const SEARCH_DEBOUNCE_MS = 250;

export type SuggestionsStatus = 'loading' | 'ready' | 'failed';

export type PeopleSearch = {
  trimmedQuery: string;
  /** The box holds a query: show `results`, else `suggestions`. */
  isSearching: boolean;
  results: UserProfile[];
  /** A typed search is in flight (debounce included). */
  isLoading: boolean;
  suggestions: UserProfile[];
  suggestionsStatus: SuggestionsStatus;
  retrySuggestions: () => void;
};

/**
 * Collector search over the moderation-filtered `public_profiles` view: popular
 * collectors before anything is typed (`fetchSuggestedUsers`, excluding the
 * viewer), then debounced `searchUsers` with a stale-response token. Shared by
 * Search's PEOPLE tab and the standalone Find People screen.
 *
 * `enabled: false` skips the suggestions read until the surface is shown.
 */
export function usePeopleSearch(
  query: string,
  { viewerId, enabled = true }: { viewerId: string | null; enabled?: boolean },
): PeopleSearch {
  const [suggestions, setSuggestions] = useState<UserProfile[]>([]);
  const [results, setResults] = useState<UserProfile[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const searchTokenRef = useRef(0);

  const [suggestionsStatus, setSuggestionsStatus] = useState<SuggestionsStatus>('loading');
  const [suggestionsAttempt, setSuggestionsAttempt] = useState(0);
  useEffect(() => {
    if (!enabled) {
      return undefined;
    }
    let cancelled = false;
    setSuggestionsStatus('loading');
    void fetchSuggestedUsers(viewerId).then(({ failed, profiles }) => {
      if (!cancelled) {
        setSuggestions(profiles);
        setSuggestionsStatus(failed ? 'failed' : 'ready');
      }
    });
    return () => {
      cancelled = true;
    };
  }, [enabled, viewerId, suggestionsAttempt]);
  const retrySuggestions = useCallback(() => setSuggestionsAttempt((attempt) => attempt + 1), []);

  const trimmedQuery = query.trim();
  const isSearching = trimmedQuery.length > 0;

  useEffect(() => {
    if (!enabled || !isSearching) {
      searchTokenRef.current += 1;
      setResults([]);
      setIsLoading(false);
      return undefined;
    }
    const token = ++searchTokenRef.current;
    setIsLoading(true);
    const timer = setTimeout(() => {
      void searchUsers(trimmedQuery).then((rows) => {
        if (token === searchTokenRef.current) {
          setResults(rows);
          setIsLoading(false);
          // Once per settled query; the text itself never leaves the device.
          capturePostHogEvent(AnalyticsEvent.peopleSearchPerformed, {
            query_length: trimmedQuery.length,
            result_count: rows.length,
          });
        }
      });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [enabled, isSearching, trimmedQuery]);

  return {
    isLoading,
    isSearching,
    results,
    retrySuggestions,
    suggestions,
    suggestionsStatus,
    trimmedQuery,
  };
}
