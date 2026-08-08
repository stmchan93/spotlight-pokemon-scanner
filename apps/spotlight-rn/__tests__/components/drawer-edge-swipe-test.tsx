import { act, screen } from '@testing-library/react-native';
import { Text, type GestureResponderEvent } from 'react-native';

import { DrawerEdgeSwipe } from '@/components/drawer-edge-swipe';
import { useAppDrawer } from '@/providers/app-drawer-provider';

import { renderWithProviders } from '../test-utils';

// The real AuthProvider spins up Supabase session plumbing this unit render has
// no use for. `test-utils` falls back to a pass-through wrapper when the module
// is mocked, so supplying `useAuth` alone is enough.
let mockIsGuest = false;
jest.mock('@/providers/auth-provider', () => ({
  useAuth: () => ({ isGuest: mockIsGuest }),
}));

type TouchPoint = { x: number; y: number };

/**
 * PanResponder derives `gestureState` from the event's `touchHistory`, so the
 * only faithful way to drive it is to hand it a real touch bank. `dx`/`dy`
 * accumulate as `current - previous` per move, exactly as on device.
 */
function makeMoveEvent(from: TouchPoint, to: TouchPoint, timeStamp: number) {
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
          previousTimeStamp: timeStamp - 16,
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
  onResponderRelease: (event: GestureResponderEvent) => void;
};

/**
 * Replays one finger: touch down, then a series of moves. Each move is
 * dispatched through BOTH the capture and bubble predicates, which is what the
 * responder system does — and is why the fires-once guard exists.
 *
 * Returns what each predicate returned, in order. `true` means "claim the
 * responder", which on device is what terminates the child's pending press;
 * these booleans are therefore the closest a unit test gets to asserting that
 * the card underneath was cancelled.
 */
function drag(start: TouchPoint, points: TouchPoint[]): boolean[] {
  const handlers = screen.getByTestId('drawer-edge-swipe').props as Handlers;
  const claims: boolean[] = [];

  act(() => {
    handlers.onStartShouldSetResponderCapture(makeStartEvent(start));
  });

  let previous = start;
  points.forEach((point, index) => {
    const event = makeMoveEvent(previous, point, (index + 1) * 16);
    act(() => {
      claims.push(handlers.onMoveShouldSetResponderCapture(event));
      claims.push(handlers.onMoveShouldSetResponder(event));
    });
    previous = point;
  });

  return claims;
}

function DrawerStateProbe() {
  const { isOpen } = useAppDrawer();
  return <Text testID="drawer-state">{isOpen ? 'open' : 'closed'}</Text>;
}

