import { createContext, useContext, type ReactNode } from 'react';
import { Platform } from 'react-native';
import { initialWindowMetrics, useSafeAreaInsets } from 'react-native-safe-area-context';

import { spacing } from '@spotlight/design-system';

/*
  ───────────────────────────────────────────────────────────────────────────────
  THE ONE PLACE THAT KNOWS HOW HIGH A FLOATING AFFORDANCE HAS TO SIT
  ───────────────────────────────────────────────────────────────────────────────
  Sibling of `@/lib/keyboard-insets`, and it exists for the same reason: the
  answer is a different measurement on each platform.

  The bar is our own (`AppTabBar`, drawn by the tab pager in
  `@/components/tab-pager`), and the pager hands every tab page the same
  contract the native tab bar used to, so no screen had to change:

   • iOS — `useSafeAreaInsets().bottom` ALREADY INCLUDES THE TAB BAR. The pager
     wraps each page in a `SafeAreaInsetsContext` whose bottom is the bar's full
     height (`getAppTabBarHeight`, home indicator included), and the page runs
     full-bleed underneath the translucent bar. (Native tabs gave the same via a
     per-screen SafeAreaProvider inside the UIKit tab child.)

   • ANDROID — the CONTAINER is already inset, so the inset must NOT be re-added.
     The pager pads each page's container by the bar's height (the bar is
     opaque there), and `useSafeAreaInsets().bottom` keeps reporting only the
     system navigation bar — exactly what Material's bar + expo-router's
     `SafeAreaView` used to produce. Yoga positions absolute children INSIDE
     that padding, so a FAB's `bottom` is already measured from the bar's top.

  `bottomTabBarHeight` (44) from the design system is the RETIRED JS pill and
  describes nothing; never add it.
*/

/**
 * Rest gap between a floating affordance and the top of the bottom chrome.
 * 28 is where the original search/add FAB was anchored above the JS nav pill;
 * the gap is the part of that arithmetic that was always correct.
 */
export const floatingAffordanceGap = 28;

/** Gap between the last card of a tab's list and the tab bar, at full scroll. */
export const LAST_CARD_TO_TAB_BAR_GAP = 16;

/**
 * Height of the white fade a tab screen draws over its content at the bottom
 * edge, so scrolling content dissolves under the bar (Figma 4407:283 feed,
 * 4134:49749 collection — both 95pt).
 *
 * THE SAME 95 MEANS TWO DIFFERENT THINGS ON THE TWO PLATFORMS. Those frames are
 * iOS mocks: the floating bar is translucent, content runs under it, and ~34pt
 * of the band sits UNDER the bar (the home-indicator inset), so ~61pt of fade
 * is what actually shows. On Android the bar is opaque and the tab container is
 * pre-inset above it (see the Android note at the top of this file), so
 * `bottom: 0` IS the bar's top edge and the full 95 landed on the content — a
 * third taller than designed, hazing the last row of cards on Home and the post
 * above the bar on Social (user, 2026-09-13, Galaxy A17). Android gets the
 * visible portion, so the two platforms show the same fade above the bar.
 */
/**
 * Pages never draw their own fade under the bar: the pager draws Figma
 * 5938:16991 (blur + white wash) for every tab page — `TabBarBackdrop`.
 * Kept for Android-only callers that still read it.
 */
export const tabBarBottomFadeVisible = Platform.OS === 'android';

/**
 * expo-blur strength for Figma 5938:16991's 4px backdrop blur: a light blur
 * (intensity is a 0-100 fraction of the system material, not a radius).
 */
export const TAB_BAR_BACKDROP_BLUR_INTENSITY = 12;

export const TAB_BAR_BOTTOM_FADE_DESIGN_HEIGHT = 95;
const IOS_HOME_INDICATOR_INSET_IN_MOCK = 34;
export const tabBarBottomFadeHeight =
  Platform.OS === 'android'
    ? TAB_BAR_BOTTOM_FADE_DESIGN_HEIGHT - IOS_HOME_INDICATOR_INSET_IN_MOCK
    : TAB_BAR_BOTTOM_FADE_DESIGN_HEIGHT;

