/**
 * Signed-in users open on the Scanner: once per launch and once per sign-in.
 *
 * Home (`/`) is still the tabs' root route, so the switch happens from Home the
 * first time it is focused for an account. If any other tab was shown first in
 * this mount of the tabs (a deep link, a guest already scanning when they signed
 * in), the launch counts as handled, so tapping Home later never bounces to Scan.
 * Module scope: per-process, holds only an id to compare.
 */
let handledForUserId: string | null = null;
let otherTabShownFirst = false;

/** The tabs layout mounted (cold launch, or the app shell after sign-in). */
export function resetLaunchTabs(): void {
  otherTabShownFirst = false;
}

/** The tabs layout is showing a tab other than Home. */
export function noteNonHomeTabShown(): void {
  otherTabShownFirst = true;
}

/** True exactly once per account: when Home should hand off to the Scanner. */
export function claimLaunchToScanner(userId: string | null | undefined): boolean {
  if (userId == null || handledForUserId === userId) {
    return false;
  }
  handledForUserId = userId;
  return !otherTabShownFirst;
}

/** Test seam. */
export function __resetLaunchToScannerForTests(): void {
  handledForUserId = null;
  otherTabShownFirst = false;
}
