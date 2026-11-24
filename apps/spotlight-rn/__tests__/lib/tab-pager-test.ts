import {
  COMMIT_VELOCITY,
  TAB_PAGER_ORDER,
  clampWithRubberBand,
  consumeTabLanding,
  innerPageForLanding,
  isPageLive,
  landingEdgeForDirection,
  pageIndexForRoute,
  pageIndexForState,
  pageSelectedness,
  requestTabLanding,
  resetTabLandingsForTests,
  resolveOuterSwipe,
  resolveSettlePage,
  rubberBand,
  scanProximity,
  subscribeTabLanding,
  swipeDirectionFromDx,
  guestBlockedPages,
} from '@/lib/tab-pager';

describe('tab pager order and route <-> page mapping', () => {
  it('lays the strip out Home | Scan | Search | Social (Figma 6725:9509)', () => {
    expect(TAB_PAGER_ORDER).toEqual(['index', 'scan', 'search', 'social']);
  });

  it('maps each tab route to its strip index and redirect routes to none', () => {
    expect(pageIndexForRoute('index')).toBe(0);
    expect(pageIndexForRoute('scan')).toBe(1);
    expect(pageIndexForRoute('search')).toBe(2);
    expect(pageIndexForRoute('social')).toBe(3);
    // Settings is a pushed screen behind the button beside the bar.
    expect(pageIndexForRoute('settings')).toBe(-1);
    // Events is a page of Social; `/events` only redirects.
    expect(pageIndexForRoute('events')).toBe(-1);
    expect(pageIndexForRoute('you')).toBe(-1);
    expect(pageIndexForRoute('portfolio')).toBe(-1);
    // Watchlist left the bar for a Home profile tab; `/wishlist` only redirects.
    expect(pageIndexForRoute('wishlist')).toBe(-1);
    expect(pageIndexForRoute(undefined)).toBe(-1);
  });

  it('reads the focused page off navigator state, whatever order the routes are in', () => {
    const routes = [{ name: 'you' }, { name: 'social' }, { name: 'index' }, { name: 'scan' }];
    expect(pageIndexForState({ index: 1, routes })).toBe(3);
    expect(pageIndexForState({ index: 3, routes })).toBe(1);
    expect(pageIndexForState({ index: 0, routes })).toBe(-1);
  });
});

describe('resolveOuterSwipe (inner -> outer hand-off)', () => {
  const HOME = 0;
  const SCAN = 1;
  const SOCIAL = 3;

  it('leaves a swipe the inner pager can still take to the inner pager', () => {
    // Collection -> Activity.
    expect(resolveOuterSwipe(HOME, 'next', { count: 2, index: 0 })).toEqual({ owner: 'inner' });
    // News -> Social feed, and News -> Market.
    expect(resolveOuterSwipe(SOCIAL, 'previous', { count: 3, index: 1 })).toEqual({ owner: 'inner' });
    expect(resolveOuterSwipe(SOCIAL, 'next', { count: 3, index: 1 })).toEqual({ owner: 'inner' });
  });

  it('hands a swipe past the inner edge to the outer strip', () => {
    // Activity -> Watchlist.
    expect(resolveOuterSwipe(HOME, 'next', { count: 2, index: 1 })).toEqual({ owner: 'outer', target: SCAN });
    // Social's first page -> Search.
    expect(resolveOuterSwipe(SOCIAL, 'previous', { count: 3, index: 0 })).toEqual({ owner: 'outer', target: 2 });
  });

  it('takes the drag at the ends of the chain too, as a rubber-band with no target', () => {
    expect(resolveOuterSwipe(HOME, 'previous', { count: 2, index: 0 })).toEqual({ owner: 'outer', target: null });
    expect(resolveOuterSwipe(SOCIAL, 'next', { count: 3, index: 2 })).toEqual({ owner: 'outer', target: null });
  });

  it('treats pages without inner pages (or a single one) as plain pages', () => {
    expect(resolveOuterSwipe(SCAN, 'next', null)).toEqual({ owner: 'outer', target: 2 });
    expect(resolveOuterSwipe(SCAN, 'previous', undefined)).toEqual({ owner: 'outer', target: 0 });
    expect(resolveOuterSwipe(2, 'next', { count: 1, index: 0 })).toEqual({ owner: 'outer', target: 3 });
  });

  it('clamps an out-of-range inner index instead of trusting it', () => {
    expect(resolveOuterSwipe(HOME, 'next', { count: 2, index: 9 })).toEqual({ owner: 'outer', target: SCAN });
  });

  it('reads the direction off the finger: right-to-left is next', () => {
    expect(swipeDirectionFromDx(-20)).toBe('next');
    expect(swipeDirectionFromDx(20)).toBe('previous');
  });
});

