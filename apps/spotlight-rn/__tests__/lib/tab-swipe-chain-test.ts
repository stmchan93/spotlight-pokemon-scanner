import {
  TAB_CHAIN_ORDER,
  consumeTabLanding,
  innerPageForLanding,
  requestTabLanding,
  resetTabLandingsForTests,
  resolveTabSwipe,
  subscribeTabLanding,
  swipeDirectionFromDx,
} from '@/lib/tab-swipe-chain';

const HOME_INNER = (index: number) => ({ count: 2, index });
const SOCIAL_INNER = (index: number) => ({ count: 3, index });

describe('resolveTabSwipe', () => {
  it('follows the bottom bar order', () => {
    expect(TAB_CHAIN_ORDER).toEqual(['index', 'wishlist', 'scan', 'events', 'social']);
  });

  it('a right-to-left finger swipe (negative dx) is "next"', () => {
    expect(swipeDirectionFromDx(-40)).toBe('next');
    expect(swipeDirectionFromDx(40)).toBe('previous');
  });

  it('Home/Collection: next is the inner Activity page, back is the start of the chain', () => {
    expect(resolveTabSwipe('index', 'next', HOME_INNER(0))).toEqual({ kind: 'inner', index: 1 });
    expect(resolveTabSwipe('index', 'previous', HOME_INNER(0))).toBeNull();
  });

  it('Home/Activity: next goes to Watchlist, back stays inside Home', () => {
    expect(resolveTabSwipe('index', 'next', HOME_INNER(1))).toEqual({
      kind: 'tab',
      landing: 'first',
      tab: 'wishlist',
    });
    expect(resolveTabSwipe('index', 'previous', HOME_INNER(1))).toEqual({ kind: 'inner', index: 0 });
  });

  it('Watchlist: back lands on Home’s LAST inner page (Activity), next is Scan', () => {
    expect(resolveTabSwipe('wishlist', 'previous')).toEqual({ kind: 'tab', landing: 'last', tab: 'index' });
    expect(resolveTabSwipe('wishlist', 'next')).toEqual({ kind: 'tab', landing: 'first', tab: 'scan' });
  });

  it('Scan and Events move straight to their neighbours', () => {
    expect(resolveTabSwipe('scan', 'previous')).toEqual({ kind: 'tab', landing: 'last', tab: 'wishlist' });
    expect(resolveTabSwipe('scan', 'next')).toEqual({ kind: 'tab', landing: 'first', tab: 'events' });
    expect(resolveTabSwipe('events', 'previous')).toEqual({ kind: 'tab', landing: 'last', tab: 'scan' });
    expect(resolveTabSwipe('events', 'next')).toEqual({ kind: 'tab', landing: 'first', tab: 'social' });
  });

  it('Social: first page goes back to Events, middle pages stay inside, last page is the end', () => {
    expect(resolveTabSwipe('social', 'previous', SOCIAL_INNER(0))).toEqual({
      kind: 'tab',
      landing: 'last',
      tab: 'events',
    });
    expect(resolveTabSwipe('social', 'next', SOCIAL_INNER(0))).toEqual({ kind: 'inner', index: 1 });
    expect(resolveTabSwipe('social', 'next', SOCIAL_INNER(1))).toEqual({ kind: 'inner', index: 2 });
    expect(resolveTabSwipe('social', 'previous', SOCIAL_INNER(1))).toEqual({ kind: 'inner', index: 0 });
    expect(resolveTabSwipe('social', 'next', SOCIAL_INNER(2))).toBeNull();
  });

  it('a single-page inner pager behaves like no pager', () => {
    expect(resolveTabSwipe('social', 'previous', { count: 1, index: 0 })).toEqual({
      kind: 'tab',
      landing: 'last',
      tab: 'events',
    });
  });

  it('maps landing edges onto inner page order', () => {
    expect(innerPageForLanding(['collection', 'activity'], 'last')).toBe('activity');
    expect(innerPageForLanding(['social', 'news', 'market'], 'first')).toBe('social');
  });
});

describe('tab landing signal', () => {
  beforeEach(() => resetTabLandingsForTests());

  it('is consumed exactly once', () => {
    requestTabLanding('index', 'last');
    expect(consumeTabLanding('index')).toBe('last');
    expect(consumeTabLanding('index')).toBeNull();
  });

  it('notifies subscribers with the requested tab', () => {
    const listener = jest.fn();
    const unsubscribe = subscribeTabLanding(listener);
    requestTabLanding('social', 'first');
    expect(listener).toHaveBeenCalledWith('social');
    unsubscribe();
    requestTabLanding('social', 'first');
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
