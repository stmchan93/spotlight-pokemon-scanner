import { fireEvent, screen, waitFor } from '@testing-library/react-native';

import type { CollapsiblePageProps } from '@/components/page-tab-pager';
import { buildDevMarketAnalytics, buildDevMarketHeatmapSet } from '@/dev/dev-market-analytics';
import { MarketAnalyticsPage } from '@/features/market/screens/market-analytics-page';
import { clearMarketAnalyticsCache } from '@/features/market/use-market-analytics';

import { createTestSpotlightRepository, renderWithProviders } from '../../test-utils';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  useFocusEffect: (callback: () => void) => {
    require('react').useEffect(callback, [callback]);
  },
  useRouter: () => ({ push: mockPush, navigate: jest.fn(), back: jest.fn() }),
}));

let mockIsGuest = false;
jest.mock('@/providers/auth-provider', () => {
  const actual = jest.requireActual('@/providers/auth-provider');
  return {
    ...actual,
    useAuth: () => ({ ...actual.useAuth(), isGuest: mockIsGuest }),
  };
});

const page: CollapsiblePageProps = {
  contentContainerStyle: { minHeight: 800, paddingTop: 100 },
  onScroll: () => {},
  progressViewOffset: 100,
  scrollEventThrottle: 16,
  scrollToOverflowEnabled: true,
};

const ID = 'market-analytics-page';

function renderPage(overrides: Parameters<typeof createTestSpotlightRepository>[0] = {}) {
  const getMarketAnalytics = jest.fn(async ({ game, window }) => buildDevMarketAnalytics(game, window));
  const getMarketHeatmapSet = jest.fn(async ({ game, setId, window }) => buildDevMarketHeatmapSet(game, setId, window));
  const spotlightRepository = createTestSpotlightRepository({
    getMarketAnalytics,
    getMarketHeatmapSet,
    fetchCalendar: async () => ({ items: [] }),
    ...overrides,
  });
  renderWithProviders(<MarketAnalyticsPage page={page} />, { spotlightRepository });
  return { getMarketAnalytics, getMarketHeatmapSet };
}

beforeEach(() => {
  clearMarketAnalyticsCache();
  mockPush.mockClear();
  mockIsGuest = false;
});

describe('MarketAnalyticsPage', () => {
  it('renders the index, set movers and as-of line for Pokémon, 30d', async () => {
    const { getMarketAnalytics } = renderPage();
    expect(screen.getByTestId(`${ID}-loading`)).toBeTruthy();

    expect(await screen.findByTestId(`${ID}-pulse-change`)).toHaveTextContent(/^\+\d+\.\d%$/);
    expect(getMarketAnalytics).toHaveBeenCalledWith({ game: 'pokemon', window: '30d' });
    expect(screen.getByTestId(`${ID}-pulse-subline`)).toHaveTextContent(/^Past 30 days · /);
    expect(screen.getByTestId(`${ID}-pulse-breadth-text`)).toHaveTextContent(/\d+% of cards up · \d+% down/);
    expect(screen.getByTestId(`${ID}-sets-rising-sv10`)).toBeTruthy();
    expect(screen.getByTestId(`${ID}-sets-falling-sv7`)).toBeTruthy();
    // Cut 2026-11-23 (owner).
    for (const gone of ['pulse-you', 'heatmap', 'bargains', 'breakouts', 'grading']) {
      expect(screen.queryByTestId(`${ID}-${gone}`)).toBeNull();
    }
    expect(screen.getByTestId(`${ID}-as-of`)).toHaveTextContent('Prices as of 2026-11-22 · USD');
  });

  it('re-reads on a window change and uses the server window label verbatim', async () => {
    const { getMarketAnalytics } = renderPage();
    await screen.findByTestId(`${ID}-pulse-change`);
    fireEvent.press(screen.getByTestId(`${ID}-window-7d`));
    await waitFor(() => expect(getMarketAnalytics).toHaveBeenLastCalledWith({ game: 'pokemon', window: '7d' }));
    await waitFor(() => expect(screen.getByTestId(`${ID}-pulse-subline`)).toHaveTextContent(/^Past week · /));
  });

  it('switches game from the sheet and shows a thin-game empty state', async () => {
    const { getMarketAnalytics } = renderPage();
    await screen.findByTestId(`${ID}-pulse-change`);
    fireEvent.press(screen.getByTestId(`${ID}-game`));
    fireEvent.press(screen.getByTestId(`${ID}-game-sheet-option-gundam`));
    await waitFor(() => expect(getMarketAnalytics).toHaveBeenLastCalledWith({ game: 'gundam', window: '30d' }));
    expect(await screen.findByTestId(`${ID}-empty`)).toBeTruthy();
  });

  it('shows a retry card when the read fails with nothing cached', async () => {
    const getMarketAnalytics = jest.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockImplementation(async ({ game, window }) => buildDevMarketAnalytics(game, window));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    renderPage({ getMarketAnalytics });
    fireEvent.press(await screen.findByTestId(`${ID}-retry`));
    expect(await screen.findByTestId(`${ID}-pulse-change`)).toBeTruthy();
    warn.mockRestore();
  });

  it('keeps its layout when the backend sends null changes', async () => {
    const base = buildDevMarketAnalytics('pokemon', '30d');
    const getMarketAnalytics = jest.fn(async () => ({
      ...base,
      pulse: { ...base.pulse, changePct: null, indexValueUsd: null, breadth: { ...base.pulse.breadth, upPct: null } },
      you: base.you && { ...base.you, changePct: null, beatsMarket: null },
      breakingOut: base.breakingOut.map((item) => ({ ...item, changePct: null, previousHighUsd: null })),
    }));
    renderPage({ getMarketAnalytics });
    expect(await screen.findByTestId(`${ID}-pulse-change`)).toHaveTextContent('—');
    expect(screen.getByTestId(`${ID}-pulse-subline`)).toHaveTextContent('Past 30 days');
    expect(screen.getByTestId(`${ID}-pulse-breadth-text`)).toHaveTextContent(/\d+% of cards up/);
  });

  it('opens a rising set on the set page with its game', async () => {
    renderPage();
    fireEvent.press(await screen.findByTestId(`${ID}-sets-rising-sv10`));
    expect(mockPush).toHaveBeenCalledWith({
      pathname: '/catalog/expansion/[expansionId]',
      params: { expansionId: 'sv10', game: 'pokemon', name: 'Destined Rivals' },
    });
  });
});
