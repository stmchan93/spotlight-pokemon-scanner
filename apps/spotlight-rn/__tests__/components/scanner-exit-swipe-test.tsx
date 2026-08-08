import { act, render, screen } from '@testing-library/react-native';
import { Pressable, Text, type GestureResponderEvent } from 'react-native';

import { ScannerExitSwipe } from '@/components/scanner-exit-swipe';

type TouchPoint = { x: number; y: number };

/**
 * PanResponder derives `gestureState` from the event's `touchHistory`, so the
 * only faithful way to drive it is to hand it a real touch bank. `dx`/`dy`
 * accumulate as `current - previous` per move, exactly as on device. Mirrors
 * the harness in `drawer-edge-swipe-test.tsx`.
 */
function makeMoveEvent(
  from: TouchPoint,
  to: TouchPoint,
  timeStamp: number,
  activeTouches = 1,
) {
  return {
    nativeEvent: {
      pageX: to.x,
      pageY: to.y,
      touches: new Array(activeTouches).fill({}),
    },
    touchHistory: {
      indexOfSingleActiveTouch: 0,
      mostRecentTimeStamp: timeStamp,
      numberActiveTouches: activeTouches,
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
 */
function drag(
  start: TouchPoint,
  points: TouchPoint[],
  { activeTouches = 1 }: { activeTouches?: number } = {},
): boolean[] {
  const handlers = screen.getByTestId('scanner-exit-swipe').props as Handlers;
  const claims: boolean[] = [];

  act(() => {
    handlers.onStartShouldSetResponderCapture(makeStartEvent(start));
  });

  let previous = start;
  points.forEach((point, index) => {
    const event = makeMoveEvent(previous, point, (index + 1) * 16, activeTouches);
    act(() => {
      claims.push(handlers.onMoveShouldSetResponderCapture(event));
      claims.push(handlers.onMoveShouldSetResponder(event));
    });
    previous = point;
  });

  return claims;
}

function releaseTouch() {
  const handlers = screen.getByTestId('scanner-exit-swipe').props as Handlers;
  act(() => {
    handlers.onResponderRelease(makeStartEvent({ x: 0, y: 0 }));
  });
}

function Content() {
  return (
    <Pressable onPress={() => {}} testID="scanner-content">
      <Text>viewfinder</Text>
    </Pressable>
  );
}

describe('ScannerExitSwipe', () => {
  it('leaves the scanner on a left-edge inward drag', () => {
    const onExit = jest.fn();
    render(
      <ScannerExitSwipe onExit={onExit}>
        <Content />
      </ScannerExitSwipe>,
    );

    drag({ x: 6, y: 400 }, [{ x: 60, y: 404 }]);

    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('fires exactly once across a whole gesture', () => {
    const onExit = jest.fn();
    render(
      <ScannerExitSwipe onExit={onExit}>
        <Content />
      </ScannerExitSwipe>,
    );

    // One continuous drag reported as four moves — the move-should-set
    // predicate is dispatched for every one of them, in both phases.
    drag({ x: 4, y: 300 }, [
      { x: 40, y: 302 },
      { x: 90, y: 306 },
      { x: 150, y: 310 },
      { x: 210, y: 312 },
    ]);

    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('fires again on a separate gesture', () => {
    const onExit = jest.fn();
    render(
      <ScannerExitSwipe onExit={onExit}>
        <Content />
      </ScannerExitSwipe>,
    );

    drag({ x: 6, y: 400 }, [{ x: 60, y: 404 }]);
    releaseTouch();
    drag({ x: 6, y: 200 }, [{ x: 60, y: 204 }]);

    expect(onExit).toHaveBeenCalledTimes(2);
  });

  // The whole point of the wrapper: it must claim so the full-screen tray
  // backdrop (and any other Pressable under the finger) does not also fire.
  it('claims the responder once the gesture is unambiguous', () => {
    const onExit = jest.fn();
    render(
      <ScannerExitSwipe onExit={onExit}>
        <Content />
      </ScannerExitSwipe>,
    );

    const claims = drag({ x: 4, y: 400 }, [
      { x: 60, y: 402 },
      { x: 140, y: 406 },
    ]);

    expect(claims.some((claimed) => claimed === true)).toBe(true);
    // Exactly one claim: the move that fired. Everything after stays declined.
    expect(claims.filter((claimed) => claimed === true)).toHaveLength(1);
  });

  it('never claims a touch that does not qualify', () => {
    const onExit = jest.fn();
    render(
      <ScannerExitSwipe onExit={onExit}>
        <Content />
      </ScannerExitSwipe>,
    );

    const claims = drag({ x: 180, y: 400 }, [
      { x: 240, y: 402 },
      { x: 300, y: 404 },
    ]);

    expect(claims.every((claimed) => claimed === false)).toBe(true);
    expect(onExit).not.toHaveBeenCalled();
  });

  it('ignores a tap (no travel), so tap-to-scan still works', () => {
    const onExit = jest.fn();
    render(
      <ScannerExitSwipe onExit={onExit}>
        <Content />
      </ScannerExitSwipe>,
    );

    const claims = drag({ x: 6, y: 400 }, [{ x: 7, y: 400 }]);

    expect(claims.every((claimed) => claimed === false)).toBe(true);
    expect(onExit).not.toHaveBeenCalled();
  });

  it('ignores a short inward nudge below the travel threshold', () => {
    const onExit = jest.fn();
    render(
      <ScannerExitSwipe onExit={onExit}>
        <Content />
      </ScannerExitSwipe>,
    );

    drag({ x: 6, y: 400 }, [{ x: 22, y: 401 }]);

    expect(onExit).not.toHaveBeenCalled();
  });

  it('ignores a horizontal drag that starts mid-screen', () => {
    const onExit = jest.fn();
    render(
      <ScannerExitSwipe onExit={onExit}>
        <Content />
      </ScannerExitSwipe>,
    );

    drag({ x: 180, y: 400 }, [
      { x: 240, y: 402 },
      { x: 300, y: 404 },
    ]);

    expect(onExit).not.toHaveBeenCalled();
  });

  // The tray's expand/collapse pan owns vertical drags.
  it('ignores a vertical drag that starts at the left edge', () => {
    const onExit = jest.fn();
    render(
      <ScannerExitSwipe onExit={onExit}>
        <Content />
      </ScannerExitSwipe>,
    );

    drag({ x: 8, y: 500 }, [
      { x: 12, y: 440 },
      { x: 14, y: 360 },
      { x: 10, y: 280 },
    ]);

    expect(onExit).not.toHaveBeenCalled();
  });

  it('ignores a diagonal drag dominated by vertical travel', () => {
    const onExit = jest.fn();
    render(
      <ScannerExitSwipe onExit={onExit}>
        <Content />
      </ScannerExitSwipe>,
    );

    drag({ x: 8, y: 500 }, [
      { x: 34, y: 460 },
      { x: 60, y: 380 },
    ]);

    expect(onExit).not.toHaveBeenCalled();
  });

  // Tray rows open leftward; that must never read as an exit.
  it('ignores a leftward drag from the left edge', () => {
    const onExit = jest.fn();
    render(
      <ScannerExitSwipe onExit={onExit}>
        <Content />
      </ScannerExitSwipe>,
    );

    drag({ x: 20, y: 400 }, [{ x: 2, y: 401 }]);

    expect(onExit).not.toHaveBeenCalled();
  });

  it('ignores a multi-touch gesture', () => {
    const onExit = jest.fn();
    render(
      <ScannerExitSwipe onExit={onExit}>
        <Content />
      </ScannerExitSwipe>,
    );

    drag({ x: 6, y: 400 }, [{ x: 90, y: 404 }], { activeTouches: 2 });

    expect(onExit).not.toHaveBeenCalled();
  });

  it('does nothing while disabled', () => {
    const onExit = jest.fn();
    render(
      <ScannerExitSwipe disabled onExit={onExit}>
        <Content />
      </ScannerExitSwipe>,
    );

    drag({ x: 6, y: 400 }, [{ x: 80, y: 404 }]);

    expect(onExit).not.toHaveBeenCalled();
  });

  it('renders its children', () => {
    render(
      <ScannerExitSwipe onExit={jest.fn()}>
        <Content />
      </ScannerExitSwipe>,
    );

    expect(screen.getByTestId('scanner-content')).toBeTruthy();
  });
});
