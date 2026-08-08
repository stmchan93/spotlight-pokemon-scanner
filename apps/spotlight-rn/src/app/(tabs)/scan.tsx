import { useCallback } from 'react';
import { useNavigation } from '@react-navigation/native';
import { StatusBar } from 'expo-status-bar';

import { NativeTabsPageBridge } from '@/components/native-tabs-page-bridge';
import { ScannerScreen } from '@/features/scanner/screens/scanner-screen';

/**
 * The Scanner, as an ordinary tab.
 *
 * The tab BAR is hidden while this route is active — see the `hidden` prop in
 * `_layout.tsx` — so the camera still gets the whole screen and the reticle
 * keeps its original size. Nothing is pushed and nothing is covered.
 *
 * ===========================================================================
 * NO HORIZONTAL SWIPE OUT OF HERE
 * ===========================================================================
 * This screen used to wrap itself in `ScannerExitSwipe`, a hand-rolled
 * left-edge drag that switched tabs. It is gone, and the component with it: no
 * screen that belongs to the tab bar may be entered or left by a horizontal
 * swipe. The exit BUTTON is the single way out, which is also what the four
 * native tabs already do — UITabBarController has no swipe-between-tabs gesture
 * either, so the scanner was the one place the rule was broken.
 *
 * This does not touch pushed stack screens. They keep UIKit's interactive
 * back-swipe, which is the app's only horizontal navigation gesture now.
 *
 * ===========================================================================
 * WHY THIS IS NOT A LAUNCHER
 * ===========================================================================
 * Four attempts tried to keep the bar off the camera by making Scan a launcher
 * that pushed a full-screen `/scan-camera` route. Every one stranded the user on
 * the blank launcher after backing out, because pushing from a tab means
 * something has to move the tab selection afterwards, and nothing does so
 * reliably while the tabs are covered:
 *
 *   1. a ref that alternated on focus — the second focus never arrived
 *   2. `getParent().navigate('index')` — addressed the ROOT STACK, which has no
 *      `index` route, so the action was silently dropped
 *   3. the same call against the tabs navigator, plus a dismissal timestamp —
 *      correct in JS, but the native UITabBarController did not follow the state
 *      change while it was covered by the pushed screen
 *
 * Hiding the bar deletes the problem instead of managing it. There is no push,
 * so there is no return, so there is nothing to strand anyone on. This is also
 * why the camera does not slide up from the bottom: a modal presentation needs
 * a push, and `NativeBottomTabsNavigator` emits `tabPress` and then dispatches
 * JUMP_TO without reading `defaultPrevented`, so a native tab cannot be
 * intercepted to present one.
 */
export default function ScanRoute() {
  const navigation = useNavigation();

  // Leaving the camera goes HOME, not to the collection: Home is the landing tab
  // now, so it is where "out of here" means. This is a TAB switch, not a pop —
  // `useNavigation()` inside a native tab screen already returns the (tabs)
  // navigator, so it dispatches to the right place (calling `getParent()` here
  // was bug #2 above).
  const goHome = useCallback(() => {
    navigation.navigate('index' as never);
  }, [navigation]);

  return (
    <NativeTabsPageBridge page="scanner">
      {/* Dark viewfinder needs light status-bar icons. */}
      <StatusBar style="light" />
      <ScannerScreen onExitToPortfolio={goHome} />
    </NativeTabsPageBridge>
  );
}
