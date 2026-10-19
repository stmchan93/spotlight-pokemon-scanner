import { fireEvent, screen, waitFor } from '@testing-library/react-native';

import type { PortfolioPerformance } from '@spotlight/api-client';
import { InsightsScreen } from '@/features/insights/screens/insights-screen';

import { createTestSpotlightRepository, renderWithProviders } from '../test-utils';

// CachedImage/thumbnails call useAuth; render without an AuthProvider in the
// harness, so stub the hook to the no-token path.
jest.mock('@/providers/auth-provider', () => ({
  ...jest.requireActual('@/providers/auth-provider'),
  useAuth: () => ({ accessToken: null }),
}));

const samplePerformance: PortfolioPerformance = {
  itemCount: 2,
  currencyCode: 'USD',
  refreshedAt: '2026-07-01T00:00:00.000Z',
  rows: [
    {
      entryId: 'e1',
      cardId: 'sm1-1',
      name: 'Ludicolo',
      cardNumber: '1/149',
      setName: 'Sun & Moon',
      imageUrl: 'https://images.pokemontcg.io/sm1/1.png',
      smallImageUrl: 'https://images.pokemontcg.io/sm1/1_small.png',
      quantity: 1,
      kind: 'raw',
      grade: null,
      variantName: 'Reverse Holofoil',
      condition: 'Near Mint',
      currentPrice: 300,
      currentValue: 300,
      costBasisTotal: 100,
      jan1Price: 250,
      yearStartValue: 250,
      ytdGainDollar: 50,
      ytdGainPercent: 20,
      todayGainDollar: 10,
      todayGainPercent: 3.4,
      monthGainDollar: 25,
      monthGainPercent: 9,
      isFavorite: true,
      sparkline: [250, 260, 300],
    },
    {
      // No cost basis and no history → G/L, cost, and chart all render "—".
      entryId: 'e2',
      cardId: 'g1',
      name: 'Gengar',
      cardNumber: '100/101',
      setName: 'Team Rocket',
      imageUrl: null,
      smallImageUrl: null,
      quantity: 2,
      kind: 'graded',
      grade: 'PSA 10',
      variantName: null,
      condition: null,
      currentPrice: 400,
      currentValue: 800,
      costBasisTotal: null,
      jan1Price: null,
      yearStartValue: null,
      ytdGainDollar: null,
      ytdGainPercent: null,
      todayGainDollar: null,
      todayGainPercent: null,
      monthGainDollar: null,
      monthGainPercent: null,
      isFavorite: false,
      sparkline: [],
    },
    {
      // One Piece holding: hidden behind the game switcher while Pokémon (two
      // entries) is the default game. No `game` field on purpose — the id
      // namespace is what identifies it, as on a payload from today's server.
      entryId: 'e3',
      cardId: 'onepiece~OP05-119',
      name: 'Monkey.D.Luffy',
      cardNumber: 'OP05-119',
      setName: 'Awakening of the New Era',
      imageUrl: null,
      smallImageUrl: null,
      quantity: 1,
      kind: 'raw',
      grade: null,
      variantName: null,
      condition: 'Near Mint',
      currentPrice: 486,
      currentValue: 486,
      costBasisTotal: 312.75,
      jan1Price: null,
      yearStartValue: null,
      ytdGainDollar: null,
      ytdGainPercent: null,
      todayGainDollar: null,
      todayGainPercent: null,
      monthGainDollar: null,
      monthGainPercent: null,
      isFavorite: false,
      sparkline: [],
    },
  ],
};

function renderInsights() {
  renderWithProviders(<InsightsScreen />, {
    spotlightRepository: createTestSpotlightRepository({
      getPortfolioPerformance: async () => samplePerformance,
    }),
  });
}

