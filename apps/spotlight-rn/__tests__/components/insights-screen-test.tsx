import { screen, waitFor } from '@testing-library/react-native';

import type { PortfolioPerformance } from '@spotlight/api-client';
import { InsightsScreen } from '@/features/insights/screens/insights-screen';

import { createTestSpotlightRepository, renderWithProviders } from '../test-utils';

// CachedImage/thumbnails call useAuth; render without an AuthProvider in the
// harness, so stub the hook to the no-token path.
jest.mock('@/providers/auth-provider', () => ({
  ...jest.requireActual('@/providers/auth-provider'),
  useAuth: () => ({ accessToken: null }),
}));

const currentYear = new Date().getFullYear();

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
      quantity: 1,
      kind: 'raw',
      grade: null,
      currentPrice: 300,
      currentValue: 300,
      costBasisTotal: 100,
      jan1Price: 250,
      yearStartValue: 250,
      ytdGainDollar: 50,
      ytdGainPercent: 20,
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
      quantity: 2,
      kind: 'graded',
      grade: 'PSA 10',
      currentPrice: 400,
      currentValue: 800,
      costBasisTotal: null,
      jan1Price: null,
      yearStartValue: null,
      ytdGainDollar: null,
      ytdGainPercent: null,
      sparkline: [],
    },
  ],
};

describe('InsightsScreen — performance tracker', () => {
  it('highlights the Collection tab in the bottom nav', async () => {
    renderWithProviders(<InsightsScreen />, {
      spotlightRepository: createTestSpotlightRepository({
        getPortfolioPerformance: async () => samplePerformance,
      }),
    });
    const tab = await screen.findByTestId('bottom-nav-portfolio');
    expect(tab.props.accessibilityState?.selected).toBe(true);
  });

  it('renders the year tracker header, count, and per-card rows', async () => {
    renderWithProviders(<InsightsScreen />, {
      spotlightRepository: createTestSpotlightRepository({
        getPortfolioPerformance: async () => samplePerformance,
      }),
    });

    expect(screen.getByTestId('insights-header-title').props.children).toBe('Insights');
    expect(screen.getByText(`${currentYear} Performance Tracker`)).toBeTruthy();
    expect(screen.getByText('PORTFOLIO')).toBeTruthy();

    // Rows + the item count land after the async performance load resolves.
    await waitFor(() => {
      expect(screen.getByText('Ludicolo')).toBeTruthy();
    });
    expect(screen.getByText('2 Items')).toBeTruthy();
    expect(screen.getByText('Gengar')).toBeTruthy();
    // Ludicolo cost basis + YTD % render; Gengar's null cells render "—".
    expect(screen.getByText('$100')).toBeTruthy();
    expect(screen.getByText('20%')).toBeTruthy();
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
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
  });
});
