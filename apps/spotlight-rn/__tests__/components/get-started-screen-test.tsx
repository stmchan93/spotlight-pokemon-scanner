import { fireEvent, render, screen } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { SpotlightThemeProvider } from '@spotlight/design-system';

import { GetStartedScreen } from '@/features/auth/components/get-started-screen';

const safeAreaMetrics = {
  frame: { height: 852, width: 393, x: 0, y: 0 },
  insets: { top: 59, right: 0, bottom: 34, left: 0 },
};

function renderScreen(overrides: Partial<React.ComponentProps<typeof GetStartedScreen>> = {}) {
  const props: React.ComponentProps<typeof GetStartedScreen> = {
    onGetStarted: jest.fn(),
    ...overrides,
  };

  render(
    <SafeAreaProvider initialMetrics={safeAreaMetrics}>
      <SpotlightThemeProvider>
        <GetStartedScreen {...props} />
      </SpotlightThemeProvider>
    </SafeAreaProvider>,
  );

  return props;
}

describe('GetStartedScreen', () => {
  it('renders the screen and the Get started button', () => {
    renderScreen();

    expect(screen.getByTestId('auth-get-started-screen')).toBeTruthy();
    expect(screen.getByTestId('auth-get-started-button')).toBeTruthy();
    expect(screen.getByText('Get started')).toBeTruthy();
  });

  it('calls onGetStarted when the button is pressed', () => {
    const props = renderScreen();

    fireEvent.press(screen.getByTestId('auth-get-started-button'));
    expect(props.onGetStarted).toHaveBeenCalledTimes(1);
  });
});