describe('DrawerEdgeSwipe', () => {
  beforeEach(() => {
    mockIsGuest = false;
  });

  it('opens the drawer for a left-edge inward drag', () => {
    const onOpen = jest.fn();
    renderWithProviders(<DrawerEdgeSwipe onOpen={onOpen} />);

    drag({ x: 6, y: 400 }, [{ x: 60, y: 404 }]);

    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('fires exactly once across a whole gesture', () => {
    const onOpen = jest.fn();
    renderWithProviders(<DrawerEdgeSwipe onOpen={onOpen} />);

    // One continuous drag reported as four moves — the move-should-set
    // predicate is dispatched for every one of them, in both phases.
    drag({ x: 4, y: 300 }, [
      { x: 40, y: 302 },
      { x: 90, y: 306 },
      { x: 150, y: 310 },
      { x: 210, y: 312 },
    ]);

    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('opens again on a separate gesture', () => {
    const onOpen = jest.fn();
    renderWithProviders(<DrawerEdgeSwipe onOpen={onOpen} />);

    drag({ x: 6, y: 400 }, [{ x: 60, y: 404 }]);
    drag({ x: 6, y: 200 }, [{ x: 60, y: 204 }]);

    expect(onOpen).toHaveBeenCalledTimes(2);
  });

  // Every rejection below asserts BOTH halves of "ignores": the drawer must not
  // open, AND the responder must not be claimed. The second half is what keeps
  // the collection list scrolling and its cards tappable — a claim is a cancel
  // for whatever is underneath, so an over-eager claim is as bad a bug as the
  // missing one it replaces.
  it('ignores a horizontal drag that starts mid-screen', () => {
    const onOpen = jest.fn();
    renderWithProviders(<DrawerEdgeSwipe onOpen={onOpen} />);

    const claims = drag({ x: 180, y: 400 }, [
      { x: 240, y: 402 },
      { x: 300, y: 404 },
    ]);

    expect(onOpen).not.toHaveBeenCalled();
    expect(claims.every((claimed) => claimed === false)).toBe(true);
  });

  it('ignores a vertical scroll that starts at the left edge', () => {
    const onOpen = jest.fn();
    renderWithProviders(<DrawerEdgeSwipe onOpen={onOpen} />);

    const claims = drag({ x: 8, y: 500 }, [
      { x: 12, y: 440 },
      { x: 14, y: 360 },
      { x: 10, y: 280 },
    ]);

    expect(onOpen).not.toHaveBeenCalled();
    expect(claims.every((claimed) => claimed === false)).toBe(true);
  });

  // The vertical case above is rejected on travel alone; this one clears the
  // inward-distance bar and must still be rejected as "mostly a scroll".
  it('ignores a diagonal drag dominated by vertical travel', () => {
    const onOpen = jest.fn();
    renderWithProviders(<DrawerEdgeSwipe onOpen={onOpen} />);

    const claims = drag({ x: 8, y: 500 }, [
      { x: 28, y: 460 },
      { x: 48, y: 380 },
    ]);

    expect(onOpen).not.toHaveBeenCalled();
    expect(claims.every((claimed) => claimed === false)).toBe(true);
  });

  it('ignores a leftward drag from the left edge', () => {
    const onOpen = jest.fn();
    renderWithProviders(<DrawerEdgeSwipe onOpen={onOpen} />);

    const claims = drag({ x: 20, y: 400 }, [{ x: 2, y: 401 }]);

    expect(onOpen).not.toHaveBeenCalled();
    expect(claims.every((claimed) => claimed === false)).toBe(true);
  });

  // The regression that made every other rejection matter: a tap that lands in
  // the edge band is a card tap, not a drawer swipe. If this ever claimed, the
  // fix for "the swipe also opens the card" would have broken tapping the card.
  it('ignores a tap at the left edge', () => {
    const onOpen = jest.fn();
    renderWithProviders(<DrawerEdgeSwipe onOpen={onOpen} />);

    const claims = drag({ x: 6, y: 400 }, [
      { x: 8, y: 401 },
      { x: 7, y: 400 },
    ]);

    expect(onOpen).not.toHaveBeenCalled();
    expect(claims.every((claimed) => claimed === false)).toBe(true);
  });

  // ==========================================================================
  // Claiming the responder.
  //
  // This is the whole fix for "the swipe opens the drawer AND opens the card
  // underneath". A `Pressable` fires `onPress` on release unless something
  // cancelled it, and the only thing that cancels it is an ancestor taking the
  // responder mid-gesture (the Pressable then gets `onResponderTerminate`).
  // A predicate returning `true` IS that claim, so asserting on the predicate's
  // return value is asserting on the cancellation.
  //
  // The counterweight — claiming too eagerly eats the collection list's scroll —
  // is asserted by the "ignores ..." cases above, which all check that nothing
  // is claimed.
  // ==========================================================================

  it('claims the responder on a qualifying drawer swipe, cancelling the child', () => {
    renderWithProviders(<DrawerEdgeSwipe onOpen={jest.fn()} />);

    const claims = drag({ x: 4, y: 400 }, [
      { x: 60, y: 402 },
      { x: 140, y: 406 },
    ]);

    expect(claims).toContain(true);
  });

  it('claims exactly once, on the move that opens the drawer', () => {
    const onOpen = jest.fn();
    renderWithProviders(<DrawerEdgeSwipe onOpen={onOpen} />);

    // The first move already clears the inward-travel bar, so the claim and the
    // open must land together on it and never repeat.
    const claims = drag({ x: 4, y: 300 }, [
      { x: 40, y: 302 },
      { x: 90, y: 306 },
      { x: 150, y: 310 },
    ]);

    expect(claims[0]).toBe(true);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('does not claim while disabled', () => {
    renderWithProviders(<DrawerEdgeSwipe disabled onOpen={jest.fn()} />);

    const claims = drag({ x: 6, y: 400 }, [{ x: 80, y: 404 }]);

    expect(claims.every((claimed) => claimed === false)).toBe(true);
  });

  it('never claims on touch-down, only on a move', () => {
    renderWithProviders(<DrawerEdgeSwipe onOpen={jest.fn()} />);

    const handlers = screen.getByTestId('drawer-edge-swipe').props as Handlers;
    let claimedOnStart = true;
    act(() => {
      claimedOnStart = handlers.onStartShouldSetResponderCapture(makeStartEvent({ x: 4, y: 400 }));
    });

    // At touch-down a drawer swipe and a tap on a card are the same event.
    expect(claimedOnStart).toBe(false);
  });

  it('releases the responder cleanly and re-arms for the next gesture', () => {
    const onOpen = jest.fn();
    renderWithProviders(<DrawerEdgeSwipe onOpen={onOpen} />);

    const handlers = screen.getByTestId('drawer-edge-swipe').props as Handlers;

    expect(drag({ x: 4, y: 400 }, [{ x: 60, y: 402 }])).toContain(true);
    act(() => {
      handlers.onResponderRelease(makeStartEvent({ x: 60, y: 402 }));
    });

    expect(drag({ x: 4, y: 300 }, [{ x: 60, y: 302 }])).toContain(true);
    expect(onOpen).toHaveBeenCalledTimes(2);
  });

  it('does nothing while disabled', () => {
    const onOpen = jest.fn();
    renderWithProviders(<DrawerEdgeSwipe disabled onOpen={onOpen} />);

    drag({ x: 6, y: 400 }, [{ x: 80, y: 404 }]);

    expect(onOpen).not.toHaveBeenCalled();
  });

  it('does nothing in guest mode', () => {
    mockIsGuest = true;
    const onOpen = jest.fn();
    renderWithProviders(<DrawerEdgeSwipe onOpen={onOpen} />);

    drag({ x: 6, y: 400 }, [{ x: 80, y: 404 }]);

    expect(onOpen).not.toHaveBeenCalled();
  });

  it('opens the app drawer when no onOpen override is given', () => {
    renderWithProviders(
      <>
        <DrawerStateProbe />
        <DrawerEdgeSwipe />
      </>,
    );

    expect(screen.getByTestId('drawer-state')).toHaveTextContent('closed');

    drag({ x: 6, y: 400 }, [{ x: 80, y: 404 }]);

    expect(screen.getByTestId('drawer-state')).toHaveTextContent('open');
  });
});
