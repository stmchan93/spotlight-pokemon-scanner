import {
  __resetLaunchToScannerForTests,
  claimLaunchToScanner,
  noteNonHomeTabShown,
  resetLaunchTabs,
} from '@/lib/launch-to-scanner';

describe('launch-to-scanner', () => {
  beforeEach(() => __resetLaunchToScannerForTests());

  it('sends a signed-in account to the Scanner once', () => {
    resetLaunchTabs();
    expect(claimLaunchToScanner('u1')).toBe(true);
    expect(claimLaunchToScanner('u1')).toBe(false);
  });

  it('never fires without an account', () => {
    expect(claimLaunchToScanner(null)).toBe(false);
  });

  it('stands down when another tab was shown first, so Home is not hijacked later', () => {
    resetLaunchTabs();
    noteNonHomeTabShown();
    expect(claimLaunchToScanner('u1')).toBe(false);
    expect(claimLaunchToScanner('u1')).toBe(false);
  });

  it('fires again for a different account after the tabs remount (sign-in)', () => {
    resetLaunchTabs();
    expect(claimLaunchToScanner('u1')).toBe(true);
    noteNonHomeTabShown();
    resetLaunchTabs();
    expect(claimLaunchToScanner('u2')).toBe(true);
  });
});