/**
 * True on a tab page of the pager (Home, Watchlist, Events, Social).
 *
 * Only Android needs this — see the Android note above: its tab CONTAINER is
 * pre-inset, while a pushed stack screen (`app/(stack)/…`, e.g. Insights) is
 * full-bleed and has no bar at all. iOS answers both cases with the same
 * `insets.bottom`, so it never reads this.
 *
 * A context rather than `useSegments()` on purpose: the pager keeps visited
 * pages MOUNTED, so a route-string check would make an unfocused page answer for
 * whatever route is focused. Provider membership does not move.
 *
 * NOT PROVIDED ON `/scan`: the scanner reserves the bar's space itself and its
 * container is full-bleed like a stack screen's.
 */
const TabScreenContext = createContext(false);

export function TabScreenProvider({ children }: { children: ReactNode }) {
  return <TabScreenContext.Provider value>{children}</TabScreenContext.Provider>;
}

type FloatingAffordanceBottomArgs = {
  os: typeof Platform.OS;
  /** `useSafeAreaInsets().bottom` as seen by the calling screen. */
  safeAreaBottom: number;
  /** Whether the caller renders on a tab page (see the context above). */
  isTabScreen: boolean;
  gap?: number;
};

/**
 * The `bottom` an absolutely-positioned floating affordance should use so it
 * rests `gap` above the bottom chrome. Pure, so the platform arithmetic can be
 * pinned by tests instead of re-derived by eye.
 */
export function resolveFloatingAffordanceBottom({
  os,
  safeAreaBottom,
  isTabScreen,
  gap = floatingAffordanceGap,
}: FloatingAffordanceBottomArgs): number {
  if (os === 'android' && isTabScreen) {
    // Container already cleared of the bar AND the system navigation bar.
    return gap;
  }
  return Math.max(safeAreaBottom, 0) + gap;
}

/** Hook form of {@link resolveFloatingAffordanceBottom}. */
export function useFloatingAffordanceBottom(gap: number = floatingAffordanceGap): number {
  const insets = useSafeAreaInsets();
  const isTabScreen = useContext(TabScreenContext);

  return resolveFloatingAffordanceBottom({
    os: Platform.OS,
    safeAreaBottom: insets.bottom,
    isTabScreen,
    gap,
  });
}

type AutomaticInsetListBottomPaddingArgs = FloatingAffordanceBottomArgs & {
  /**
   * The WINDOW's bottom safe area (home indicator), which UIKit already adds to
   * a scroll view running `contentInsetAdjustmentBehavior="automatic"`.
   */
  windowBottomInset: number;
};

/**
 * `paddingBottom` for a tab page's list that runs
 * `contentInsetAdjustmentBehavior="automatic"`, so its last item rests `gap`
 * above the tab bar's top edge.
 *
 * iOS: UIKit already insets such a list by the window's home-indicator area
 * (it knows nothing of our JS bar), so padding by the full bar height counted
 * that 34pt twice and the last card floated ~50pt above the bar instead of 16
 * (design review 2026-11-16). Subtract what UIKit adds. Android: the prop is a
 * no-op, so this equals {@link resolveFloatingAffordanceBottom}.
 *
 * Lists on RN's `never` default (Watchlist) want the floating-affordance value.
 */
export function resolveAutomaticInsetListBottomPadding({
  windowBottomInset,
  ...args
}: AutomaticInsetListBottomPaddingArgs): number {
  const clearance = resolveFloatingAffordanceBottom(args);
  if (args.os !== 'ios') {
    return clearance;
  }
  return Math.max(clearance - Math.max(windowBottomInset, 0), 0);
}

/** Hook form of {@link resolveAutomaticInsetListBottomPadding}. */
export function useAutomaticInsetListBottomPadding(gap: number = LAST_CARD_TO_TAB_BAR_GAP): number {
  const insets = useSafeAreaInsets();
  const isTabScreen = useContext(TabScreenContext);

  return resolveAutomaticInsetListBottomPadding({
    os: Platform.OS,
    safeAreaBottom: insets.bottom,
    isTabScreen,
    gap,
    // The window's, not the context's: inside the pager the context's bottom is
    // the whole bar. Same source the bar itself is sized from.
    windowBottomInset: initialWindowMetrics?.insets.bottom ?? 0,
  });
}
