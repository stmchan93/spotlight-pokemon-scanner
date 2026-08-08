import { createContext, useContext, type MutableRefObject } from 'react';

type TabsPageContextValue = {
  activePage: 'portfolio' | 'scanner';
  /**
   * Set to true by surfaces that need to "own" horizontal gestures
   * (e.g. the portfolio chart while the user is long-press scrubbing
   * across data points). `DrawerEdgeSwipe` checks this flag in its
   * pan-responder capture callback so it doesn't steal the gesture mid-scrub.
   * (The retired TopTabsPager used it the same way.) Defaults to a stable no-op
   * ref so consumers rendered outside a provider don't crash.
   */
  chartScrubLockRef: MutableRefObject<boolean>;
  /**
   * True while a portfolio-adjacent surface (e.g. the Collection screen) is in
   * an in-place editing mode. `DrawerEdgeSwipe` stands down while this is true
   * so the edit UI owns gestures across the full screen.
   *
   * NOTE: it no longer hides the bottom bar. That was the retired pager drawing
   * its own JS bar and simply not rendering it; the bar is UIKit's now and
   * cannot be hidden per-screen. Defaults to false / a no-op setter for
   * consumers rendered outside a provider.
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
