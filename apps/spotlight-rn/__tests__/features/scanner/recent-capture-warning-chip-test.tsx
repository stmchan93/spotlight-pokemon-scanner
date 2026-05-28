import { act, fireEvent, render, screen } from '@testing-library/react-native';
import type { PropsWithChildren } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { SpotlightThemeProvider } from '@spotlight/design-system';

import { RecentCaptureWarningChip } from '@/features/scanner/screens/recent-capture-warning-chip';

const safeAreaMetrics = {
  frame: { height: 852, width: 393, x: 0, y: 0 },
  insets: { top: 59, right: 0, bottom: 34, left: 0 },
};

function Wrapper({ children }: PropsWithChildren) {
  return (
    <SafeAreaProvider initialMetrics={safeAreaMetrics}>
      <SpotlightThemeProvider>{children}</SpotlightThemeProvider>
    </SafeAreaProvider>
  );
}

function renderChip(
  overrides: Partial<Parameters<typeof RecentCaptureWarningChip>[0]> = {},
) {
  const props = {
    message: 'Looks like a Japanese card.',
    primaryActionLabel: 'Switch to JP & rescan',
    onPrimaryAction: jest.fn(),
    secondaryActionLabel: 'Keep result',
    onSecondaryAction: jest.fn(),
    onAutoDismiss: jest.fn(),
    testID: 'scanner-warning-language-cap-1',
    ...overrides,
  };
  render(<RecentCaptureWarningChip {...props} />, { wrapper: Wrapper });
  return props;
}

describe('RecentCaptureWarningChip', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('renders the message and both action labels', () => {
    renderChip();

    expect(screen.getByText('Looks like a Japanese card.')).toBeTruthy();
    expect(screen.getByText('Switch to JP & rescan')).toBeTruthy();
    expect(screen.getByText('Keep result')).toBeTruthy();
    expect(screen.getByTestId('scanner-warning-language-cap-1')).toBeTruthy();
  });

  it('tapping the primary action calls onPrimaryAction and cancels the auto-dismiss timer', () => {
    const props = renderChip();

    fireEvent.press(screen.getByTestId('scanner-warning-language-cap-1-primary'));
    expect(props.onPrimaryAction).toHaveBeenCalledTimes(1);

    // Advance well past the default 10s auto-dismiss window.
    act(() => {
      jest.advanceTimersByTime(15000);
    });
    expect(props.onAutoDismiss).not.toHaveBeenCalled();
  });

  it('tapping the secondary action calls onSecondaryAction and cancels the auto-dismiss timer', () => {
    const props = renderChip();

    fireEvent.press(screen.getByTestId('scanner-warning-language-cap-1-secondary'));
    expect(props.onSecondaryAction).toHaveBeenCalledTimes(1);

    act(() => {
      jest.advanceTimersByTime(15000);
    });
    expect(props.onAutoDismiss).not.toHaveBeenCalled();
  });

  it('fires onAutoDismiss after autoDismissMs when the user does not tap', () => {
    const props = renderChip({ autoDismissMs: 5000 });

    expect(props.onAutoDismiss).not.toHaveBeenCalled();

    act(() => {
      jest.advanceTimersByTime(4999);
    });
    expect(props.onAutoDismiss).not.toHaveBeenCalled();

    act(() => {
      jest.advanceTimersByTime(1);
    });
    expect(props.onAutoDismiss).toHaveBeenCalledTimes(1);
  });

  it('defaults autoDismissMs to 10000 when not provided', () => {
    const props = renderChip();

    act(() => {
      jest.advanceTimersByTime(9999);
    });
    expect(props.onAutoDismiss).not.toHaveBeenCalled();

    act(() => {
      jest.advanceTimersByTime(1);
    });
    expect(props.onAutoDismiss).toHaveBeenCalledTimes(1);
  });

  it('passing null for autoDismissMs disables the timer entirely', () => {
    const props = renderChip({ autoDismissMs: null });

    act(() => {
      jest.advanceTimersByTime(60_000);
    });
    expect(props.onAutoDismiss).not.toHaveBeenCalled();
  });
});
