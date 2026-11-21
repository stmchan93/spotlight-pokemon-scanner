import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { ScrollView, Text } from 'react-native';
import { GestureDetector, State } from 'react-native-gesture-handler';
import { fireGestureHandler, getByGestureTestId } from 'react-native-gesture-handler/jest-utils';

import {
  PullDownToDismiss,
  usePullDownToDismiss,
  type UsePullDownToDismissOptions,
} from '@/components/pull-down-to-dismiss';

function Harness(props: UsePullDownToDismissOptions) {
  const pullDown = usePullDownToDismiss(props);
  return (
    <PullDownToDismiss controller={pullDown} testID="pull-down-root">
      <GestureDetector gesture={pullDown.scrollGesture}>
        <ScrollView {...pullDown.scrollProps} testID="pull-down-scroll">
          <Text>Body</Text>
        </ScrollView>
      </GestureDetector>
    </PullDownToDismiss>
  );
}

function pull(translationY: number, velocityY: number) {
  fireGestureHandler(getByGestureTestId('pull-down-to-dismiss'), [
    { state: State.BEGAN, translationY: 0, velocityY: 0 },
    { state: State.ACTIVE, translationY: translationY / 2, velocityY },
    { state: State.ACTIVE, translationY, velocityY },
    { state: State.END, translationY, velocityY },
  ]);
}

const scrollEvent = (y: number) => ({ nativeEvent: { contentOffset: { x: 0, y }, velocity: { x: 0, y: 0 } } });

describe('PullDownToDismiss', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('renders its children', () => {
    render(<Harness onDismiss={jest.fn()} />);
    expect(screen.getByTestId('pull-down-root')).toBeTruthy();
    expect(screen.getByText('Body')).toBeTruthy();
  });

  it('calls onDismiss once a pull passes the threshold', () => {
    const onDismiss = jest.fn();
    render(<Harness onDismiss={onDismiss} />);
    pull(160, 0);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('does not dismiss a short, slow pull', () => {
    const onDismiss = jest.fn();
    render(<Harness onDismiss={onDismiss} />);
    pull(60, 100);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('turns off top bounce only while resting at the top', () => {
    render(<Harness onDismiss={jest.fn()} />);
    const scroll = () => screen.getByTestId('pull-down-scroll');
    expect(scroll().props.bounces).toBe(false);

    fireEvent.scroll(scroll(), scrollEvent(200));
    expect(scroll().props.bounces).toBeUndefined();

    fireEvent(scroll(), 'momentumScrollEnd', scrollEvent(0));
    expect(scroll().props.bounces).toBe(false);
  });

  it('leaves scroll bounce alone when disabled', () => {
    render(<Harness enabled={false} onDismiss={jest.fn()} />);
    expect(screen.getByTestId('pull-down-scroll').props.bounces).toBeUndefined();
  });

  it('survives the dismiss fallback timer', () => {
    render(<Harness onDismiss={jest.fn()} />);
    pull(200, 0);
    act(() => {
      jest.advanceTimersByTime(1500);
    });
    expect(screen.getByTestId('pull-down-root')).toBeTruthy();
  });
});
