import { act, fireEvent, render, screen } from '@testing-library/react-native';

import { SpotlightThemeProvider, Toast } from '@spotlight/design-system';

function renderToast(node: React.ReactElement) {
  return render(<SpotlightThemeProvider>{node}</SpotlightThemeProvider>);
}

describe('Toast', () => {
  it('renders the message when visible', () => {
    renderToast(
      <Toast visible message="Looks like a Japanese card" onDismiss={jest.fn()} testID="toast" />,
    );
    expect(screen.getByTestId('toast')).toBeTruthy();
    expect(screen.getByText('Looks like a Japanese card')).toBeTruthy();
  });

  it('renders nothing when not visible from the start', () => {
    renderToast(<Toast visible={false} message="hidden" onDismiss={jest.fn()} testID="toast" />);
    expect(screen.queryByTestId('toast')).toBeNull();
  });

  it('fires onPress when the body is tapped (the primary action)', () => {
    const onPress = jest.fn();
    renderToast(
      <Toast visible message="tap me" onPress={onPress} onDismiss={jest.fn()} testID="toast" />,
    );
    fireEvent.press(screen.getByTestId('toast'));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('fires onDismiss when the × is tapped', () => {
    const onDismiss = jest.fn();
    renderToast(<Toast visible message="dismiss me" onDismiss={onDismiss} testID="toast" />);
    fireEvent.press(screen.getByTestId('toast-dismiss'));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('auto-dismisses after durationMs', () => {
    jest.useFakeTimers();
    try {
      const onDismiss = jest.fn();
      renderToast(
        <Toast visible message="auto" onDismiss={onDismiss} durationMs={6000} testID="toast" />,
      );
      expect(onDismiss).not.toHaveBeenCalled();
      act(() => {
        jest.advanceTimersByTime(6000);
      });
      expect(onDismiss).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not auto-dismiss when durationMs is 0', () => {
    jest.useFakeTimers();
    try {
      const onDismiss = jest.fn();
      renderToast(
        <Toast visible message="sticky" onDismiss={onDismiss} durationMs={0} testID="toast" />,
      );
      act(() => {
        jest.advanceTimersByTime(60000);
      });
      expect(onDismiss).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });
});
