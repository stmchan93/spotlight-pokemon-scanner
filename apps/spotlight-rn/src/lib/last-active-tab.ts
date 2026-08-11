/**
 * The tab the user was on before they opened the Scanner.
 *
 * WHY THIS IS A MODULE AND NOT STATE
 * Leaving the scanner has to land you back where you came from, and the screen
 * that needs the answer (`(tabs)/scan.tsx`) is a SIBLING of the one that knows
 * it (`(tabs)/_layout.tsx`). React state would mean a provider wrapping the tab
 * navigator purely to carry one string across a tab switch, and a context read
 * that re-renders every tab whenever the value changes. The value is also not
 * render-relevant: nothing draws differently because of it — it is read once, in
 * a press handler, at the moment of leaving.
 *
 * Module scope is safe here because the value is per-process and disposable. It
 * carries no user data, so it does not need the owner-scoping that persisted
 * state in this app does, and a fresh launch simply starts on the default.
 */

/** The tab route names that can be returned to. Scan is deliberately not one. */
export type ReturnableTabName = 'index' | 'wishlist' | 'you';

const RETURNABLE_TABS: readonly string[] = ['index', 'wishlist', 'you'];

/**
 * Home. Used before anything has been recorded — a cold launch straight into
 * the Scanner (via a deep link or the tab itself) has no previous tab, and Home
 * is the app's landing surface.
 */
const DEFAULT_TAB: ReturnableTabName = 'index';

let lastActiveTab: ReturnableTabName = DEFAULT_TAB;

/**
 * Map a pathname to the tab it belongs to, or null when it is not a returnable
 * tab. `/` is Home; `/scan` returns null on purpose, so opening the Scanner
 * never overwrites the tab we are meant to go back to.
 */
export function returnableTabFromPathname(pathname: string): ReturnableTabName | null {
  const normalized = pathname.split('?')[0]?.replace(/\/+$/, '') ?? '';
  if (normalized === '' || normalized === '/') {
    return 'index';
  }
  const segment = normalized.replace(/^\/+/, '');
  return RETURNABLE_TABS.includes(segment) ? (segment as ReturnableTabName) : null;
}

/** Record the tab currently on screen. No-ops for anything that is not a tab. */
export function rememberActiveTab(pathname: string): void {
  const tab = returnableTabFromPathname(pathname);
  if (tab) {
    lastActiveTab = tab;
  }
}

/** The tab to return to when leaving the Scanner. */
export function getLastActiveTab(): ReturnableTabName {
  return lastActiveTab;
}

/** Test seam — resets the module between cases. */
export function __resetLastActiveTabForTests(): void {
  lastActiveTab = DEFAULT_TAB;
}
