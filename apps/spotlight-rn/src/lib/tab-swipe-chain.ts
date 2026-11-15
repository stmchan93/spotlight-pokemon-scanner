/**
 * The app-wide horizontal swipe chain: one continuous left/right pager across
 * the bottom tabs, Instagram-style.
 *
 *   Home [Collection → Activity] → Watchlist → Scan → Events → Social [Social → News → Market]
 *
 * A screen with inner swipeable pages walks those first; only a swipe past its
 * last (or first) inner page moves to the neighbouring tab, and it lands on
 * that tab's NEAR edge (its first inner page going forward, its last going
 * back). The ends of the chain do nothing.
 *
 * This file is the pure half (order + edge rules + the cross-tab "land on"
 * signal). The gesture lives in `@/components/tab-swipe-chain`.
 */

/** Bottom-tab route names in bar order, left → right. The one place it is defined. */
export const TAB_CHAIN_ORDER = ['index', 'wishlist', 'scan', 'events', 'social'] as const;

export type ChainTab = (typeof TAB_CHAIN_ORDER)[number];

/**
 * `next` is the page to the RIGHT, reached by a right-to-left finger swipe
 * (negative dx); `previous` is the one to the left.
 */
export type SwipeDirection = 'next' | 'previous';

/** Which inner page to open on arrival: the near edge for the direction travelled. */
export type LandingEdge = 'first' | 'last';

/** Where the screen's own inner pager currently is. Omit for screens without one. */
export type InnerPagePosition = { count: number; index: number };

export type TabSwipeTarget =
  /** Still inside the screen's own pager — that pager handles it, not the chain. */
  | { kind: 'inner'; index: number }
  | { kind: 'tab'; landing: LandingEdge; tab: ChainTab };

export function swipeDirectionFromDx(dx: number): SwipeDirection {
  return dx < 0 ? 'next' : 'previous';
}

/**
 * Given where the user is and which way they swiped, where should they end up?
 * Null at either end of the chain.
 */
export function resolveTabSwipe(
  tab: ChainTab,
  direction: SwipeDirection,
  inner?: InnerPagePosition | null,
): TabSwipeTarget | null {
  const step = direction === 'next' ? 1 : -1;

  if (inner && inner.count > 1) {
    const current = Math.min(Math.max(inner.index, 0), inner.count - 1);
    const nextInner = current + step;
    if (nextInner >= 0 && nextInner < inner.count) {
      return { kind: 'inner', index: nextInner };
    }
  }

  const position = TAB_CHAIN_ORDER.indexOf(tab);
  const nextTab = TAB_CHAIN_ORDER[position + step];
  if (position < 0 || !nextTab) {
    return null;
  }
  return { kind: 'tab', landing: direction === 'next' ? 'first' : 'last', tab: nextTab };
}

/** Maps a landing edge onto a concrete inner page of an ordered list. */
export function innerPageForLanding<V>(order: readonly V[], edge: LandingEdge): V | undefined {
  return edge === 'first' ? order[0] : order[order.length - 1];
}

// ─── Cross-tab "land on" signal ─────────────────────────────────────────────
// Module scope for the same reason as `last-active-tab.ts`: the screen that
// knows (the one being swiped away from) and the one that needs it (the
// arriving tab) are siblings under the native tab navigator, and the value is
// a one-shot, per-process hint with no user data in it.

type LandingListener = (tab: ChainTab) => void;

const pendingLandings = new Map<ChainTab, LandingEdge>();
const landingListeners = new Set<LandingListener>();

/** Ask `tab` to open on `edge` the next time it is reached. */
export function requestTabLanding(tab: ChainTab, edge: LandingEdge) {
  pendingLandings.set(tab, edge);
  landingListeners.forEach((listener) => listener(tab));
}

/** Take (and clear) the pending landing for `tab`, if any. */
export function consumeTabLanding(tab: ChainTab): LandingEdge | null {
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