describe('InsightsScreen — performance tracker', () => {
  it('draws no bottom tab bar of its own, because it is a pushed screen', async () => {
    renderInsights();
    // Wait for the real content so this cannot pass by asserting on an
    // unmounted tree.
    await screen.findByTestId('insights-header-title');

    // Insights lives in app/(stack), not app/(tabs). It used to render the
    // standalone `AppBottomTabBar` — the pre-tabs chrome — which shipped a
    // second, stale-looking bar under the app's real one.
    expect(screen.queryByTestId('bottom-nav-portfolio')).toBeNull();
    expect(screen.queryByTestId('bottom-nav-wishlist')).toBeNull();
    expect(screen.queryByTestId('bottom-nav-scan')).toBeNull();
  });

  it('renders the category header, count, and per-card rows', async () => {
    renderInsights();

    expect(screen.getByTestId('insights-header-title').props.children).toBe('INSIGHTS');
    // Game switcher label = gameDisplayName, uppercased (same as the scanner's
    // "Scanning for" sheet), so the accent survives.
    expect(screen.getByTestId('insights-category-title').props.children).toBe('POKÉMON');
    expect(screen.getByText('PORTFOLIO')).toBeTruthy();

    // Rows + the item count land after the async performance load resolves.
    // The count is per game: the One Piece Luffy is not in the Pokémon table.
    await waitFor(() => {
      expect(screen.getByText('Ludicolo')).toBeTruthy();
    });
    expect(screen.getByText('2 ITEMS')).toBeTruthy();
    expect(screen.getByText('Gengar')).toBeTruthy();
    expect(screen.queryByText('Monkey.D.Luffy')).toBeNull();
    // Ludicolo cost basis + month $/% G/L render; Gengar's null cells render "—".
    expect(screen.getByText('$100')).toBeTruthy();
    expect(screen.getByText('$25')).toBeTruthy();
    expect(screen.getByText('9%')).toBeTruthy();
    // % Total (all-time growth vs cost): (300 - 100) / 100 = 200%.
    expect(screen.getByText('200%')).toBeTruthy();
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
    // Row subtitle surfaces the printing; raw condition is not shown here.
    expect(screen.getByText('REVERSE HOLOFOIL')).toBeTruthy();
    expect(screen.queryByText('NEAR MINT')).toBeNull();
    // Graded Gengar (qty 2) shows its grade + quantity.
    expect(screen.getByText('PSA 10 · ×2')).toBeTruthy();
  });

  it('filters rows by search query', async () => {
    renderInsights();
    await waitFor(() => {
      expect(screen.getByText('Ludicolo')).toBeTruthy();
    });

    fireEvent.changeText(screen.getByPlaceholderText('SEARCH YOUR PORTFOLIO'), 'gengar');
    expect(screen.getByText('Gengar')).toBeTruthy();
    expect(screen.queryByText('Ludicolo')).toBeNull();
    expect(screen.getByText('1 ITEM')).toBeTruthy();

    fireEvent.changeText(screen.getByPlaceholderText('SEARCH YOUR PORTFOLIO'), 'zzz');
    expect(screen.getByText('No cards match your search.')).toBeTruthy();
  });

  it('filters rows with the Likes and Graded chips', async () => {
    renderInsights();
    await waitFor(() => {
      expect(screen.getByText('Ludicolo')).toBeTruthy();
    });

    // Likes → only the favorited Ludicolo remains.
    fireEvent.press(screen.getByTestId('insights-filter-chip-row-favorites'));
    expect(screen.getByText('Ludicolo')).toBeTruthy();
    expect(screen.queryByText('Gengar')).toBeNull();

    // Graded → only the PSA 10 Gengar remains.
    fireEvent.press(screen.getByTestId('insights-filter-chip-row-graded'));
    expect(screen.getByText('Gengar')).toBeTruthy();
    expect(screen.queryByText('Ludicolo')).toBeNull();
  });

  it('applies a sort from the Filter By sheet', async () => {
    renderInsights();
    await waitFor(() => {
      expect(screen.getByText('Ludicolo')).toBeTruthy();
    });

    fireEvent.press(screen.getByTestId('insights-sort-button'));
    expect(screen.getByText('Filter By')).toBeTruthy();

    // Most Valuable puts Gengar ($800 value) above Ludicolo ($300).
    fireEvent.press(screen.getByTestId('insights-sort-sheet-option-most-valuable'));
    fireEvent.press(screen.getByTestId('insights-sort-sheet-apply'));

    const cardCells = screen.getAllByTestId(/^performance-table-card-/);
    expect(cardCells.map((cell) => cell.props.testID)).toEqual([
      'performance-table-card-e2',
      'performance-table-card-e1',
    ]);
  });

  it('opens the game sheet from the category header, listing only held games', async () => {
    renderInsights();
    await waitFor(() => {
      expect(screen.getByText('Ludicolo')).toBeTruthy();
    });
    expect(screen.queryByTestId('insights-game-sheet')).toBeNull();

    fireEvent.press(screen.getByTestId('insights-category-picker'));

    expect(screen.getByTestId('insights-game-sheet')).toBeTruthy();
    expect(screen.getByText('Game')).toBeTruthy();
    // Pokémon + One Piece have entries; the other games are not offered.
    expect(screen.getByText('ONE PIECE')).toBeTruthy();
    expect(screen.getByTestId('insights-game-sheet-option-pokemon')).toBeTruthy();
    expect(screen.getByTestId('insights-game-sheet-option-onepiece')).toBeTruthy();
    expect(screen.queryByTestId('insights-game-sheet-option-lorcana')).toBeNull();
    expect(screen.queryByTestId('insights-game-sheet-option-riftbound')).toBeNull();
    expect(screen.queryByTestId('insights-game-sheet-option-gundam')).toBeNull();
    // The current game is the selected radio.
    expect(
      screen.getByTestId('insights-game-sheet-option-pokemon').props.accessibilityState,
    ).toEqual({ selected: true });
  });

  it('switching to One Piece filters the rows and the item count', async () => {
    renderInsights();
    await waitFor(() => {
      expect(screen.getByText('Ludicolo')).toBeTruthy();
    });

    fireEvent.press(screen.getByTestId('insights-category-picker'));
    fireEvent.press(screen.getByTestId('insights-game-sheet-option-onepiece'));

    // Selection commits at once: header relabels, table + count re-scope.
    expect(screen.getByTestId('insights-category-title').props.children).toBe('ONE PIECE');
    expect(screen.getByText('Monkey.D.Luffy')).toBeTruthy();
    expect(screen.queryByText('Ludicolo')).toBeNull();
    expect(screen.queryByText('Gengar')).toBeNull();
    expect(screen.getByText('1 ITEM')).toBeTruthy();

    // Search still scopes within the chosen game.
    fireEvent.changeText(screen.getByPlaceholderText('SEARCH YOUR PORTFOLIO'), 'gengar');
    expect(screen.getByText('No cards match your search.')).toBeTruthy();
  });

  it('shows an empty state when the portfolio has no cards', async () => {
    renderWithProviders(<InsightsScreen />, {
      spotlightRepository: createTestSpotlightRepository({
        getPortfolioPerformance: async () => ({
          itemCount: 0,
          currencyCode: 'USD',
          refreshedAt: '',
          rows: [],
        }),
      }),
    });

    await waitFor(() => {
      expect(screen.getByText('No cards in your portfolio yet.')).toBeTruthy();
    });

    // The column headers (PORTFOLIO + metric labels) must render even with no
    // rows — regression for headers being absent until data loaded.
    expect(screen.getByText('PORTFOLIO')).toBeTruthy();
    expect(screen.getByText('Current')).toBeTruthy();
    expect(screen.getByText('Cost')).toBeTruthy();
  });

  it('shows a filter-applied dot only once a non-default sort is applied', async () => {
    renderInsights();
    await waitFor(() => {
      expect(screen.getByText('Ludicolo')).toBeTruthy();
    });

    // Default sort → no dot.
    expect(screen.queryByTestId('insights-sort-active-dot')).toBeNull();

    fireEvent.press(screen.getByTestId('insights-sort-button'));
    fireEvent.press(screen.getByTestId('insights-sort-sheet-option-most-valuable'));
    fireEvent.press(screen.getByTestId('insights-sort-sheet-apply'));

    // Non-default sort applied → dot appears.
    expect(screen.getByTestId('insights-sort-active-dot')).toBeTruthy();
  });
});
