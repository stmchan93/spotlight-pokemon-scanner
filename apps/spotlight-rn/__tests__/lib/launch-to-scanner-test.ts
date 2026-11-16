import {
  __resetLaunchToScanForTests,
  shouldRedirectLaunchToScan,
} from '@/lib/launch-to-scanner';

describe('shouldRedirectLaunchToScan', () => {
  beforeEach(() => {
    __resetLaunchToScanForTests();
  });

  it('redirects a cold start on Home until the Scanner is reached, then never again', () => {
    expect(shouldRedirectLaunchToScan('/')).toBe(true);
    expect(shouldRedirectLaunchToScan('/')).toBe(true); // re-render before the redirect lands
    expect(shouldRedirectLaunchToScan('/scan')).toBe(false);
    // Later taps / swipes to Home are just Home.
    expect(shouldRedirectLaunchToScan('/')).toBe(false);
  });

  it('leaves a cold start deep-linked to another tab alone', () => {
    expect(shouldRedirectLaunchToScan('/wishlist')).toBe(false);
    expect(shouldRedirectLaunchToScan('/')).toBe(false);
  });
});
