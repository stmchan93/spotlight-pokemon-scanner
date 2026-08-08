import { render, waitFor } from '@testing-library/react-native';

import { PostHogScreenTracker } from '@/lib/observability/posthog-screen-tracker';

const mockCapturePostHogScreen = jest.fn();
let mockedPathname = '/';

jest.mock('expo-router', () => ({
  usePathname: () => mockedPathname,
}));

jest.mock('@/lib/observability/posthog', () => ({
  capturePostHogScreen: (...args: unknown[]) => mockCapturePostHogScreen(...args),
}));

describe('PostHogScreenTracker', () => {
  beforeEach(() => {
    mockedPathname = '/';
    mockCapturePostHogScreen.mockClear();
  });

  it('maps tracked routes to normalized screen names', async () => {
    // `/` is the Home FEED now. It reported as 'scan' for as long as the tabs
    // root landed on the scanner; keeping that would have counted every app
    // open as a scanner view.
    const view = render(<PostHogScreenTracker />);

    await waitFor(() => {
      expect(mockCapturePostHogScreen).toHaveBeenCalledWith('feed');
    });

    mockedPathname = '/account/import';
    view.rerender(<PostHogScreenTracker />);
    await waitFor(() => {
      expect(mockCapturePostHogScreen).toHaveBeenNthCalledWith(2, 'portfolio_import');
    });

    mockedPathname = '/cards/base1-4/scan-review';
    view.rerender(<PostHogScreenTracker />);
    await waitFor(() => {
      expect(mockCapturePostHogScreen).toHaveBeenNthCalledWith(3, 'scan_review');
    });
  });

  it('reports Collection as portfolio from both of its paths', async () => {
    // Collection moved to `/you`; `/portfolio` is a redirect to it that can
    // still be observed in passing. Both must report the same name or the
    // series splits in two at the migration.
    mockedPathname = '/you';
    const view = render(<PostHogScreenTracker />);

    await waitFor(() => {
      expect(mockCapturePostHogScreen).toHaveBeenCalledWith('portfolio');
    });

    mockedPathname = '/portfolio';
    view.rerender(<PostHogScreenTracker />);
    await waitFor(() => {
      expect(mockCapturePostHogScreen).toHaveBeenCalledTimes(1);
    });
  });

  it('deduplicates repeated screen names and skips untracked routes', async () => {
    mockedPathname = '/scan';
    const view = render(<PostHogScreenTracker />);

    await waitFor(() => {
      expect(mockCapturePostHogScreen).toHaveBeenCalledTimes(1);
    });

    mockedPathname = '/scan/live';
    view.rerender(<PostHogScreenTracker />);
    await waitFor(() => {
      expect(mockCapturePostHogScreen).toHaveBeenCalledTimes(1);
    });

    mockedPathname = '/cards/base1-4';
    view.rerender(<PostHogScreenTracker />);
    await waitFor(() => {
      expect(mockCapturePostHogScreen).toHaveBeenNthCalledWith(2, 'card_detail');
    });

    mockedPathname = '/cards/base2-8';
    view.rerender(<PostHogScreenTracker />);
    await waitFor(() => {
      expect(mockCapturePostHogScreen).toHaveBeenCalledTimes(2);
    });

    mockedPathname = '/settings';
    view.rerender(<PostHogScreenTracker />);
    await waitFor(() => {
      expect(mockCapturePostHogScreen).toHaveBeenCalledTimes(2);
    });
  });
});
