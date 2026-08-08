import { act, screen } from '@testing-library/react-native';
import { ScrollView, Text, View, type GestureResponderEvent } from 'react-native';

import {
  CollapsibleTabPager,
  PageSwipeGuard,
  type CollapsiblePageProps,
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
  onChange = jest.fn(),
  shouldStandDown,
  value = 'collection' as Tab,
  withGuard = false,
}: {
  chartScrubbing?: boolean;
  collectionEditing?: boolean;
  disabled?: boolean;
  onChange?: (next: Tab) => void;
  shouldStandDown?: () => boolean;
  value?: Tab;
  withGuard?: boolean;
} = {}) {
  const renderPage = (page: Tab, pageProps: CollapsiblePageProps) => (
    <ScrollView
      contentContainerStyle={pageProps.contentContainerStyle}
      onScroll={pageProps.onScroll}
      scrollEventThrottle={pageProps.scrollEventThrottle}
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
        disabled={disabled}
        header={<View testID="pager-header" />}
        onChange={onChange}
        order={TABS}
        renderPage={renderPage}
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
