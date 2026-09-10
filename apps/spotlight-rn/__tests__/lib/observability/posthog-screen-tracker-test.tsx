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
    mockedPathname = '/social';
    mockCapturePostHogScreen.mockClear();
  });

  it('maps tracked routes to normalized screen names', async () => {
    // The feed is `/social` now. It reported as 'scan' while the tabs root
    // landed on the scanner, then as `/` while it was Home — read this series
    // by NAME, since the pathname behind it has moved twice.
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

  it('reports Collection as portfolio from all of its paths', async () => {
    // Collection is the tabs root; `/you` and `/portfolio` are redirects to it
    // that can still be observed in passing. All three must report the same
    // name or the series splits at the migration.
    mockedPathname = '/you';
    const view = render(<PostHogScreenTracker />);

    await waitFor(() => {
      expect(mockCapturePostHogScreen).toHaveBeenCalledWith('portfolio');
    });

    for (const path of ['/portfolio', '/']) {
      mockedPathname = path;
      view.rerender(<PostHogScreenTracker />);
      await waitFor(() => {
        expect(mockCapturePostHogScreen).toHaveBeenCalledTimes(1);
      });
    }
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
