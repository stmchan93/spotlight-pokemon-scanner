import { NativeTabs } from 'expo-router/unstable-native-tabs';

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
 *    `hidden` hides a TAB, not the BAR
 *
 * Scan is a real tab because a native bar cannot host a push-button:
 * NativeBottomTabsNavigator emits `tabPress` then dispatches JUMP_TO without
 * reading `defaultPrevented`. The cost is that the bar draws over the viewfinder
 * and insets it. `disableAutomaticContentInsets` fixes that but needs
 * react-native-screens 4.25+ (we are on 4.23.0) — a native build, not an OTA.
 *
 * The pager is still in git history if this needs reverting.
 */
export default function TabsLayout() {
  return (
    <NativeTabs minimizeBehavior="onScrollDown">
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
