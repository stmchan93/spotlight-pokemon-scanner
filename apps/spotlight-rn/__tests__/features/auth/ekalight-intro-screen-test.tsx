import { AccessibilityInfo } from 'react-native';
import { act, render, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { SpotlightThemeProvider } from '@spotlight/design-system';

import { AuthGate } from '@/features/auth/components/auth-gate';
import { EkalightIntroScreen } from '@/features/auth/components/ekalight-intro-screen';

const safeAreaMetrics = {
  frame: { height: 852, width: 393, x: 0, y: 0 },
  insets: { top: 59, right: 0, bottom: 34, left: 0 },
};

describe('EkalightIntroScreen', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('mounts without throwing and renders the wordmark', async () => {
    render(<EkalightIntroScreen onDone={jest.fn()} word="Ekalight" />);

    // The intro resolves the reduced-motion flag on the next microtask before
    // showing the wordmark/filmstrip.
    await waitFor(() => {
      expect(screen.getByTestId('ekalight-intro-filmstrip')).toBeTruthy();
    });
    expect(screen.getAllByText('EKALIGHT').length).toBeGreaterThan(0);
  });

  it('reaches onDone deterministically when motion plays', async () => {
    jest
      .spyOn(AccessibilityInfo, 'isReduceMotionEnabled')
      .mockResolvedValue(false);
    // Fake timers so the safety-net setTimeout never leaks past the test even
    // when the animation completion callback also resolves onDone.
    jest.useFakeTimers();
    const onDone = jest.fn();

    render(<EkalightIntroScreen onDone={onDone} />);

    // Before the reduced-motion flag resolves, onDone has not been called.
    expect(onDone).not.toHaveBeenCalled();

    // Flush the reduced-motion promise so the animation effect runs. Under the
    // reanimated jest mock the timing callbacks resolve synchronously; the
    // safety timer below guarantees onDone regardless.
    await act(async () => {
      await Promise.resolve();
    });
    act(() => {
      jest.advanceTimersByTime(2000);
    });

    expect(onDone).toHaveBeenCalled();
  });

  it('skips the filmstrip and calls onDone quickly when reduced motion is on', async () => {
    jest
      .spyOn(AccessibilityInfo, 'isReduceMotionEnabled')
      .mockResolvedValue(true);
    jest.useFakeTimers();
    const onDone = jest.fn();

    render(<EkalightIntroScreen onDone={onDone} />);

    await act(async () => {
      await Promise.resolve();
    });

    act(() => {
      jest.advanceTimersByTime(100);
    });

    expect(onDone).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('ekalight-intro-filmstrip')).toBeNull();
  });
});

describe('AuthGate signed-out intro', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('plays the intro first, then resolves to the sign-in screen', async () => {
    jest
      .spyOn(AccessibilityInfo, 'isReduceMotionEnabled')
      .mockResolvedValue(false);
    jest.useFakeTimers();

    render(
      <SafeAreaProvider initialMetrics={safeAreaMetrics}>
        <SpotlightThemeProvider>
          <AuthGate
            appleSignInAvailable
            authenticatedContent={null}
            configurationIssue={null}
            currentUser={null}
            errorMessage={null}
            isBusy={false}
            isConfigured
            onAppleSignIn={jest.fn()}
            onChangeProfileDraftName={jest.fn()}
            onGoogleSignIn={jest.fn()}
            onSubmitProfile={jest.fn()}
            profileDraftName=""
            state="signedOut"
          />
        </SpotlightThemeProvider>
      </SafeAreaProvider>,
    );

    // Before the intro resolves, the intro screen is mounted and the sign-in
    // screen is not.
    expect(screen.getByTestId('ekalight-intro-screen')).toBeTruthy();
    expect(screen.queryByText('Sign into Ekalight')).toBeNull();

    // Drive the intro to completion (reduced-motion flag flush + timers).
    await act(async () => {
      await Promise.resolve();
    });
    act(() => {
      jest.advanceTimersByTime(2000);
    });

    // Once the intro calls onDone, the flow resolves to the sign-in screen.
    await waitFor(() => {
      expect(screen.getByText('Sign into Ekalight')).toBeTruthy();
    });
    expect(screen.queryByTestId('ekalight-intro-filmstrip')).toBeNull();
  });
});
