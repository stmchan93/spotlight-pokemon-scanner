import { useCallback } from 'react';
import { useNavigation } from '@react-navigation/native';

import { FocusedStatusBar } from '@/components/focused-status-bar';
import { ScannerScreen } from '@/features/scanner/screens/scanner-screen';
import { getLastActiveTab } from '@/lib/last-active-tab';
import { useDeferDataRefreshWhileFocused } from '@/providers/use-defer-data-refresh';

/**
 * The Scanner, as an ordinary page of the tab pager.
 *
 * The pager's tab bar turns into the solid black scanner bar on this page
 * (`AppTabBar`, Figma 6322:9081), and `reserveTabBarSpace` makes the scanner lay
 * its viewfinder and tray out above it rather than under it. A horizontal drag on
 * the camera area is the pager's (back to Watchlist, forward to Events); the
 * tray, binder review and every sheet stand it down (see `scanner-screen.tsx`).
 *
 * The camera runs only when this page is the SETTLED page and the app is in the
 * foreground: `TabsPageContext.activePage` is 'scanner' only once the strip is at
 * rest here, so dragging Scan half into view never starts it.
 *
 * ===========================================================================
 * THE WHITE BAR AT THE BOTTOM ON ANDROID IS NOT OURS
 * ===========================================================================
 * Reported on a Galaxy A17: a white band across the bottom of the viewfinder.
 * It is not the tab bar and not any view in this tree. It is the SYSTEM
 * navigation bar's contrast scrim, and the chain is:
 *
 *   1. `android/gradle.properties` sets `edgeToEdgeEnabled=true`, so
 *      `EdgeToEdgePackage` (expo-modules-core) calls React Native's
 *      `Window.enableEdgeToEdge()` on every Activity create.
 *   2. That sets `navigationBarColor = TRANSPARENT` **and**
 *      `isNavigationBarContrastEnforced = true`, plus
 *      `isAppearanceLightNavigationBars = !isDarkMode` — and this app is pinned
 *      to light (`app.json` `userInterfaceStyle`).
 *   3. A transparent nav bar with contrast enforced makes the platform paint a
 *      scrim, and the LIGHT one is `argb(0xE6, 0xFF, 0xFF, 0xFF)` — ~90% opaque
 *      white. React Native names that constant `LightNavigationBarColor` in
 *      `views/view/WindowUtil.kt`.
 *   4. `EdgeToEdgePackage` then re-reads `android.R.attr.
 *      enforceNavigationBarContrast` from the app theme, DEFAULTING TO TRUE, and
 *      `android/app/src/main/res/values/styles.xml` never declares it.
 *
 * Every other screen hides it by accident: their content is white in exactly
 * that strip. Over the black scanner bar the scrim is what is left. It only
 * shows under BUTTON navigation — gesture nav gets no scrim — which is why it
 * reproduces on a Samsung and not on every Android.
 *
 * The scrim is drawn by the window decor, ABOVE every React view, so no style
 * here can cover it and none of the installed modules can recolour it
 * (`Screen.navigationBarColor` is documented a no-op from target SDK 35).
 * The fix is one theme attribute — `android:enforceNavigationBarContrast` =
 * false in `AppTheme`, which is exactly what expo-dev-launcher's own
 * edge-to-edge theme does — and it needs a NATIVE build, not an OTA.
 */
export default function ScanRoute() {
  const navigation = useNavigation();
  // Coalesce the Scanner's per-add refreshData() calls; leaving flushes them
  // before Collection, a card page, etc. can show stale data.
  useDeferDataRefreshWhileFocused();

  const goBack = useCallback(() => {
    // BACK to where you came from, not to a fixed destination: scanning from the
    // tab your cards are on should land you back there. A tab switch through
    // the pager navigator, not a pop.
    navigation.navigate(getLastActiveTab() as never);
  }, [navigation]);

  return (
    <>
      {/* Dark viewfinder needs light status-bar icons. */}
      <FocusedStatusBar style="light" />
      <ScannerScreen onExitToPortfolio={goBack} reserveTabBarSpace />
    </>
  );
}
