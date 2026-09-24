import { Share } from 'react-native';
import { fireEvent, screen, waitFor } from '@testing-library/react-native';

import type { SetSpotlight, SetSpotlightQuery } from '@spotlight/api-client';
import { SetSpotlightScreen } from '@/features/meta-feed/screens/set-spotlight-screen';

import { mockSetSpotlight } from '../mock-api-client';
import { createTestSpotlightRepository, renderWithProviders } from '../test-utils';

const mockOpenBrowserAsync = jest.fn(async () => ({ type: 'opened' }));

jest.mock('expo-web-browser', () => ({
  maybeCompleteAuthSession: jest.fn(),
  openAuthSessionAsync: jest.fn(async () => ({ type: 'cancel' })),
  openBrowserAsync: (...args: unknown[]) => mockOpenBrowserAsync(...(args as [])),
}));

jest.mock('@/providers/auth-provider', () => ({
  ...jest.requireActual('@/providers/auth-provider'),
  useAuth: () => ({ accessToken: null }),
}));

function renderSet(fetchSetSpotlight: (query?: SetSpotlightQuery) => Promise<SetSpotlight | null>, setId = 'cel25') {
  const onBack = jest.fn();
  const onOpenCard = jest.fn();
  renderWithProviders(<SetSpotlightScreen onBack={onBack} onOpenCard={onOpenCard} setId={setId} />, {
    spotlightRepository: createTestSpotlightRepository({ fetchSetSpotlight }),
  });
  return { onBack, onOpenCard };
}

describe('SetSpotlightScreen', () => {
  beforeEach(() => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockOpenBrowserAsync.mockClear();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('shows a skeleton while loading', () => {
    renderSet(() => new Promise(() => {}));
    expect(screen.getByTestId('set-spotlight-loading')).toBeTruthy();
    // No share until there is something to share.
    expect(screen.queryByTestId('set-spotlight-share')).toBeNull();
  });

  it('reads the requested set and renders header, stats, top 10, callout and videos', async () => {
    const fetchSetSpotlight = jest.fn(async () => mockSetSpotlight);
    const { onOpenCard } = renderSet(fetchSetSpotlight);

    expect(await screen.findByTestId('set-spotlight-name')).toBeTruthy();
    expect(fetchSetSpotlight).toHaveBeenCalledWith({ setId: 'cel25' });
    expect(screen.getByText('Celebrations')).toBeTruthy();
    expect(screen.getByText('25th anniversary · Oct 2021 · 50 cards')).toBeTruthy();
    // Code tile stands in for the missing logo.
    expect(screen.getByText('CEL')).toBeTruthy();
    expect(screen.getByText('$1,284')).toBeTruthy();
    expect(screen.getByText('+5.2%')).toBeTruthy();
    expect(screen.getByText('142')).toBeTruthy();

    expect(screen.getByTestId('set-top-card-cel25c-4_A')).toBeTruthy();
    fireEvent.press(screen.getByTestId('set-top-card-cel25c-17_A'));
    expect(onOpenCard).toHaveBeenCalledWith('cel25c-17_A');

    fireEvent.press(screen.getByTestId('set-callout-card'));
    expect(onOpenCard).toHaveBeenLastCalledWith('cel25c-17_A');

    const [firstVideo] = mockSetSpotlight.videos;
    fireEvent.press(screen.getByTestId(`set-video-${firstVideo.id}`));
    await waitFor(() => expect(mockOpenBrowserAsync).toHaveBeenCalledWith(firstVideo.url));

    // Empty news list → no section.
    expect(screen.queryByTestId('set-news')).toBeNull();
  });

  it('switches the top 10 between price, movers and PSA 10', async () => {
    renderSet(async () => mockSetSpotlight);
    await screen.findByTestId('set-top-tabs');

    fireEvent.press(screen.getByTestId('set-top-tabs-psa10'));
    // Tab label + the graded row's lane tag.
    expect(screen.getAllByText('PSA 10', { exact: true })).toHaveLength(2);
    expect(screen.getByText('$1,240.00')).toBeTruthy();
    expect(screen.queryByTestId('set-top-card-cel25c-17_A')).toBeNull();

    fireEvent.press(screen.getByTestId('set-top-tabs-movers'));
    expect(screen.getByTestId('set-top-card-cel25c-17_A')).toBeTruthy();
  });

  it('shares the set', async () => {
    const shareSpy = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' });
    renderSet(async () => mockSetSpotlight);
    fireEvent.press(await screen.findByTestId('set-spotlight-share'));
    expect(shareSpy).toHaveBeenCalledWith({ message: expect.stringContaining('Celebrations on Ekalight') });
  });

  it('hides every section that has nothing to show', async () => {
    renderSet(async () => ({
      ...mockSetSpotlight,
      callout: null,
      news: [],
      topByPrice: [],
      topMovers: [],
      topPsa10: [],
      videos: [],
    }));
    expect(await screen.findByTestId('set-spotlight-name')).toBeTruthy();
    expect(screen.queryByTestId('set-top')).toBeNull();
    expect(screen.queryByTestId('set-callout')).toBeNull();
    expect(screen.queryByTestId('set-videos')).toBeNull();
    expect(screen.queryByTestId('set-news')).toBeNull();
  });

  it('renders tagged news rows when present', async () => {
    const [video] = mockSetSpotlight.videos;
    renderSet(async () => ({
      ...mockSetSpotlight,
      news: [{ ...video, id: 'n1', kind: 'news', title: 'Celebrations reprint announced', video: null }],
    }));
    expect(await screen.findByText('Celebrations reprint announced')).toBeTruthy();
    fireEvent.press(screen.getByTestId('set-news-n1'));
    await waitFor(() => expect(mockOpenBrowserAsync).toHaveBeenCalledWith(video.url));
  });

  it('shows a retryable error', async () => {
    const fetchSetSpotlight = jest
      .fn<Promise<SetSpotlight | null>, [SetSpotlightQuery?]>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(mockSetSpotlight);
    renderSet(fetchSetSpotlight);
    fireEvent.press(await screen.findByTestId('set-spotlight-retry'));
    expect(await screen.findByTestId('set-spotlight-name')).toBeTruthy();
  });

  it('says coming soon when the feature flag is off', async () => {
    renderSet(async () => null);
    expect(await screen.findByTestId('set-spotlight-disabled')).toBeTruthy();
  });
});
