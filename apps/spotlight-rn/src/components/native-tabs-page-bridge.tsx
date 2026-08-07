import { useIsFocused } from '@react-navigation/native';
import { type ReactNode, useMemo, useRef, useState } from 'react';

import { TabsPageContext } from '@/contexts/tabs-page-context';

/**
 * Supplies `TabsPageContext` to a screen mounted as a NATIVE tab, so the four
 * existing consumers keep working unchanged while we evaluate native tabs.
 *
 * WHY A BRIDGE INSTEAD OF DELETING THE CONTEXT
 * `activePage` is not cosmetic. In the pager both screens are mounted
 * side-by-side permanently, so it is the ONLY signal telling each one whether it
 * is live:
 *
 *   - `scanner-screen.tsx` gates `shouldMountCamera` on it. Get it wrong and the
 *     camera either runs while you are looking at Collection, or never starts.
 *   - `use-portfolio-screen-model.ts` gates inventory loading on it.
 *
 * Native tabs keep screens mounted too, so the same question still needs an
 * answer — it just has a better one available: real navigation focus. This maps
 * focus onto the existing contract rather than rewriting four call sites, which
 * keeps the pager and the native path behaviourally comparable while both exist.
 *
 * `page` is this screen's own identity. There are exactly two pages, so an
 * unfocused screen reports the other one as active — which is precisely what
 * each consumer's `activePage === 'mine'` check needs, and it stays correct
 * without either screen having to know the other's focus state.
 */
export function NativeTabsPageBridge({
  children,
  page,
}: {
  children: ReactNode;
  page: 'portfolio' | 'scanner';
}) {
  const isFocused = useIsFocused();
  const other = page === 'portfolio' ? 'scanner' : 'portfolio';

  // Inert here — it exists so the chart's long-press scrub can stop the PAGER
  // stealing the gesture, and there is no pager on this path. Provided as a real
  // ref anyway so `portfolio-chart-card` doesn't have to branch.
  const chartScrubLockRef = useRef(false);

  // Kept local: the native tab bar cannot be hidden per-screen the way the
  // pager hid its JS bar, so today this only serves consumers that read it.
  // Tracked in the adoption plan as an open item, not silently dropped.
  const [collectionEditing, setCollectionEditing] = useState(false);

  const value = useMemo(
    () => ({
      activePage: (isFocused ? page : other) as 'portfolio' | 'scanner',
      chartScrubLockRef,
      collectionEditing,
      setCollectionEditing,
    }),
    [collectionEditing, isFocused, other, page],
  );

  return <TabsPageContext.Provider value={value}>{children}</TabsPageContext.Provider>;
}