describe('landing on the near inner page', () => {
  afterEach(() => resetTabLandingsForTests());

  it('lands going forward on the first inner page, going back on the last', () => {
    expect(landingEdgeForDirection('next')).toBe('first');
    expect(landingEdgeForDirection('previous')).toBe('last');
    expect(innerPageForLanding(['collection', 'activity'], 'last')).toBe('activity');
    expect(innerPageForLanding(['social', 'news', 'market'], 'first')).toBe('social');
  });

  it('delivers a landing once, to subscribers and to a later consume', () => {
    const listener = jest.fn();
    const unsubscribe = subscribeTabLanding(listener);
    requestTabLanding('index', 'last');
    expect(listener).toHaveBeenCalledWith('index');
    expect(consumeTabLanding('index')).toBe('last');
    expect(consumeTabLanding('index')).toBeNull();
    unsubscribe();
  });
});

describe('resolveSettlePage', () => {
  it('springs back on a short, slow drag', () => {
    expect(resolveSettlePage({ position: 1.2, startPage: 1, velocityX: 0 })).toBe(1);
    expect(resolveSettlePage({ position: 0.8, startPage: 1, velocityX: 0 })).toBe(1);
  });

  it('commits past the distance threshold', () => {
    expect(resolveSettlePage({ position: 1.5, startPage: 1, velocityX: 0 })).toBe(2);
    expect(resolveSettlePage({ position: 0.5, startPage: 1, velocityX: 0 })).toBe(0);
  });

  it('commits on a flick, however short', () => {
    expect(resolveSettlePage({ position: 1.05, startPage: 1, velocityX: -COMMIT_VELOCITY })).toBe(2);
    expect(resolveSettlePage({ position: 0.95, startPage: 1, velocityX: COMMIT_VELOCITY })).toBe(0);
  });

  it('returns to the start when flicked back from past the threshold', () => {
    expect(resolveSettlePage({ position: 1.6, startPage: 1, velocityX: COMMIT_VELOCITY * 2 })).toBe(1);
  });

  it('never moves more than one page, nor past either end', () => {
    expect(resolveSettlePage({ position: 2.9, startPage: 1, velocityX: -5000 })).toBe(2);
    expect(resolveSettlePage({ position: -0.3, startPage: 0, velocityX: 5000 })).toBe(0);
    expect(resolveSettlePage({ position: 3.3, startPage: 3, velocityX: -5000 })).toBe(3);
  });
});

describe('rubber band and bar blend', () => {
  it('passes positions inside the strip through untouched', () => {
    expect(clampWithRubberBand(0)).toBe(0);
    expect(clampWithRubberBand(1.4)).toBe(1.4);
    expect(clampWithRubberBand(3)).toBe(3);
  });

  it('resists past either end, lightly and never more than 0.4 of a page', () => {
    expect(rubberBand(0)).toBe(0);
    const small = rubberBand(0.2);
    expect(small).toBeGreaterThan(0);
    expect(small).toBeLessThan(0.2);
    expect(rubberBand(100)).toBeLessThan(0.4);
    expect(clampWithRubberBand(-0.2)).toBeCloseTo(-small);
    expect(clampWithRubberBand(3.2)).toBeCloseTo(3 + small);
  });

  it('blends the bar to the scanner look in step with the drag', () => {
    expect(scanProximity(1)).toBe(1);
    expect(scanProximity(1.5)).toBe(0.5);
    expect(scanProximity(2)).toBe(0);
    expect(scanProximity(0)).toBe(0);
    expect(pageSelectedness(3.25, 3)).toBe(0.75);
    expect(pageSelectedness(1, 3)).toBe(0);
  });
});

describe('isPageLive (camera / data-load gating)', () => {
  const base = { focusedPage: 2, page: 2, parentFocused: true, settledPage: 2 };

  it('is live only when focused, settled, and uncovered', () => {
    expect(isPageLive(base)).toBe(true);
  });

  it('is not live while the strip is still sliding to the focused page', () => {
    expect(isPageLive({ ...base, settledPage: 1 })).toBe(false);
  });

  it('is not live while a drag merely reveals it (route unchanged)', () => {
    expect(isPageLive({ ...base, focusedPage: 1, settledPage: 1 })).toBe(false);
  });

  it('is not live under a pushed stack screen', () => {
    expect(isPageLive({ ...base, parentFocused: false })).toBe(false);
  });
});

describe('guest tabs', () => {
  it('keeps guests off Home only', () => {
    const blocked = guestBlockedPages(true);
    expect(TAB_PAGER_ORDER.filter((_, page) => !blocked[page])).toEqual(['scan', 'search', 'social']);
    expect(guestBlockedPages(false).every((value) => !value)).toBe(true);
  });
});
