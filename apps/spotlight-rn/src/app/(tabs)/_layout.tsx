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
 *    swipe-between-tabs gesture; absent from TabsHost and expo-router alike).
 *    THIS IS NOW THE INTENDED BEHAVIOUR, not a gap to close: no screen that
 *    draws this bar may be reached or left by a horizontal swipe. The scanner's
 *    hand-rolled left-edge exit swipe was deleted for the same reason. Pushed
 *    stack screens keep UIKit's back-swipe — that rule is only about the tabs.
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
 * `minimizeBehavior` — WHAT IT ACTUALLY DEPENDS ON. This was twice written off
 * as blocked on native support. It is not: the requirement is a JS-side tree
 * shape, and it is met in `portfolio-screen.tsx`, not here.
 *
 * The prop reaches UIKit fine — expo-router forwards it as
 * `tabBarMinimizeBehavior` and `RNSBottomTabsHostComponentView` assigns
 * `_controller.tabBarMinimizeBehavior` behind an iOS 26 SDK check. UIKit then
 * has to work out WHICH scroll view to track, and it finds it by walking
 * `subviews[0]` down from the tab screen's view. react-native-screens 4.23.0
 * indeed never implements `contentScrollViewForEdge:`, but it does not need to:
 * it replicates the same walk in
 * `ios/helpers/scroll-view/RNSScrollViewFinder.mm`, whose header says outright
 * that it works "similar to UIKit behavior". DEPTH IS NOT THE CONSTRAINT — the
 * walk is unbounded, and expo-router's own two wrappers (a `<SafeAreaProvider>`
 * and a `<View collapsable={false}>`, in NativeTabsView.js `Screen()`) are both
 * real single-child views and pass it fine.
 *
 * What breaks it is React Native VIEW FLATTENING. A plain `<View>` that has a
 * `testID` but no stacking-context trigger is mounted as a real but EMPTY
 * UIView, with its children re-parented as its own siblings
 * (`ViewShadowNode::initialize` + `sliceChildShadowNodeViewPairs.cpp`). One such
 * wrapper anywhere on the chain parks a childless view at index 0 and the walk
 * returns nil. `collapsable={false}` on that wrapper is the whole fix, and is
 * what the screens maintainer prescribes in
 * software-mansion/react-native-screens#3954. (#4145 is a different, still-open
 * case: a scroll view under a nested native STACK, which no JS flag reaches.)
 *
 * So: if minimize ever stops working, do not look here and do not look at
 * `contentInsetAdjustmentBehavior`. Look for a new unflattened `<View>` between
 * the tab screen and the list. `<DrawerEdgeSwipe>` in wrapper mode is safe — its
 * PanResponder handlers set `ViewEvents` bits, which force a stacking context on
 * their own.
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
      {/*
        Home / Scan / Wishlist / You, in that order.

        `index` is the FEED now, not Collection — the app's landing surface is
        social. Collection moved to `you` and kept its screen unchanged; the
        legacy `/portfolio` path redirects there so old links still resolve.
      */}
      <Trigger name="index">
        <Icon sf={{ default: 'house', selected: 'house.fill' }} />
        <Label>Home</Label>
      </Trigger>
      <Trigger name="scan">
        <Icon sf={{ default: 'viewfinder', selected: 'viewfinder' }} />
        <Label>Scan</Label>
      </Trigger>
      <Trigger name="wishlist">
        <Icon sf={{ default: 'bookmark', selected: 'bookmark.fill' }} />
        <Label>Wishlist</Label>
      </Trigger>
      <Trigger name="you">
        <Icon sf={{ default: 'person.crop.circle', selected: 'person.crop.circle.fill' }} />
        <Label>You</Label>
      </Trigger>
    </NativeTabs>
  );
}
