import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { Linking } from 'react-native';
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
 * A product page is the exact card; a keyword search is a guess. So the PDP
 * takes the TCGplayer product id whenever the card carries one, and only falls
 * back to a search when it doesn't — and that search has to open with the
 * card's OWN game, since "pokemon OP16-001" matches nothing.
 */
describe('card detail marketplace link', () => {
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

  const rawTrends = jest.fn(async (query: { mode: string }) => ({
    mode: query.mode as 'raw' | 'graded',
    provider: 'tcgplayer' as const,
    rows: [{
      label: 'Near Mint',
      key: 'NM',
      currentPrice: 12,
      currencyCode: 'USD',
      points: [1, 2, 3],
      trendPct: 1,
    }],
  }));

  function onePieceDetail(over: Partial<CardDetailRecord>) {
    const baseRepository = createTestSpotlightRepository();
    return jest.fn(async (query: { cardId: string }) => {
      const base = await baseRepository.getCardDetail({ ...query, cardId: 'sm7-1' });
      return base
        ? ({
            ...base,
            game: 'onepiece',
            name: 'Monkey D. Luffy',
            cardNumber: 'OP16-001',
            setName: 'OP16',
            ...over,
          } satisfies CardDetailRecord)
        : null;
    });
  }

  async function openRawRow(getCardDetail: ReturnType<typeof onePieceDetail>) {
    const openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined as never);

    renderWithProviders(
      <CardDetailScreen cardId="sm7-1" onBack={jest.fn()} />,
      {
        spotlightRepository: createTestSpotlightRepository({
          getCardDetail,
          getCardPriceTrends: rawTrends,
        }),
      },
    );

    fireEvent.press(await screen.findByTestId('detail-price-trends-row-NM'));
    await waitFor(() => {
      expect(openURL).toHaveBeenCalledTimes(1);
    });
    return String(openURL.mock.calls[0][0]);
  }

  it('deep-links to the exact TCGplayer product when the card has a product id', async () => {
    const url = await openRawRow(onePieceDetail({
      tcgPlayerVariants: [{
        name: 'Normal',
        marketplaces: [{ name: 'tcgplayer', product_id: '610422' }],
      }],
    }));

    expect(url).toContain('tcgplayer.com/product/610422');
    // The condition filter still rides along — it's the one facet that never
    // changes which card you land on.
    expect(url).toContain('Condition=Near+Mint');
  });

  // Base Charizard on prod: the default printing is TCGplayer-named "Holofoil",
  // the variant map is Scrydex-named, so nothing matched and the logo opened a
  // search listing every Charizard. The card's main product id now wins.
  const baseCharizardVariants = [
    { name: 'firstEditionShadowlessHolofoil', marketplaces: [{ name: 'tcgplayer', product_id: '106999' }] },
    { name: 'jumbo', marketplaces: [{ name: 'tcgplayer', product_id: '179079' }] },
    { name: 'unlimitedHolofoil', marketplaces: [{ name: 'tcgplayer', product_id: '42382' }] },
  ];

  function baseCharizardDetail(over: Partial<CardDetailRecord>) {
    const baseRepository = createTestSpotlightRepository();
    return jest.fn(async (query: { cardId: string }) => {
      const base = await baseRepository.getCardDetail({ ...query, cardId: 'sm7-1' });
      return base
        ? ({
            ...base,
            game: 'pokemon',
            name: 'Charizard',
            cardNumber: '4/102',
            setName: 'Base',
            variantOptions: [
              { id: 'Holofoil', label: 'Holofoil' },
              { id: 'Unlimited Holofoil', label: 'Unlimited Holofoil' },
              { id: 'Jumbo', label: 'Jumbo' },
            ],
            tcgPlayerVariants: baseCharizardVariants,
            ...over,
          } as CardDetailRecord)
        : null;
    });
  }

  async function pressChartLogo(getCardDetail: ReturnType<typeof baseCharizardDetail>) {
    const openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined as never);
    renderWithProviders(
      <CardDetailScreen cardId="sm7-1" onBack={jest.fn()} />,
      {
        spotlightRepository: createTestSpotlightRepository({
          getCardDetail,
          getCardPriceTrends: rawTrends,
        }),
      },
    );
    fireEvent.press(await screen.findByTestId('detail-price-chart-tcgplayer'));
    await waitFor(() => {
      expect(openURL).toHaveBeenCalledTimes(1);
    });
    return String(openURL.mock.calls[0][0]);
  }

  it('the price-header logo opens the card’s main product when the printing has no id of its own', async () => {
    // Map without an Unlimited entry, so only the main id can produce 42382.
    const url = await pressChartLogo(baseCharizardDetail({
      tcgPlayerProductId: '42382',
      tcgPlayerVariants: baseCharizardVariants.slice(0, 2),
    }));

    expect(url).toContain('tcgplayer.com/product/42382');
    expect(url).not.toContain('/search');
  });

  it('the price-header logo still opens a product page on a backend without the main id', async () => {
    const url = await pressChartLogo(baseCharizardDetail({ tcgPlayerProductId: null }));

    // "Holofoil" → "unlimitedHolofoil", never the search.
    expect(url).toContain('tcgplayer.com/product/42382');
  });

  it('falls back to a search in the card’s own game when there is no product id', async () => {
    const url = await openRawRow(onePieceDetail({ tcgPlayerVariants: [] }));

    expect(url).toContain('tcgplayer.com/search');
    expect(url).toContain('one+piece');
    // The literal that made a One Piece card search TCGplayer for Pokémon.
    expect(url).not.toContain('pokemon');
  });
});
