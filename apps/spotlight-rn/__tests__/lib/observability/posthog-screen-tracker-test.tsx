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
    const view = render(<PostHogScreenTracker />);

    await waitFor(() => {
      expect(mockCapturePostHogScreen).toHaveBeenCalledWith('scan');
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

    mockedPathname = '/sell/batch/review';
    view.rerender(<PostHogScreenTracker />);
    await waitFor(() => {
      expect(mockCapturePostHogScreen).toHaveBeenNthCalledWith(4, 'sell_batch');
    });
  });

  it('deduplicates repeated screen names and skips untracked routes', async () => {
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
