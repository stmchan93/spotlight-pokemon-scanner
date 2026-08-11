import { Platform } from 'react-native';

/*
  ───────────────────────────────────────────────────────────────────────────────
  THE ONE PLACE THAT KNOWS WHAT A "KEYBOARD HEIGHT" MEANS ON EACH PLATFORM
  ───────────────────────────────────────────────────────────────────────────────
  Every surface in this app that has to hold something clear of the software
  keyboard needs the same fact, and it is not the fact you would guess: the
  number `Keyboard`'s events report does NOT mean the same thing on the two
  platforms, and the safe-area bottom inset is paid on top of it on exactly one
  of them.

   • ANDROID — the reported height EXCLUDES the system navigation bar.
     `ReactRootView.java`'s `checkForKeyboardEvents()` computes

         int height = imeInsets.bottom - barInsets.bottom;   // :922

     — the IME inset MINUS the system bars — so what arrives in JS is the
     keyboard's height ABOVE the navigation bar. The bar itself is still there,
     still drawn over the app (this app builds with `edgeToEdgeEnabled=true`, see
     `android/gradle.properties`, under which the window is NEVER resized for the
     IME and the app consumes the insets itself), and it is exactly what
     `useSafeAreaInsets().bottom` reports. So the distance from the bottom of the
     screen to the top of the keyboard is `reportedHeight + safeAreaBottom`, and
     anything that assumes the reported height already covers the bar under-shoots
     by ~24pt (gesture nav) to ~48pt (three-button nav) — enough to bury a text
     field, a POST button, or a whole composer.

     `react-native-safe-area-context` will not rescue that assumption either: its
     Android implementation (`SafeAreaUtils.kt`) asks for
     `statusBars | displayCutout | navigationBars | captionBar` and deliberately
     never includes the IME, so the inset is the SAME number whether the keyboard
     is up or down.

   • iOS — the reported frame is in SCREEN coordinates, so it already reaches the
     physical bottom of the display and OVERLAPS the home-indicator strip. There
     is nothing extra to add; adding the safe-area inset here pays that strip
     twice and leaves the surface floating.

  This arithmetic was independently derived THREE times before it lived here —
  `keyboardLift` in `new-post-screen.tsx`, `systemBottomInset` /
  `composerBottomPadding` / `sheetHeightForKeyboard` in `comments-sheet.tsx`, and
  a third screen (`edit-profile-screen.tsx`) that simply had none and shipped with
  the keyboard over its bio field. Two of those carried a comment saying they
  existed "so there is no third time". Comments do not stop a fourth derivation;
  one importable function does.

  WHY A PURE MODULE AND NOT A HOOK. What the three sites share is the ARITHMETIC,
  not the plumbing: `comments-sheet` subscribes only while it is `visible` and its
  listener is entangled with `claimResizeFor` (a resize claimed on the keyboard
  event rather than in the effect that animates it — see the note there);
  `new-post-screen` derives its iOS height from `endCoordinates.screenY` rather
  than `.height` so a dismissing keyboard stops lifting; `edit-profile` needs the
  value on Android only. A shared `useKeyboardHeight()` could not be adopted by
  either of the first two without changing behaviour, which is the one thing this
  extraction may not do. Pure functions are also injectable-by-platform, which is
  what makes the Android branch testable without re-importing a module under a
  patched `Platform.OS` (that resets the module registry and takes every other
  test in the file with it).

  `platform` is therefore injectable on every function here, and defaults to the
  real one.
*/

/**
 * The part of the bottom safe-area inset that the reported keyboard height does
 * NOT already account for — i.e. the strip at the bottom of the screen the SYSTEM
 * has taken and that must be reserved ON TOP OF the keyboard.
 *
 * The Android navigation bar (or gesture handle) on Android; nothing on iOS,
 * where the keyboard's frame already reaches the bottom of the display.
 *
 * Never negative, whatever a provider reports before it has measured.
 */
export function keyboardInsetSurcharge(
  safeAreaBottom: number,
  platform: string = Platform.OS,
): number {
  if (platform !== 'android') {
    return 0;
  }
  return Math.max(0, safeAreaBottom);
}

/**
 * How much of the screen, measured up from its physical bottom edge, the keyboard
 * and the system strip beneath it occupy together. Zero when the keyboard is down.
 *
 * This is the number to reserve when the surface reaching for it starts at the
 * bottom of the screen and has NOT already paid a bottom inset of its own —
 * a full-height container under an edge-to-edge window, which is what
 * `edit-profile-screen.tsx` shrinks its scroll viewport by. When the container
 * HAS paid one, use `keyboardLift`, which is this minus what it paid.
 */
export function keyboardClearance(
  keyboardHeight: number,
  safeAreaBottom: number,
  platform: string = Platform.OS,
): number {
  if (keyboardHeight <= 0) {
    return 0;
  }
  return keyboardHeight + keyboardInsetSurcharge(safeAreaBottom, platform);
}

/**
 * How far a surface must be lifted to clear a keyboard of height
 * `keyboardHeight`, given `bottomInset` — the bottom padding its own container
 * already applies.
 *
 * THE CONTRACT: the surface's bottom edge ends up `bottomInset + lift` above the
 * screen's bottom edge, and that total is the clearance. `bottomInset` must be
 * the SAME VARIABLE the container pays, not an inset some other component is
 * assumed to have paid — in `new-post-screen.tsx` that used to name a
 * `SafeAreaView` which turned out to pay nothing inside an iOS modal, so the
 * footer was lifted `keyboardHeight - 34` when it needed `keyboardHeight` and
 * POST sat one home-indicator strip inside the keyboard.
 *
 * For any real (non-negative) inset this is exactly
 * `keyboardClearance(...) - bottomInset`; the branch is written out because that
 * identity is the claim, and because the two platforms disagree about which of
 * the two terms the reported height already contains (see the note at the top of
 * this file, and `ReactRootView.java:922`).
 */
export function keyboardLift(
  keyboardHeight: number,
  bottomInset: number,
  platform: string = Platform.OS,
): number {
  if (keyboardHeight <= 0) {
    return 0;
  }
  if (platform === 'android') {
    // The reported height excludes the navigation bar the container's padding is
    // paying, so the two do not overlap and nothing may be subtracted. Doing so
    // under-lifts by exactly one nav bar.
    return keyboardHeight;
  }
  // iOS: the keyboard's screen-coordinate frame already covers the strip the
  // container's padding holds the surface clear of. Subtracting is what stops
  // that strip being paid twice.
  return Math.max(0, keyboardHeight - bottomInset);
}
