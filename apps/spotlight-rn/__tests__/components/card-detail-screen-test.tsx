import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { Linking } from 'react-native';

import type { CardDetailRecord, InventoryCardEntry } from '@spotlight/api-client';
import { CardDetailScreen } from '@/features/cards/screens/card-detail-screen';
import {
  clearCardDetailPreviewSessions,
  saveCardDetailPreviewFromCatalogResult,
  saveCardDetailPreviewFromInventoryEntry,
} from '@/features/cards/card-detail-preview-session';
import {
  clearScanCandidateReviewSessions,
  saveScanCandidateReviewSession,
} from '@/features/scanner/scan-candidate-review-session';

import { capturePostHogEvent } from '@/lib/observability/posthog';

import { createTestSpotlightRepository, renderWithProviders } from '../test-utils';

jest.mock('@/lib/observability/posthog', () => ({
  capturePostHogEvent: jest.fn(),
}));

describe('CardDetailScreen', () => {
  afterEach(() => {
    clearCardDetailPreviewSessions();
    clearScanCandidateReviewSessions();
    jest.clearAllMocks();
  });

  it('renders the hero, market card, marketplace CTA, and action-stack icons for a card not yet owned', async () => {
    const onBack = jest.fn();
    const onOpenAddToCollection = jest.fn();
    const getCardRecentSales = jest.fn(async () => null);

    renderWithProviders(
      <CardDetailScreen
        cardId="sm7-1"
        onBack={onBack}
        onOpenAddToCollection={onOpenAddToCollection}
      />,
      {
        spotlightRepository: createTestSpotlightRepository({
          getCardRecentSales,
        }),
      },
    );

    expect(await screen.findByText('Treecko')).toBeTruthy();
    expect(screen.getByTestId('detail-back')).toBeTruthy();
    expect(screen.getByTestId('sell-backdrop')).toBeTruthy();
    expect(screen.getByTestId('detail-hero-card')).toBeTruthy();
    expect(screen.getByTestId('detail-market-card')).toBeTruthy();
    expect(screen.getByTestId('detail-marketplace-cta')).toBeTruthy();
    expect(screen.getByTestId('detail-marketplace-icon')).toBeTruthy();
    expect(screen.getByText('View on TCGplayer')).toBeTruthy();
    expect(screen.getByText('#001/096 • 裂空のカリスマ')).toBeTruthy();
    expect(screen.queryByText('Recent Sales')).toBeNull();
    expect(screen.queryByTestId('detail-recent-sales-card')).toBeNull();
    expect(screen.queryByTestId('detail-collection-card')).toBeNull();
    expect(getCardRecentSales).not.toHaveBeenCalled();

    const stackIds = Children.toArray(screen.getByTestId('detail-action-stack').props.children)
      .filter((child): child is ReactElement<{ children?: ReactNode }> => isValidElement(child))
      .flatMap((cell) => (
        Children.toArray(cell.props.children)
          .filter((c): c is ReactElement<{ testID?: string }> => isValidElement(c))
          .map((c) => c.props.testID)
      ))
      .filter(Boolean);
    expect(stackIds).toEqual([
      'detail-add-to-collection',
      'detail-favorite-card',
    ]);

    fireEvent.press(screen.getByTestId('detail-back'));
    expect(onBack).toHaveBeenCalled();

    fireEvent.press(screen.getByTestId('detail-add-to-collection'));
    expect(onOpenAddToCollection).toHaveBeenCalledWith('sm7-1', undefined);
  });

  it('opens the condition dropdown modal and selects a new condition via its option testIDs', async () => {
    const baseRepository = createTestSpotlightRepository();
    const getCardMarketHistory = jest.fn(async (query: { cardId: string; condition?: string | null }) => {
      const detail = await baseRepository.getCardDetail({ cardId: query.cardId });
      if (!detail) {
        return null;
      }

      const normalizedCondition = query.condition ?? 'near_mint';
      const priceByCondition: Record<string, number> = {
        damaged: 0.12,
        heavily_played: 0.19,
        lightly_played: 0.22,
        moderately_played: 0.27,
        near_mint: 0.31,
      };

      return {
        ...detail.marketHistory,
        currentPrice: priceByCondition[normalizedCondition] ?? detail.marketHistory.currentPrice,
        selectedCondition: normalizedCondition,
      };
    });

    renderWithProviders(
      <CardDetailScreen
        cardId="sm7-1"
        onBack={jest.fn()}
        onOpenAddToCollection={jest.fn()}
      />,
      {
        spotlightRepository: createTestSpotlightRepository({
          getCardMarketHistory,
        }),
      },
    );

    expect(await screen.findByText('Treecko')).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByTestId('detail-market-price').props.children).toBe('$0.31');
    });

    fireEvent.press(screen.getByTestId('detail-condition-dropdown'));
    fireEvent.press(await screen.findByTestId('detail-condition-dropdown-option-lightly_played'));

    await waitFor(() => {
      expect(screen.getByTestId('detail-market-price').props.children).toBe('$0.22');
      expect(getCardMarketHistory).toHaveBeenLastCalledWith(expect.objectContaining({
        cardId: 'sm7-1',
        condition: 'lightly_played',
      }));
    });
  });

  it('renders market condition prices in the dropdown options when the backend returns short condition ids', async () => {
    const baseRepository = createTestSpotlightRepository();
    const repository = createTestSpotlightRepository({
      getCardDetail: async (query) => {
        const detail = await baseRepository.getCardDetail(query);
        if (!detail) {
          return null;
        }

        const shortIdByLabel: Record<string, string> = {
          Damaged: 'DMG',
          'Heavily Played': 'HP',
          'Lightly Played': 'LP',
          'Moderately Played': 'MP',
          'Near Mint': 'NM',
        };
        return {
          ...detail,
          marketHistory: {
            ...detail.marketHistory,
            availableConditions: detail.marketHistory.availableConditions.map((condition) => ({
              ...condition,
              id: shortIdByLabel[condition.label] ?? condition.id,
            })),
            selectedCondition: 'NM',
          },
        } satisfies CardDetailRecord;
      },
    });

    renderWithProviders(
      <CardDetailScreen
        cardId="sm7-1"
        onBack={jest.fn()}
        onOpenAddToCollection={jest.fn()}
      />,
      { spotlightRepository: repository },
    );

    expect(await screen.findByText('Treecko')).toBeTruthy();
    fireEvent.press(screen.getByTestId('detail-condition-dropdown'));

    const nearMintOption = await screen.findByTestId('detail-condition-dropdown-option-near_mint');
    const lpOption = await screen.findByTestId('detail-condition-dropdown-option-lightly_played');
    expect(nearMintOption).toBeTruthy();
    expect(lpOption).toBeTruthy();
  });

  it('shows the Sell and Edit icons for owned cards and routes Add vs Edit to the right entryId', async () => {
    const onOpenSell = jest.fn();
    const onOpenAddToCollection = jest.fn();

    renderWithProviders(
      <CardDetailScreen
        cardId="xyp-111"
        entryId="entry-3"
        onBack={jest.fn()}
        onOpenAddToCollection={onOpenAddToCollection}
        onOpenSell={onOpenSell}
      />,
    );

    expect(await screen.findByText('Celebi')).toBeTruthy();
    expect(screen.getByTestId('detail-sell-card')).toBeTruthy();
    expect(screen.getByTestId('detail-edit-collection-entry')).toBeTruthy();
    expect(screen.getByTestId('detail-add-to-collection')).toBeTruthy();

    fireEvent.press(screen.getByTestId('detail-sell-card'));
    expect(onOpenSell).toHaveBeenCalledWith('entry-3');

    fireEvent.press(screen.getByTestId('detail-add-to-collection'));
    expect(onOpenAddToCollection).toHaveBeenLastCalledWith('xyp-111', undefined);

    fireEvent.press(screen.getByTestId('detail-edit-collection-entry'));
    expect(onOpenAddToCollection).toHaveBeenLastCalledWith('xyp-111', 'entry-3');
  });

  it('omits the Sell and Edit icons when the card is not owned', async () => {
    renderWithProviders(
      <CardDetailScreen
        cardId="sm7-1"
        onBack={jest.fn()}
        onOpenAddToCollection={jest.fn()}
        onOpenSell={jest.fn()}
      />,
    );

    expect(await screen.findByText('Treecko')).toBeTruthy();
    expect(screen.queryByTestId('detail-sell-card')).toBeNull();
    expect(screen.queryByTestId('detail-edit-collection-entry')).toBeNull();
    expect(screen.queryByTestId('detail-hero-raw-inventory')).toBeNull();
    expect(screen.queryByTestId('detail-hero-slab-cert-quantity')).toBeNull();
  });

  it('shows the raw inventory line (condition · variant · qty) in the hero when an owned raw entry is selected', async () => {
    const baseRepository = createTestSpotlightRepository();
    const rawEntry: InventoryCardEntry = {
      addedAt: '2026-04-27T12:00:00.000Z',
      cardId: 'sm7-1',
      cardNumber: '#001/096',
      conditionCode: 'lightly_played',
      conditionLabel: 'Lightly Played',
      conditionShortLabel: 'LP',
      costBasisPerUnit: null,
      costBasisTotal: null,
      currencyCode: 'USD',
      hasMarketPrice: true,
      id: 'raw-treecko-lp',
      imageUrl: 'https://cdn.spotlight.test/sm7/treecko.png',
      kind: 'raw',
      marketPrice: 1.5,
      name: 'Treecko',
      quantity: 3,
      setName: 'Sky Stream',
      variantName: 'Holofoil',
    };

    renderWithProviders(
      <CardDetailScreen
        cardId="sm7-1"
        entryId="raw-treecko-lp"
        onBack={jest.fn()}
        onOpenAddToCollection={jest.fn()}
      />,
      {
        spotlightRepository: createTestSpotlightRepository({
          getCardDetail: async (query) => {
            const detail = await baseRepository.getCardDetail(query);
            return detail
              ? ({ ...detail, ownedEntries: [rawEntry] } satisfies CardDetailRecord)
              : null;
          },
        }),
      },
    );

    expect(await screen.findByText('Treecko')).toBeTruthy();
    const line = await screen.findByTestId('detail-hero-raw-inventory');
    expect(String(line.props.children)).toBe('Lightly Played  ·  Holofoil  ·  Qty 3');
  });

  it('shows the slab cert + quantity line in the hero when an owned graded entry is selected', async () => {
    const baseRepository = createTestSpotlightRepository();
    const gradedEntry: InventoryCardEntry = {
      addedAt: '2026-04-27T12:00:00.000Z',
      cardId: 'sm7-1',
      cardNumber: '#001/096',
      conditionCode: null,
      conditionLabel: null,
      conditionShortLabel: null,
      costBasisPerUnit: null,
      costBasisTotal: null,
      currencyCode: 'USD',
      hasMarketPrice: true,
      id: 'graded-treecko-psa10',
      imageUrl: 'https://cdn.spotlight.test/sm7/treecko-psa10.png',
      kind: 'graded',
      marketPrice: 52,
      name: 'Treecko',
      quantity: 1,
      setName: 'Sky Stream',
      slabContext: {
        certNumber: '00012345',
        grade: '10',
        grader: 'PSA',
        variantName: 'PSA 10',
      },
      variantName: 'PSA 10',
    };

    renderWithProviders(
      <CardDetailScreen
        cardId="sm7-1"
        entryId="graded-treecko-psa10"
        onBack={jest.fn()}
        onOpenAddToCollection={jest.fn()}
      />,
      {
        spotlightRepository: createTestSpotlightRepository({
          getCardDetail: async (query) => {
            const detail = await baseRepository.getCardDetail(query);
            return detail
              ? ({ ...detail, ownedEntries: [gradedEntry] } satisfies CardDetailRecord)
              : null;
          },
        }),
      },
    );

    expect(await screen.findByText('Treecko')).toBeTruthy();
    expect((await screen.findByTestId('detail-hero-slab-meta')).props.children).toBe('PSA • 10');
    const certQty = await screen.findByTestId('detail-hero-slab-cert-quantity');
    expect(String(certQty.props.children)).toBe('Cert #00012345  ·  Qty 1');
  });

  it('lets a slab user toggle between PSA grades and refetches pricing with the override', async () => {
    const baseRepository = createTestSpotlightRepository();
    const gradedEntry: InventoryCardEntry = {
      addedAt: '2026-04-27T12:00:00.000Z',
      cardId: 'sm7-1',
      cardNumber: '#001/096',
      conditionCode: null,
      conditionLabel: null,
      conditionShortLabel: null,
      costBasisPerUnit: null,
      costBasisTotal: null,
      currencyCode: 'USD',
      hasMarketPrice: true,
      id: 'graded-treecko-psa10-toggle',
      imageUrl: 'https://cdn.spotlight.test/sm7/treecko-psa10.png',
      kind: 'graded',
      marketPrice: 52,
      name: 'Treecko',
      quantity: 1,
      setName: 'Sky Stream',
      slabContext: {
        certNumber: '00012345',
        grade: '10',
        grader: 'PSA',
        variantName: 'PSA 10',
      },
      variantName: 'PSA 10',
    };
    const getCardMarketHistory = jest.fn(async () => null);

    renderWithProviders(
      <CardDetailScreen
        cardId="sm7-1"
        entryId="graded-treecko-psa10-toggle"
        onBack={jest.fn()}
        onOpenAddToCollection={jest.fn()}
      />,
      {
        spotlightRepository: createTestSpotlightRepository({
          getCardDetail: async (query) => {
            const detail = await baseRepository.getCardDetail(query);
            return detail
              ? ({ ...detail, ownedEntries: [gradedEntry] } satisfies CardDetailRecord)
              : null;
          },
          getCardMarketHistory,
        }),
      },
    );

    expect(await screen.findByText('Treecko')).toBeTruthy();
    expect(String(screen.getByTestId('detail-condition-dropdown-label').props.children)).toBe('PSA 10');

    fireEvent.press(screen.getByTestId('detail-condition-dropdown'));
    fireEvent.press(await screen.findByTestId('detail-condition-dropdown-option-9'));

    await waitFor(() => {
      expect(String(screen.getByTestId('detail-condition-dropdown-label').props.children)).toBe('PSA 9');
      expect(getCardMarketHistory).toHaveBeenLastCalledWith(expect.objectContaining({
        slabContext: expect.objectContaining({ grader: 'PSA', grade: '9' }),
      }));
    });

    // Hero still shows the user's actual slab grade — only the pricing lens changed.
    expect((await screen.findByTestId('detail-hero-slab-meta')).props.children).toBe('PSA • 10');
  });

  it('omits the Sell icon when isOwned but onOpenSell is undefined', async () => {
    renderWithProviders(
      <CardDetailScreen
        cardId="xyp-111"
        entryId="entry-3"
        onBack={jest.fn()}
        onOpenAddToCollection={jest.fn()}
      />,
    );

    expect(await screen.findByText('Celebi')).toBeTruthy();
    expect(screen.queryByTestId('detail-sell-card')).toBeNull();
  });

  it('defaults the timeframe selector to 30d and offers only 7d and 30d', async () => {
    renderWithProviders(
      <CardDetailScreen
        cardId="sm7-1"
        onBack={jest.fn()}
        onOpenAddToCollection={jest.fn()}
      />,
    );

    expect(await screen.findByText('Treecko')).toBeTruthy();
    expect(screen.getByTestId('detail-timeframe-dropdown')).toBeTruthy();
    expect(String(screen.getByTestId('detail-timeframe-dropdown-label').props.children)).toBe('30d');

    fireEvent.press(screen.getByTestId('detail-timeframe-dropdown'));
    expect(await screen.findByTestId('detail-timeframe-dropdown-option-7d')).toBeTruthy();
    expect(screen.getByTestId('detail-timeframe-dropdown-option-30d')).toBeTruthy();
    expect(screen.queryByTestId('detail-timeframe-dropdown-option-90d')).toBeNull();
    expect(screen.queryByTestId('detail-timeframe-dropdown-option-180d')).toBeNull();
    expect(screen.queryByTestId('detail-timeframe-dropdown-option-1y')).toBeNull();
    expect(screen.queryByTestId('detail-timeframe-dropdown-option-all')).toBeNull();
  });

  it('opens the timeframe dropdown and selects 7d', async () => {
    renderWithProviders(
      <CardDetailScreen
        cardId="sm7-1"
        onBack={jest.fn()}
        onOpenAddToCollection={jest.fn()}
      />,
    );

    expect(await screen.findByText('Treecko')).toBeTruthy();
    expect(String(screen.getByTestId('detail-timeframe-dropdown-label').props.children)).toBe('30d');

    fireEvent.press(screen.getByTestId('detail-timeframe-dropdown'));
    fireEvent.press(await screen.findByTestId('detail-timeframe-dropdown-option-7d'));

    await waitFor(() => {
      expect(String(screen.getByTestId('detail-timeframe-dropdown-label').props.children)).toBe('7d');
    });
  });

  it('renders the slab last-sold rows (capped at 2) for slab entries with recent eBay sales', async () => {
    const baseRepository = createTestSpotlightRepository();
    const gradedEntry: InventoryCardEntry = {
      addedAt: '2026-04-27T12:00:00.000Z',
      cardId: 'sm7-1',
      cardNumber: '#001/096',
      conditionCode: null,
      conditionLabel: null,
      conditionShortLabel: null,
      costBasisPerUnit: null,
      costBasisTotal: null,
      currencyCode: 'USD',
      hasMarketPrice: true,
      id: 'graded-treecko-entry',
      imageUrl: 'https://cdn.spotlight.test/sm7/treecko-psa10.png',
      kind: 'graded',
      marketPrice: 52,
      name: 'Treecko',
      quantity: 1,
      setName: '裂空のカリスマ',
      slabContext: {
        certNumber: '12345678',
        grade: '10',
        grader: 'PSA',
        variantName: 'PSA 10',
      },
      variantName: 'PSA 10',
    };
    const getCardRecentSales = jest.fn(async () => ({
      source: 'ebay' as const,
      status: 'available' as const,
      statusReason: null,
      unavailableReason: null,
      fetchedAt: '2026-05-03T12:00:00.000Z',
      canRefresh: false,
      saleCount: 3,
      sales: [
        {
          id: 'sale-1',
          title: 'Newest PSA 10 sale',
          soldAt: '2026-05-02T10:00:00.000Z',
          priceAmount: 52,
          currencyCode: 'USD',
          saleUrl: 'https://www.ebay.com/itm/1',
        },
        {
          id: 'sale-2',
          title: 'Middle PSA 10 sale',
          soldAt: '2026-04-30T10:00:00.000Z',
          priceAmount: 50,
          currencyCode: 'USD',
          saleUrl: 'https://www.ebay.com/itm/2',
        },
        {
          id: 'sale-3',
          title: 'Older PSA 10 sale',
          soldAt: '2026-04-20T10:00:00.000Z',
          priceAmount: 48,
          currencyCode: 'USD',
          saleUrl: 'https://www.ebay.com/itm/3',
        },
      ],
    }));

    renderWithProviders(
      <CardDetailScreen
        cardId="sm7-1"
        entryId="graded-treecko-entry"
        onBack={jest.fn()}
        onOpenAddToCollection={jest.fn()}
        onOpenSell={jest.fn()}
      />,
      {
        spotlightRepository: createTestSpotlightRepository({
          getCardDetail: async (query) => {
            const detail = await baseRepository.getCardDetail(query);
            return detail
              ? ({
                  ...detail,
                  ownedEntries: [gradedEntry],
                } satisfies CardDetailRecord)
              : null;
          },
          getCardRecentSales,
        }),
      },
    );

    expect(await screen.findByText('Treecko')).toBeTruthy();
    expect(await screen.findByTestId('detail-slab-last-sold')).toBeTruthy();
    expect(screen.getByText('Latest sales from eBay')).toBeTruthy();
    expect(screen.queryByText('Last sold · eBay')).toBeNull();
    expect(screen.getByTestId('detail-slab-last-sold-row-0')).toBeTruthy();
    expect(screen.getByTestId('detail-slab-last-sold-row-1')).toBeTruthy();
    expect(screen.queryByTestId('detail-slab-last-sold-row-2')).toBeNull();

    await waitFor(() => {
      expect(getCardRecentSales).toHaveBeenCalledWith({
        cardId: 'sm7-1',
        limit: 25,
        slabContext: gradedEntry.slabContext,
        source: 'ebay',
      });
    });
  });

  it('expands beyond two rows when Load more sales is pressed', async () => {
    const baseRepository = createTestSpotlightRepository();
    const gradedEntry: InventoryCardEntry = {
      addedAt: '2026-04-27T12:00:00.000Z',
      cardId: 'sm7-1',
      cardNumber: '#001/096',
      conditionCode: null,
      conditionLabel: null,
      conditionShortLabel: null,
      costBasisPerUnit: null,
      costBasisTotal: null,
      currencyCode: 'USD',
      hasMarketPrice: true,
      id: 'graded-load-more-entry',
      imageUrl: 'https://cdn.spotlight.test/sm7/treecko-psa10.png',
      kind: 'graded',
      marketPrice: 52,
      name: 'Treecko',
      quantity: 1,
      setName: '裂空のカリスマ',
      slabContext: {
        certNumber: '00000001',
        grade: '10',
        grader: 'PSA',
        variantName: 'PSA 10',
      },
      variantName: 'PSA 10',
    };
    const getCardRecentSales = jest.fn(async () => ({
      source: 'ebay' as const,
      status: 'available' as const,
      statusReason: null,
      unavailableReason: null,
      fetchedAt: '2026-05-03T12:00:00.000Z',
      canRefresh: false,
      saleCount: 4,
      sales: [
        {
          id: 'sale-a',
          title: 'Sale A',
          soldAt: '2026-05-02T10:00:00.000Z',
          priceAmount: 52,
          currencyCode: 'USD',
          saleUrl: 'https://www.ebay.com/itm/a',
        },
        {
          id: 'sale-b',
          title: 'Sale B',
          soldAt: '2026-05-01T10:00:00.000Z',
          priceAmount: 51,
          currencyCode: 'USD',
          saleUrl: 'https://www.ebay.com/itm/b',
        },
        {
          id: 'sale-c',
          title: 'Sale C',
          soldAt: '2026-04-28T10:00:00.000Z',
          priceAmount: 49,
          currencyCode: 'USD',
          saleUrl: 'https://www.ebay.com/itm/c',
        },
        {
          id: 'sale-d',
          title: 'Sale D',
          soldAt: '2026-04-25T10:00:00.000Z',
          priceAmount: 47,
          currencyCode: 'USD',
          saleUrl: 'https://www.ebay.com/itm/d',
        },
      ],
    }));

    renderWithProviders(
      <CardDetailScreen
        cardId="sm7-1"
        entryId="graded-load-more-entry"
        onBack={jest.fn()}
        onOpenAddToCollection={jest.fn()}
        onOpenSell={jest.fn()}
      />,
      {
        spotlightRepository: createTestSpotlightRepository({
          getCardDetail: async (query) => {
            const detail = await baseRepository.getCardDetail(query);
            return detail
              ? ({ ...detail, ownedEntries: [gradedEntry] } satisfies CardDetailRecord)
              : null;
          },
          getCardRecentSales,
        }),
      },
    );

    expect(await screen.findByText('Treecko')).toBeTruthy();
    expect(await screen.findByTestId('detail-slab-last-sold-row-0')).toBeTruthy();
    expect(screen.getByTestId('detail-slab-last-sold-row-1')).toBeTruthy();
    expect(screen.queryByTestId('detail-slab-last-sold-row-2')).toBeNull();
    expect(screen.queryByTestId('detail-slab-last-sold-row-3')).toBeNull();

    const loadMoreButton = screen.getByTestId('detail-slab-load-more-sales');
    expect(loadMoreButton).toBeTruthy();

    fireEvent.press(loadMoreButton);

    await waitFor(() => {
      expect(screen.getByTestId('detail-slab-last-sold-row-2')).toBeTruthy();
      expect(screen.getByTestId('detail-slab-last-sold-row-3')).toBeTruthy();
    });
    expect(screen.queryByTestId('detail-slab-load-more-sales')).toBeNull();
  });

  it('renders the empty-state copy when a slab returns zero eBay sales', async () => {
    const baseRepository = createTestSpotlightRepository();
    const gradedEntry: InventoryCardEntry = {
      addedAt: '2026-04-27T12:00:00.000Z',
      cardId: 'sm7-1',
      cardNumber: '#001/096',
      conditionCode: null,
      conditionLabel: null,
      conditionShortLabel: null,
      costBasisPerUnit: null,
      costBasisTotal: null,
      currencyCode: 'USD',
      hasMarketPrice: true,
      id: 'graded-empty-sales-entry',
      imageUrl: 'https://cdn.spotlight.test/sm7/treecko-psa10.png',
      kind: 'graded',
      marketPrice: 52,
      name: 'Treecko',
      quantity: 1,
      setName: '裂空のカリスマ',
      slabContext: {
        certNumber: '00000002',
        grade: '9',
        grader: 'PSA',
        variantName: 'PSA 9',
      },
      variantName: 'PSA 9',
    };
    const getCardRecentSales = jest.fn(async () => ({
      source: 'ebay' as const,
      status: 'available' as const,
      statusReason: 'no_results' as const,
      unavailableReason: null,
      fetchedAt: null,
      canRefresh: false,
      saleCount: 0,
      sales: [],
    }));

    renderWithProviders(
      <CardDetailScreen
        cardId="sm7-1"
        entryId="graded-empty-sales-entry"
        onBack={jest.fn()}
        onOpenAddToCollection={jest.fn()}
        onOpenSell={jest.fn()}
      />,
      {
        spotlightRepository: createTestSpotlightRepository({
          getCardDetail: async (query) => {
            const detail = await baseRepository.getCardDetail(query);
            return detail
              ? ({ ...detail, ownedEntries: [gradedEntry] } satisfies CardDetailRecord)
              : null;
          },
          getCardRecentSales,
        }),
      },
    );

    expect(await screen.findByText('Treecko')).toBeTruthy();
    expect(await screen.findByText('Latest sales from eBay')).toBeTruthy();
    const emptyBlock = await screen.findByTestId('detail-slab-last-sold-empty');
    expect(emptyBlock).toBeTruthy();
    expect(screen.queryByTestId('detail-slab-last-sold-row-0')).toBeNull();
    expect(screen.queryByTestId('detail-slab-load-more-sales')).toBeNull();
  });

  it('does not render the slab last-sold section for raw entries', async () => {
    const getCardRecentSales = jest.fn(async () => null);

    renderWithProviders(
      <CardDetailScreen
        cardId="xyp-111"
        entryId="entry-3"
        onBack={jest.fn()}
        onOpenAddToCollection={jest.fn()}
        onOpenSell={jest.fn()}
      />,
      {
        spotlightRepository: createTestSpotlightRepository({
          getCardRecentSales,
        }),
      },
    );

    expect(await screen.findByText('Celebi')).toBeTruthy();
    expect(screen.queryByTestId('detail-slab-last-sold')).toBeNull();
    expect(screen.queryByTestId('detail-slab-last-sold-row-0')).toBeNull();
    expect(getCardRecentSales).not.toHaveBeenCalled();
  });

  it('opens the slab last-sold row sale URL in the browser and tracks the event', async () => {
    const openUrlSpy = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
    const baseRepository = createTestSpotlightRepository();
    const gradedEntry: InventoryCardEntry = {
      addedAt: '2026-04-27T12:00:00.000Z',
      cardId: 'sm7-1',
      cardNumber: '#001/096',
      conditionCode: null,
      conditionLabel: null,
      conditionShortLabel: null,
      costBasisPerUnit: null,
      costBasisTotal: null,
      currencyCode: 'USD',
      hasMarketPrice: true,
      id: 'graded-open-entry',
      imageUrl: 'https://cdn.spotlight.test/sm7/treecko-psa10.png',
      kind: 'graded',
      marketPrice: 52,
      name: 'Treecko',
      quantity: 1,
      setName: '裂空のカリスマ',
      slabContext: {
        certNumber: '22334455',
        grade: '10',
        grader: 'PSA',
        variantName: 'PSA 10',
      },
      variantName: 'PSA 10',
    };
    const getCardRecentSales = jest.fn().mockResolvedValue({
      source: 'ebay',
      status: 'available',
      statusReason: null,
      unavailableReason: null,
      fetchedAt: '2026-05-03T12:00:00.000Z',
      canRefresh: false,
      saleCount: 1,
      sales: [
        {
          id: 'sale-open-1',
          title: 'PSA 10 Treecko recent sale',
          soldAt: '2026-05-02T10:00:00.000Z',
          priceAmount: 52,
          currencyCode: 'USD',
          saleUrl: 'https://www.ebay.com/itm/open-1',
        },
      ],
    });

    renderWithProviders(
      <CardDetailScreen
        cardId="sm7-1"
        entryId="graded-open-entry"
        onBack={jest.fn()}
        onOpenAddToCollection={jest.fn()}
        onOpenSell={jest.fn()}
      />,
      {
        spotlightRepository: createTestSpotlightRepository({
          getCardDetail: async (query) => {
            const detail = await baseRepository.getCardDetail(query);
            return detail ? { ...detail, ownedEntries: [gradedEntry] } : null;
          },
          getCardRecentSales,
        }),
      },
    );

    expect(await screen.findByText('Treecko')).toBeTruthy();
    expect(await screen.findByTestId('detail-slab-last-sold-row-0')).toBeTruthy();

    fireEvent.press(screen.getByTestId('detail-slab-last-sold-row-0'));
    expect(openUrlSpy).toHaveBeenCalledWith('https://www.ebay.com/itm/open-1');
    expect(capturePostHogEvent).toHaveBeenCalledWith('card_recent_sales_row_opened', expect.objectContaining({
      detail_kind: 'slab',
      row_index: 0,
      sales_provider: 'scrydex',
      sales_source: 'ebay',
    }));

    openUrlSpy.mockRestore();
  });

  it('uses slab scan-review context for recent sales before an inventory entry exists', async () => {
    const getCardRecentSales = jest.fn(async () => ({
      source: 'ebay' as const,
      status: 'available' as const,
      statusReason: null,
      unavailableReason: null,
      fetchedAt: '2026-05-03T12:00:00.000Z',
      canRefresh: false,
      saleCount: 1,
      sales: [
        {
          id: 'sale-charizard-psa9',
          title: 'PSA 9 Charizard recent sale',
          soldAt: '2026-05-02T10:00:00.000Z',
          priceAmount: 2271.15,
          currencyCode: 'USD',
          saleUrl: 'https://www.ebay.com/itm/987',
        },
      ],
    }));
    const scanReviewId = saveScanCandidateReviewSession({
      id: 'scan-review-charizard-slab',
      selectedCardId: 'base1-4',
      normalizedImageDimensions: { height: 357, width: 751 },
      normalizedImageUri: 'file:///tmp/normalized-slab.jpg',
      slabContext: {
        grader: 'PSA',
        grade: '9',
        certNumber: '70539858',
        variantName: 'PSA 9',
      },
      candidates: [
        {
          id: 'base1-4-candidate',
          cardId: 'base1-4',
          name: 'Charizard',
          cardNumber: '#4/102',
          setName: 'Base',
          imageUrl: 'https://images.pokemontcg.io/base1/4.png',
          marketPrice: 2271.15,
          currencyCode: 'USD',
        },
      ],
    });

    renderWithProviders(
      <CardDetailScreen
        cardId="base1-4"
        onBack={jest.fn()}
        onOpenAddToCollection={jest.fn()}
        onOpenSell={jest.fn()}
        scanReviewId={scanReviewId}
      />,
      {
        spotlightRepository: createTestSpotlightRepository({
          getCardRecentSales,
        }),
      },
    );

    expect(await screen.findByText('Charizard')).toBeTruthy();
    expect(screen.getByTestId('detail-hero-slab-meta').props.children).toBe('PSA • 9');
    expect(screen.getByTestId('detail-market-price').props.children).toBe('$2,271.15');
    expect(await screen.findByTestId('detail-slab-last-sold')).toBeTruthy();
    expect(await screen.findByText('PSA 9 Charizard recent sale')).toBeTruthy();
    await waitFor(() => {
      expect(getCardRecentSales).toHaveBeenCalledWith({
        cardId: 'base1-4',
        limit: 25,
        slabContext: {
          grader: 'PSA',
          grade: '9',
          certNumber: '70539858',
          variantName: 'PSA 9',
        },
        source: 'ebay',
      });
    });
  });

  it('renders "Refreshed Xh ago" instead of legacy "Prices · " prefix when a recent fetchedAt is present', async () => {
    const baseRepository = createTestSpotlightRepository();
    const gradedEntry: InventoryCardEntry = {
      addedAt: '2026-04-27T12:00:00.000Z',
      cardId: 'sm7-1',
      cardNumber: '#001/096',
      conditionCode: null,
      conditionLabel: null,
      conditionShortLabel: null,
      costBasisPerUnit: null,
      costBasisTotal: null,
      currencyCode: 'USD',
      hasMarketPrice: true,
      id: 'graded-freshness-entry',
      imageUrl: 'https://cdn.spotlight.test/sm7/treecko-psa10.png',
      kind: 'graded',
      marketPrice: 52,
      name: 'Treecko',
      quantity: 1,
      setName: '裂空のカリスマ',
      slabContext: {
        certNumber: '99999999',
        grade: '10',
        grader: 'PSA',
        variantName: 'PSA 10',
      },
      variantName: 'PSA 10',
    };
    const fetchedAt = new Date(Date.now() - 2 * 3_600_000).toISOString();
    const getCardRecentSales = jest.fn(async () => ({
      source: 'ebay' as const,
      status: 'available' as const,
      statusReason: null,
      unavailableReason: null,
      fetchedAt,
      canRefresh: false,
      saleCount: 1,
      sales: [
        {
          id: 'sale-freshness',
          title: 'PSA 10 freshness sale',
          soldAt: '2026-05-02T10:00:00.000Z',
          priceAmount: 52,
          currencyCode: 'USD',
          saleUrl: 'https://www.ebay.com/itm/freshness',
        },
      ],
    }));

    renderWithProviders(
      <CardDetailScreen
        cardId="sm7-1"
        entryId="graded-freshness-entry"
        onBack={jest.fn()}
        onOpenAddToCollection={jest.fn()}
        onOpenSell={jest.fn()}
      />,
      {
        spotlightRepository: createTestSpotlightRepository({
          getCardDetail: async (query) => {
            const detail = await baseRepository.getCardDetail(query);
            return detail
              ? ({ ...detail, ownedEntries: [gradedEntry] } satisfies CardDetailRecord)
              : null;
          },
          getCardRecentSales,
        }),
      },
    );

    const freshness = await screen.findByTestId('detail-prices-freshness');
    expect(String(freshness.props.children).startsWith('Refreshed')).toBe(true);
    expect(String(freshness.props.children)).not.toContain('Prices ·');
  });

  it('shows scan alternatives in the header chip and opens the candidate review', async () => {
    const onOpenScanCandidateReview = jest.fn();
    const scanReviewId = saveScanCandidateReviewSession({
      id: 'scan-review-oshawott',
      selectedCardId: 'mcdonalds25-21',
      normalizedImageDimensions: { height: 880, width: 630 },
      normalizedImageUri: 'file:///tmp/normalized-scan.jpg',
      candidates: [
        {
          id: 'mcdonalds25-21-candidate',
          cardId: 'mcdonalds25-21',
          name: 'Oshawott',
          cardNumber: '#21/25',
          setName: "McDonald's Collection 2021",
          imageUrl: 'https://images.pokemontcg.io/mcdonalds25/21.png',
          marketPrice: 0.56,
          currencyCode: 'USD',
        },
        ...Array.from({ length: 9 }, (_, index) => ({
          id: `similar-${index}`,
          cardId: `similar-${index}`,
          name: `Similar Card ${index + 1}`,
          cardNumber: `#${index + 1}/99`,
          setName: 'Candidate Set',
          imageUrl: `https://cdn.spotlight.test/similar-${index}.png`,
          marketPrice: index + 1,
          currencyCode: 'USD',
        })),
      ],
    });

    renderWithProviders(
      <CardDetailScreen
        cardId="mcdonalds25-21"
        entryId="entry-2"
        onBack={jest.fn()}
        onOpenAddToCollection={jest.fn()}
        onOpenScanCandidateReview={onOpenScanCandidateReview}
        onOpenSell={jest.fn()}
        scanReviewId={scanReviewId}
      />,
    );

    expect(await screen.findByText('Oshawott')).toBeTruthy();
    expect(screen.getByText('View on TCGplayer')).toBeTruthy();
    expect(screen.getByTestId('detail-similar-cards-button')).toBeTruthy();
    expect(screen.getByText('9 similar')).toBeTruthy();

    fireEvent.press(screen.getByTestId('detail-similar-cards-button'));
    expect(onOpenScanCandidateReview).toHaveBeenCalledWith(scanReviewId);
  });

  it('hides the similar-cards chip when no scanReviewId is provided', async () => {
    renderWithProviders(
      <CardDetailScreen
        cardId="sm7-1"
        onBack={jest.fn()}
        onOpenAddToCollection={jest.fn()}
      />,
    );

    expect(await screen.findByText('Treecko')).toBeTruthy();
    expect(screen.queryByTestId('detail-similar-cards-button')).toBeNull();
  });

  it('renders the scan candidate immediately while full card detail hydrates', async () => {
    const baseRepository = createTestSpotlightRepository();
    let resolveDetail: ((detail: CardDetailRecord | null) => void) | undefined;
    const repository = createTestSpotlightRepository({
      getCardDetail: async () => new Promise((resolve) => {
        resolveDetail = resolve;
      }),
    });
    const scanReviewId = saveScanCandidateReviewSession({
      id: 'scan-review-preview',
      selectedCardId: 'mcdonalds25-21',
      normalizedImageDimensions: { height: 880, width: 630 },
      normalizedImageUri: 'file:///tmp/normalized-scan.jpg',
      candidates: [
        {
          id: 'mcdonalds25-21-candidate',
          cardId: 'mcdonalds25-21',
          name: 'Oshawott',
          cardNumber: '#21/25',
          setName: "McDonald's Collection 2021",
          imageUrl: 'https://images.pokemontcg.io/mcdonalds25/21.png',
          marketPrice: 0.56,
          currencyCode: 'USD',
        },
      ],
    });

    renderWithProviders(
      <CardDetailScreen
        cardId="mcdonalds25-21"
        entryId="entry-2"
        onBack={jest.fn()}
        onOpenAddToCollection={jest.fn()}
        onOpenSell={jest.fn()}
        scanReviewId={scanReviewId}
      />,
      { spotlightRepository: repository },
    );

    expect(screen.getByTestId('detail-hero-card')).toBeTruthy();
    expect(screen.queryByText('Loading card...')).toBeNull();
    expect(screen.getByText('Oshawott')).toBeTruthy();
    expect(screen.getByText('#21/25 • McDonald\'s Collection 2021')).toBeTruthy();
    expect(screen.getByText('View on TCGplayer')).toBeTruthy();

    await waitFor(() => {
      expect(resolveDetail).toBeTruthy();
    });

    const resolvedDetail = await baseRepository.getCardDetail({ cardId: 'mcdonalds25-21' });
    await act(async () => {
      resolveDetail?.(resolvedDetail);
    });

    expect(await screen.findByTestId('detail-condition-dropdown')).toBeTruthy();
  });

  it('renders an add-card catalog preview immediately while full card detail hydrates', () => {
    const previewId = saveCardDetailPreviewFromCatalogResult({
      id: 'catalog-preview-treecko',
      cardId: 'catalog-preview-treecko',
      name: 'Preview Treecko',
      cardNumber: '#001/096',
      setName: 'Celestial Storm',
      imageUrl: 'https://cdn.spotlight.test/preview-treecko.png',
      marketPrice: 12.34,
      currencyCode: 'USD',
      ownedQuantity: 0,
    });
    const pendingCardDetail = new Promise<CardDetailRecord | null>(() => {});
    const pendingMarketHistory = new Promise<CardDetailRecord['marketHistory'] | null>(() => {});
    const pendingEbayListings = new Promise<null>(() => {});

    renderWithProviders(
      <CardDetailScreen
        cardId="catalog-preview-treecko"
        onBack={jest.fn()}
        onOpenAddToCollection={jest.fn()}
        previewId={previewId}
      />,
      {
        spotlightRepository: createTestSpotlightRepository({
          getCardDetail: async () => pendingCardDetail,
          getCardMarketHistory: async () => pendingMarketHistory,
          getCardEbayListings: async () => pendingEbayListings,
        }),
      },
    );

    expect(screen.queryByText('Loading card...')).toBeNull();
    expect(screen.getByText('Preview Treecko')).toBeTruthy();
    expect(screen.getByText('#001/096 • Celestial Storm')).toBeTruthy();
    expect(screen.getByText('View on TCGplayer')).toBeTruthy();
    expect(screen.queryByTestId('detail-sell-card')).toBeNull();
    expect(screen.getByText('$12.34')).toBeTruthy();
  });

  it('renders an owned inventory preview immediately while full card detail hydrates', () => {
    const ownedEntry: InventoryCardEntry = {
      addedAt: '2026-04-27T12:00:00.000Z',
      cardId: 'owned-preview-osha',
      cardNumber: '#021/025',
      conditionCode: 'near_mint',
      conditionLabel: 'Near Mint',
      conditionShortLabel: 'NM',
      costBasisPerUnit: null,
      costBasisTotal: null,
      currencyCode: 'USD',
      hasMarketPrice: true,
      id: 'owned-preview-entry',
      imageUrl: 'https://cdn.spotlight.test/owned-osha.png',
      kind: 'raw',
      marketPrice: 56.78,
      name: 'Preview Oshawott',
      quantity: 2,
      setName: "McDonald's Collection 2021",
      variantName: 'Raw',
    };
    const previewId = saveCardDetailPreviewFromInventoryEntry(ownedEntry);
    const pendingCardDetail = new Promise<CardDetailRecord | null>(() => {});
    const pendingMarketHistory = new Promise<CardDetailRecord['marketHistory'] | null>(() => {});
    const pendingEbayListings = new Promise<null>(() => {});

    renderWithProviders(
      <CardDetailScreen
        cardId="owned-preview-osha"
        entryId="owned-preview-entry"
        onBack={jest.fn()}
        onOpenAddToCollection={jest.fn()}
        onOpenSell={jest.fn()}
        previewId={previewId}
      />,
      {
        spotlightRepository: createTestSpotlightRepository({
          getCardDetail: async () => pendingCardDetail,
          getCardMarketHistory: async () => pendingMarketHistory,
          getCardEbayListings: async () => pendingEbayListings,
        }),
      },
    );

    expect(screen.queryByText('Loading card...')).toBeNull();
    expect(screen.getByText('Preview Oshawott')).toBeTruthy();
    expect(screen.getByText('#021/025 • McDonald\'s Collection 2021')).toBeTruthy();
    expect(screen.getByTestId('detail-sell-card')).toBeTruthy();
    expect(screen.getAllByText('$56.78').length).toBeGreaterThan(0);
  });

  it('renders the inline View on TCGplayer row inside the pricing card for raw cards', async () => {
    renderWithProviders(
      <CardDetailScreen
        cardId="sm7-1"
        onBack={jest.fn()}
        onOpenAddToCollection={jest.fn()}
      />,
    );

    expect(await screen.findByText('Treecko')).toBeTruthy();
    const marketCard = screen.getByTestId('detail-market-card');
    const marketplaceCta = screen.getByTestId('detail-marketplace-cta');
    expect(marketplaceCta).toBeTruthy();
    expect(marketCard.findByProps({ testID: 'detail-marketplace-cta' })).toBeTruthy();
  });

  it('does not render the inline TCGplayer row for slab cards', async () => {
    const baseRepository = createTestSpotlightRepository();
    const gradedEntry: InventoryCardEntry = {
      addedAt: '2026-04-27T12:00:00.000Z',
      cardId: 'sm7-1',
      cardNumber: '#001/096',
      conditionCode: null,
      conditionLabel: null,
      conditionShortLabel: null,
      costBasisPerUnit: null,
      costBasisTotal: null,
      currencyCode: 'USD',
      hasMarketPrice: true,
      id: 'graded-no-tcgplayer-entry',
      imageUrl: 'https://cdn.spotlight.test/sm7/treecko-psa10.png',
      kind: 'graded',
      marketPrice: 52,
      name: 'Treecko',
      quantity: 1,
      setName: '裂空のカリスマ',
      slabContext: {
        certNumber: '11111111',
        grade: '10',
        grader: 'PSA',
        variantName: 'PSA 10',
      },
      variantName: 'PSA 10',
    };

    renderWithProviders(
      <CardDetailScreen
        cardId="sm7-1"
        entryId="graded-no-tcgplayer-entry"
        onBack={jest.fn()}
        onOpenAddToCollection={jest.fn()}
        onOpenSell={jest.fn()}
      />,
      {
        spotlightRepository: createTestSpotlightRepository({
          getCardDetail: async (query) => {
            const detail = await baseRepository.getCardDetail(query);
            return detail
              ? ({ ...detail, ownedEntries: [gradedEntry] } satisfies CardDetailRecord)
              : null;
          },
        }),
      },
    );

    expect(await screen.findByText('Treecko')).toBeTruthy();
    expect(screen.queryByTestId('detail-marketplace-cta')).toBeNull();
    expect(screen.queryByText('View on TCGplayer')).toBeNull();
  });

  it('renders an unavailable state when the repository returns no local card detail', async () => {
    renderWithProviders(
      <CardDetailScreen
        cardId="missing-card-id"
        onBack={jest.fn()}
        onOpenAddToCollection={jest.fn()}
      />,
    );

    expect(await screen.findByText('Card unavailable')).toBeTruthy();
    expect(screen.getByText('We could not find this card in the local catalog.')).toBeTruthy();
  });
});
