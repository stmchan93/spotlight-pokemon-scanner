import { fireEvent, render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';

import { AppErrorBoundary } from '@/lib/observability/app-error-boundary';
import { capturePostHogException } from '@/lib/observability/posthog';

jest.mock('@/lib/observability/posthog', () => ({
  __esModule: true,
  capturePostHogException: jest.fn(),
}));

const mockCapturePostHogException = capturePostHogException as jest.Mock;

// Throws on the first render, then renders fine — lets us exercise the reload
// recovery path (press Reload → child re-renders without throwing).
let shouldThrow = true;
function MaybeBoom() {
  if (shouldThrow) {
    throw new Error('boom');
  }
  return <Text testID="recovered-child">recovered</Text>;
}

describe('AppErrorBoundary', () => {
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    mockCapturePostHogException.mockClear();
    shouldThrow = true;
    // React logs caught render errors to console.error; silence it for the suite.
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it('renders children when there is no error', () => {
    shouldThrow = false;
    render(
      <AppErrorBoundary>
        <Text testID="happy-child">ok</Text>
      </AppErrorBoundary>,
    );

    expect(screen.getByTestId('happy-child')).toBeTruthy();
    expect(mockCapturePostHogException).not.toHaveBeenCalled();
  });

  it('shows the recovery screen and reports the error to PostHog when a child throws', () => {
    render(
      <AppErrorBoundary>
        <MaybeBoom />
      </AppErrorBoundary>,
    );

    expect(screen.getByText('Something went wrong')).toBeTruthy();
    expect(screen.getByTestId('app-error-boundary-reload')).toBeTruthy();

    expect(mockCapturePostHogException).toHaveBeenCalledTimes(1);
    const [error, props] = mockCapturePostHogException.mock.calls[0];
    expect((error as Error).message).toBe('boom');
    expect(props).toMatchObject({ source: 'error_boundary' });
  });

  it('remounts the tree when Reload is pressed (recovers a transient failure)', () => {
    render(
      <AppErrorBoundary>
        <MaybeBoom />
      </AppErrorBoundary>,
    );

    // The next render won't throw; pressing Reload should clear the fallback.
    shouldThrow = false;
    fireEvent.press(screen.getByTestId('app-error-boundary-reload'));

    expect(screen.getByTestId('recovered-child')).toBeTruthy();
    expect(screen.queryByText('Something went wrong')).toBeNull();
  });
});
