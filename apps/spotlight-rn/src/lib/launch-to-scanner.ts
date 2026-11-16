/**
 * The app always opens on the Scanner (user, 2026-11-16). A cold start lands on
 * `/` (Home); the tabs layout asks this on each render and redirects to `/scan`
 * until the first non-Home path is seen. After that, `/` is just Home.
 *
 * Decided on the FIRST path only: a cold start deep-linked to another tab
 * (a notification, `/wishlist`) is left alone.
 */
let launchRedirectPending: boolean | null = null;

export function shouldRedirectLaunchToScan(pathname: string): boolean {
  if (launchRedirectPending === null) {
    launchRedirectPending = pathname === '/';
  }
  if (launchRedirectPending && pathname !== '/') {
    launchRedirectPending = false;
  }
  return launchRedirectPending;
}

export function __resetLaunchToScanForTests(): void {
  launchRedirectPending = null;
}
