/**
 * The app opens on Home, which is the Social feed (`/social`), the first tab
 * (user, 2026-11-16). A cold start lands on `/` (the `index` route, now
 * Collection); the tabs layout asks this on each render and redirects to
 * `/social` until the first non-`/` path is seen. After that, `/` is just
 * Collection. Decided on the FIRST path only: a cold-start deep link to another
 * tab (a notification, `/wishlist`) is left alone.
 */
let launchRedirectPending: boolean | null = null;

export function shouldRedirectLaunchToHome(pathname: string): boolean {
  if (launchRedirectPending === null) {
    launchRedirectPending = pathname === '/';
  }
  if (launchRedirectPending && pathname !== '/') {
    launchRedirectPending = false;
  }
  return launchRedirectPending;
}

export function __resetLaunchToHomeForTests(): void {
  launchRedirectPending = null;
}
