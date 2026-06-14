import { AccessibilityInfo } from 'react-native';
import { act, render, screen, waitFor } from '@testing-library/react-native';

import { EkalightIntroScreen } from '@/features/auth/components/ekalight-intro-screen';

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
