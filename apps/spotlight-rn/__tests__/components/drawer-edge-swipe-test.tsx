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
};

/**
 * Replays one finger: touch down, then a series of moves. Each move is
 * dispatched through BOTH the capture and bubble predicates, which is what the
 * responder system does — and is why the fires-once guard exists.
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

  it('ignores a horizontal drag that starts mid-screen', () => {
    const onOpen = jest.fn();
    renderWithProviders(<DrawerEdgeSwipe onOpen={onOpen} />);

    drag({ x: 180, y: 400 }, [
      { x: 240, y: 402 },
      { x: 300, y: 404 },
    ]);

    expect(onOpen).not.toHaveBeenCalled();
  });

  it('ignores a vertical scroll that starts at the left edge', () => {
    const onOpen = jest.fn();
    renderWithProviders(<DrawerEdgeSwipe onOpen={onOpen} />);

    drag({ x: 8, y: 500 }, [
      { x: 12, y: 440 },
      { x: 14, y: 360 },
      { x: 10, y: 280 },
    ]);

    expect(onOpen).not.toHaveBeenCalled();
  });

  // The vertical case above is rejected on travel alone; this one clears the
  // inward-distance bar and must still be rejected as "mostly a scroll".
  it('ignores a diagonal drag dominated by vertical travel', () => {
    const onOpen = jest.fn();
    renderWithProviders(<DrawerEdgeSwipe onOpen={onOpen} />);

    drag({ x: 8, y: 500 }, [
      { x: 28, y: 460 },
      { x: 48, y: 380 },
    ]);

    expect(onOpen).not.toHaveBeenCalled();
  });

  it('ignores a leftward drag from the left edge', () => {
    const onOpen = jest.fn();
    renderWithProviders(<DrawerEdgeSwipe onOpen={onOpen} />);

    drag({ x: 20, y: 400 }, [{ x: 2, y: 401 }]);

    expect(onOpen).not.toHaveBeenCalled();
  });

  it('never claims the responder, whatever the gesture', () => {
    renderWithProviders(<DrawerEdgeSwipe onOpen={jest.fn()} />);

    const claims = drag({ x: 4, y: 400 }, [
      { x: 60, y: 402 },
      { x: 140, y: 406 },
    ]);

    expect(claims.length).toBeGreaterThan(0);
    expect(claims.every((claimed) => claimed === false)).toBe(true);
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
