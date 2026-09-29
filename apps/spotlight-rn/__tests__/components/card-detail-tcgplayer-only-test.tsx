import { fireEvent, screen, waitFor, within } from '@testing-library/react-native';
import { useRouter } from 'expo-router';

import type { CardDetailRecord, InventoryCardEntry } from '@spotlight/api-client';

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
 * A TCGplayer-only card (Scrydex does not list it) has raw TCGplayer pricing
 * and nothing else. Its page must look like any other card's, minus the graded
 * surfaces — even for Pokémon, whose game capabilities WOULD offer PSA/BGS/CGC.
 */
describe('card detail for a TCGplayer-only card', () => {
  let router: { replace: jest.Mock; push: jest.Mock; back: jest.Mock; dismissTo: jest.Mock };

  beforeEach(() => {
    router = { replace: jest.fn(), push: jest.fn(), back: jest.fn(), dismissTo: jest.fn() };
    (useRouter as jest.Mock).mockReturnValue(router);
  });

  afterEach(() => {
    clearCardDetailPreviewSessions();
    clearCardDetailCache();
    jest.clearAllMocks();
  });

  const population = {
    PSA: { totalPopulation: 120, gemRate: 0.4, grades: { '10': 48, '9': 60, '8': 12 } },
  };

  function detailWith(patch: Partial<CardDetailRecord>) {
    const baseRepository = createTestSpotlightRepository();
    return jest.fn(async (query: { cardId: string }) => {
      const base = await baseRepository.getCardDetail({ ...query, cardId: 'sm7-1' });
      return base
        ? ({ ...base, cardId: query.cardId, game: 'pokemon', population, ...patch } satisfies CardDetailRecord)
        : null;
    });
  }

  const priceTrends = jest.fn(async (query: { mode: string }) => ({
    mode: query.mode as 'raw' | 'graded',
    provider: (query.mode === 'graded' ? 'ebay' : 'tcgplayer') as 'ebay' | 'tcgplayer',
    rows: [{
      label: query.mode === 'graded' ? 'PSA 10' : 'Near Mint',
      key: query.mode === 'graded' ? 'PSA 10' : 'NM',
      currentPrice: 100,
      currencyCode: 'USD',
      points: [1, 2, 3],
      trendPct: 2,
    }],
  }));

  it('shows Pokémon graded lanes + population for a Scrydex card', async () => {
    renderWithProviders(
      <CardDetailScreen cardId="sm7-1" onBack={jest.fn()} />,
      {
        spotlightRepository: createTestSpotlightRepository({
          getCardDetail: detailWith({ catalogSource: 'scrydex' }),
          getCardPriceTrends: priceTrends,
        }),
      },
    );

    fireEvent.press(await screen.findByTestId('detail-configurator-grader-PSA'));
    expect(await screen.findByTestId('detail-population-report')).toBeTruthy();
  });

  it('hides graded lanes and population for a TCGplayer-only Pokémon card, keeping Raw', async () => {
    renderWithProviders(
      <CardDetailScreen cardId="tcgplayer-600001" onBack={jest.fn()} />,
      {
        spotlightRepository: createTestSpotlightRepository({
          getCardDetail: detailWith({ catalogSource: 'tcgplayer', cardNumber: '' }),
          getCardPriceTrends: priceTrends,
        }),
      },
    );

    await screen.findByTestId('detail-configurator');
    expect(screen.getByTestId('detail-configurator-grader-Raw')).toBeTruthy();
    for (const grader of ['PSA', 'BGS', 'CGC']) {
      expect(screen.queryByTestId(`detail-configurator-grader-${grader}`)).toBeNull();
    }
    expect(screen.queryByTestId('detail-population-report')).toBeNull();
    // Raw price still shows.
    expect(await screen.findByTestId('detail-price-trends')).toBeTruthy();
  });

  it('hides an empty card number instead of showing "--"', async () => {
    renderWithProviders(
      <CardDetailScreen cardId="tcgplayer-600001" onBack={jest.fn()} />,
      {
        spotlightRepository: createTestSpotlightRepository({
          getCardDetail: detailWith({ catalogSource: 'tcgplayer', cardNumber: '', setName: 'Prerelease Promos' }),
        }),
      },
    );

    await waitFor(() => {
      expect(screen.getByTestId('detail-identity-number-set').props.children).toBe('Prerelease Promos');
    });
    expect(screen.queryByText(/--/)).toBeNull();
    expect(screen.queryByText(/undefined/)).toBeNull();
  });

  it('shows "—" for an owned graded copy and never asks for graded pricing', async () => {
    const slab: InventoryCardEntry = {
      id: 'entry-slab',
      cardId: 'tcgplayer-600001',
      name: 'Pikachu (Staff Prerelease)',
      cardNumber: '',
      setName: 'Prerelease Promos',
      imageUrl: 'https://tcgplayer-cdn.tcgplayer.com/product/600001_in_1000x1000.jpg',
      marketPrice: 0,
      hasMarketPrice: false,
      currencyCode: 'USD',
      quantity: 1,
      addedAt: '2026-09-28T18:00:00Z',
      kind: 'graded',
      slabContext: { grader: 'PSA', grade: '10', certNumber: null, variantName: null },
      game: 'pokemon',
      catalogSource: 'tcgplayer',
    };

    renderWithProviders(
      <CardDetailScreen cardId="tcgplayer-600001" entryId="entry-slab" onBack={jest.fn()} />,
      {
        spotlightRepository: createTestSpotlightRepository({
          getCardDetail: detailWith({ catalogSource: 'tcgplayer', cardNumber: '', ownedEntries: [slab] }),
          getCardPriceTrends: priceTrends,
        }),
      },
    );

    fireEvent.press(await screen.findByTestId('detail-inventory-header'));
    const row = await screen.findByTestId('detail-inventory-row-entry-slab');
    expect(within(row).getByText('—')).toBeTruthy();
    // The owned slab keeps its own lens chip, but no population and no
    // graded price request.
    expect(screen.getByTestId('detail-configurator-grader-PSA')).toBeTruthy();
    expect(screen.queryByTestId('detail-population-report')).toBeNull();
    expect(priceTrends.mock.calls.some(([query]) => query.mode === 'graded')).toBe(false);
  });

  it('redirects to the canonical Scrydex card once superseded', async () => {
    renderWithProviders(
      <CardDetailScreen cardId="tcgplayer-600001" onBack={jest.fn()} />,
      {
        spotlightRepository: createTestSpotlightRepository({
          getCardDetail: detailWith({ catalogSource: 'tcgplayer', canonicalCardId: 'svp-999' }),
        }),
      },
    );

    await waitFor(() => {
      expect(router.replace).toHaveBeenCalledWith({
        pathname: '/cards/[cardId]',
        params: { cardId: 'svp-999' },
      });
    });
    expect(router.replace).toHaveBeenCalledTimes(1);
  });
});
