import { NavigationContext } from '@react-navigation/native';
import { act, render, screen } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import { Text, View, type GestureResponderEvent } from 'react-native';

import { PageSwipeGuard } from '@/components/page-tab-pager';
import { TabSwipeChain, useTabLanding } from '@/components/tab-swipe-chain';
import {
  consumeTabLanding,
  requestTabLanding,
  resetTabLandingsForTests,
  type ChainTab,
  type InnerPagePosition,
} from '@/lib/tab-swipe-chain';

let mockIsGuest = false;
jest.mock('@/providers/auth-provider', () => ({
  useAuth: () => ({ isGuest: mockIsGuest }),
}));

const mockCapture = jest.fn();
jest.mock('@/lib/observability/posthog', () => ({
  capturePostHogEvent: (...args: unknown[]) => mockCapture(...args),
}));

type TouchPoint = { x: number; y: number };

// Same faithful touch-bank replay as drawer-edge-swipe-test.
function makeMoveEvent(from: TouchPoint, to: TouchPoint, timeStamp: number, dt = 16) {
  return {
    nativeEvent: { pageX: to.x, pageY: to.y, touches: [{}] },
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
          previousTimeStamp: timeStamp - dt,
        },
      ],
    },
  } as unknown as GestureResponderEvent;
}

function makeStartEvent(point: TouchPoint) {
  return {
    nativeEvent: { pageX: point.x, pageY: point.y, touches: [{}] },
    touchHistory: { indexOfSingleActiveTouch: 0, mostRecentTimeStamp: 0, numberActiveTouches: 1, touchBank: [] },
  } as unknown as GestureResponderEvent;
}

type Handlers = {
  onStartShouldSetResponderCapture: (event: GestureResponderEvent) => boolean;
  onMoveShouldSetResponderCapture: (event: GestureResponderEvent) => boolean;
  onMoveShouldSetResponder: (event: GestureResponderEvent) => boolean;
  onResponderRelease: (event: GestureResponderEvent) => void;
};

/** One finger: down, moves (both phases), up. Returns whether it was ever claimed. */
function swipe(start: TouchPoint, points: TouchPoint[], { dt = 16, guardTestID }: { dt?: number; guardTestID?: string } = {}) {
  const handlers = screen.getByTestId('chain').props as Handlers;
  let claimed = false;
  act(() => {
    handlers.onStartShouldSetResponderCapture(makeStartEvent(start));
    if (guardTestID) {
      // Capture runs root → target, so a guard below the chain fires after it.
      (screen.getByTestId(guardTestID).props as Handlers).onStartShouldSetResponderCapture(makeStartEvent(start));
    }
  });
  let previous = start;
  let last = makeStartEvent(start);
  points.forEach((point, index) => {
    const event = makeMoveEvent(previous, point, (index + 1) * dt, dt);
    act(() => {
      claimed = handlers.onMoveShouldSetResponderCapture(event) || claimed;
      claimed = handlers.onMoveShouldSetResponder(event) || claimed;
    });
    previous = point;
    last = event;
  });
  act(() => {
    handlers.onResponderRelease(last);
  });
  return claimed;
}

const LEFT_SWIPE = [{ x: 280, y: 402 }, { x: 160, y: 404 }];
const RIGHT_SWIPE = [{ x: 120, y: 402 }, { x: 260, y: 404 }];

function setup({
  disabled,
  inner,
  shouldStandDown,
  tab,
  children,
  focused = true,
}: {
  children?: ReactNode;
  disabled?: boolean;
  focused?: boolean;
  inner?: InnerPagePosition;
  shouldStandDown?: () => boolean;
  tab: ChainTab;
}) {
  const navigation = { isFocused: jest.fn(() => focused), navigate: jest.fn() };
  render(
    <NavigationContext.Provider value={navigation as never}>
      <TabSwipeChain disabled={disabled} inner={inner} shouldStandDown={shouldStandDown} tab={tab} testID="chain">
        {children ?? <View />}
      </TabSwipeChain>
    </NavigationContext.Provider>,
  );
  return navigation;
}

