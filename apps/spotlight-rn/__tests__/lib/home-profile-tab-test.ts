import {
  HOME_WATCHLIST_HREF,
  parseHomeProfileTabParam,
} from '@/lib/home-profile-tab';

describe('home profile tab param', () => {
  it('points the watchlist href at Home with tab=watchlist', () => {
    expect(HOME_WATCHLIST_HREF).toBe('/?tab=watchlist');
  });

  it('parses known tabs, case- and array-tolerant, and maps the legacy spelling', () => {
    expect(parseHomeProfileTabParam('watchlist')).toBe('watchlist');
    expect(parseHomeProfileTabParam(['Watchlist'])).toBe('watchlist');
    expect(parseHomeProfileTabParam('wishlist')).toBe('watchlist');
    expect(parseHomeProfileTabParam('collection')).toBe('collection');
    expect(parseHomeProfileTabParam('masterset')).toBe('masterset');
  });

  it('rejects anything else', () => {
    expect(parseHomeProfileTabParam(undefined)).toBeNull();
    expect(parseHomeProfileTabParam('')).toBeNull();
    expect(parseHomeProfileTabParam('forsale')).toBeNull();
    expect(parseHomeProfileTabParam(42)).toBeNull();
  });
});
