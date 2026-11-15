import { createContext, useContext, useEffect, useId, useMemo, useRef, type ReactNode } from 'react';
import { View } from 'react-native';
import { Gesture, GestureDetector, type GestureType } from 'react-native-gesture-handler';
import type { SharedValue } from 'react-native-reanimated';

import {
  consumeTabLanding,
  subscribeTabLanding,
  type InnerPagePosition,
  type LandingEdge,
  type PagerTab,
} from '@/lib/tab-pager';

/**
 * What a page of the bottom-tab pager can tell the outer strip. Provided per
 * page by `TabPagerView`; every hook below is a no-op outside it (pushed stack
 * screens, the dev-screen host, isolated tests), so screens never branch.
 */
export type TabPagerPageApi = {
  page: number;
  /** Report the page's own inner pager (Home, Social) so the hand-off rule can read it on the UI thread. */
  setInner: (position: InnerPagePosition | null) => void;
  /** Stand the outer strip down for this page while `locked` (edit modes, open sheets…). */
  setLock: (key: string, locked: boolean) => void;
  /**
   * UI-thread timestamp of the last touch-down that landed on a guarded view
   * (`usePagerTouchGuardGesture`). The outer pan compares it with its own
   * touch-down time, so the check never races the JS thread.
   */
  guardedAt: SharedValue<number>;
  /** Which way the last guard blocks: 0 both directions, 1 only `next` (leftward drags). */
  guardedStep: SharedValue<number>;
};

export const TabPagerPageContext = createContext<TabPagerPageApi | null>(null);

export function useTabPagerPage(): TabPagerPageApi | null {
  return useContext(TabPagerPageContext);
}

/** Keep the outer strip informed of this page's inner pager position. */
export function useTabPagerInnerPosition(position: InnerPagePosition | null) {
  const api = useTabPagerPage();
  const count = position?.count ?? 0;
  const index = position?.index ?? 0;
  useEffect(() => {
    if (!api) {
      return;
    }
    api.setInner(count > 0 ? { count, index } : null);
  }, [api, count, index]);
  useEffect(() => {
    if (!api) {
      return;
    }
    return () => api.setInner(null);
  }, [api]);
}

/** While `locked`, a horizontal drag on this page never moves the outer strip. */
export function useTabPagerLock(locked: boolean) {
  const api = useTabPagerPage();
  const key = useId();
  useEffect(() => {
    if (!api) {
      return;
    }
    api.setLock(key, locked);
  }, [api, key, locked]);
  useEffect(() => {
    if (!api) {
      return;
    }
    return () => api.setLock(key, false);
  }, [api, key]);
}

/**
 * A gesture that never activates and only stamps `guardedAt` on touch-down, so
 * a drag that STARTS inside the view it is attached to (a horizontal chip row,
 * the scanner tray) is never taken by the outer strip. Attach it with its own
 * `GestureDetector`, or compose it `Simultaneous` with the view's own gesture.
 * Null outside the pager. A fresh instance per caller: RNGH forbids sharing one
 * gesture object between detectors.
 *
 * `direction` narrows it to one way: a swipe-to-delete row guards only `next`
 * (a leftward drag opens its rail), so a rightward drag on it still pages.
 */
export function usePagerTouchGuardGesture(direction: 'both' | 'next' = 'both'): GestureType | null {
  const api = useTabPagerPage();
  const guardedAt = api?.guardedAt ?? null;
  const guardedStep = api?.guardedStep ?? null;
  const step = direction === 'next' ? 1 : 0;
  return useMemo(() => {
    if (!guardedAt || !guardedStep) {
      return null;
    }
    return Gesture.Manual()
      .onTouchesDown((_event, stateManager) => {
        'worklet';
        guardedAt.value = Date.now();
        guardedStep.value = step;
        // Out of the way at once: it exists only to leave the stamp.
        stateManager.fail();
      });
  }, [guardedAt, guardedStep, step]);
}

/**
 * Component form of `usePagerTouchGuardGesture` for a subtree without a view of
 * its own to attach to (a `Swipeable` row). Adds one plain wrapper view, only
 * inside the pager.
 */
export function PagerTouchGuard({
  children,
  direction = 'both',
}: {
  children: ReactNode;
  direction?: 'both' | 'next';
}) {
  const gesture = usePagerTouchGuardGesture(direction);
  if (!gesture) {
    return <>{children}</>;
  }
  return (
    <GestureDetector gesture={gesture}>
      <View collapsable={false}>{children}</View>
    </GestureDetector>
  );
}

/**
 * Lets a page with inner pages open on the edge the pager asked for — fired
 * when the outer strip starts revealing it from a neighbour (see
 * `requestTabLanding`), immediately if mounted, or on mount if this reveal is
 * what mounted it.
 */
export function useTabLanding(tab: PagerTab, onLand: (edge: LandingEdge) => void) {
  const onLandRef = useRef(onLand);
  onLandRef.current = onLand;

  useEffect(() => {
    const pending = consumeTabLanding(tab);
    if (pending) {
      onLandRef.current(pending);
    }
    return subscribeTabLanding((requested) => {
      if (requested !== tab) {
        return;
      }
      const edge = consumeTabLanding(tab);
      if (edge) {
        onLandRef.current(edge);
      }
    });
  }, [tab]);
}
