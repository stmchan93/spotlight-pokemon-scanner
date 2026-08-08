import { useCallback, useEffect, useRef } from 'react';
import { View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { router, useFocusEffect } from 'expo-router';
import { StatusBar } from 'expo-status-bar';

/**
 * The Scan TAB is a launcher, not a screen.
 *
 * Tapping it pushes the camera (`/scan-camera`) over the tabs. That push is what
 * hides the tab bar: UIKit's `hidesBottomBarWhenPushed` applies to pushed view
 * controllers, so the camera gets the full screen — full-bleed preview, reticle
 * at its original size — and the bar returns on pop, for free. Making the camera
 * a tab SCREEN instead is what shrank the reticle, because a tab always renders
 * the bar over its content and insets it.
 *
 * A native tab cannot push instead of switching (NativeBottomTabsNavigator emits
 * `tabPress` and then dispatches JUMP_TO without ever reading
 * `defaultPrevented`), so the tab switch still happens underneath — this screen
 * just must never be what the user is left on.
 *
 * ===========================================================================
 * WHY THIS TOOK THREE TRIES — READ BEFORE CHANGING ANYTHING BELOW
 * ===========================================================================
 * Symptom, twice reported: the camera opens fine, but backing out (especially
 * with the interactive back-swipe, which never runs an exit callback) lands on a
 * black screen with Scan still selected, which immediately relaunches the
 * camera — an infinite bounce.
 *
 * ATTEMPT 1 — "detect the return": launch on the first focus, and on the focus
 * caused by popping, redirect to Collection. Detecting the return is the wrong
 * shape: any latch that is SET at launch and CLEARED on the next focus leaks
 * forever the moment that second focus does not arrive, and then the next
 * legitimate launch is swallowed instead. It also leaves the user parked on the
 * launcher for a frame before the redirect.
 *
 * ATTEMPT 2 — "hand the tab selection back": `navigation.getParent()?.navigate('index')`.
 * The intent was right; the target was wrong, and that is the actual root cause
 * of the bug being fixed here. Inside a native tab screen `useNavigation()`
 * ALREADY returns the `(tabs)` navigator's navigation object — verified by
 * walking `getParent()` at runtime:
 *
 *     level 0  id "/(tabs)"  routes ["index","scan"]   <- useNavigation()
 *     level 1  id ""         routes ["(tabs)"]         <- getParent() = ROOT STACK
 *     level 2  id "__root"   routes ["__root"]
 *
 * So `getParent()` skipped straight past the tabs to the ROOT stack, which has
 * no route named `index`. React Navigation logged
 * "The action 'NAVIGATE' with payload {"name":"index"} was not handled by any
 * navigator" and the tab selection never moved at all. Attempt 2 also dropped
 * the re-entrancy guard, so the untouched Scan selection meant pop -> refocus ->
 * push -> pop -> ... forever.
 *
 * THE FIX, in three layers:
 *
 *  1. Hand the tab selection back on the CORRECT navigator — `navigation`
 *     itself, no `getParent()`. This is the load-bearing change: once Scan is no
 *     longer the selected tab, popping the camera lands on Collection for both
 *     the back button and the back-swipe, and this screen is never the return
 *     target, so there is nothing to relaunch.
 *
 *     Do NOT "simplify" this to `router.navigate('/')`. That is a root-stack
 *     NAVIGATE towards an existing route, which would POP the camera we just
 *     pushed. We want to change only which tab sits UNDERNEATH it.
 *
 *  2. Never stack two cameras: if a `scan-camera` is already on an ancestor
 *     stack, do nothing. This guard can never swallow a real launch, because a
 *     real launch by definition happens when no camera is up.
 *
 *  3. A relaunch-loop breaker that does not depend on an exit callback (the
 *     back-swipe never runs one) and cannot leak: the camera route stamps
 *     `markScanCameraDismissed()` from its UNMOUNT cleanup, which fires for the
 *     back button, `dismissTo`, and a committed back-swipe alike. A focus that
 *     lands here within `RETURN_WINDOW_MS` of that stamp is a return, not an
 *     intent, so we hand the tab back instead of pushing again. Unlike attempt
 *     1's latch this is a TIMESTAMP, so it expires on its own — a stale one can
 *     never suppress a later launch — and `tabPress` clears it outright, so a
 *     deliberate tap on the Scan tab is never suppressed at all.
 *
 * Layer 1 alone is expected to be sufficient. Layers 2 and 3 exist so that if it
 * ever stops being sufficient the failure is "Scan bounced me to Collection
 * once", not "the app is stuck in the camera".
 */

/** Root-stack route name of the pushed camera (`src/app/scan-camera.tsx`). */
const CAMERA_ROUTE_NAME = 'scan-camera';
/** Route name of the Collection tab inside `(tabs)` (`src/app/(tabs)/index.tsx`). */
const COLLECTION_TAB_ROUTE_NAME = 'index';

/**
 * How long after the camera unmounts a focus on this launcher still counts as
 * "the user came back" rather than "the user wants to scan".
 *
 * The pop and the refocus happen in the SAME navigation commit, so anything
 * above a few frames is pure margin; a second is chosen because the cost of
 * being too tight (an infinite relaunch loop) is far worse than the cost of
 * being too loose (one programmatic launch swallowed). Tab taps are exempt
 * entirely — see the `tabPress` listener below.
 */
const RETURN_WINDOW_MS = 1000;

/**
 * Module scope on purpose. `react-native-screens`' `enableFreeze(true)` (see
 * `src/app/_layout.tsx`) suspends this subtree while the camera covers it, and
 * React tears down and re-creates effects around that — so anything kept in a
 * ref or in component state cannot be trusted to survive the very trip this
 * value exists to describe.
 */
let lastCameraDismissedAt = 0;

/**
 * Called from `src/app/scan-camera.tsx`'s unmount cleanup. Deliberately driven
 * by unmount rather than by an explicit exit handler: the interactive back-swipe
 * pops the screen without ever invoking one, and the swipe is the gesture this
 * whole file keeps getting wrong.
 */
export function markScanCameraDismissed() {
  lastCameraDismissedAt = Date.now();
}

type MinimalNavigationState = {
  index: number;
  routes: { key: string; name: string }[];
};

/**
 * The slice of the React Navigation navigation object this screen uses.
 * `useNavigation()` is typed against `ReactNavigation.RootParamList`, which does
 * not know about `(tabs)`-local route names, and the untyped escape hatch used
 * before (`navigate('index' as never)`) is exactly what let attempt 2 aim at the
 * wrong navigator without the compiler noticing.
 */
type MinimalNavigation = {
  addListener: (type: string, callback: () => void) => () => void;
  getParent: () => MinimalNavigation | undefined;
  getState: () => MinimalNavigationState | undefined;
  navigate: (name: string) => void;
};

/**
 * Is a camera already on the stack above us? Starts at the PARENT: `scan-camera`
 * is a root-level route, so it can never appear in the `(tabs)` navigator's own
 * state. Walks the whole ancestor chain rather than assuming a depth, since
 * assuming the shape of this tree is what broke attempt 2.
 */
function isCameraAlreadyPushed(navigation: MinimalNavigation): boolean {
  let ancestor = navigation.getParent?.();

  while (ancestor) {
    const routes = ancestor.getState?.()?.routes;

    if (routes?.some((route) => route.name === CAMERA_ROUTE_NAME)) {
      return true;
    }

    ancestor = ancestor.getParent?.();
  }

  return false;
}

export default function ScanTab() {
  const navigation = useNavigation() as unknown as MinimalNavigation;

  // Keep the navigation object behind a ref so the focus callback can hold an
  // EMPTY dependency array. `useFocusEffect` re-subscribes on `[effect,
  // navigation]`, and it re-runs the effect on every re-subscribe while the
  // screen is focused — so a callback that changes identity is itself a way to
  // fire a second launch.
  const navigationRef = useRef(navigation);
  navigationRef.current = navigation;

  // A tab press is unambiguous user intent, so it clears the return window: a
  // user who back-swipes out of the camera and immediately taps Scan again must
  // get the camera, not a bounce to Collection.
  //
  // This CANNOT live inside `useFocusEffect` — `tabPress` is delivered while
  // this screen is still unfocused (the emit happens before the JUMP_TO that
  // focuses it), so a focus-scoped listener would never hear it.
  useEffect(() => {
    return navigationRef.current.addListener('tabPress', () => {
      lastCameraDismissedAt = 0;
    });
  }, []);

  useFocusEffect(
    useCallback(() => {
      const tabsNavigation = navigationRef.current;

      // Layer 2: a camera is already up. Nothing to launch, nothing to fix.
      if (isCameraAlreadyPushed(tabsNavigation)) {
        return;
      }

      // Layer 1: hand the selected tab back to Collection. Unconditional and
      // idempotent — it runs on the launch path AND on the return path, so a
      // return that somehow reaches this screen still leaves on Collection
      // rather than on the black launcher.
      //
      // `tabsNavigation` IS the `(tabs)` navigator (see the header comment).
      tabsNavigation.navigate(COLLECTION_TAB_ROUTE_NAME);

      // Layer 3: this focus is the camera closing, not a request to open it.
      if (Date.now() - lastCameraDismissedAt < RETURN_WINDOW_MS) {
        lastCameraDismissedAt = 0;
        return;
      }

      // Push AFTER the tab switch so the camera animates in over Collection —
      // the screen the user will be returned to — instead of over this black
      // launcher.
      router.push(`/${CAMERA_ROUTE_NAME}` as never);
    }, []),
  );

  // Black, not transparent, and not the app's light surface: this is on screen
  // only for the frame or two between UIKit selecting the Scan tab natively and
  // JS committing the push, and black is what the camera it becomes looks like.
  // It is deliberately not a spinner or a message — with the tab switch above
  // this is never a resting state, and a control that flashes for one frame
  // reads as a glitch.
  return (
    <View style={{ backgroundColor: '#000000', flex: 1 }} testID="scan-tab-launcher">
      <StatusBar style="light" />
    </View>
  );
}
