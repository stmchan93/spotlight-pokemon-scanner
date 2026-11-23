/**
 * The pure half of the bottom-tab pager (`@/components/tab-pager`): page order,
 * the route <-> page mapping, the inner -> outer hand-off rule, and the settle
 * maths. Everything a gesture worklet calls is marked `'worklet'` so the same
 * function runs on the UI thread in the app and in plain JS under jest.
 *
 *   Home [Collection, …] | Search | Scan | Events | Social [For you, Your posts]
 *
 * Watchlist left the bar for a tab of the Home profile (Figma 6642:5964);
 * `/wishlist` survives as a redirect route, not a page.
 */

/** Bottom-tab route names in strip order, left -> right. The one place it is defined. */
export const TAB_PAGER_ORDER = ['index', 'search', 'scan', 'events', 'social'] as const;

export type PagerTab = (typeof TAB_PAGER_ORDER)[number];

export const TAB_PAGE_COUNT = TAB_PAGER_ORDER.length;

export const SCAN_PAGE_INDEX = TAB_PAGER_ORDER.indexOf('scan');

/**
 * The tabs a GUEST can open (owner, 2026-11-20): Scan and Events, plus Search —
 * catalog browsing was already open to guests from the Scanner. Home and Social
 * need an account — tapping one opens sign-in and stays put. Guests can't swipe
 * the strip at all; they tap.
 */
export const GUEST_OPEN_TABS: ReadonlySet<PagerTab> = new Set<PagerTab>(['search', 'scan', 'events']);

/** Per page, whether a guest is kept off it. Plain array so a worklet can read it. */
export function guestBlockedPages(isGuest: boolean): boolean[] {
  return TAB_PAGER_ORDER.map((tab) => isGuest && !GUEST_OPEN_TABS.has(tab));
}

/** `next` = the page to the RIGHT, reached by a right-to-left finger drag. */
export type SwipeDirection = 'next' | 'previous';

/** Which inner page a tab should show when it slides in: the near edge. */
export type LandingEdge = 'first' | 'last';

/** Where a page's own inner pager is. `null` for pages without one. */
export type InnerPagePosition = { count: number; index: number };

/** Strip index of a route, or -1 for routes that are not pages (`/you`, `/portfolio`, `/wishlist` redirects). */
export function pageIndexForRoute(routeName: string | undefined): number {
  return TAB_PAGER_ORDER.indexOf(routeName as PagerTab);
}

/** Strip index of the FOCUSED route of a tab navigator state, or -1. */
export function pageIndexForState(state: {
  index: number;
  routes: readonly { name: string }[];
}): number {
  return pageIndexForRoute(state.routes[state.index]?.name);
}

export function swipeDirectionFromDx(dx: number): SwipeDirection {
  'worklet';
  return dx < 0 ? 'next' : 'previous';
}

export type OuterSwipeDecision =
  /** The page's own inner pager can still move this way: the outer strip stands down. */
  | { owner: 'inner' }
  /** The outer strip takes the drag. `target` null = end of the chain (rubber-band only). */
  | { owner: 'outer'; target: number | null };

/**
 * THE HAND-OFF RULE, decided once per touch at gesture start.
 *
 * A page with inner pages owns every swipe it can still perform itself; only a
 * swipe pointing past its first/last inner page belongs to the outer strip. At
 * the ends of the whole chain the outer strip still takes the drag, so the user
 * gets a rubber-band instead of a dead finger.
 */
export function resolveOuterSwipe(
  page: number,
  direction: SwipeDirection,
  inner: InnerPagePosition | null | undefined,
  pageCountArg?: number,
): OuterSwipeDecision {
  'worklet';
  // Defaults live in the body: the worklets plugin does not capture module
  // constants used in DEFAULT PARAMETERS, and on the UI thread that throws
  // "Property 'TAB_PAGE_COUNT' doesn't exist" (the 2026-11-15 swipe crash).
  const pageCount = pageCountArg ?? TAB_PAGE_COUNT;
  const step = direction === 'next' ? 1 : -1;
  if (inner && inner.count > 1) {
    const current = Math.min(Math.max(inner.index, 0), inner.count - 1);
    const nextInner = current + step;
    if (nextInner >= 0 && nextInner < inner.count) {
      return { owner: 'inner' };
    }
  }
  const target = page + step;
  if (target < 0 || target >= pageCount) {
    return { owner: 'outer', target: null };
  }
  return { owner: 'outer', target };
}

/** Arriving by `direction`, a page with inner pages shows its NEAR edge. */
export function landingEdgeForDirection(direction: SwipeDirection): LandingEdge {
  return direction === 'next' ? 'first' : 'last';
}

/** Maps a landing edge onto a concrete inner page of an ordered list. */
export function innerPageForLanding<V>(order: readonly V[], edge: LandingEdge): V | undefined {
  return edge === 'first' ? order[0] : order[order.length - 1];
}

