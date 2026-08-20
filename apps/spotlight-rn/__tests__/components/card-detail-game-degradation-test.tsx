import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { useRouter } from 'expo-router';

import type { CardDetailRecord } from '@spotlight/api-client';

import { CardDetailScreen } from '@/features/cards/screens/card-detail-screen';
import { clearCardDetailCache } from '@/features/cards/card-detail-prefetch';
import { clearCardDetailPreviewSessions } from '@/features/cards/card-detail-preview-session';

import { createTestSpotlightRepository, renderWithProviders } from '../test-utils';

jest.mock('@/lib/observability/posthog', () => ({
  capturePostHogEvent: jest.fn(),
}));

jest.mock('expo-router', () => ({
  useRouter: jest.fn(),
}));

/**
 * A card page must not offer a surface its game has no data behind. The failure
 * this guards against is not a crash — it is a control that leads to a
 * permanently empty chart, or a drawer whose two panels sit in their empty
 * states under a "See more on eBay" link that goes somewhere equally empty.
 *
 * Everything here is driven by the capability table, never by `game ===
 * 'pokemon'`, which is why Lorcana (graded YES with its OWN eight companies,
 * population NO, listings YES only since the 2026-08-14 probe) is the
 * interesting case rather than a redundant one.
 */
describe('card detail degrades by game capability', () => {
  beforeEach(() => {
    (useRouter as jest.Mock).mockReturnValue({
      replace: jest.fn(),
      push: jest.fn(),
      back: jest.fn(),
      dismissTo: jest.fn(),
    });
  });

  afterEach(() => {
    clearCardDetailPreviewSessions();
    clearCardDetailCache();
    jest.clearAllMocks();
  });

  function detailForGame(game: CardDetailRecord['game']) {
    const baseRepository = createTestSpotlightRepository();
    return jest.fn(async (query: { cardId: string }) => {
      const base = await baseRepository.getCardDetail({ ...query, cardId: 'sm7-1' });
      return base ? ({ ...base, game } satisfies CardDetailRecord) : null;
    });
  }

  const trendRows = (mode: string) => ([
    {
      label: mode === 'graded' ? 'PSA 10' : 'Near Mint',
      key: mode === 'graded' ? 'PSA 10' : 'NM',
      currentPrice: 100,
      currencyCode: 'USD',
      points: [1, 2, 3],
      trendPct: 2,
    },
  ]);

  const priceTrendsFor = () => jest.fn(async (query: { mode: string }) => ({
    mode: query.mode as 'raw' | 'graded',
    provider: (query.mode === 'graded' ? 'ebay' : 'tcgplayer') as 'ebay' | 'tcgplayer',
    rows: trendRows(query.mode),
  }));

  it('offers no grading lane on a One Piece card, but keeps Raw so it is still ownable', async () => {
    renderWithProviders(
      <CardDetailScreen cardId="sm7-1" onBack={jest.fn()} />,
      {
        spotlightRepository: createTestSpotlightRepository({
          getCardDetail: detailForGame('onepiece'),
        }),
      },
    );

    await screen.findByTestId('detail-configurator');
    expect(screen.getByTestId('detail-configurator-grader-Raw')).toBeTruthy();
    for (const grader of ['PSA', 'BGS', 'CGC']) {
      expect(screen.queryByTestId(`detail-configurator-grader-${grader}`)).toBeNull();
    }
  });

  it("offers Lorcana its OWN graders, not Pokémon's four", async () => {
    // Lorcana's priced slabs span eight companies; handing it the Pokémon set
    // would hide most of its data and invent lanes it doesn't use.
    renderWithProviders(
      <CardDetailScreen cardId="sm7-1" onBack={jest.fn()} />,
      {
        spotlightRepository: createTestSpotlightRepository({
          getCardDetail: detailForGame('lorcana'),
        }),
      },
    );

    await screen.findByTestId('detail-configurator');
    expect(screen.getByTestId('detail-configurator-grader-SGC')).toBeTruthy();
    expect(screen.getByTestId('detail-configurator-grader-TAG')).toBeTruthy();
  });

  it('keeps all four Pokémon lanes when the payload carries no game at all', async () => {
    // A backend predating multi-game sends none. Reading that as "unknown"
    // would strip PSA pricing off every card already in the app.
    renderWithProviders(
      <CardDetailScreen cardId="sm7-1" onBack={jest.fn()} />,
      {
        spotlightRepository: createTestSpotlightRepository({
          getCardDetail: detailForGame(undefined),
        }),
      },
    );

    await screen.findByTestId('detail-configurator');
    for (const grader of ['Raw', 'PSA', 'BGS', 'CGC']) {
      expect(screen.getByTestId(`detail-configurator-grader-${grader}`)).toBeTruthy();
    }
  });

  it('opens the comps drawer for Lorcana now that its listings are measured real', async () => {
    // Flipped 2026-08-14: the probe (tools/probe_scrydex_lorcana_listings.py)
    // returned a real eBay sold row for AOTV-224, so Lorcana's graded rows now
    // have something to expand INTO. This USED to assert the tap was a no-op —
    // that was the honest state while listings were unmeasured, and keeping the
    // drawer hidden here would have buried the one non-Pokémon game with real
    // comps behind a stale client table.
    const getCardRecentSales = jest.fn(async () => ({
      source: 'ebay' as const,
      status: 'available' as const,
      fetchedAt: new Date().toISOString(),
      canRefresh: false,
      saleCount: 1,
      sales: [{
        id: 'sale-0',
        title: 'Mulan Elite Archer 224/204 Foil Legendary PSA 10 GEM Deep Trouble Lorcana',
        soldAt: '2026-08-10T00:00:00.000Z',
        priceAmount: 140,
        currencyCode: 'USD',
        saleUrl: 'https://www.ebay.com/itm/224',
      }],
    }));

    renderWithProviders(
      <CardDetailScreen cardId="sm7-1" onBack={jest.fn()} />,
      {
        spotlightRepository: createTestSpotlightRepository({
          getCardDetail: detailForGame('lorcana'),
          getCardPriceTrends: priceTrendsFor(),
          getCardRecentSales,
        }),
      },
    );

    fireEvent.press(await screen.findByTestId('detail-configurator-grader-PSA'));
    fireEvent.press(await screen.findByTestId('detail-price-trends-row-PSA 10'));

    await waitFor(() => {
      expect(screen.getByTestId('detail-recent-sales')).toBeTruthy();
    });
    expect(getCardRecentSales).toHaveBeenCalled();
  });

  it('still opens the comps drawer for Pokémon', async () => {
    // The guard above must be a capability read, not a switch that turned the
    // drawer off for everyone.
    const getCardRecentSales = jest.fn(async () => ({
      source: 'ebay' as const,
      status: 'available' as const,
      fetchedAt: new Date().toISOString(),
      canRefresh: false,
      saleCount: 1,
      sales: [{
        id: 'sale-0',
        title: 'Treecko PSA 10',
        soldAt: '2026-07-10T00:00:00.000Z',
        priceAmount: 100,
        currencyCode: 'USD',
        saleUrl: 'https://www.ebay.com/itm/100',
      }],
    }));

    renderWithProviders(
      <CardDetailScreen cardId="sm7-1" onBack={jest.fn()} />,
      {
        spotlightRepository: createTestSpotlightRepository({
          getCardDetail: detailForGame('pokemon'),
          getCardPriceTrends: priceTrendsFor(),
          getCardRecentSales,
        }),
      },
    );

    fireEvent.press(await screen.findByTestId('detail-configurator-grader-PSA'));
    fireEvent.press(await screen.findByTestId('detail-price-trends-row-PSA 10'));

    await waitFor(() => {
      expect(screen.getByTestId('detail-recent-sales')).toBeTruthy();
    });
    expect(getCardRecentSales).toHaveBeenCalled();
  });
});
