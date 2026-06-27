import { createContext, useContext, type MutableRefObject } from 'react';

type TabsPageContextValue = {
  activePage: 'portfolio' | 'scanner';
  /**
   * True while a portfolio→scanner swipe is in progress (before it commits), so
   * the scanner can start its camera session early and let autofocus/exposure
   * converge during the swipe — the preview is sharp on arrival instead of
   * blurring while it warms up. Stays false when parked on portfolio so the
   * camera (and the iOS in-use indicator) never runs off the scanner.
   */
  isScannerPrewarming: boolean;
  /**
   * Set to true by surfaces that need to "own" horizontal gestures
   * (e.g. the portfolio chart while the user is long-press scrubbing
   * across data points). The TopTabsPager checks this flag in its
   * pan-responder capture callback so it doesn't steal the gesture
   * mid-scrub. Defaults to a stable no-op ref so consumers that render
   * outside the pager (tests, isolated renders) don't crash.
   */
  chartScrubLockRef: MutableRefObject<boolean>;
};

const defaultScrubLockRef: MutableRefObject<boolean> = { current: false };

export const TabsPageContext = createContext<TabsPageContextValue>({
  activePage: 'scanner',
  isScannerPrewarming: false,
  chartScrubLockRef: defaultScrubLockRef,
});

export function useTabsPage() {
  return useContext(TabsPageContext);
}
