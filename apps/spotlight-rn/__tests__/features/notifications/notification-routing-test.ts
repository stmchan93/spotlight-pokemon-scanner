import {
  DEAL_NOTIFICATION_FALLBACK_URL,
  normalizeNotificationUrl,
  parseNotificationRoute,
  pushOpenedAnalyticsProps,
} from '@/features/notifications/notification-routing';

describe('normalizeNotificationUrl', () => {
  it('accepts an in-app absolute path', () => {
    expect(normalizeNotificationUrl('/wishlist')).toBe('/wishlist');
    expect(normalizeNotificationUrl('  /cards/sm7-1  ')).toBe('/cards/sm7-1');
  });

  it('rejects anything that could leave the app', () => {
    // A push payload is remote input, and `router.push` would happily follow
    // any of these somewhere other than an in-app screen.
    expect(normalizeNotificationUrl('https://evil.example/wishlist')).toBeNull();
    expect(normalizeNotificationUrl('//evil.example/wishlist')).toBeNull();
    expect(normalizeNotificationUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeNotificationUrl('spotlight://wishlist')).toBeNull();
    expect(normalizeNotificationUrl('wishlist')).toBeNull();
  });

  it('rejects non-strings and blanks', () => {
    expect(normalizeNotificationUrl(null)).toBeNull();
    expect(normalizeNotificationUrl(42)).toBeNull();
    expect(normalizeNotificationUrl('   ')).toBeNull();
  });
});

describe('parseNotificationRoute', () => {
  it('reads the deal-alert payload the backend sends', () => {
    expect(
      parseNotificationRoute({
        alertId: 'alert-1',
        cardId: 'sm7-1',
        type: 'deal_alert',
        url: '/wishlist',
      }),
    ).toEqual({ alertId: 'alert-1', cardId: 'sm7-1', url: '/wishlist' });
  });

  it('falls back to the watchlist rather than dropping the tap', () => {
    expect(parseNotificationRoute({ alertId: 'alert-1', url: 'https://evil.example' })).toEqual({
      alertId: 'alert-1',
      cardId: null,
      url: DEAL_NOTIFICATION_FALLBACK_URL,
    });
    expect(parseNotificationRoute({})).toEqual({
      alertId: null,
      cardId: null,
      url: DEAL_NOTIFICATION_FALLBACK_URL,
    });
  });

  it('returns null when there is no data object at all', () => {
    expect(parseNotificationRoute(undefined)).toBeNull();
    expect(parseNotificationRoute(null)).toBeNull();
    expect(parseNotificationRoute('deal')).toBeNull();
  });
});

describe('parseNotificationRoute with the feed market pages switched off', () => {
  const FLAG = 'EXPO_PUBLIC_SPOTLIGHT_FEED_MARKET_BLOCKS';

  afterEach(() => {
    delete process.env[FLAG];
  });

  it('sends a push aimed at a hidden market page to its card, or the feed', () => {
    process.env[FLAG] = '0';
    expect(parseNotificationRoute({ cardId: 'sm7-1', url: '/meta/group/modern:raw:sir?game=pokemon' })).toEqual({
      alertId: null,
      cardId: 'sm7-1',
      url: '/cards/sm7-1',
    });
    expect(parseNotificationRoute({ url: '/news?kind=video' })?.url).toBe('/social');
    expect(parseNotificationRoute({ url: '/set-spotlight/sv8' })?.url).toBe('/social');
  });

  it('leaves the market alerts that ship today untouched', () => {
    process.env[FLAG] = '0';
    expect(parseNotificationRoute({ type: 'price_move', cardId: 'a', url: '/cards/a' })?.url).toBe('/cards/a');
    expect(parseNotificationRoute({ type: 'weekly_summary', url: '/' })?.url).toBe('/');
    expect(parseNotificationRoute({ type: 'deal_alert', alertId: 'x', url: '/wishlist' })?.url).toBe('/wishlist');
    // Not a market page, just a lookalike prefix.
    expect(parseNotificationRoute({ url: '/metadata' })?.url).toBe('/metadata');
  });

  it('keeps market-page links as-is while the pages are on', () => {
    expect(parseNotificationRoute({ cardId: 'sm7-1', url: '/meta' })?.url).toBe('/meta');
  });
});

describe('pushOpenedAnalyticsProps', () => {
  it('maps the backend data type to a kind and flags bundled price moves', () => {
    expect(pushOpenedAnalyticsProps({ type: 'price_move', cardIds: ['a'], cardId: 'a', url: '/cards/a' }))
      .toEqual({ bundled: false, kind: 'price_move' });
    expect(pushOpenedAnalyticsProps({ type: 'price_move', cardIds: ['a', 'b'], url: '/' }))
      .toEqual({ bundled: true, kind: 'price_move' });
    expect(pushOpenedAnalyticsProps({ type: 'weekly_summary', url: '/' })).toEqual({ kind: 'weekly_summary' });
    expect(pushOpenedAnalyticsProps({ type: 'deal_alert', alertId: 'x', url: '/wishlist' })).toEqual({ kind: 'deal' });
    expect(pushOpenedAnalyticsProps({ type: 'ops_alert' })).toEqual({ kind: 'other' });
    expect(pushOpenedAnalyticsProps(null)).toEqual({ kind: 'other' });
  });
});

// The market sections default off in every build; the tests above that exercise
// them switch them on here (the "switched off" suites set '0' after this runs).
beforeEach(() => {
  process.env.EXPO_PUBLIC_SPOTLIGHT_FEED_MARKET_BLOCKS = '1';
});
afterEach(() => {
  delete process.env.EXPO_PUBLIC_SPOTLIGHT_FEED_MARKET_BLOCKS;
});
