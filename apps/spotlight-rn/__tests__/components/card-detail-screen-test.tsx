import { Children, isValidElement, type ReactElement } from 'react';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react-native';
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

import { createTestSpotlightRepository, renderWithProviders } from '../test-utils';

jest.mock('@/lib/observability/posthog', () => ({
  capturePostHogEvent: jest.fn(),
}));

const mockUseSuggestedDiscount = jest.fn(() => ({ discountPct: null as number | null, setDiscountPct: jest.fn() }));
jest.mock('@/features/pricing/use-suggested-discount', () => ({
  useSuggestedDiscount: () => mockUseSuggestedDiscount(),
}));

import { capturePostHogEvent } from '@/lib/observability/posthog';

describe('CardDetailScreen', () => {
  beforeEach(() => {
    mockUseSuggestedDiscount.mockReturnValue({ discountPct: null, setDiscountPct: jest.fn() });
  });

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
    expect(screen.getByTestId('detail-history-card')).toBeTruthy();
    expect(screen.getByTestId('detail-marketplace-cta')).toBeTruthy();
    expect(screen.getByTestId('detail-marketplace-icon')).toBeTruthy();
    expect(screen.getByText('View on TCGplayer')).toBeTruthy();
    expect(screen.getByText('#001/096 • 裂空のカリスマ')).toBeTruthy();
    expect(screen.queryByText('Recent Sales')).toBeNull();
    expect(screen.queryByTestId('detail-recent-sales-card')).toBeNull();
    expect(screen.queryByTestId('detail-collection-card')).toBeNull();
    expect(getCardRecentSales).not.toHaveBeenCalled();

    // Action stack: favorite, add-to-collection, overflow
    const stackIds = Children.toArray(screen.getByTestId('detail-action-stack').props.children)
      .filter((child): child is ReactElement<{ testID?: string }> => isValidElement(child))
      .map((child) => child.props.testID)
      .filter(Boolean);
    expect(stackIds).toEqual([
      'detail-favorite-card',
      'detail-add-to-collection',
      'detail-overflow-menu',
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
    expect(within(nearMintOption).getByText('$0.31')).toBeTruthy();
    expect(within(lpOption).getByText('$0.22')).toBeTruthy();
  });

  it('does not render negative y-axis labels for sub-dollar market history', async () => {
    const baseRepository = createTestSpotlightRepository();
    const lowValueHistory: CardDetailRecord['marketHistory'] = {
      currencyCode: 'USD',
      currentPrice: 0.13,
      points: [
        { isoDate: '2026-04-16', shortLabel: 'Apr 16', value: 0.13 },
        { isoDate: '2026-04-20', shortLabel: 'Apr 20', value: 0.13 },
        { isoDate: '2026-04-24', shortLabel: 'Apr 24', value: 0.14 },
        { isoDate: '2026-04-27', shortLabel: 'Apr 27', value: 0.13 },
      ],
      availableVariants: [],
      availableConditions: [
        { id: 'lightly_played', label: 'LP', currentPrice: 0.13 },
        { id: 'near_mint', label: 'NM', currentPrice: 0.16 },
      ],
      selectedCondition: 'lightly_played',
      insights: [],
    };

    renderWithProviders(
      <CardDetailScreen
        cardId="sm7-1"
        onBack={jest.fn()}
        onOpenAddToCollection={jest.fn()}
      />,
      {
        spotlightRepository: createTestSpotlightRepository({
          getCardDetail: async (query) => {
            const detail = await baseRepository.getCardDetail(query);
            if (!detail) {
              return null;
            }

            return {
              ...detail,
              marketPrice: 0.13,
              marketHistory: lowValueHistory,
            } satisfies CardDetailRecord;
          },
          getCardMarketHistory: async () => lowValueHistory,
        }),
      },
    );

    expect(await screen.findByText('Treecko')).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByTestId('detail-market-price').props.children).toBe('$0.13');
    });

    const gridLabels = [0, 1, 2, 3].map((index) => (
      String(screen.getByTestId(`detail-market-grid-label-${index}`).props.children)
    ));

    gridLabels.forEach((label) => {
      expect(label.startsWith('-')).toBe(false);
    });
  });

  it('shows the SELL CARD button for owned cards and triggers onOpenSell', async () => {
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
    expect(screen.getByText('SELL CARD')).toBeTruthy();
    // No collection sub-card any more; access via overflow / add icon
    expect(screen.queryByTestId('detail-collection-card')).toBeNull();
    expect(screen.getByTestId('detail-add-to-collection')).toBeTruthy();

    fireEvent.press(screen.getByTestId('detail-sell-card'));
    expect(onOpenSell).toHaveBeenCalledWith('entry-3');

    // overflow → edit-collection routes through onOpenAddToCollection with entry id
    fireEvent.press(screen.getByTestId('detail-overflow-menu'));
    fireEvent.press(await screen.findByTestId('detail-overflow-edit-collection'));
    expect(onOpenAddToCollection).toHaveBeenCalledWith('xyp-111', 'entry-3');
  });

  it('hides the suggested price column when discountPct is null', async () => {
    mockUseSuggestedDiscount.mockReturnValue({ discountPct: null, setDiscountPct: jest.fn() });

    renderWithProviders(
      <CardDetailScreen
        cardId="sm7-1"
        onBack={jest.fn()}
        onOpenAddToCollection={jest.fn()}
      />,
    );

    expect(await screen.findByText('Treecko')).toBeTruthy();
    expect(screen.queryByTestId('detail-suggested-price')).toBeNull();
    expect(screen.queryByTestId('detail-suggested-price-column')).toBeNull();
  });

  it('renders the suggested price when discountPct is non-null', async () => {
    mockUseSuggestedDiscount.mockReturnValue({ discountPct: 10, setDiscountPct: jest.fn() });

    renderWithProviders(
      <CardDetailScreen
        cardId="xyp-111"
        onBack={jest.fn()}
        onOpenAddToCollection={jest.fn()}
      />,
    );

    expect(await screen.findByText('Celebi')).toBeTruthy();
    const node = await screen.findByTestId('detail-suggested-price');
    expect(node).toBeTruthy();
    // marketPrice for xyp-111 = $37.54 → 37.54 * 0.9 = $33.79 (rounded to 2)
    expect(String(node.props.children)).toBe('$33.79');
    expect(String(screen.getByTestId('detail-suggested-price-label').props.children)).toBe('Suggested (−10%)');
  });

  it('toggles the price-details body open and closed via the Show more / Show less control', async () => {
    renderWithProviders(
      <CardDetailScreen
        cardId="sm7-1"
        onBack={jest.fn()}
        onOpenAddToCollection={jest.fn()}
      />,
    );

    expect(await screen.findByText('Treecko')).toBeTruthy();
    expect(screen.queryByTestId('detail-price-details-body')).toBeNull();
    expect(screen.getByText('Show more')).toBeTruthy();

    fireEvent.press(screen.getByTestId('detail-price-details-toggle'));
    expect(screen.getByTestId('detail-price-details-body')).toBeTruthy();
    expect(screen.getByTestId('detail-trend-chip-row')).toBeTruthy();
    expect(screen.getByText('Show less')).toBeTruthy();

    fireEvent.press(screen.getByTestId('detail-price-details-toggle'));
    expect(screen.queryByTestId('detail-price-details-body')).toBeNull();
  });

  it('renders em-dashes in trend chips when trendsPct values are absent', async () => {
    renderWithProviders(
      <CardDetailScreen
        cardId="sm7-1"
        onBack={jest.fn()}
        onOpenAddToCollection={jest.fn()}
      />,
    );

    expect(await screen.findByText('Treecko')).toBeTruthy();
    fireEvent.press(screen.getByTestId('detail-price-details-toggle'));

    for (const id of ['detail-trend-chip-7d', 'detail-trend-chip-30d', 'detail-trend-chip-90d']) {
      const chip = screen.getByTestId(id);
      expect(within(chip).getByText('—')).toBeTruthy();
    }
  });

  it('renders signed percent values in trend chips when trendsPct is provided', async () => {
    const baseRepository = createTestSpotlightRepository();

    renderWithProviders(
      <CardDetailScreen
        cardId="sm7-1"
        onBack={jest.fn()}
        onOpenAddToCollection={jest.fn()}
      />,
      {
        spotlightRepository: createTestSpotlightRepository({
          getCardDetail: async (query) => {
            const detail = await baseRepository.getCardDetail(query);
            return detail
              ? ({
                  ...detail,
                  trendsPct: { days7: 12.3, days30: -4.5, days90: null },
                } satisfies CardDetailRecord)
              : null;
          },
        }),
      },
    );

    expect(await screen.findByText('Treecko')).toBeTruthy();
    fireEvent.press(screen.getByTestId('detail-price-details-toggle'));

    expect(within(screen.getByTestId('detail-trend-chip-7d')).getByText('+12.3%')).toBeTruthy();
    expect(within(screen.getByTestId('detail-trend-chip-30d')).getByText('-4.5%')).toBeTruthy();
    expect(within(screen.getByTestId('detail-trend-chip-90d')).getByText('—')).toBeTruthy();
  });

  it('defaults the timeframe selector to 90d', async () => {
    renderWithProviders(
      <CardDetailScreen
        cardId="sm7-1"
        onBack={jest.fn()}
        onOpenAddToCollection={jest.fn()}
      />,
    );

    expect(await screen.findByText('Treecko')).toBeTruthy();
    expect(screen.getByTestId('detail-timeframe-row')).toBeTruthy();
    for (const id of ['7d', '30d', '90d', '180d', '1y', 'all']) {
      expect(screen.getByTestId(`detail-timeframe-${id}`)).toBeTruthy();
    }

    // The 90d chip should have the "selected" border color = theme brand.
    const chip = screen.getByTestId('detail-timeframe-90d');
    const sevenDay = screen.getByTestId('detail-timeframe-7d');
    const flatten = (style: unknown): Record<string, unknown> => {
      const arr = Array.isArray(style) ? style : [style];
      return arr.reduce<Record<string, unknown>>((acc, entry) => {
        if (entry && typeof entry === 'object') {
          return { ...acc, ...(entry as Record<string, unknown>) };
        }
        return acc;
      }, {});
    };
    const chipStyle = flatten(chip.props.style);
    const sevenDayStyle = flatten(sevenDay.props.style);
    expect(chipStyle.borderColor).not.toBe(sevenDayStyle.borderColor);
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
    expect(screen.getByTestId('detail-slab-last-sold-row-0')).toBeTruthy();
    expect(screen.getByTestId('detail-slab-last-sold-row-1')).toBeTruthy();
    // capped at 2 rows
    expect(screen.queryByTestId('detail-slab-last-sold-row-2')).toBeNull();
    expect(within(screen.getByTestId('detail-slab-last-sold-row-0')).getByText('Newest PSA 10 sale')).toBeTruthy();
    expect(within(screen.getByTestId('detail-slab-last-sold-row-1')).getByText('Middle PSA 10 sale')).toBeTruthy();

    await waitFor(() => {
      expect(getCardRecentSales).toHaveBeenCalledWith({
        cardId: 'sm7-1',
        limit: 25,
        slabContext: gradedEntry.slabContext,
        source: 'ebay',
      });
    });
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

  it('shows scan alternatives under the marketplace CTA and opens the candidate review', async () => {
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
    expect(screen.getByText('9 similar cards found')).toBeTruthy();

    fireEvent.press(screen.getByTestId('detail-similar-cards-button'));
    expect(onOpenScanCandidateReview).toHaveBeenCalledWith(scanReviewId);
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
    expect(screen.queryByText('SELL CARD')).toBeNull();
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
    expect(screen.getByText('SELL CARD')).toBeTruthy();
    expect(screen.getAllByText('$56.78').length).toBeGreaterThan(0);
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