describe('TabSwipeChain', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockIsGuest = false;
    mockCapture.mockClear();
    resetTabLandingsForTests();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('Watchlist: a right-to-left swipe switches to Scan and logs it', () => {
    const navigation = setup({ tab: 'wishlist' });
    expect(swipe({ x: 320, y: 400 }, LEFT_SWIPE)).toBe(true);
    expect(navigation.navigate).toHaveBeenCalledWith('scan');
    expect(mockCapture).toHaveBeenCalledWith('tab_swipe_navigated', {
      direction: 'next',
      from_tab: 'wishlist',
      to_tab: 'scan',
    });
  });

  it('Watchlist: a left-to-right swipe goes back to Home and asks it to land on Activity', () => {
    const navigation = setup({ tab: 'wishlist' });
    swipe({ x: 80, y: 400 }, RIGHT_SWIPE);
    expect(navigation.navigate).toHaveBeenCalledWith('index');
    expect(consumeTabLanding('index')).toBe('last');
  });

  it('Home/Collection leaves both directions alone (inner pager / start of chain)', () => {
    const navigation = setup({ inner: { count: 2, index: 0 }, tab: 'index' });
    expect(swipe({ x: 320, y: 400 }, LEFT_SWIPE)).toBe(false);
    expect(swipe({ x: 80, y: 400 }, RIGHT_SWIPE)).toBe(false);
    expect(navigation.navigate).not.toHaveBeenCalled();
  });

  it('Home/Activity: forward goes to Watchlist, back is left to the inner pager', () => {
    const navigation = setup({ inner: { count: 2, index: 1 }, tab: 'index' });
    expect(swipe({ x: 80, y: 400 }, RIGHT_SWIPE)).toBe(false);
    expect(swipe({ x: 320, y: 400 }, LEFT_SWIPE)).toBe(true);
    expect(navigation.navigate).toHaveBeenCalledTimes(1);
    expect(navigation.navigate).toHaveBeenCalledWith('wishlist');
  });

  it('Social: past the last inner page does nothing; back from the first goes to Events', () => {
    const last = setup({ inner: { count: 3, index: 2 }, tab: 'social' });
    expect(swipe({ x: 320, y: 400 }, LEFT_SWIPE)).toBe(false);
    expect(last.navigate).not.toHaveBeenCalled();
  });

  it('Social first page → Events', () => {
    const navigation = setup({ inner: { count: 3, index: 0 }, tab: 'social' });
    swipe({ x: 80, y: 400 }, RIGHT_SWIPE);
    expect(navigation.navigate).toHaveBeenCalledWith('events');
  });

  it('never claims a vertical scroll', () => {
    const navigation = setup({ tab: 'events' });
    expect(swipe({ x: 200, y: 400 }, [{ x: 196, y: 380 }, { x: 170, y: 300 }])).toBe(false);
    expect(navigation.navigate).not.toHaveBeenCalled();
  });

  it('leaves the left-edge drawer band alone', () => {
    const navigation = setup({ tab: 'wishlist' });
    expect(swipe({ x: 10, y: 400 }, [{ x: 60, y: 402 }, { x: 200, y: 404 }])).toBe(false);
    expect(navigation.navigate).not.toHaveBeenCalled();
  });

  it('stands down when disabled', () => {
    const disabled = setup({ disabled: true, tab: 'wishlist' });
    expect(swipe({ x: 320, y: 400 }, LEFT_SWIPE)).toBe(false);
    expect(disabled.navigate).not.toHaveBeenCalled();
  });

  it('stands down while shouldStandDown is true', () => {
    const navigation = setup({ shouldStandDown: () => true, tab: 'wishlist' });
    expect(swipe({ x: 320, y: 400 }, LEFT_SWIPE)).toBe(false);
    expect(navigation.navigate).not.toHaveBeenCalled();
  });

  it('stands down for guests', () => {
    mockIsGuest = true;
    const navigation = setup({ tab: 'scan' });
    expect(swipe({ x: 320, y: 400 }, LEFT_SWIPE)).toBe(false);
    expect(navigation.navigate).not.toHaveBeenCalled();
  });

  it('yields to a PageSwipeGuard-ed horizontal scroller', () => {
    const navigation = setup({
      children: (
        <PageSwipeGuard testID="chips">
          <View />
        </PageSwipeGuard>
      ),
      tab: 'events',
    });
    expect(swipe({ x: 320, y: 400 }, LEFT_SWIPE, { guardTestID: 'chips' })).toBe(false);
    expect(navigation.navigate).not.toHaveBeenCalled();
  });

  it('does not switch on a short, slow drag', () => {
    const navigation = setup({ tab: 'wishlist' });
    // 30pt in 300ms: claimed (it is horizontal) but under both commit thresholds.
    expect(swipe({ x: 320, y: 400 }, [{ x: 305, y: 401 }, { x: 290, y: 401 }], { dt: 150 })).toBe(true);
    expect(navigation.navigate).not.toHaveBeenCalled();
  });

  it('does nothing from an unfocused tab', () => {
    const navigation = setup({ focused: false, tab: 'wishlist' });
    swipe({ x: 320, y: 400 }, LEFT_SWIPE);
    expect(navigation.navigate).not.toHaveBeenCalled();
  });

  it('retries a dropped switch only while the source tab stays focused', () => {
    const navigation = setup({ tab: 'scan' });
    swipe({ x: 320, y: 400 }, LEFT_SWIPE);
    expect(navigation.navigate).toHaveBeenCalledTimes(1);
    act(() => {
      jest.advanceTimersByTime(350);
    });
    expect(navigation.navigate).toHaveBeenCalledTimes(2);
    navigation.isFocused.mockReturnValue(false);
    act(() => {
      jest.advanceTimersByTime(2000);
    });
    expect(navigation.navigate).toHaveBeenCalledTimes(2);
  });

  it('is inert outside a navigator', () => {
    render(
      <TabSwipeChain tab="wishlist" testID="chain">
        <View />
      </TabSwipeChain>,
    );
    expect(() => swipe({ x: 320, y: 400 }, LEFT_SWIPE)).not.toThrow();
    expect(mockCapture).not.toHaveBeenCalled();
  });
});

describe('useTabLanding', () => {
  beforeEach(() => resetTabLandingsForTests());

  function Probe({ onLand, tab }: { onLand: (edge: string) => void; tab: ChainTab }) {
    useTabLanding(tab, onLand);
    return <Text>probe</Text>;
  }

  it('applies a landing requested while mounted, only for its own tab', () => {
    const onLand = jest.fn();
    render(<Probe onLand={onLand} tab="index" />);
    act(() => requestTabLanding('social', 'first'));
    expect(onLand).not.toHaveBeenCalled();
    act(() => requestTabLanding('index', 'last'));
    expect(onLand).toHaveBeenCalledWith('last');
    expect(consumeTabLanding('index')).toBeNull();
  });

  it('applies a landing requested before mount (MountOnFirstFocus tabs)', () => {
    requestTabLanding('social', 'first');
    const onLand = jest.fn();
    render(<Probe onLand={onLand} tab="social" />);
    expect(onLand).toHaveBeenCalledWith('first');
  });
});
