import { useCallback } from 'react';
import { useNavigation } from '@react-navigation/native';
import { StatusBar } from 'expo-status-bar';

import { NativeTabsPageBridge } from '@/components/native-tabs-page-bridge';
import { ScannerExitSwipe } from '@/components/scanner-exit-swipe';
import { ScannerScreen } from '@/features/scanner/screens/scanner-screen';

/**
 * The Scanner, as an ordinary tab.
 *
 * The tab BAR is hidden while this route is active — see the `hidden` prop in
 * `_layout.tsx` — so the camera still gets the whole screen and the reticle
 * keeps its original size. Nothing is pushed and nothing is covered.
 *
 * ===========================================================================
 * WHY THIS IS NOT A LAUNCHER ANY MORE
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
 * so there is no return, so there is nothing to strand anyone on.
 */
export default function ScanRoute() {
  const navigation = useNavigation();

  // Back out to Collection. This is a TAB switch, not a pop — `useNavigation()`
  // inside a native tab screen already returns the (tabs) navigator, so this
  // dispatches to the right place (calling `getParent()` here was bug #2 above).
  const goToCollection = useCallback(() => {
    navigation.navigate('index' as never);
  }, [navigation]);

  return (
    <NativeTabsPageBridge page="scanner">
      {/* Dark viewfinder needs light status-bar icons. */}
      <StatusBar style="light" />
      {/* A pushed camera route used to give a back-swipe for free; a tab does
          not. This puts the left-edge drag back, wired to the same destination
          as the back button so there is exactly one way out with two ways to
          ask for it. */}
      <ScannerExitSwipe onExit={goToCollection}>
        <ScannerScreen onExitToPortfolio={goToCollection} />
      </ScannerExitSwipe>
    </NativeTabsPageBridge>
  );
}
