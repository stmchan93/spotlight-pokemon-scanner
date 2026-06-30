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
  /**
   * True while a portfolio-adjacent surface (e.g. the Collection screen) is in
   * an in-place editing mode. The TopTabsPager hides the bottom tab bar and
   * locks the horizontal page swipe while this is true so the edit UI owns the
   * full screen and gestures. Defaults to false / a no-op setter for consumers
   * that render outside the pager (tests, isolated renders).
   */
  collectionEditing: boolean;
  setCollectionEditing: (editing: boolean) => void;
};

const defaultScrubLockRef: MutableRefObject<boolean> = { current: false };

export const TabsPageContext = createContext<TabsPageContextValue>({
  activePage: 'scanner',
  chartScrubLockRef: defaultScrubLockRef,
  collectionEditing: false,
  setCollectionEditing: () => {},
});

export function useTabsPage() {
  return useContext(TabsPageContext);
}
