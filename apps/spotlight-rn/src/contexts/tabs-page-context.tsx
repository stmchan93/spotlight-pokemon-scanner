import { createContext, useContext, type MutableRefObject } from 'react';

type TabsPageContextValue = {
  activePage: 'portfolio' | 'scanner';
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
  chartScrubLockRef: defaultScrubLockRef,
});

export function useTabsPage() {
  return useContext(TabsPageContext);
}
