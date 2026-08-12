import { act, fireEvent, screen } from '@testing-library/react-native';
import { useState } from 'react';
import {
  Animated,
  Dimensions,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type GestureResponderEvent,
} from 'react-native';

import {
  CollapsibleTabPager,
  PageSwipeGuard,
  type CollapsiblePageProps,
  type CollapsibleScrollTarget,
} from '@/components/page-tab-pager';
import { TabsPageContext } from '@/contexts/tabs-page-context';

import { renderWithProviders } from '../test-utils';

// The real AuthProvider spins up Supabase session plumbing this unit render has
// no use for. `test-utils` falls back to a pass-through wrapper when the module
// is mocked, so supplying `useAuth` alone is enough.
jest.mock('@/providers/auth-provider', () => ({
  useAuth: () => ({ isGuest: false }),
}));

type TouchPoint = { x: number; y: number };

const TABS = ['collection', 'forsale', 'activity'] as const;
type Tab = (typeof TABS)[number];

/**
 * PanResponder derives `gestureState` from the event's `touchHistory`, so the
 * only faithful way to drive it is to hand it a real touch bank: `dx`/`dy` come
 * out as `current - start` (CUMULATIVE, which is what the dominance test reads)
 * and `vx` as `(current - previous) / elapsed`. Modelled on
 * `drawer-edge-swipe-test`, which drives the sibling recogniser the same way.
 */
function makeMoveEvent(from: TouchPoint, to: TouchPoint, timeStamp: number, stepMs: number) {
  return {
    nativeEvent: {
      pageX: to.x,
      pageY: to.y,
      touches: [{}],
    },
    touchHistory: {
      indexOfSingleActiveTouch: 0,
      mostRecentTimeStamp: timeStamp,
      numberActiveTouches: 1,
      touchBank: [
        {
          touchActive: true,
          startPageX: from.x,
          startPageY: from.y,
          startTimeStamp: 0,
          currentPageX: to.x,
          currentPageY: to.y,
          currentTimeStamp: timeStamp,
          previousPageX: from.x,
          previousPageY: from.y,
          previousTimeStamp: timeStamp - stepMs,
        },
      ],
    },
  } as unknown as GestureResponderEvent;
}

function makeStartEvent(point: TouchPoint) {
  return {
    nativeEvent: {
      pageX: point.x,
      pageY: point.y,
      touches: [{}],
    },
    touchHistory: {
      indexOfSingleActiveTouch: 0,
      mostRecentTimeStamp: 0,
      numberActiveTouches: 1,
      touchBank: [],
    },
  } as unknown as GestureResponderEvent;
}

type Handlers = {
  onStartShouldSetResponderCapture: (event: GestureResponderEvent) => boolean;
  onMoveShouldSetResponderCapture: (event: GestureResponderEvent) => boolean;
  onMoveShouldSetResponder: (event: GestureResponderEvent) => boolean;
  onResponderGrant: (event: GestureResponderEvent) => void;
  onResponderMove: (event: GestureResponderEvent) => void;
  onResponderRelease: (event: GestureResponderEvent) => void;
  onResponderTerminate: (event: GestureResponderEvent) => void;
};

function pagerHandlers() {
  return screen.getByTestId('collapsible-tab-pager').props as unknown as Handlers;
}

/**
 * Reports a page's `contentOffset.y` the way the device does, so the pager's
 * per-page offset bookkeeping sees it.
 *
 * `Animated.event` returns the `AnimatedEvent` OBJECT rather than a function
 * whenever it is native-driven, and it is `createAnimatedComponent` that turns
 * it into one — the app's pages are `AnimatedFlatList`/`AnimatedScrollView`, so
 * they do that for free. The plain `ScrollView` this harness renders does not,
 * so unwrap it here exactly as the animated wrapper would.
 */
function deliverScroll(tab: Tab, y: number, scrollY?: Animated.Value) {
  const onScroll = screen.getByTestId(`page-${tab}`).props.onScroll as unknown as
    | ((event: unknown) => void)
    | { __getHandler: () => (event: unknown) => void };
  const handler = typeof onScroll === 'function' ? onScroll : onScroll.__getHandler();

  handler({
    nativeEvent: {
      contentOffset: { x: 0, y },
      contentSize: { height: 4000, width: 393 },
      layoutMeasurement: { height: 800, width: 393 },
    },
  });
  // The `contentOffset.y` -> `scrollY` half of the mapping is the NATIVE
  // driver's, and there is no native driver under Jest — the handler above only
  // runs the JS listener. Do it here so the chrome moves the way it does on
  // device.
  scrollY?.setValue(y);
}

function reportScroll(tab: Tab, y: number, scrollY?: Animated.Value) {
  act(() => {
    deliverScroll(tab, y, scrollY);
  });
}

/**
 * Replays one whole finger: touch down, a series of moves, then lift.
 *
 * Until the pager claims, every move is offered to BOTH the capture and bubble
 * predicates — which is what the responder system does, and is why the
 * claims-once guard exists. The first `true` is the claim, and is followed by
 * the grant; from there the drag is delivered as `onResponderMove` (the pager
 * owns the gesture) and finished with `onResponderRelease`, which is where the
 * page is committed or snapped back.
 *
 * `guardTestID` also replays the capture-phase touch-down a `PageSwipeGuard`
 * inside the page would receive, in the order the responder system dispatches it
 * (root → target, so the pager's own start handler runs first).
 *
 * Returns what each pre-claim predicate returned. `true` means "claim the
 * responder", which on device is what cancels the pending press on the card
 * under the finger and stops the page scrolling vertically.
 */
