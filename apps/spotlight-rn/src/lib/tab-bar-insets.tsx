import { createContext, useContext, type ReactNode } from 'react';
import { Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

/*
  ───────────────────────────────────────────────────────────────────────────────
  THE ONE PLACE THAT KNOWS HOW HIGH A FLOATING AFFORDANCE HAS TO SIT
  ───────────────────────────────────────────────────────────────────────────────
  Sibling of `@/lib/keyboard-insets`, and it exists for the same reason: the
  answer is not a number, it is a different measurement on each platform, and
  every screen that guesses gets it wrong in a way nobody notices until it is
  pointed at.

  The app's tab bar is `NativeTabs` (`src/app/(tabs)/_layout.tsx`) — Apple's real
  `UITabBarController` on iOS, Material's `BottomNavigationView` on Android.
  NEITHER platform hands its height to JS, and `@react-navigation/bottom-tabs`'
  `useBottomTabBarHeight()` CANNOT be used to ask: that hook reads
  `BottomTabBarHeightContext`, which is only ever mounted by the JS
  `BottomTabView` (`@react-navigation/bottom-tabs/src/views/BottomTabView.tsx`,
  the `<BottomTabBarHeightContext.Provider>` at :327). Under a native navigator
  nothing provides it and the hook THROWS
  ("Couldn't find the bottom tab bar height").

  So do not reach for the bar's height at all. Both platforms already tell us the
  same thing in a better form — how much room the chrome takes — just through two
  different channels:

   • iOS — `useSafeAreaInsets().bottom` ALREADY INCLUDES THE TAB BAR.
     expo-router wraps every native tab screen's content in a FRESH
     `<SafeAreaProvider>` (`expo-router/build/native-tabs/NativeTabsView.js`,
     `Screen()`: `else if (process.env.EXPO_OS === 'ios') return
     <SafeAreaProvider>{content}</SafeAreaProvider>`). That provider's native view
     reports `self.safeAreaInsets`
     (`react-native-safe-area-context/ios/Fabric/RNCSafeAreaProviderComponentView.mm:85`),
     and it is mounted INSIDE the tab's child view controller view
     (`react-native-screens/ios/bottom-tabs/screen/RNSBottomTabsScreenComponentView.mm:221`),
     which UIKit insets by the translucent tab bar. So the nearest provider to any
     tab screen reports `homeIndicator + tabBar`, not `homeIndicator`.
     Corroborated in-app by the Collection/Wishlist edit bars, which are
     `position:absolute; bottom:0` with `paddingBottom: max(insets.bottom, 12)` and
     clear the bar today — they could not, on 34pt of home indicator alone.

     This is also why nothing here needs a per-iOS-version bar height: the number
     is whatever UIKit currently says, including on the Scanner where the bar is
     hidden (`hidden={isScanner}`) and the inset collapses back to the home
     indicator on its own.

   • ANDROID — the CONTAINER is already inset, so the inset must NOT be re-added.
     Android has no translucent-overlay equivalent. `TabsHost` is a FrameLayout
     that adds the content at MATCH_PARENT and the `BottomNavigationView` over it
     at `Gravity.BOTTOM`, and instead of insetting the safe area it feeds its
     MEASURED bar height out as "interface insets"
     (`TabsHost.kt:500` — `EdgeInsets(0, 0, 0, bottomNavigationView.height)`).
     expo-router consumes that by wrapping every Android tab screen in
     react-native-screens' `SafeAreaView edges={{ bottom: true }}` (same
     `Screen()`), whose padding is
     `EdgeInsets.max(interfaceInsets, systemInsets)` (`safearea/SafeAreaView.kt`,
     `updateInsets()`) — i.e. the bar height, which Material's `NavigationBarView`
     has already grown by the system navigation bar.

     Yoga positions absolutely-positioned children INSIDE that padding by default
     (`react-native/ReactCommon/yoga/yoga/algorithm/AbsoluteLayout.cpp:43-44`,
     `flexEndPosition += parent->getLayout().padding(...)`, skipped only under the
     `AbsolutePositionWithoutInsetsExcludesPadding` errata, which RN does not set).
     So on an Android tab screen a FAB's `bottom` is measured from a container
     edge that is ALREADY above both the bar and the system navigation bar, and
     adding `insets.bottom` on top over-shoots by the navigation bar (~24pt
     gesture, ~48pt three-button).

  What this replaces: `bottomTabBarHeight` (44) from the design system, which is
  the height of the RETIRED JS `BottomTabBar` pill and has not described the app's
  real bar since native tabs landed. Every floating affordance that added it was
  sitting ~44pt too high on both platforms.
*/

/**
 * Rest gap between a floating affordance and the top of the bottom chrome.
 * 28 is where the original search/add FAB was anchored above the JS nav pill;
 * the gap is the part of that arithmetic that was always correct.
 */
export const floatingAffordanceGap = 28;

/**
 * True inside `src/app/(tabs)`, i.e. under a screen that `NativeTabs` owns.
 *
 * Only Android needs this — see the Android note above: its tab CONTAINER is
 * pre-inset, while a pushed stack screen (`app/(stack)/…`, e.g. Insights) is
 * full-bleed and has no bar at all. iOS answers both cases with the same
 * `insets.bottom`, so it never reads this.
 *
 * A context rather than `useSegments()` on purpose: native tabs keep every tab
 * screen MOUNTED, so a route-string check would make an unfocused screen answer
 * for whatever route is focused. Provider membership does not move.
 *
 * THE ONE TAB THIS DOES NOT DESCRIBE IS `/scan`. It sets
 * `disableAutomaticContentInsets`, which is exactly the flag that suppresses the
 * Android `SafeAreaView` wrapper this branch assumes (and it hides the bar
 * outright), so its container is full-bleed like a stack screen's. That is fine
 * today because no floating affordance renders on the Scanner — it owns its own
 * full-screen chrome. Anything that starts floating there must take the
 * non-tab-screen arithmetic; iOS is already correct either way, since hiding the
 * bar collapses the inset on its own.
 */
const NativeTabScreenContext = createContext(false);

export function NativeTabScreenProvider({ children }: { children: ReactNode }) {
  return <NativeTabScreenContext.Provider value>{children}</NativeTabScreenContext.Provider>;
}

type FloatingAffordanceBottomArgs = {
  os: typeof Platform.OS;
  /** `useSafeAreaInsets().bottom` as seen by the calling screen. */
  safeAreaBottom: number;
  /** Whether the caller renders under `NativeTabs` (see the context above). */
  isNativeTabScreen: boolean;
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
  isNativeTabScreen,
  gap = floatingAffordanceGap,
}: FloatingAffordanceBottomArgs): number {
  if (os === 'android' && isNativeTabScreen) {
    // Container already cleared of the bar AND the system navigation bar.
    return gap;
  }
  return Math.max(safeAreaBottom, 0) + gap;
}

/** Hook form of {@link resolveFloatingAffordanceBottom}. */
export function useFloatingAffordanceBottom(gap: number = floatingAffordanceGap): number {
  const insets = useSafeAreaInsets();
  const isNativeTabScreen = useContext(NativeTabScreenContext);

  return resolveFloatingAffordanceBottom({
    os: Platform.OS,
    safeAreaBottom: insets.bottom,
    isNativeTabScreen,
    gap,
  });
}
