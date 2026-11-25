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

const RELEASES = {
  items: [
    { id: 'rel', date: '2026-11-06', kind: 'release' as const, game: 'pokemon' as const, title: 'Delta Reign', subtitle: null, setId: 'set-1', url: null, logoUrl: null },
  ],
};

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

type JsonNode = { props?: { testID?: unknown }; children?: (JsonNode | string)[] | null };

/** Every host testID in the rendered tree, in document (depth-first) order. */
function renderedTestIDs() {
  const ids: string[] = [];
  const walk = (node: JsonNode | JsonNode[] | string | null) => {
    if (node == null || typeof node === 'string') {
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (typeof node.props?.testID === 'string') {
      ids.push(node.props.testID);
    }
    (node.children ?? []).forEach(walk);
  };
  walk(screen.toJSON() as JsonNode | JsonNode[] | null);
  return ids;
}

/** Position of an exact testID in the rendered tree (document order). */
function treePosition(testID: string) {
  const index = renderedTestIDs().indexOf(testID);
  expect(index).toBeGreaterThanOrEqual(0);
  return index;
}

beforeEach(() => {
  clearMarketAnalyticsCache();
  mockPush.mockClear();
  mockIsGuest = false;
});

describe('MarketAnalyticsPage', () => {
  it('renders rising and falling lists, your movers and the as-of line for Pokémon, 30d', async () => {
    const { getMarketAnalytics } = renderPage();
    expect(screen.getByTestId(`${ID}-loading`)).toBeTruthy();

    const data = buildDevMarketAnalytics('pokemon', '30d');
    const first = data.cardsRising[0];
    expect(await screen.findByTestId(`${ID}-rising-${first.cardId}`)).toBeTruthy();
    expect(getMarketAnalytics).toHaveBeenCalledWith({ game: 'pokemon', window: '30d' });
    expect(screen.getByTestId(`${ID}-rising-${first.cardId}-change`)).toHaveTextContent(
      `${Math.abs(first.changePct).toFixed(1)}%`,
    );
    expect(screen.getByTestId(`${ID}-falling-${data.cardsFalling[0].cardId}`)).toBeTruthy();
    expect(screen.getByText('RISING')).toBeTruthy();
    expect(screen.getByText('FALLING')).toBeTruthy();
    // No toggle and no "Moving in" title any more.
    expect(screen.queryByText('MOVING IN POKÉMON')).toBeNull();
    expect(screen.queryByTestId(`${ID}-movers`)).toBeNull();

    const mine = data.yourMovers!.gainers[0];
    expect(screen.getByTestId(`${ID}-yours-${mine.cardId}`)).toHaveTextContent(new RegExp(`You own ${mine.quantity}`));
    expect(screen.getByTestId(`${ID}-yours-${data.yourMovers!.losers[0].cardId}-change`)).toHaveTextContent(/^−\$/);
    // Cut 2026-11-24 (owner).
    for (const gone of ['pulse', 'sets-rising', 'sets-falling']) {
      expect(screen.queryByTestId(`${ID}-${gone}`)).toBeNull();
    }
    expect(screen.getByTestId(`${ID}-as-of`)).toHaveTextContent('Prices as of 2026-11-22 · USD');
  });

  it.each(['rising', 'falling'] as const)('shows 5 %s rows, then "Show more" reveals the rest', async (direction) => {
    renderPage();
    const data = buildDevMarketAnalytics('pokemon', '30d');
    const items = direction === 'rising' ? data.cardsRising : data.cardsFalling;
    expect(items.length).toBeGreaterThan(5);
    await screen.findByTestId(`${ID}-${direction}-list`);

    for (const item of items.slice(0, 5)) {
      expect(screen.getByTestId(`${ID}-${direction}-${item.cardId}`)).toBeTruthy();
    }
    expect(screen.queryByTestId(`${ID}-${direction}-${items[5].cardId}`)).toBeNull();
    expect(screen.getByTestId(`${ID}-${direction}-more-view-more`)).toHaveTextContent(`Show ${items.length - 5} more`);

    fireEvent.press(screen.getByTestId(`${ID}-${direction}-more-view-more`));
    expect(screen.getByTestId(`${ID}-${direction}-${items[items.length - 1].cardId}`)).toBeTruthy();
    expect(screen.queryByTestId(`${ID}-${direction}-more-view-more`)).toBeNull();
  });

  it('opens a card page from either list', async () => {
    renderPage();
    const data = buildDevMarketAnalytics('pokemon', '30d');
    const rising = data.cardsRising[0];
    fireEvent.press(await screen.findByTestId(`${ID}-rising-${rising.cardId}`));
    expect(mockPush).toHaveBeenLastCalledWith({
      pathname: '/cards/[cardId]',
      params: { cardId: rising.cardId, name: rising.name },
    });
    const falling = data.cardsFalling[0];
    fireEvent.press(screen.getByTestId(`${ID}-falling-${falling.cardId}`));
    expect(mockPush).toHaveBeenLastCalledWith({
      pathname: '/cards/[cardId]',
      params: { cardId: falling.cardId, name: falling.name },
    });
  });

  it('orders upcoming sets, your movers, rising, then falling', async () => {
    renderPage({ fetchCalendar: async () => RELEASES });
    await screen.findByTestId(`${ID}-rising`);
    await screen.findByTestId(`${ID}-upcoming-rel`);

    const controls = treePosition(`${ID}-window`);
    const upcoming = treePosition(`${ID}-upcoming`);
    const yours = treePosition(`${ID}-yours`);
    const rising = treePosition(`${ID}-rising`);
    const falling = treePosition(`${ID}-falling`);
    expect(controls).toBeLessThan(upcoming);
    expect(upcoming).toBeLessThan(yours);
    expect(yours).toBeLessThan(rising);
    expect(rising).toBeLessThan(falling);
  });

  it('renders nothing for a list with no items', async () => {
    const base = buildDevMarketAnalytics('pokemon', '30d');
    renderPage({ getMarketAnalytics: jest.fn(async () => ({ ...base, cardsFalling: [] })) });
    await screen.findByTestId(`${ID}-rising`);
    expect(screen.queryByTestId(`${ID}-falling`)).toBeNull();
    expect(screen.queryByTestId(`${ID}-empty`)).toBeNull();
  });

  it('re-reads on a window change, including 1Y', async () => {
    const { getMarketAnalytics } = renderPage();
    await screen.findByTestId(`${ID}-rising`);
    fireEvent.press(screen.getByTestId(`${ID}-window-7d`));
    await waitFor(() => expect(getMarketAnalytics).toHaveBeenLastCalledWith({ game: 'pokemon', window: '7d' }));
    fireEvent.press(screen.getByTestId(`${ID}-window-1y`));
    await waitFor(() => expect(getMarketAnalytics).toHaveBeenLastCalledWith({ game: 'pokemon', window: '1y' }));
    const data = buildDevMarketAnalytics('pokemon', '1y');
    expect(await screen.findByTestId(`${ID}-rising-${data.cardsRising[0].cardId}`)).toBeTruthy();
  });

  it('shows a guest line instead of your movers', async () => {
    mockIsGuest = true;
    renderPage();
    expect(await screen.findByTestId(`${ID}-yours-guest`)).toHaveTextContent(
      'Add cards to see what moved in your collection',
    );
  });

  it('hides your movers for a signed-in user with nothing moved', async () => {
    const base = buildDevMarketAnalytics('pokemon', '30d');
    renderPage({ getMarketAnalytics: jest.fn(async () => ({ ...base, yourMovers: null })) });
    await screen.findByTestId(`${ID}-rising`);
    expect(screen.queryByTestId(`${ID}-yours`)).toBeNull();
  });

  it('switches game from the sheet and shows the empty state with a 1M suggestion', async () => {
    const { getMarketAnalytics } = renderPage();
    await screen.findByTestId(`${ID}-rising`);
    fireEvent.press(screen.getByTestId(`${ID}-window-7d`));
    fireEvent.press(screen.getByTestId(`${ID}-game`));
    fireEvent.press(screen.getByTestId(`${ID}-game-sheet-option-gundam`));
    await waitFor(() => expect(getMarketAnalytics).toHaveBeenLastCalledWith({ game: 'gundam', window: '7d' }));
    expect(await screen.findByTestId(`${ID}-empty`)).toHaveTextContent(/Not enough sales in this window/);
    expect(screen.getByTestId(`${ID}-empty`)).toHaveTextContent(/Try 1M instead/);
    expect(screen.queryByTestId(`${ID}-rising`)).toBeNull();
    expect(screen.queryByTestId(`${ID}-falling`)).toBeNull();
    fireEvent.press(screen.getByTestId(`${ID}-empty-action`));
    await waitFor(() => expect(getMarketAnalytics).toHaveBeenLastCalledWith({ game: 'gundam', window: '30d' }));
    await waitFor(() => expect(screen.queryByTestId(`${ID}-empty-action`)).not.toBeOnTheScreen());
  });

  it('shows a retry card when the read fails with nothing cached', async () => {
    const getMarketAnalytics = jest.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockImplementation(async ({ game, window }) => buildDevMarketAnalytics(game, window));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    renderPage({ getMarketAnalytics });
    fireEvent.press(await screen.findByTestId(`${ID}-retry`));
    expect(await screen.findByTestId(`${ID}-rising`)).toBeTruthy();
    expect(screen.getByTestId(`${ID}-falling`)).toBeTruthy();
    warn.mockRestore();
  });
});
