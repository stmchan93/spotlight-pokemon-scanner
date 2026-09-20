import {
  DEAL_NOTIFICATION_FALLBACK_URL,
  normalizeNotificationUrl,
  parseNotificationRoute,
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
