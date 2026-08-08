import { usePathname } from 'expo-router';
import { NativeTabs } from 'expo-router/unstable-native-tabs';

import { colors } from '@spotlight/design-system';

const { Trigger } = NativeTabs;
const { Icon, Label } = Trigger;

/**
 * The app's tab bar: Apple's native iOS 26 tab controller, which is what gives
 * the real Liquid Glass material and the system minimize-on-scroll.
 *
 * REPLACED `TopTabsPager`. What that cost, so nobody re-derives it:
 *  - the horizontal Portfolio <-> Scanner swipe (UITabBarController has no
 *    swipe-between-tabs gesture; absent from TabsHost and expo-router alike)
 *  - the left-edge drag that opened the hamburger drawer, which lived inside
 *    the pager's pan responder — the drawer BUTTON still works
 *  - hiding the bar during Collection edit mode; UIKit owns this bar and
 *    `hidden` on a TRIGGER hides a tab; `hidden` on <NativeTabs> hides the bar,
 *    which is how the Scanner gets a full screen (see below)
 *
 * Scan is a real tab because a native bar cannot host a push-button:
 * NativeBottomTabsNavigator emits `tabPress` then dispatches JUMP_TO without
 * reading `defaultPrevented`. The cost is that the bar draws over the viewfinder
 * and insets it. `disableAutomaticContentInsets` fixes that but needs
 * react-native-screens 4.25+ (we are on 4.23.0) — a native build, not an OTA.
 *
 * The pager is still in git history if this needs reverting.
 *
 * SELECTED-TAB COLOUR — why `tintColor` and nothing else.
 * Without it UIKit uses the system accent (iOS blue). `tintColor` is the ONE
 * prop that covers every surface of the selected item, because expo-router fans
 * it out three ways (expo-router/build/native-tabs/NativeBottomTabsNavigator.js
 * + NativeTabsView.js):
 *   1. `selectedIconColor: iconColor.selected ?? tintColor`
 *      -> standardAppearance.stacked.selected.tabBarItemIconColor  (ICON)
 *   2. `selectedLabelStyle: { color: tintColor }`
 *      -> standardAppearance.stacked.selected.tabBarItemTitleFontColor (LABEL)
 *   3. `tabBarTintColor={tintColor}` on the react-native-screens host, which per
 *      TabsHost.types.ts also tints the iOS 26 Liquid Glass SELECTION GLOW.
 * Setting `iconColor`/`labelStyle` on top would only re-state 1 and 2 while
 * risking a mismatch with 3, so this stays a single source of truth.
 *
 * UNSELECTED items are deliberately left alone: expo-router only writes these
 * values into the `selected`/`focused` appearance states, and react-native-screens
 * documents that from iOS 26 the unselected items follow the tab bar's own
 * light/dark appearance. Forcing gray900 on `normal` too would kill that
 * contrast in dark mode.
 *
 * `minimizeBehavior` IS KNOWN NOT TO WORK AT react-native-screens 4.23.0.
 * It is left set because it is correct and costs nothing, but do not spend more
 * time on the JS side — the blocker is native and outside this repo:
 *   - The prop reaches UIKit fine: expo-router forwards it as
 *     `tabBarMinimizeBehavior`, and RNSBottomTabsHostComponentView assigns
 *     `_controller.tabBarMinimizeBehavior` (guarded by an iOS 26 SDK check).
 *   - UIKit then has to work out WHICH scroll view to track, via
 *     `UIViewController.contentScrollView(for:)`. react-native-screens 4.23.0
 *     never implements or calls it — `grep -r contentScrollView` over its `ios/`
 *     dir finds only an unused `RNSScrollViewFinder` helper. So resolution is
 *     left entirely to UIKit's own shallow auto-detection.
 *   - That auto-detection loses the list behind the styled UIViews stacked
 *     between the tab screen and it. Two of those are added by EXPO-ROUTER, not
 *     by us: `Screen()` in expo-router/build/native-tabs/NativeTabsView.js wraps
 *     every iOS tab in a `<SafeAreaProvider>` and then a
 *     `<View collapsable={false}>` carrying backgroundColor + overflow:'hidden'.
 *     Nothing exposed on NativeTabs or Trigger removes them.
 *     Upstream: software-mansion/react-native-screens#4145 (and #3954), which
 *     ask for `contentScrollViewForEdge:` on RNSTabsScreenViewController.
 * Setting `contentInsetAdjustmentBehavior` on the list does NOT fix this —
 * screens already forces that value; see the note in portfolio-screen.tsx.
 * Re-test after a screens upgrade past 4.23.0, not before.
 */
export default function TabsLayout() {
  // Hide the BAR ITSELF on the Scanner. `hidden` on <NativeTabs> maps to
  // react-native-screens' `tabBarHidden` (NativeTabsView.js) — note this is NOT
  // the `hidden` on a Trigger, which removes a TAB from the bar entirely.
  //
  // This is what finally makes Scan work as a normal tab. Four earlier attempts
  // tried to keep the camera off the tab bar by making Scan a LAUNCHER that
  // pushed a full-screen route, and every one of them stranded the user on the
  // blank launcher after backing out: pushing from a tab means something has to
  // move the tab selection afterwards, and nothing reliably does while the tabs
  // are covered. Hiding the bar removes the entire problem — there is no push,
  // so there is nothing to come back from.
  const pathname = usePathname();
  const isScanner = pathname === '/scan';

  return (
    <NativeTabs
      hidden={isScanner}
      minimizeBehavior="onScrollDown"
      tintColor={colors.gray900}
    >
      <Trigger name="index">
        <Icon sf={{ default: 'square.grid.2x2', selected: 'square.grid.2x2.fill' }} />
        <Label>Collection</Label>
      </Trigger>
      <Trigger name="scan">
        <Icon sf={{ default: 'viewfinder', selected: 'viewfinder' }} />
        <Label>Scan</Label>
      </Trigger>
      <Trigger name="wishlist">
        <Icon sf={{ default: 'bookmark', selected: 'bookmark.fill' }} />
        <Label>Wishlist</Label>
      </Trigger>
    </NativeTabs>
  );
}
