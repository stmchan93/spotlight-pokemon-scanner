import { NativeTabs } from 'expo-router/unstable-native-tabs';

const { Trigger } = NativeTabs;
const { Icon, Label } = Trigger;

/**
 * Native iOS 26 tab bar — Collection and Wishlist only.
 *
 * SCAN IS DELIBERATELY NOT A TAB. Two hard constraints force this, both verified
 * in source rather than assumed:
 *
 *  1. `NativeBottomTabsNavigator` emits `tabPress` and then dispatches JUMP_TO
 *     WITHOUT reading `defaultPrevented`, so a native tab item can never be
 *     intercepted to push a full-screen route instead of switching to it.
 *  2. A native tab necessarily renders the bar over its screen and applies
 *     automatic content insets. On the camera that shrank the reticle, because
 *     reticle geometry comes from `useWindowDimensions()` (scanner-screen.tsx
 *     :862-863) — full-window math inside an inset container.
 *
 * So the camera is a pushed route (`/native-scan`) instead. That is not a
 * consolation prize: a pushed screen is full-bleed, keeps the reticle at full
 * size, and gets a real back button plus iOS's own interactive drag-follow
 * back-swipe — the swipe the pager hand-rolled in 358 lines, owned by UIKit.
 */
export default function NativeTabsLayout() {
  return (
    <NativeTabs minimizeBehavior="onScrollDown">
      <Trigger name="index">
        <Icon sf={{ default: 'square.grid.2x2', selected: 'square.grid.2x2.fill' }} />
        <Label>Collection</Label>
      </Trigger>
      {/*
        Middle slot, by request. Being a real tab is the ONLY way to sit in a
        native bar — and it costs the full-bleed camera: UIKit draws the bar over
        the viewfinder and insets the content, which shrinks the reticle.

        `disableAutomaticContentInsets` is the fix and we cannot use it yet: it
        is in expo-router's NativeTabOptions but absent from react-native-screens
        4.23.0, so it needs 4.25+ — a native build, not an OTA.

        `/native-scan` is kept alive as the pushed-route alternative for exactly
        this reason; deep link it to compare a full-size reticle against this.
      */}
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
