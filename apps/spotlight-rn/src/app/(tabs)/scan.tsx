import { useCallback } from 'react';
import { useNavigation } from '@react-navigation/native';
import { StatusBar } from 'expo-status-bar';

import { NativeTabsPageBridge } from '@/components/native-tabs-page-bridge';
import { ScannerScreen } from '@/features/scanner/screens/scanner-screen';
import { getLastActiveTab } from '@/lib/last-active-tab';

/**
 * The Scanner, as an ordinary tab.
 *
 * The tab BAR is hidden while this route is active — see the `hidden` prop in
 * `_layout.tsx` — so the camera still gets the whole screen and the reticle
 * keeps its original size. Nothing is pushed and nothing is covered.
 *
 * ===========================================================================
 * THE WHITE BAR AT THE BOTTOM ON ANDROID IS NOT OURS
 * ===========================================================================
 * Reported on a Galaxy A17: a white band across the bottom of the viewfinder.
 * It is not the tab bar (hidden, and verified working on Android — see
 * `_layout.tsx`), not expo-router's automatic bottom inset (disabled on the Scan
 * trigger), and not any view in this tree. It is the SYSTEM navigation bar's
 * contrast scrim, and the chain is:
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
 * Every other screen hides it by accident: the native tab bar is
 * `colors.canvasElevated` (#FFFFFF) and sits in exactly that strip. Kill the bar
 * for the camera and the scrim is what is left. It only shows under BUTTON
 * navigation — gesture nav gets no scrim — which is why it reproduces on a
 * Samsung and not on every Android.
 *
 * The scrim is drawn by the window decor, ABOVE every React view, so no style
 * here can cover it and none of the installed modules can recolour it
 * (`Screen.navigationBarColor` is documented a no-op from target SDK 35).
 * The fix is one theme attribute — `android:enforceNavigationBarContrast` =
 * false in `AppTheme`, which is exactly what expo-dev-launcher's own
 * edge-to-edge theme does — and it needs a NATIVE build, not an OTA.
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

  const goBack = useCallback(() => {
    // BACK to where you came from, not to a fixed destination. Leaving the
    // Scanner always went to Home, so scanning from You — the tab your cards are
    // on, and the one people scan from — dumped you on the feed and made you
    // navigate back to see what you had just added.
    //
    // Still a TAB SWITCH, not a pop: `useNavigation()` inside a native tab
    // screen already returns the (tabs) navigator, so this dispatches to the
    // right place (calling `getParent()` here was bug #2 above).
    navigation.navigate(getLastActiveTab() as never);
  }, [navigation]);

  return (
    <NativeTabsPageBridge page="scanner">
      {/* Dark viewfinder needs light status-bar icons. */}
      <StatusBar style="light" />
      <ScannerScreen onExitToPortfolio={goBack} />
    </NativeTabsPageBridge>
  );
}
