import {
  __resetLastActiveTabForTests,
  getLastActiveTab,
  rememberActiveTab,
  returnableTabFromPathname,
} from '@/lib/last-active-tab';

describe('last active tab', () => {
  beforeEach(() => {
    __resetLastActiveTabForTests();
  });

  it('maps each tab pathname, and treats the root as Home', () => {
    expect(returnableTabFromPathname('/')).toBe('index');
    expect(returnableTabFromPathname('')).toBe('index');
    expect(returnableTabFromPathname('/wishlist')).toBe('wishlist');
    expect(returnableTabFromPathname('/you')).toBe('you');
    // Trailing slashes and query strings are the same tab.
    expect(returnableTabFromPathname('/you/')).toBe('you');
    expect(returnableTabFromPathname('/wishlist?filter=all')).toBe('wishlist');
  });

  // The load-bearing case. If `/scan` counted as a returnable tab, opening the
  // Scanner would overwrite the very answer we are storing and "back" would
  // always mean "back to the Scanner".
  it('does not treat the Scanner as somewhere to go back to', () => {
    expect(returnableTabFromPathname('/scan')).toBeNull();

    rememberActiveTab('/you');
    rememberActiveTab('/scan');
    expect(getLastActiveTab()).toBe('you');
  });

  it('ignores pushed routes, so a detour does not become the destination', () => {
    rememberActiveTab('/wishlist');
    // Opening a card from the Wishlist should not make the PDP the tab to
    // return to — it is not a tab at all.
    rememberActiveTab('/cards/base1-4');
    rememberActiveTab('/notifications');
    expect(getLastActiveTab()).toBe('wishlist');
  });

  it('starts on Home, for a cold launch straight into the Scanner', () => {
    // No tab has been visited — a deep link or a launch onto the Scan tab.
    expect(getLastActiveTab()).toBe('index');
  });

  it('follows the most recent tab', () => {
    rememberActiveTab('/');
    expect(getLastActiveTab()).toBe('index');
    rememberActiveTab('/you');
    expect(getLastActiveTab()).toBe('you');
    rememberActiveTab('/wishlist');
    expect(getLastActiveTab()).toBe('wishlist');
  });
});
