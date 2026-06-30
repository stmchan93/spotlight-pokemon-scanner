import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  type PropsWithChildren,
} from 'react';
import {
  Animated,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';

/**
 * iOS 26-style "minimize on scroll" chrome signal for the bottom tab bar.
 *
 * A single `Animated.Value` (`collapseProgress`) is shared between the screens
 * that scroll and the `AppBottomTabBar` that renders the design-system
 * `BottomTabBar`. The bar consumes the value as `collapseProgress`:
 *   0 = expanded full bar
 *   1 = collapsed to a pill showing only the active tab icon
 *
 * Screens spread `useTabBarScrollHandler()` onto their ScrollView/FlatList
 * `onScroll` (with `scrollEventThrottle={16}`); scrolling down collapses the
 * bar, scrolling up expands it.
 */

// Ignore micro-jitters so the bar doesn't flicker on tiny finger movements.
const MIN_DELTA = 6;
// Don't collapse until the content has scrolled meaningfully past the top.
const COLLAPSE_OFFSET = 48;
// Anything inside this band at the very top is always treated as "expanded".
const TOP_FORCE_EXPANDED_OFFSET = 16;

const COLLAPSE_ANIMATION_DURATION = 180;

/**
 * Pure collapse-state decision with a small threshold + hysteresis so the bar
 * doesn't flicker:
 *   - near the very top (offset < TOP_FORCE_EXPANDED_OFFSET) → always expanded.
 *   - tiny deltas (< MIN_DELTA) → keep the current state.
 *   - scrolling DOWN past COLLAPSE_OFFSET → collapse.
 *   - scrolling UP (past the delta) → expand.
 */
export function nextCollapsed(
  prevOffset: number,
  nextOffset: number,
  currentlyCollapsed: boolean,
): boolean {
  // Always show the full bar at/near the top of the content.
  if (nextOffset < TOP_FORCE_EXPANDED_OFFSET) {
    return false;
  }

  const delta = nextOffset - prevOffset;

  // Ignore sub-threshold jitter — hold whatever state we're already in.
  if (Math.abs(delta) < MIN_DELTA) {
    return currentlyCollapsed;
  }

  // Scrolling down: collapse, but only once we're clear of the top region.
  if (delta > 0) {
    return nextOffset > COLLAPSE_OFFSET ? true : currentlyCollapsed;
  }

  // Scrolling up by more than the delta threshold: expand.
  return false;
}

type TabBarChromeContextValue = {
  collapseProgress: Animated.Value;
  handleScroll: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
};

const fallbackCollapseProgress = new Animated.Value(0);

const TabBarChromeContext = createContext<TabBarChromeContextValue>({
  collapseProgress: fallbackCollapseProgress,
  handleScroll: () => {},
});

export function TabBarChromeProvider({ children }: PropsWithChildren) {
  const collapseProgress = useRef(new Animated.Value(0)).current;
  const lastOffsetRef = useRef(0);
  const collapsedRef = useRef(false);

  const handleScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const nextOffset = event.nativeEvent.contentOffset.y;
      const prevOffset = lastOffsetRef.current;
      lastOffsetRef.current = nextOffset;

      const collapsed = nextCollapsed(prevOffset, nextOffset, collapsedRef.current);
      if (collapsed === collapsedRef.current) {
        return;
      }
      collapsedRef.current = collapsed;

      Animated.timing(collapseProgress, {
        toValue: collapsed ? 1 : 0,
        duration: COLLAPSE_ANIMATION_DURATION,
        useNativeDriver: true,
      }).start();
    },
    [collapseProgress],
  );

  const value = useMemo<TabBarChromeContextValue>(
    () => ({ collapseProgress, handleScroll }),
    [collapseProgress, handleScroll],
  );

  return (
    <TabBarChromeContext.Provider value={value}>
      {children}
    </TabBarChromeContext.Provider>
  );
}

/**
 * Spread the returned handler onto a ScrollView/FlatList `onScroll`
 * (with `scrollEventThrottle={16}`) to drive the collapse signal.
 */
export function useTabBarScrollHandler(): (
  event: NativeSyntheticEvent<NativeScrollEvent>,
) => void {
  return useContext(TabBarChromeContext).handleScroll;
}

/**
 * Read the shared collapse signal (0 = expanded, 1 = collapsed) so the bottom
 * bar can animate itself out on scroll. Falls back to a static 0 with no
 * provider, so the bar simply stays expanded.
 */
export function useTabBarCollapseProgress(): Animated.Value {
  return useContext(TabBarChromeContext).collapseProgress;
}
