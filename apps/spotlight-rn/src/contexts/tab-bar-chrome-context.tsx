import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren,
} from 'react';
import {
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';

/**
 * Reddit-style "minimize on scroll" chrome signal for the bottom tab bar.
 *
 * A shared boolean (`collapsed`) connects the screens that scroll with the
 * `AppBottomTabBar` that renders the design-system `BottomTabBar`:
 *   false = expanded full bar
 *   true  = collapsed to an icon-only circle showing just the active tab
 * (The bar itself animates the morph via LayoutAnimation.)
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
  collapsed: boolean;
  handleScroll: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
};

const TabBarChromeContext = createContext<TabBarChromeContextValue>({
  collapsed: false,
  handleScroll: () => {},
});

export function TabBarChromeProvider({ children }: PropsWithChildren) {
  const [collapsed, setCollapsed] = useState(false);
  const lastOffsetRef = useRef(0);
  const collapsedRef = useRef(false);

  const handleScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const nextOffset = event.nativeEvent.contentOffset.y;
      const prevOffset = lastOffsetRef.current;
      lastOffsetRef.current = nextOffset;

      const next = nextCollapsed(prevOffset, nextOffset, collapsedRef.current);
      if (next === collapsedRef.current) {
        return;
      }
      collapsedRef.current = next;
      setCollapsed(next);
    },
    [],
  );

  const value = useMemo<TabBarChromeContextValue>(
    () => ({ collapsed, handleScroll }),
    [collapsed, handleScroll],
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
 * Read the shared collapse state (false = expanded, true = icon-only pill) so
 * the bottom bar can morph on scroll. Falls back to a static false with no
 * provider, so the bar simply stays expanded.
 */
export function useTabBarCollapsed(): boolean {
  return useContext(TabBarChromeContext).collapsed;
}
