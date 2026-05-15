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

    // For not-owned cards the hero shows an Add-to-collection button and a top-right favorite,
    // not the quantity stepper or Sell.
    expect(screen.getByTestId('detail-add-to-collection')).toBeTruthy();
    expect(screen.getByTestId('detail-favorite-card')).toBeTruthy();
    expect(screen.queryByTestId('detail-quantity-stepper')).toBeNull();
    expect(screen.queryByTestId('detail-sell-card')).toBeNull();
    expect(screen.queryByTestId('detail-edit-collection-entry')).toBeNull();

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

  it('shows quantity stepper + Sell button for owned cards and routes increment/edit/sell correctly', async () => {
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
    expect(screen.getByTestId('detail-quantity-stepper')).toBeTruthy();
    expect(screen.getByTestId('detail-quantity-increment')).toBeTruthy();
    expect(screen.getByTestId('detail-edit-collection-entry')).toBeTruthy();
    expect(screen.getByTestId('detail-sell-card')).toBeTruthy();
    // The standalone Add icon is hidden when owned — stepper handles add-another via `+`.
    expect(screen.queryByTestId('detail-add-to-collection')).toBeNull();

    fireEvent.press(screen.getByTestId('detail-sell-card'));
    expect(onOpenSell).toHaveBeenCalledWith('entry-3');

    fireEvent.press(screen.getByTestId('detail-quantity-increment'));
    expect(onOpenAddToCollection).toHaveBeenLastCalledWith('xyp-111', undefined);

    fireEvent.press(screen.getByTestId('detail-edit-collection-entry'));
    expect(onOpenAddToCollection).toHaveBeenLastCalledWith('xyp-111', 'entry-3');
  });

  it('routes the yellow Sell button to the Stripe sell flow when onOpenStripeSell is provided, and shows Buy/Trade actions', async () => {
    const onOpenSell = jest.fn();
    const onOpenStripeSell = jest.fn();
    const onOpenBuy = jest.fn();
    const onOpenTrade = jest.fn();

    renderWithProviders(
      <CardDetailScreen
        cardId="xyp-111"
        entryId="entry-3"
        onBack={jest.fn()}
        onOpenAddToCollection={jest.fn()}
        onOpenBuy={onOpenBuy}
        onOpenSell={onOpenSell}
        onOpenStripeSell={onOpenStripeSell}
        onOpenTrade={onOpenTrade}
      />,
    );

    expect(await screen.findByText('Celebi')).toBeTruthy();

    // Yellow Sell button is rendered with the Stripe-preferred Bolt icon.
    expect(screen.getByTestId('detail-sell-card')).toBeTruthy();
    expect(screen.getByTestId('detail-buy-card')).toBeTruthy();
    expect(screen.getByTestId('detail-trade-card')).toBeTruthy();

    // Pressing the yellow Sell button prefers the Stripe flow when available.
    fireEvent.press(screen.getByTestId('detail-sell-card'));
    expect(onOpenStripeSell).toHaveBeenCalledWith('entry-3');
    expect(onOpenSell).not.toHaveBeenCalled();

    fireEvent.press(screen.getByTestId('detail-buy-card'));
    expect(onOpenBuy).toHaveBeenCalledWith('xyp-111');

    fireEvent.press(screen.getByTestId('detail-trade-card'));
    expect(onOpenTrade).toHaveBeenCalledWith('xyp-111');
  });

  it('toggles favorite on and off via the top-right heart, persisting via setCardFavorite', async () => {
    const baseRepository = createTestSpotlightRepository();
    let nextIsFavorite = false;
    const setCardFavorite = jest.fn(async (_cardId: string, isFavorite?: boolean | null) => {
      nextIsFavorite = isFavorite ?? !nextIsFavorite;
      return {
        cardId: 'sm7-1',
        favoritedAt: nextIsFavorite ? '2026-05-15T00:00:00.000Z' : null,
        isFavorite: nextIsFavorite,
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
          getCardDetail: baseRepository.getCardDetail.bind(baseRepository),
          setCardFavorite,
        }),
      },
    );

    expect(await screen.findByText('Treecko')).toBeTruthy();
    const heart = screen.getByTestId('detail-favorite-card');
    expect(heart.props.accessibilityLabel).toBe('Favorite card');

    fireEvent.press(heart);
    await waitFor(() => {
      expect(setCardFavorite).toHaveBeenLastCalledWith('sm7-1', true);
      expect(screen.getByTestId('detail-favorite-card').props.accessibilityLabel).toBe('Remove from favorites');
    });

    fireEvent.press(screen.getByTestId('detail-favorite-card'));
    await waitFor(() => {
      expect(setCardFavorite).toHaveBeenLastCalledWith('sm7-1', false);
      expect(screen.getByTestId('detail-favorite-card').props.accessibilityLabel).toBe('Favorite card');
    });
  });

  it('decrements quantity via replacePortfolioEntry when qty > 1', async () => {
    const baseRepository = createTestSpotlightRepository();
    const gradedEntry: InventoryCardEntry = {
      addedAt: '2026-04-27T12:00:00.000Z',
      cardId: 'sm7-1',
      cardNumber: '#001/096',
      conditionCode: null,
      conditionLabel: null,
      conditionShortLabel: null,
      costBasisPerUnit: 25,
      costBasisTotal: 75,
      currencyCode: 'USD',
      hasMarketPrice: true,
      id: 'entry-qty-3',
      imageUrl: 'https://cdn.spotlight.test/sm7/treecko-psa10.png',
      kind: 'graded',
      marketPrice: 30,
      name: 'Treecko',
      quantity: 3,
      setName: 'Sky Stream',
      slabContext: {
        certNumber: '00012345',
        grade: '10',
        grader: 'PSA',
        variantName: 'PSA 10',
      },
      variantName: 'PSA 10',
    };
    const replacePortfolioEntry = jest.fn(async () => ({
      cardID: 'sm7-1',
      deckEntryID: 'entry-qty-3',
      previousDeckEntryID: 'entry-qty-3',
      quantity: 2,
      unitPrice: 25,
      updatedAt: '2026-05-15T00:00:00.000Z',
    }));

    renderWithProviders(
      <CardDetailScreen
        cardId="sm7-1"
        entryId="entry-qty-3"
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
          replacePortfolioEntry,
        }),
      },
    );

    expect(await screen.findByText('Treecko')).toBeTruthy();
    expect(screen.queryByTestId('detail-quantity-delete')).toBeNull();
    expect(screen.getByTestId('detail-quantity-decrement')).toBeTruthy();

    fireEvent.press(screen.getByTestId('detail-quantity-decrement'));

    await waitFor(() => {
      expect(replacePortfolioEntry).toHaveBeenCalledWith(expect.objectContaining({
        cardID: 'sm7-1',
        deckEntryID: 'entry-qty-3',
        quantity: 2,
        unitPrice: 25,
      }));
    });
  });

  it('shows the trash icon when qty === 1 and confirms before deleting', async () => {
    const baseRepository = createTestSpotlightRepository();
    const rawEntry: InventoryCardEntry = {
      addedAt: '2026-04-27T12:00:00.000Z',
      cardId: 'sm7-1',
      cardNumber: '#001/096',
      conditionCode: 'near_mint',
      conditionLabel: 'Near Mint',
      conditionShortLabel: 'NM',
      costBasisPerUnit: null,
      costBasisTotal: null,
      currencyCode: 'USD',
      hasMarketPrice: true,
      id: 'entry-solo-raw',
      imageUrl: 'https://cdn.spotlight.test/sm7/treecko.png',
      kind: 'raw',
      marketPrice: 2,
      name: 'Treecko',
      quantity: 1,
      setName: 'Sky Stream',
      variantName: null,
    };
    const deletePortfolioEntry = jest.fn(async () => ({
      cardID: 'sm7-1',
      deckEntryID: 'entry-solo-raw',
    }));
    const onBack = jest.fn();

    renderWithProviders(
      <CardDetailScreen
        cardId="sm7-1"
        entryId="entry-solo-raw"
        onBack={onBack}
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
          deletePortfolioEntry,
        }),
      },
    );

    expect(await screen.findByText('Treecko')).toBeTruthy();
    expect(screen.getByTestId('detail-quantity-delete')).toBeTruthy();
    expect(screen.queryByTestId('detail-quantity-decrement')).toBeNull();

    fireEvent.press(screen.getByTestId('detail-quantity-delete'));
    expect(await screen.findByTestId('detail-delete-confirm-confirm')).toBeTruthy();
    expect(deletePortfolioEntry).not.toHaveBeenCalled();

    // Cancel keeps the entry.
    fireEvent.press(screen.getByTestId('detail-delete-confirm-cancel'));
    await waitFor(() => {
      expect(screen.queryByTestId('detail-delete-confirm-confirm')).toBeNull();
    });
    expect(deletePortfolioEntry).not.toHaveBeenCalled();

    // Re-open and confirm: triggers delete + navigates back.
    fireEvent.press(screen.getByTestId('detail-quantity-delete'));
    fireEvent.press(await screen.findByTestId('detail-delete-confirm-confirm'));

    await waitFor(() => {
      expect(deletePortfolioEntry).toHaveBeenCalledWith({ deckEntryID: 'entry-solo-raw' });
      expect(onBack).toHaveBeenCalled();
    });
  });

  it('shows the Add to collection button (no stepper) when the card is not owned', async () => {
    renderWithProviders(
      <CardDetailScreen
        cardId="sm7-1"
        onBack={jest.fn()}
        onOpenAddToCollection={jest.fn()}
        onOpenSell={jest.fn()}
      />,
    );

    expect(await screen.findByText('Treecko')).toBeTruthy();
    expect(screen.getByTestId('detail-add-to-collection')).toBeTruthy();
    expect(screen.queryByTestId('detail-quantity-stepper')).toBeNull();
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

  it('renders all available sales (capped at 5) once the user presses Load eBay sales for a slab entry', async () => {
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
    expect(screen.getByTestId('detail-slab-load-ebay-sales')).toBeTruthy();
    // Sales should not be fetched until the user explicitly opts in.
    expect(getCardRecentSales).not.toHaveBeenCalled();
    expect(screen.queryByTestId('detail-slab-last-sold-row-0')).toBeNull();

    fireEvent.press(screen.getByTestId('detail-slab-load-ebay-sales'));

    await waitFor(() => {
      expect(screen.getByTestId('detail-slab-last-sold-row-0')).toBeTruthy();
      expect(screen.getByTestId('detail-slab-last-sold-row-1')).toBeTruthy();
      expect(screen.getByTestId('detail-slab-last-sold-row-2')).toBeTruthy();
    });
    expect(getCardRecentSales).toHaveBeenCalledWith({
      cardId: 'sm7-1',
      limit: 25,
      refresh: true,
      slabContext: gradedEntry.slabContext,
      source: 'ebay',
    });
  });

  it('expands beyond five rows when Load more sales is pressed', async () => {
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
    const buildSale = (id: string, daysAgo: number, priceAmount: number) => ({
      id,
      title: `Sale ${id.toUpperCase()}`,
      soldAt: new Date(Date.parse('2026-05-03T10:00:00.000Z') - daysAgo * 86400000).toISOString(),
      priceAmount,
      currencyCode: 'USD',
      saleUrl: `https://www.ebay.com/itm/${id}`,
    });
    const getCardRecentSales = jest.fn(async () => ({
      source: 'ebay' as const,
      status: 'available' as const,
      statusReason: null,
      unavailableReason: null,
      fetchedAt: '2026-05-03T12:00:00.000Z',
      canRefresh: false,
      saleCount: 7,
      sales: [
        buildSale('a', 1, 52),
        buildSale('b', 2, 51),
        buildSale('c', 5, 50),
        buildSale('d', 8, 49),
        buildSale('e', 12, 48),
        buildSale('f', 15, 47),
        buildSale('g', 20, 46),
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
    fireEvent.press(await screen.findByTestId('detail-slab-load-ebay-sales'));

    await waitFor(() => {
      expect(screen.getByTestId('detail-slab-last-sold-row-4')).toBeTruthy();
    });
    expect(screen.queryByTestId('detail-slab-last-sold-row-5')).toBeNull();
    expect(screen.queryByTestId('detail-slab-last-sold-row-6')).toBeNull();

    fireEvent.press(screen.getByTestId('detail-slab-load-more-sales'));

    await waitFor(() => {
      expect(screen.getByTestId('detail-slab-last-sold-row-5')).toBeTruthy();
      expect(screen.getByTestId('detail-slab-last-sold-row-6')).toBeTruthy();
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
    // Empty state only renders after the user opts to load.
    expect(screen.queryByTestId('detail-slab-last-sold-empty')).toBeNull();

    fireEvent.press(screen.getByTestId('detail-slab-load-ebay-sales'));

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
    fireEvent.press(await screen.findByTestId('detail-slab-load-ebay-sales'));
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
    expect(getCardRecentSales).not.toHaveBeenCalled();

    fireEvent.press(await screen.findByTestId('detail-slab-load-ebay-sales'));
    expect(await screen.findByText('PSA 9 Charizard recent sale')).toBeTruthy();
    await waitFor(() => {
      expect(getCardRecentSales).toHaveBeenCalledWith({
        cardId: 'base1-4',
        limit: 25,
        refresh: true,
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
