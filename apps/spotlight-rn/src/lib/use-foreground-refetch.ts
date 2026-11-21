import { NavigationContext } from '@react-navigation/native';
import { type Context, createContext, useContext, useEffect, useRef } from 'react';
import { AppState, type AppStateStatus } from 'react-native';

// Tests that mock `@react-navigation/native` may not export the context.
type FocusSource = { isFocused: () => boolean } | undefined;
const NoNavigationContext = createContext<FocusSource>(undefined);
const FocusContext = (NavigationContext ?? NoNavigationContext) as Context<FocusSource>;

/** A successful load older than this is worth re-reading on return to the app. */
export const FOREGROUND_REFETCH_STALE_MS = 5 * 60_000;

export type ForegroundRefetchOptions = {
  /** Off while the screen has nothing to load (guest, browse disabled, …). */
  enabled?: boolean;
  /** The last load ended in an error (or hit its deadline). */
  failed: boolean;
  /** Epoch ms of the last successful load; null until one lands. */
  lastLoadedAt: number | null;
  /** A load is already in flight — never stack another on it. */
  isLoading?: boolean;
  onRefetch: () => void;
  staleAfterMs?: number;
};

/**
 * Re-run a screen's load when the app comes back to the foreground — only when
 * this screen is the focused one AND its last load failed or has gone stale.
 * Focus is read at the moment of the transition, so a hidden tab never fires.
 */
export function useForegroundRefetch({
  enabled = true,
  failed,
  lastLoadedAt,
  isLoading = false,
  onRefetch,
  staleAfterMs = FOREGROUND_REFETCH_STALE_MS,
}: ForegroundRefetchOptions) {
  // Optional: screens rendered outside a navigator (tests, sheets) count as focused.
  const navigation = useContext(FocusContext);
  const latest = useRef({ enabled, failed, isLoading, lastLoadedAt, navigation, onRefetch, staleAfterMs });
  latest.current = { enabled, failed, isLoading, lastLoadedAt, navigation, onRefetch, staleAfterMs };

  useEffect(() => {
    let previous: AppStateStatus = AppState.currentState;
    const subscription = AppState.addEventListener('change', (next) => {
      const cameBack = next === 'active' && previous !== 'active';
      previous = next;
      if (!cameBack) {
        return;
      }
      const state = latest.current;
      if (!state.enabled || state.isLoading) {
        return;
      }
      if (state.navigation && !state.navigation.isFocused()) {
        return;
      }
      const isStale = state.lastLoadedAt !== null
        && Date.now() - state.lastLoadedAt >= state.staleAfterMs;
      if (state.failed || isStale) {
        state.onRefetch();
      }
    });
    return () => {
      subscription?.remove?.();
    };
  }, []);
}