function drag(
  start: TouchPoint,
  points: TouchPoint[],
  options: { guardTestID?: string; release?: boolean; stepMs?: number } = {},
): boolean[] {
  const handlers = pagerHandlers();
  const claims: boolean[] = [];
  // 16ms/step is one frame — i.e. a FAST drag, fast enough to commit on
  // velocity alone. Tests asserting on distance pass a bigger step.
  const stepMs = options.stepMs ?? 16;
  let granted = false;

  act(() => {
    handlers.onStartShouldSetResponderCapture(makeStartEvent(start));
    if (options.guardTestID) {
      const guard = screen.getByTestId(options.guardTestID).props as unknown as Handlers;
      guard.onStartShouldSetResponderCapture(makeStartEvent(start));
    }
  });

  let previous = start;
  points.forEach((point, index) => {
    const event = makeMoveEvent(previous, point, (index + 1) * stepMs, stepMs);
    act(() => {
      if (granted) {
        handlers.onResponderMove(event);
        return;
      }
      const captured = handlers.onMoveShouldSetResponderCapture(event);
      claims.push(captured);
      const bubbled = captured ? false : handlers.onMoveShouldSetResponder(event);
      claims.push(bubbled);
      if (captured || bubbled) {
        granted = true;
        handlers.onResponderGrant(event);
      }
    });
    previous = point;
  });

  // Only the view that IS the responder is sent the release, so a gesture the
  // pager declined must never reach its release handler — replaying one anyway
  // would be testing something the responder system cannot produce.
  if (granted && options.release !== false) {
    act(() => {
      // Release does not recompute `gestureState`; it reads whatever the last
      // move left there, exactly as on device.
      handlers.onResponderRelease(makeMoveEvent(previous, previous, 1000, stepMs));
    });
  }

  return claims;
}

/** A fast, unambiguous horizontal drag well clear of the left-edge band. */
function swipeLeft(fromY = 400, options: { stepMs?: number } = {}) {
  return drag(
    { x: 400, y: fromY },
    [
      { x: 340, y: fromY + 2 },
      { x: 240, y: fromY + 4 },
      { x: 140, y: fromY + 6 },
    ],
    options,
  );
}

function swipeRight(fromY = 400, options: { stepMs?: number } = {}) {
  return drag(
    { x: 400, y: fromY },
    [
      { x: 460, y: fromY + 2 },
      { x: 560, y: fromY + 4 },
      { x: 660, y: fromY + 6 },
    ],
    options,
  );
}

function renderPager({
  chartScrubbing = false,
  collectionEditing = false,
  disabled = false,
  contentInsetTop,
  headerFadeDistance,
  onChange = jest.fn(),
  pageRefs,
  pinnedTopInset,
  scrollY,
  shouldStandDown,
  value = 'collection' as Tab,
  withGuard = false,
}: {
  chartScrubbing?: boolean;
  collectionEditing?: boolean;
  disabled?: boolean;
  contentInsetTop?: number;
  headerFadeDistance?: number;
  onChange?: (next: Tab) => void;
  pageRefs?: Partial<Record<Tab, { readonly current: CollapsibleScrollTarget | null }>>;
  pinnedTopInset?: number;
  scrollY?: Animated.Value;
  shouldStandDown?: () => boolean;
  value?: Tab;
  withGuard?: boolean;
} = {}) {
  const renderPage = (page: Tab, pageProps: CollapsiblePageProps) => (
    <ScrollView
      contentContainerStyle={pageProps.contentContainerStyle}
      onScroll={pageProps.onScroll}
      scrollEventThrottle={pageProps.scrollEventThrottle}
      scrollToOverflowEnabled={pageProps.scrollToOverflowEnabled}
      testID={`page-${page}`}
    >
      <Text>{page}</Text>
      {page === 'collection' && withGuard ? (
        <PageSwipeGuard testID="chip-guard">
          <ScrollView horizontal testID="chip-row">
            <Text>chips</Text>
          </ScrollView>
        </PageSwipeGuard>
      ) : null}
    </ScrollView>
  );

  return renderWithProviders(
    <TabsPageContext.Provider
      value={{
        activePage: 'portfolio',
        chartScrubLockRef: { current: chartScrubbing },
        collectionEditing,
        setCollectionEditing: () => {},
      }}
    >
      <CollapsibleTabPager
        contentInsetTop={contentInsetTop}
        disabled={disabled}
        header={<View testID="pager-header" />}
        headerFadeDistance={headerFadeDistance}
        onChange={onChange}
        order={TABS}
        pageRefs={pageRefs}
        pinnedTopInset={pinnedTopInset}
        renderPage={renderPage}
        scrollY={scrollY}
        shouldStandDown={shouldStandDown}
        tabBar={<View testID="pager-tab-bar" />}
        value={value}
      />
    </TabsPageContext.Provider>,
  );
}