/** Release past this fraction of a page commits the move… */
export const COMMIT_FRACTION = 0.35;
/** …or a flick at least this fast, in points per second. */
export const COMMIT_VELOCITY = 400;

/**
 * Where the strip settles on release. `position` and the result are in PAGES
 * (0 = Home). `velocityX` is the finger's px/s (negative = moving left = next).
 * Never more than one page from where the drag started, like Instagram.
 */
export function resolveSettlePage({
  pageCount: pageCountArg,
  position,
  startPage,
  velocityX,
}: {
  pageCount?: number;
  position: number;
  startPage: number;
  velocityX: number;
}): number {
  'worklet';
  const pageCount = pageCountArg ?? TAB_PAGE_COUNT; // in the body, see resolveOuterSwipe
  const delta = position - startPage;
  let target = startPage;
  if (Math.abs(velocityX) >= COMMIT_VELOCITY) {
    // A flick decides on its own direction, even against the drag so far.
    target = velocityX < 0 ? startPage + 1 : startPage - 1;
    // …but a flick back toward the start from past it only returns to it.
    if (velocityX < 0 && delta < -COMMIT_FRACTION) {
      target = startPage;
    } else if (velocityX > 0 && delta > COMMIT_FRACTION) {
      target = startPage;
    }
  } else if (delta >= COMMIT_FRACTION) {
    target = startPage + 1;
  } else if (delta <= -COMMIT_FRACTION) {
    target = startPage - 1;
  }
  return Math.min(Math.max(target, 0), pageCount - 1);
}

/** Largest rubber-band travel past either end, in pages. */
const RUBBER_LIMIT = 0.4;
const RUBBER_COEFFICIENT = 0.55;

/**
 * Light iOS-style rubber band: `overshoot` pages of finger travel past an end
 * become a diminishing, bounded displacement (never more than `RUBBER_LIMIT`).
 */
export function rubberBand(overshoot: number): number {
  'worklet';
  if (overshoot <= 0) {
    return 0;
  }
  return (1 - 1 / ((overshoot * RUBBER_COEFFICIENT) / RUBBER_LIMIT + 1)) * RUBBER_LIMIT;
}

/** Clamp a raw strip position into [0, last], rubber-banding the excess. */
export function clampWithRubberBand(raw: number, pageCountArg?: number): number {
  'worklet';
  const pageCount = pageCountArg ?? TAB_PAGE_COUNT; // in the body, see resolveOuterSwipe
  const last = pageCount - 1;
  if (raw < 0) {
    return -rubberBand(-raw);
  }
  if (raw > last) {
    return last + rubberBand(raw - last);
  }
  return raw;
}

/**
 * How "on the Scan page" the strip is, 0..1, for the bar's light -> dark blend.
 * 1 when Scan fills the screen, 0 once it is a full page away.
 */
export function scanProximity(position: number): number {
  'worklet';
  return Math.max(0, 1 - Math.abs(position - SCAN_PAGE_INDEX));
}

/** How selected bar item `page` is, 0..1, for its icon/label blend. */
export function pageSelectedness(position: number, page: number): number {
  'worklet';
  return Math.max(0, 1 - Math.abs(position - page));
}

/**
 * Is `page` LIVE — the one the user is looking at, at rest? Only then does it
 * report itself as the `activePage` (the scanner's camera, Collection's data
 * loads). A page being dragged into view, or one the strip is still sliding
 * toward after a tap, is not live yet; nor is anything under a pushed screen.
 */
export function isPageLive({
  focusedPage,
  page,
  parentFocused,
  settledPage,
}: {
  focusedPage: number;
  page: number;
  parentFocused: boolean;
  settledPage: number;
}): boolean {
  return parentFocused && focusedPage === page && settledPage === page;
}

// ─── Cross-page "land on" signal ────────────────────────────────────────────
// Module scope: the pager knows a neighbour is about to slide in, and the
// neighbour's screen (which may not even be mounted yet) needs to pick its near
// inner page before it is seen. A one-shot, per-process hint with no user data.

type LandingListener = (tab: PagerTab) => void;

const pendingLandings = new Map<PagerTab, LandingEdge>();
const landingListeners = new Set<LandingListener>();

/** Ask `tab` to show its `edge` inner page the next time it is revealed. */
export function requestTabLanding(tab: PagerTab, edge: LandingEdge) {
  pendingLandings.set(tab, edge);
  landingListeners.forEach((listener) => listener(tab));
}

/** Take (and clear) the pending landing for `tab`, if any. */
export function consumeTabLanding(tab: PagerTab): LandingEdge | null {
  const edge = pendingLandings.get(tab) ?? null;
  pendingLandings.delete(tab);
  return edge;
}

export function subscribeTabLanding(listener: LandingListener): () => void {
  landingListeners.add(listener);
  return () => {
    landingListeners.delete(listener);
  };
}

/** Test-only reset. */
export function resetTabLandingsForTests() {
  pendingLandings.clear();
  landingListeners.clear();
}
