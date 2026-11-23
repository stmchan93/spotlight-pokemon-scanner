import { createContext, useContext, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from 'react';

/**
 * Per-page state of the bottom-tab pager, provided to every page by
 * `TabPagerView` (`@/components/tab-pager`).
 */
type TabsPageContextValue = {
  /**
   * 'scanner' only while the Scan page is the focused route AND the strip is at
   * rest on it (and no pushed screen covers the pager); 'portfolio' otherwise.
   * Each non-scan page sees 'portfolio' only while IT is the settled page. The
   * scanner's camera and Collection's data loading gate on this.
   */
  activePage: 'portfolio' | 'scanner';
  /**
   * Set to true by surfaces that need to "own" horizontal gestures
   * (e.g. the portfolio chart while the user is long-press scrubbing
   * across data points). `CollapsibleTabPager` checks this flag in its
   * pan-responder capture callback so it doesn't steal the gesture mid-scrub.
   * Defaults to a stable no-op
   * ref so consumers rendered outside a provider don't crash.
   */
  chartScrubLockRef: MutableRefObject<boolean>;
  /**
   * True while a portfolio-adjacent surface (e.g. the Collection screen) is in
   * an in-place editing mode. `CollapsibleTabPager` stands down while this is
   * true so the edit UI owns gestures across the full screen.
   *
   * The tab pager also stands its outer strip down for the page while it is
   * true. Defaults to false / a no-op setter outside a provider.
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

/**
 * A fixed page identity for screens rendered OUTSIDE the pager (the dev-screen
 * host used for design screenshots): always the active page.
 */
export function StaticTabsPageProvider({
  children,
  page,
}: {
  children: ReactNode;
  page: 'portfolio' | 'scanner';
}) {
  const chartScrubLockRef = useRef(false);
  const [collectionEditing, setCollectionEditing] = useState(false);
  const value = useMemo(
    () => ({ activePage: page, chartScrubLockRef, collectionEditing, setCollectionEditing }),
    [collectionEditing, page],
  );
  return <TabsPageContext.Provider value={value}>{children}</TabsPageContext.Provider>;
}