describe('CollapsibleTabPager', () => {
  // ==========================================================================
  // Layout: the header collapses, the tab bar pins, all three pages exist.
  //
  // The pages have to be MOUNTED side by side — that is the whole reason the
  // screen was turned inside out, and the thing a drag-follow pager cannot do
  // without.
  // ==========================================================================

  it('mounts every page, not just the active one', () => {
    renderPager({ value: 'collection' });

    expect(screen.getByTestId('page-collection')).toBeTruthy();
    expect(screen.getByTestId('page-forsale')).toBeTruthy();
    expect(screen.getByTestId('page-activity')).toBeTruthy();
  });

  it('renders the header and tab bar once, above the pages', () => {
    renderPager();

    expect(screen.getAllByTestId('pager-header')).toHaveLength(1);
    expect(screen.getAllByTestId('pager-tab-bar')).toHaveLength(1);
  });

  it('reserves room on every page for the pinned chrome', () => {
    renderPager();

    TABS.forEach((tab) => {
      const style = screen.getByTestId(`page-${tab}`).props.contentContainerStyle;
      expect(style).toEqual(
        expect.objectContaining({
          minHeight: expect.any(Number),
          paddingTop: expect.any(Number),
        }),
      );
    });
  });

  /*
    WHAT EACH PAGE RESERVES FOR THE CHROME.

    The chrome is measured from y=0, so it spans the status bar. A page running
    `contentInsetAdjustmentBehavior="automatic"` is ALREADY inset by that same
    strip by UIKit, and reserving it again opened a second status bar of white
    between the tab bar and the first row of the page.
  */
  describe('contentInsetTop', () => {
    function chromePaddingAfterLayout(contentInsetTop?: number) {
      renderPager({ contentInsetTop });

      const headerWrapper = screen.getByTestId('pager-header').parent;
      const tabBarWrapper = screen.getByTestId('pager-tab-bar').parent;
      act(() => {
        fireEvent(headerWrapper as never, 'layout', {
          nativeEvent: { layout: { height: 300, width: 393, x: 0, y: 0 } },
        });
        fireEvent(tabBarWrapper as never, 'layout', {
          nativeEvent: { layout: { height: 50, width: 393, x: 0, y: 0 } },
        });
      });

      return screen.getByTestId('page-collection').props.contentContainerStyle.paddingTop;
    }

    it('reserves the whole chrome when the page is not inset from outside', () => {
      expect(chromePaddingAfterLayout()).toBe(350);
    });

    it('reserves only what the outside inset does not already cover', () => {
      expect(chromePaddingAfterLayout(59)).toBe(291);
    });

    it('never reserves a negative amount before the chrome has been measured', () => {
      renderPager({ contentInsetTop: 59 });

      expect(screen.getByTestId('page-collection').props.contentContainerStyle.paddingTop).toBe(0);
    });
  });

  /*
    WHERE THE TAB BAR COMES TO REST.

    The bar's resting top is `headerHeight + translate`, and the translate is
    clamped at `-collapseDistance` — so the collapse distance IS the pin
    position, inverted. Left at the full header height the bar parks at 0, which
    on Portfolio put "Collection / For Sale / Activity" behind the status-bar
    clock, under the floating glass bubbles.

    `collapseDistance` is not readable from the outside, but every page's
    `minHeight` is `screenHeight + collapseDistance`, so the pin position is
    asserted through that.
  */
  describe('pinnedTopInset', () => {
    function collapseDistanceAfterHeaderLayout(pinnedTopInset?: number) {
      renderPager({ pinnedTopInset });

      const headerWrapper = screen.getByTestId('pager-header').parent;
      act(() => {
        fireEvent(headerWrapper as never, 'layout', {
          nativeEvent: { layout: { height: 300, width: 393, x: 0, y: 0 } },
        });
      });

      const { minHeight } = screen.getByTestId('page-collection').props.contentContainerStyle;
      const screenHeight = Dimensions.get('window').height;
      return minHeight - screenHeight;
    }

    it('collapses the full header height when nothing floats above the pager', () => {
      expect(collapseDistanceAfterHeaderLayout()).toBe(300);
    });

    it('stops the collapse short so the tab bar parks below the floating chrome', () => {
      // 300pt header, 100pt of chrome above it → the header only travels 200,
      // leaving the tab bar resting at 100 rather than at 0.
      expect(collapseDistanceAfterHeaderLayout(100)).toBe(200);
    });

    it('never collapses past zero when the chrome is taller than the header', () => {
      // Guards the interpolation: a negative distance would invert the
      // translate and drive the header DOWN the screen as you scroll.
      expect(collapseDistanceAfterHeaderLayout(400)).toBe(0);
    });
  });

  /*
    `pinnedTopInset` stops the collapse short, leaving the header's last
    `pinnedTopInset` points parked behind the floating chrome — on Portfolio, the
    Followers/Following row showing through the gaps between glass bubbles. An
    opaque bar was tried and rejected, so the header fades instead.
  */
  describe('headerFadeDistance', () => {
    // 300pt header parked 100 short → 200 of travel; a 100pt fade therefore
    // runs across the SECOND half of it, [100, 200].
    function renderFadingPager(headerFadeDistance?: number) {
      const scrollY = new Animated.Value(0);
      renderPager({ headerFadeDistance, pinnedTopInset: 100, scrollY });
      act(() => {
        fireEvent(screen.getByTestId('pager-header').parent as never, 'layout', {
          nativeEvent: { layout: { height: 300, width: 393, x: 0, y: 0 } },
        });
      });
      return scrollY;
    }

    // The HOST node's style carries the interpolation already resolved to a
    // number; the React element still holds animated nodes.
    function headerStyle() {
      return StyleSheet.flatten(
        screen.getByTestId('collapsible-tab-pager-header').props.style,
      ) as { opacity?: number };
    }

    function headerPointerEvents() {
      return screen.getByTestId('collapsible-tab-pager-header').props.pointerEvents;
    }

    it('leaves the header alone when no fade was asked for', () => {
      const scrollY = renderFadingPager();
      act(() => scrollY.setValue(200));

      // Not "opacity 1" — no opacity at all, so a pager without a floating bar
      // above it pays nothing for this.
      expect(headerStyle()?.opacity).toBeUndefined();
      expect(headerPointerEvents()).toBe('auto');
    });

    it('holds the header solid until the fade band begins', () => {
      const scrollY = renderFadingPager(100);

      expect(headerStyle().opacity).toBe(1);
      act(() => scrollY.setValue(100));
      expect(headerStyle().opacity).toBe(1);
    });

    it('is half faded half way through the band', () => {
      const scrollY = renderFadingPager(100);
      act(() => scrollY.setValue(150));

      expect(headerStyle().opacity).toBeCloseTo(0.5, 5);
    });

    it('finishes exactly when the collapse does, not before or after', () => {
      const scrollY = renderFadingPager(100);
      act(() => scrollY.setValue(199));
      expect(headerStyle().opacity).toBeGreaterThan(0);

      act(() => scrollY.setValue(200));
      expect(headerStyle().opacity).toBe(0);
    });

    it('never starts part-faded when the band is wider than the travel', () => {
      // 400 of fade over 200 of travel would otherwise begin at -200, i.e.
      // already half gone at the top of the page.
      const scrollY = renderFadingPager(400);

      expect(headerStyle().opacity).toBe(1);
      act(() => scrollY.setValue(200));
      expect(headerStyle().opacity).toBe(0);
    });

    // At zero opacity the Followers pill is still a live target between two
    // bubbles. `pointerEvents` is not animatable, hence a separate JS decision.
    it('disarms the invisible header so it cannot swallow a tap', () => {
      const scrollY = renderFadingPager(100);
      expect(headerPointerEvents()).toBe('auto');

      act(() => scrollY.setValue(200));
      expect(headerPointerEvents()).toBe('none');

      // And arms it again on the way back up.
      act(() => scrollY.setValue(150));
      expect(headerPointerEvents()).toBe('auto');
    });
  });

  /*
    WHERE "THE TOP OF A PAGE" IS, IN `contentOffset.y`.

    NOT ZERO. A page running `contentInsetAdjustmentBehavior="automatic"` is
    inset by UIKit, and an inset scroll view rests at `-adjustedContentInset.top`
    — the very `contentInsetTop` the chrome padding already subtracts.

    Everything here guards the same regression, which is what "swiping to the You
    page sometimes lands it scrolled a tad down" looked like: the chrome measured
    from 0 while the pages measured from `-contentInsetTop`, so the first
    `contentInsetTop` points of every scroll were a DEAD ZONE — the page content
    slid up under the pinned tab bar while the profile block, still reading
    `scrollY <= 0`, had not started collapsing. Anything left parked in that band
    showed a fully expanded header with the balance clipped behind the tab strip.
  */
  describe('the page top is -contentInsetTop, not 0', () => {
    const HEADER = 300;
    const TAB_BAR = 50;
    const INSET = 59;

    function mountWithChrome(contentInsetTop: number) {
      const scrollY = new Animated.Value(0);
      renderPager({ contentInsetTop, scrollY });

      act(() => {
        fireEvent(screen.getByTestId('pager-header').parent as never, 'layout', {
          nativeEvent: { layout: { height: HEADER, width: 393, x: 0, y: 0 } },
        });
        fireEvent(screen.getByTestId('pager-tab-bar').parent as never, 'layout', {
          nativeEvent: { layout: { height: TAB_BAR, width: 393, x: 0, y: 0 } },
        });
      });

      const chromeTranslate = () => {
        const style = StyleSheet.flatten(
          screen.getByTestId('collapsible-tab-pager-chrome').props.style,
        ) as unknown as { transform: { translateY: number }[] };
        return style.transform[0].translateY;
      };
      const scrollPageTo = (y: number) => {
        act(() => {
          scrollY.setValue(y);
        });
      };

      return { chromeTranslate, scrollPageTo };
    }

    it('leaves the chrome fully expanded before any page has reported an offset', () => {
      // Nothing reports the resting `-contentInsetTop` until the first scroll
      // event, so an unseeded value would mount the chrome that far up the
      // screen and snap it back on the first frame that scrolls.
      const { chromeTranslate } = mountWithChrome(INSET);

      expect(chromeTranslate()).toBe(0);
    });

    it('leaves the chrome fully expanded with the page at its top', () => {
      const { chromeTranslate, scrollPageTo } = mountWithChrome(INSET);

      scrollPageTo(-INSET);

      expect(chromeTranslate()).toBe(0);
    });

    // THE BUG. 30pt of travel from the page top has to move the chrome 30pt, or
    // the balance spends that travel hidden behind a stationary tab bar.
    it('collapses the chrome from the first point the page travels', () => {
      const { chromeTranslate, scrollPageTo } = mountWithChrome(INSET);

      scrollPageTo(-INSET + 30);

      expect(chromeTranslate()).toBe(-30);
    });

    it('finishes the collapse exactly one collapse-distance from the page top', () => {
      const { chromeTranslate, scrollPageTo } = mountWithChrome(INSET);

      scrollPageTo(-INSET + HEADER);

      expect(chromeTranslate()).toBe(-HEADER);
      scrollPageTo(-INSET + HEADER + 500);
      expect(chromeTranslate()).toBe(-HEADER);
    });

    // The public profile's pages are on React Native's `never` inset default, so
    // their top IS 0 and none of the above may shift them.
    it('is unchanged for a pager whose pages are not inset from outside', () => {
      const { chromeTranslate, scrollPageTo } = mountWithChrome(0);

      expect(chromeTranslate()).toBe(0);
      scrollPageTo(30);
      expect(chromeTranslate()).toBe(-30);
    });
  });

  /*
    PARKING THE INACTIVE PAGES.

    The sync exists so a swipe cannot reveal a page whose header sits somewhere
    else, and it works in ABSOLUTE `contentOffset.y` — so "the top" it falls back
    to, and the band it clamps into, are both anchored at `-contentInsetTop`.
    Falling back to 0 instead shoves a page that is already at its top down by
    the whole inset, under a header that never moved.
  */
  describe('syncPageOffsets', () => {
    const HEADER = 300;
    const INSET = 59;

    function renderWithPageRefs(reported: Partial<Record<Tab, number>>) {
      const scrollToOffset = jest.fn();
      const node: CollapsibleScrollTarget = { scrollToOffset };
      const pageRefs = {
        collection: { current: node },
        forsale: { current: node },
        activity: { current: node },
      };
      renderPager({ contentInsetTop: INSET, pageRefs, value: 'collection' });

      act(() => {
        fireEvent(screen.getByTestId('pager-header').parent as never, 'layout', {
          nativeEvent: { layout: { height: HEADER, width: 393, x: 0, y: 0 } },
        });
      });

      (Object.keys(reported) as Tab[]).forEach((tab) => {
        reportScroll(tab, reported[tab] as number);
      });

      return scrollToOffset;
    }

    // THE REGRESSION. Collection is active and has never reported an offset;
    // For Sale is sitting exactly at its own top. Nothing should move it.
    it('leaves a page that is already at its top alone', () => {
      const scrollToOffset = renderWithPageRefs({ forsale: -INSET });

      swipeLeft();

      expect(scrollToOffset).not.toHaveBeenCalledWith(
        expect.objectContaining({ offset: 0 }),
      );
      expect(scrollToOffset).not.toHaveBeenCalled();
    });

    it('parks the other pages at the active page top, not at zero', () => {
      const scrollToOffset = renderWithPageRefs({ collection: -INSET, activity: 200 });

      swipeLeft();

      expect(scrollToOffset).toHaveBeenCalledWith({ offset: -INSET, animated: false });
    });

    it('clamps the park into the collapse band measured from the page top', () => {
      // Collection is scrolled a full collapse-distance PLUS 100 past its top.
      // Beyond the collapse the header is pinned either way, so the others only
      // need to reach the end of the band — which is `collapseDistance` from
      // THEIR top, not from 0.
      const scrollToOffset = renderWithPageRefs({ collection: -INSET + HEADER + 100 });

      swipeLeft();

      expect(scrollToOffset).toHaveBeenCalledWith({
        offset: -INSET + HEADER,
        animated: false,
      });
    });
  });

  /*
    WHAT AN ACTIVE-PAGE CHANGE DOES — AND WHAT MERELY RE-RENDERING DOES NOT.

    A SUB-TAB TAP resets: both pages and the chrome go back to the top, because
    switching sub-tabs is a request for a fresh page. Carrying the old offsets
    across is what read as "really jumpy" — the chrome had to snap between a
    collapsed and an expanded profile block on every tap, in whichever direction
    the two tabs happened to disagree.

    A SWIPE does not. It is continuous and finger-tracked, and the grant-time
    `syncPageOffsets` already puts both pages on ONE offset before the drag
    reveals the neighbour, so the gesture and its settle are already jump-free.

    AND NOTHING ELSE DOES. Leaving by the bottom nav and coming back, a stack
    round trip to a card, a re-measure of the chrome, the safe-area insets
    arriving a render late — none of those is a sub-tab change, and every one has
    to keep the user's place.
  */
  describe('changing the active page', () => {
    const HEADER = 300;
    const TAB_BAR = 50;
    const INSET = 59;

    /**
     * The pager with a REAL `value`, driven by taps on its own tab bar — the
     * path a tab tap takes on device, and the one that never reaches the pan
     * responder.
     *
     * The page refs REPORT BACK the way a real scroll view does: UIKit answers a
     * programmatic `setContentOffset` with a scroll event, which is how the
     * pager learns where a page it moved has ended up. Without that the pager's
     * bookkeeping would go stale the moment anything scrolled a page for it, and
     * a test could pass on a desync the device never has.
     *
     * They also LAND where the device lands them, which is not always where they
     * were sent:
     *   - React Native clamps a programmatic target into the scroll view's own
     *     range, and it measures the bottom of that range against `contentInset`
     *     (zero here) rather than `adjustedContentInset` (where
     *     `contentInsetAdjustmentBehavior="automatic"` puts the safe area) — so
     *     a negative target is rounded up to 0 unless the page was given
     *     `scrollToOverflowEnabled`. `RCTScrollViewComponentView.mm`
     *     `scrollTo:y:animated:` / `RCTScrollView.m` `scrollToOffset:animated:`;
     *   - and a scroll to where the page already is does nothing at all, so it
     *     answers with no event. Echoing one anyway would let a test paper over
     *     a page that never moved.
     */
    function renderTappablePager({ inset = INSET }: { inset?: number } = {}) {
      const scrollY = new Animated.Value(0);
      const scrollToOffset = jest.fn();
      /** Where each page actually IS, seeded at its own resting top. */
      const landedAt = new Map<Tab, number>(TABS.map((tab) => [tab, -inset]));
      /** Whether the pager told this page it may scroll past the clamp. */
      const overflowAllowed = {} as Record<Tab, boolean | undefined>;
      const pageRefs = Object.fromEntries(
        TABS.map((tab) => [
          tab,
          {
            current: {
              scrollToOffset: (options: { offset: number; animated?: boolean }) => {
                scrollToOffset(tab, options);
                const landing = overflowAllowed[tab]
                  ? options.offset
                  : Math.max(options.offset, 0);
                if (landedAt.get(tab) === landing) {
                  return;
                }
                landedAt.set(tab, landing);
                deliverScroll(tab, landing, scrollY);
              },
            } satisfies CollapsibleScrollTarget,
          },
        ]),
      ) as Record<Tab, { readonly current: CollapsibleScrollTarget | null }>;

      function Harness() {
        const [value, setValue] = useState<Tab>('collection');
        const [contentInsetTop, setContentInsetTop] = useState(inset);
        return (
          <>
            <Text
              onPress={() => setContentInsetTop(inset + 20)}
              testID="grow-inset"
            >
              inset
            </Text>
            <CollapsibleTabPager
              contentInsetTop={contentInsetTop}
              header={<View testID="pager-header" />}
              onChange={setValue}
              order={TABS}
              pageRefs={pageRefs}
              renderPage={(page: Tab, pageProps: CollapsiblePageProps) => {
                overflowAllowed[page] = pageProps.scrollToOverflowEnabled;
                return (
                  <ScrollView
                    contentContainerStyle={pageProps.contentContainerStyle}
                    onScroll={pageProps.onScroll}
                    scrollEventThrottle={pageProps.scrollEventThrottle}
                    scrollToOverflowEnabled={pageProps.scrollToOverflowEnabled}
                    testID={`page-${page}`}
                  />
                );
              }}
              scrollY={scrollY}
              tabBar={(
                <View testID="pager-tab-bar">
                  {TABS.map((tab) => (
                    <Text key={tab} onPress={() => setValue(tab)} testID={`tap-${tab}`}>
                      {tab}
                    </Text>
                  ))}
                </View>
              )}
              value={value}
            />
          </>
        );
      }

      renderWithProviders(<Harness />);

      act(() => {
        fireEvent(screen.getByTestId('pager-header').parent as never, 'layout', {
          nativeEvent: { layout: { height: HEADER, width: 393, x: 0, y: 0 } },
        });
        fireEvent(screen.getByTestId('pager-tab-bar').parent as never, 'layout', {
          nativeEvent: { layout: { height: TAB_BAR, width: 393, x: 0, y: 0 } },
        });
      });

      const press = (testID: string) => {
        act(() => {
          fireEvent.press(screen.getByTestId(testID));
        });
      };

      return {
        chromeTranslate: () => {
          const style = StyleSheet.flatten(
            screen.getByTestId('collapsible-tab-pager-chrome').props.style,
          ) as unknown as { transform: { translateY: number }[] };
          return style.transform[0].translateY;
        },
        growInset: () => press('grow-inset'),
        /** How far a page is RESTING from its own top, in points. */
        restingTravelFromTop: (tab: Tab) => (landedAt.get(tab) as number) + inset,
        scrollPage: (tab: Tab, travelledFromTop: number) => {
          landedAt.set(tab, -inset + travelledFromTop);
          reportScroll(tab, -inset + travelledFromTop, scrollY);
        },
        scrollToOffset,
        tap: (tab: Tab) => press(`tap-${tab}`),
      };
    }

    // ────────────────────────────────────────────────────────────────────────
    // A sub-tab TAP resets.
    // ────────────────────────────────────────────────────────────────────────

    /*
      THE RESET HAS TO LAND, NOT JUST FIRE.

      "Scroll to the top of Collection, then tap Activity — the photo is
      partially covered by the tab." The reset was firing and being CLAMPED:
      React Native measures the range it clamps a programmatic target into
      against the scroll view's `contentInset`, which is zero on these pages,
      instead of `adjustedContentInset`, which is where
      `contentInsetAdjustmentBehavior="automatic"` puts the safe area. The lowest
      reachable offset therefore came out as 0 while the page's real top is
      `-contentInsetTop`, and every page — including ones already sitting at
      their top, which the reset pushed DOWN — landed a whole inset short. The
      chrome had meanwhile asserted the top, so it drew a fully expanded profile
      block over content that had slid up behind the tab strip.

      `scrollToOverflowEnabled` is the one lever React Native exposes for that
      clamp, and it lives on the page's scroller — so the pager has to hand it
      out with the rest of the page props.
    */
    it('lands the arriving page at its own top, not at the clamp floor', () => {
      const pager = renderTappablePager();

      // The repro exactly: Collection sitting at its top.
      pager.scrollPage('collection', 0);

      pager.tap('activity');

      expect(pager.restingTravelFromTop('activity')).toBe(0);
      expect(pager.chromeTranslate()).toBe(0);
    });

    // The page you LEFT is reset too, and it is the one that was already at its
    // top — so a clamp shows up here as the reset SHOVING it down an inset.
    it('does not push a page that is already at its top away from it', () => {
      const pager = renderTappablePager();

      pager.tap('activity');

      TABS.forEach((tab) => {
        expect(pager.restingTravelFromTop(tab)).toBe(0);
      });
    });

    it('tells every page it may scroll past that clamp', () => {
      renderPager();

      TABS.forEach((tab) => {
        expect(screen.getByTestId(`page-${tab}`).props.scrollToOverflowEnabled).toBe(true);
      });
    });

    it('puts the arriving page and the chrome back at the top on a tap', () => {
      const pager = renderTappablePager();

      pager.tap('activity');
      pager.scrollPage('activity', 400);
      expect(pager.chromeTranslate()).toBe(-HEADER);

      pager.tap('collection');

      expect(pager.chromeTranslate()).toBe(0);
      expect(pager.scrollToOffset).toHaveBeenCalledWith('collection', {
        offset: -INSET,
        animated: false,
      });
    });

    // The page you LEFT is reset too, so coming back is a fresh page rather than
    // wherever it happened to be — that swap between a collapsed and an expanded
    // profile block on alternate taps is the "jumpy" being fixed.
    it('resets the departing page too, so coming back is also at the top', () => {
      const pager = renderTappablePager();

      pager.scrollPage('collection', 120);
      expect(pager.chromeTranslate()).toBe(-120);

      pager.tap('activity');
      pager.tap('collection');

      expect(pager.chromeTranslate()).toBe(0);
    });

    // Otherwise the pager still believes a page it just parked at the top is
    // 400pt down, and the stale number resurfaces at the next pan grant as the
    // offset every OTHER page gets synced to.
    it('forgets the old offsets, so a later swipe cannot resurrect them', () => {
      const pager = renderTappablePager();

      pager.tap('activity');
      pager.scrollPage('activity', 400);
      pager.tap('collection');
      pager.scrollToOffset.mockClear();

      // A swipe now grants against pages that are all at the top, so its sync
      // has nothing to do. A stale 341 would have dragged them all back down.
      swipeLeft();

      expect(pager.scrollToOffset).not.toHaveBeenCalled();
      expect(pager.chromeTranslate()).toBe(0);
    });

    // ────────────────────────────────────────────────────────────────────────
    // A SWIPE does not reset — it has to stay continuous.
    // ────────────────────────────────────────────────────────────────────────

    /*
      Resetting a swipe cannot be done without producing the very jump this
      change removes, wherever it is hooked: at the pan grant the page under the
      finger leaps to its top mid-touch (and on drags that never commit); on
      release both pages are on screen for the whole ~190ms slide and jump
      together; after the settle the arriving page jumps once everything already
      looks finished.
    */
    it('leaves the pages alone when the change came from a swipe', () => {
      const pager = renderTappablePager();

      pager.scrollPage('collection', 120);
      pager.scrollToOffset.mockClear();

      swipeLeft();

      // The grant-time sync brought For Sale alongside Collection — that is the
      // whole reveal — and nothing afterwards sent anything back to the top.
      expect(pager.scrollToOffset).toHaveBeenCalledWith('forsale', {
        offset: -INSET + 120,
        animated: false,
      });
      expect(pager.scrollToOffset).not.toHaveBeenCalledWith('forsale', {
        offset: -INSET,
        animated: false,
      });
      // …and the chrome did not move when the swipe committed.
      expect(pager.chromeTranslate()).toBe(-120);
    });

    // ────────────────────────────────────────────────────────────────────────
    // Everything that is NOT a sub-tab change must keep the user's place.
    // ────────────────────────────────────────────────────────────────────────

    // The mount seed used to be its own one-shot effect. It is now the `??
    // pageTop` fallback of the same reconcile, and it still has to hold.
    it('still mounts the chrome expanded before any page has reported an offset', () => {
      const pager = renderTappablePager();

      expect(pager.chromeTranslate()).toBe(0);
    });

    /*
      LEAVING BY THE BOTTOM NAV AND COMING BACK, AND A STACK ROUND TRIP TO A
      CARD, ARE BOTH THIS.

      Neither remounts the pager and neither changes `value`, so what has to hold
      is that a re-render on its own resets nothing. Re-measuring the chrome is
      the re-render this harness can produce; the guard is the same one.

      IT IS ALSO WHAT STOPS THE RECONCILE EFFECT'S DEPENDENCIES BEING WIDENED.
      That effect writes a whole offset, so anything that re-runs it mid-scroll
      rewinds the chrome to the last REPORTED offset — a frame behind the finger
      at best, and at worst it throws away where the user was. `value` and
      `pageTop` are the only two things that can invalidate the pairing.
    */
    it('leaves a scrolled page alone when the chrome re-measures', () => {
      const pager = renderTappablePager();

      pager.scrollPage('collection', 180);
      pager.scrollToOffset.mockClear();

      act(() => {
        fireEvent(screen.getByTestId('pager-tab-bar').parent as never, 'layout', {
          nativeEvent: { layout: { height: TAB_BAR + 12, width: 393, x: 0, y: 0 } },
        });
      });

      expect(pager.scrollToOffset).not.toHaveBeenCalled();
      expect(pager.chromeTranslate()).toBe(-180);
    });

    // The safe-area insets arrive a render late, which moves `pageTop` under a
    // page that may already be scrolled. It re-points the chrome — the geometry
    // really did change — but it is not a sub-tab change and must not reset.
    it('leaves a scrolled page alone when the content inset arrives late', () => {
      const pager = renderTappablePager();

      pager.scrollPage('collection', 180);
      pager.scrollToOffset.mockClear();

      pager.growInset();

      expect(pager.scrollToOffset).not.toHaveBeenCalled();
      // 20pt more inset means the page's top moved 20pt further up, so the same
      // reported offset is now 200pt of travel rather than 180.
      expect(pager.chromeTranslate()).toBe(-200);
    });
  });

  // ==========================================================================
  // Paging.
  // ==========================================================================

  it('moves forward on a leftward swipe', () => {
    const onChange = jest.fn();
    renderPager({ onChange, value: 'collection' });

    swipeLeft();

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('forsale');
  });

  it('moves back on a rightward swipe', () => {
    const onChange = jest.fn();
    renderPager({ onChange, value: 'activity' });

    swipeRight();

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('forsale');
  });

  it('moves exactly one page per gesture, however long the drag', () => {
    const onChange = jest.fn();
    renderPager({ onChange, value: 'collection' });

    drag({ x: 700, y: 300 }, [
      { x: 620, y: 302 },
      { x: 500, y: 304 },
      { x: 380, y: 306 },
      { x: 200, y: 308 },
      { x: 40, y: 310 },
    ]);

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('forsale');
  });

  it('snaps back without changing page when the drag is too small and too slow', () => {
    const onChange = jest.fn();
    renderPager({ onChange, value: 'collection' });

    // Clears the 14pt claim bar, so the pages DO follow the finger — but on
    // release it is neither far enough nor fast enough to commit.
    drag(
      { x: 400, y: 400 },
      [
        { x: 380, y: 401 },
        { x: 372, y: 401 },
        { x: 368, y: 402 },
      ],
      { stepMs: 400 },
    );

    expect(onChange).not.toHaveBeenCalled();
  });

  it('pages again on a separate gesture', () => {
    const onChange = jest.fn();
    renderPager({ onChange, value: 'collection' });

    swipeLeft(400);
    swipeLeft(200);

    // `value` is fixed in this render, so both report the same target — what
    // matters is that the second gesture re-armed at all.
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  // ==========================================================================
  // No wrap-around, at EITHER end.
  //
  // Both halves are asserted: nothing changes, AND nothing is claimed — at the
  // ends a horizontal drag has to be left entirely to whatever is underneath.
  // ==========================================================================

  it('does not wrap backwards off the first page', () => {
    const onChange = jest.fn();
    renderPager({ onChange, value: 'collection' });

    const claims = swipeRight();

    expect(onChange).not.toHaveBeenCalled();
    expect(claims.every((claimed) => claimed === false)).toBe(true);
  });

  it('does not wrap forwards off the last page', () => {
    const onChange = jest.fn();
    renderPager({ onChange, value: 'activity' });

    const claims = swipeLeft();

    expect(onChange).not.toHaveBeenCalled();
    expect(claims.every((claimed) => claimed === false)).toBe(true);
  });

  // ==========================================================================
  // Standing down. Every case asserts that nothing was CLAIMED as well as that
  // nothing changed — an over-eager claim eats the collection list's vertical
  // scroll, which is a worse bug than a missing page swipe.
  // ==========================================================================

  it('ignores a vertical scroll', () => {
    const onChange = jest.fn();
    renderPager({ onChange, value: 'forsale' });

    const claims = drag({ x: 400, y: 600 }, [
      { x: 406, y: 520 },
      { x: 412, y: 420 },
      { x: 404, y: 300 },
    ]);

    expect(onChange).not.toHaveBeenCalled();
    expect(claims.every((claimed) => claimed === false)).toBe(true);
  });

  // Clears the horizontal claim bar outright, and must still be rejected as
  // "mostly a scroll" — this is the one that keeps a long collection scrolling.
  it('ignores a diagonal drag dominated by vertical travel', () => {
    const onChange = jest.fn();
    renderPager({ onChange, value: 'forsale' });

    const claims = drag({ x: 400, y: 600 }, [
      { x: 360, y: 540 },
      { x: 310, y: 460 },
      { x: 260, y: 380 },
    ]);

    expect(onChange).not.toHaveBeenCalled();
    expect(claims.every((claimed) => claimed === false)).toBe(true);
  });

  it('ignores a tap', () => {
    const onChange = jest.fn();
    renderPager({ onChange, value: 'collection' });

    const claims = drag({ x: 400, y: 400 }, [
      { x: 402, y: 401 },
      { x: 401, y: 400 },
    ]);

    expect(onChange).not.toHaveBeenCalled();
    expect(claims.every((claimed) => claimed === false)).toBe(true);
  });

  // THE MOST LIKELY COLLISION. A rightward drag from the left edge belongs to
  // `DrawerEdgeSwipe` on the owner Portfolio, and to the stack's interactive
  // back-swipe on a public profile. Both directions are ignored inside the band.
  it('ignores a touch starting in the left-edge drawer band', () => {
    const onChange = jest.fn();
    renderPager({ onChange, value: 'forsale' });

    const rightward = drag({ x: 6, y: 400 }, [
      { x: 80, y: 402 },
      { x: 200, y: 404 },
      { x: 340, y: 406 },
    ]);
    const leftward = drag({ x: 20, y: 400 }, [
      { x: 4, y: 402 },
      { x: 2, y: 404 },
    ]);

    expect(onChange).not.toHaveBeenCalled();
    expect([...rightward, ...leftward].every((claimed) => claimed === false)).toBe(true);
  });

  it('still pages for a drag that starts just outside the band', () => {
    const onChange = jest.fn();
    renderPager({ onChange, value: 'forsale' });

    drag({ x: 30, y: 400 }, [
      { x: 120, y: 402 },
      { x: 260, y: 404 },
      { x: 400, y: 406 },
    ]);

    expect(onChange).toHaveBeenCalledWith('collection');
  });

  it('stands down while the chart is being scrubbed', () => {
    const onChange = jest.fn();
    renderPager({ chartScrubbing: true, onChange, value: 'collection' });

    const claims = swipeLeft();

    expect(onChange).not.toHaveBeenCalled();
    expect(claims.every((claimed) => claimed === false)).toBe(true);
  });

  it('stands down in collection edit mode', () => {
    const onChange = jest.fn();
    renderPager({ collectionEditing: true, onChange, value: 'collection' });

    const claims = swipeLeft();

    expect(onChange).not.toHaveBeenCalled();
    expect(claims.every((claimed) => claimed === false)).toBe(true);
  });

  it('stands down while disabled', () => {
    const onChange = jest.fn();
    renderPager({ disabled: true, onChange, value: 'collection' });

    const claims = swipeLeft();

    expect(onChange).not.toHaveBeenCalled();
    expect(claims.every((claimed) => claimed === false)).toBe(true);
  });

  it('stands down for a screen-supplied predicate (e.g. the search field has focus)', () => {
    const onChange = jest.fn();
    renderPager({ onChange, shouldStandDown: () => true, value: 'collection' });

    const claims = swipeLeft();

    expect(onChange).not.toHaveBeenCalled();
    expect(claims.every((claimed) => claimed === false)).toBe(true);
  });

  // ==========================================================================
  // Horizontal scrollables inside a page.
  // ==========================================================================

  it('leaves a drag inside a PageSwipeGuard to that scroller', () => {
    const onChange = jest.fn();
    renderPager({ onChange, value: 'collection', withGuard: true });

    const claims = drag(
      { x: 400, y: 400 },
      [
        { x: 340, y: 401 },
        { x: 240, y: 402 },
        { x: 140, y: 403 },
      ],
      { guardTestID: 'chip-guard' },
    );

    expect(onChange).not.toHaveBeenCalled();
    expect(claims.every((claimed) => claimed === false)).toBe(true);
  });

  it('re-arms after a guarded gesture ends', () => {
    const onChange = jest.fn();
    renderPager({ onChange, value: 'collection', withGuard: true });

    drag({ x: 400, y: 400 }, [{ x: 300, y: 401 }], { guardTestID: 'chip-guard' });
    expect(onChange).not.toHaveBeenCalled();

    // A later touch that does NOT land in the chip row must work normally: the
    // block flag is per-touch, cleared by the pager's own start handler.
    swipeLeft();

    expect(onChange).toHaveBeenCalledWith('forsale');
  });

  // ==========================================================================
  // Claiming the responder.
  //
  // A `Pressable` fires `onPress` on release unless something cancelled it, and
  // the only thing that cancels it is an ancestor taking the responder
  // mid-gesture. Without the claim, a page swipe would change the tab AND open
  // the collection card the finger started on. It is also what stops the page
  // scrolling vertically half way through the drag.
  // ==========================================================================

  it('claims the responder on a qualifying swipe, cancelling the child', () => {
    renderPager({ value: 'collection' });

    expect(swipeLeft()).toContain(true);
  });

  it('claims exactly once', () => {
    renderPager({ value: 'collection' });

    const claims = drag({ x: 700, y: 300 }, [
      { x: 620, y: 302 },
      { x: 500, y: 304 },
      { x: 380, y: 306 },
    ]);

    expect(claims.filter(Boolean)).toHaveLength(1);
  });

  it('never claims on touch-down, only on a move', () => {
    renderPager({ value: 'collection' });

    let claimedOnStart = true;
    act(() => {
      claimedOnStart = pagerHandlers().onStartShouldSetResponderCapture(
        makeStartEvent({ x: 400, y: 400 }),
      );
    });

    // At touch-down a page swipe and a tap on a card are the same event.
    expect(claimedOnStart).toBe(false);
  });

  it('re-arms cleanly for the next gesture after a release', () => {
    const onChange = jest.fn();
    renderPager({ onChange, value: 'collection' });

    expect(swipeLeft(400)).toContain(true);
    expect(swipeLeft(200)).toContain(true);
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('does not change page when the gesture is terminated instead of released', () => {
    const onChange = jest.fn();
    renderPager({ onChange, value: 'collection' });

    swipeLeft(400, { stepMs: 16 });
    onChange.mockClear();

    // Same drag, but the system takes the gesture away (an incoming call, a
    // modal) instead of the finger lifting: snap back, commit nothing.
    drag(
      { x: 400, y: 400 },
      [
        { x: 340, y: 401 },
        { x: 240, y: 402 },
      ],
      { release: false },
    );
    act(() => {
      pagerHandlers().onResponderTerminate(makeStartEvent({ x: 240, y: 402 }));
    });

    expect(onChange).not.toHaveBeenCalled();
  });
});
