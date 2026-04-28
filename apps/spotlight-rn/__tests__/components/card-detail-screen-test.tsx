import { act, fireEvent, screen, waitFor, within } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

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

describe('CardDetailScreen', () => {
  afterEach(() => {
    clearCardDetailPreviewSessions();
    clearScanCandidateReviewSessions();
  });

  it('shows the hero and add-to-collection CTA for cards not yet owned', async () => {
    const onBack = jest.fn();
    const onOpenAddToCollection = jest.fn();

    renderWithProviders(
      <CardDetailScreen
        cardId="sm7-1"
        onBack={onBack}
        onOpenAddToCollection={onOpenAddToCollection}
      />,
    );

    expect(await screen.findByText('Treecko')).toBeTruthy();
    expect(screen.getByTestId('detail-back')).toBeTruthy();
    expect(screen.getByTestId('sell-backdrop')).toBeTruthy();
    expect(screen.getByTestId('detail-hero-card')).toBeTruthy();
    expect(screen.getByTestId('detail-market-card')).toBeTruthy();
    expect(screen.getByTestId('detail-ebay-card')).toBeTruthy();
    expect(screen.getByTestId('detail-marketplace-cta')).toBeTruthy();
    expect(screen.getByTestId('detail-marketplace-icon')).toBeTruthy();
    expect(screen.getByText('ADD TO COLLECTION')).toBeTruthy();
    expect(screen.getByText('TCGPLAYER BUYING OPTIONS')).toBeTruthy();
    expect(screen.getByText('Lowest active eBay listings')).toBeTruthy();
    expect(screen.getByText('NM')).toBeTruthy();
    expect(screen.getByText('LP')).toBeTruthy();
    expect(screen.getByText('MP')).toBeTruthy();
    expect(screen.getByText('HP')).toBeTruthy();
    expect(screen.getByText('DMG')).toBeTruthy();
    expect(screen.getByText('#001/096 • 裂空のカリスマ')).toBeTruthy();
    expect(screen.getByText('View all on eBay')).toBeTruthy();
    expect(screen.queryByText('Not in collection')).toBeNull();
    expect(screen.queryByText('Add to track pricing')).toBeNull();
    expect(screen.queryByText('Confirm the exact card details before adding it to your collection.')).toBeNull();
    expect(screen.queryByText('LOOK UP MARKET')).toBeNull();
    expect(screen.getByTestId('detail-condition-chip-near_mint')).toBeTruthy();
    expect(StyleSheet.flatten(screen.getByTestId('detail-hero-meta').props.style)).toMatchObject({
      fontSize: 15,
      lineHeight: 20,
    });
    expect(StyleSheet.flatten(screen.getByTestId('detail-add-to-collection').props.style)).toMatchObject({
      minHeight: 48,
    });
    expect(StyleSheet.flatten(screen.getByTestId('detail-marketplace-cta').props.style)).toMatchObject({
      minHeight: 48,
    });
    expect(StyleSheet.flatten(screen.getByText('ADD TO COLLECTION').props.style)).toMatchObject({
      fontSize: 15,
      lineHeight: 20,
      textAlign: 'left',
    });
    expect(StyleSheet.flatten(screen.getByText('TCGPLAYER BUYING OPTIONS').props.style)).toMatchObject({
      fontSize: 15,
      lineHeight: 20,
    });
    expect(StyleSheet.flatten(screen.getByText('View all on eBay').props.style)).toMatchObject({
      fontSize: 15,
      lineHeight: 20,
    });
    expect(StyleSheet.flatten(screen.getByTestId('detail-market-header-label').props.style)).toMatchObject({
      fontSize: 18,
      lineHeight: 22,
    });

    fireEvent.press(screen.getByTestId('detail-back'));
    expect(onBack).toHaveBeenCalled();

    fireEvent.press(screen.getByTestId('detail-add-to-collection'));
    expect(onOpenAddToCollection).toHaveBeenCalledWith('sm7-1');
  });

  it('renders market condition prices when the backend returns short condition ids', async () => {
    const baseRepository = createTestSpotlightRepository();
    const repository = createTestSpotlightRepository({
      getCardDetail: async (query) => {
        const detail = await baseRepository.getCardDetail(query);
        if (!detail) {
          return null;
        }

        return {
          ...detail,
          marketHistory: {
            ...detail.marketHistory,
            availableConditions: detail.marketHistory.availableConditions.map((condition) => {
              const shortIdByLabel: Record<string, string> = {
                Damaged: 'DMG',
                'Heavily Played': 'HP',
                'Lightly Played': 'LP',
                'Moderately Played': 'MP',
                'Near Mint': 'NM',
              };

              return {
                ...condition,
                id: shortIdByLabel[condition.label] ?? condition.id,
              };
            }),
            selectedCondition: 'NM',
          },
        } satisfies CardDetailRecord;
      },
      getCardMarketHistory: async (query) => {
        const detail = await baseRepository.getCardDetail(query);
        if (!detail) {
          return null;
        }

        return {
          ...detail.marketHistory,
          availableConditions: detail.marketHistory.availableConditions.map((condition) => {
            const shortIdByLabel: Record<string, string> = {
              Damaged: 'DMG',
              'Heavily Played': 'HP',
              'Lightly Played': 'LP',
              'Moderately Played': 'MP',
              'Near Mint': 'NM',
            };

            return {
              ...condition,
              id: shortIdByLabel[condition.label] ?? condition.id,
            };
          }),
          selectedCondition: 'NM',
        };
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
    expect(within(screen.getByTestId('detail-condition-chip-near_mint')).getByText('$0.31')).toBeTruthy();
    expect(within(screen.getByTestId('detail-condition-chip-lightly_played')).getByText('$0.22')).toBeTruthy();
  });

  it('updates the large market value when a different condition chip is selected', async () => {
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

    fireEvent.press(screen.getByTestId('detail-condition-chip-lightly_played'));

    await waitFor(() => {
      expect(screen.getByTestId('detail-market-price').props.children).toBe('$0.22');
      expect(getCardMarketHistory).toHaveBeenLastCalledWith(expect.objectContaining({
        cardId: 'sm7-1',
        condition: 'lightly_played',
        days: 30,
      }));
    });
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

  it('renders the collection summary for owned cards', async () => {
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
    expect(screen.getByText('In your collection')).toBeTruthy();
    expect(screen.queryByText('1 copy tracked')).toBeNull();
    expect(screen.getByTestId('detail-collection-card')).toBeTruthy();
    expect(screen.getByTestId('detail-collection-edit-entry-3')).toBeTruthy();
    expect(StyleSheet.flatten(screen.getByTestId('detail-collection-art-entry-3').props.style)).toMatchObject({
      height: '100%',
      resizeMode: 'cover',
      width: '100%',
    });
    expect(screen.getByTestId('detail-sell-card')).toBeTruthy();
    expect(screen.getByText('SELL CARD')).toBeTruthy();
    expect(screen.queryByTestId('detail-add-to-collection')).toBeNull();
    expect(screen.queryByText('In collection')).toBeNull();
    expect(screen.getByText('Near Mint • Raw')).toBeTruthy();
    expect(screen.queryByText('Qty 1 in collection')).toBeNull();
    expect(screen.queryByText('Ready to sell')).toBeNull();
    expect(screen.queryByText('Open the sell sheet for this owned card.')).toBeNull();
    expect(StyleSheet.flatten(screen.getByTestId('detail-sell-card').props.style)).toMatchObject({
      minHeight: 48,
    });
    expect(StyleSheet.flatten(screen.getByText('SELL CARD').props.style)).toMatchObject({
      fontSize: 15,
      lineHeight: 20,
      textAlign: 'left',
    });
    expect(StyleSheet.flatten(screen.getByTestId('detail-collection-header-label').props.style)).toMatchObject({
      paddingRight: 4,
    });
    expect(StyleSheet.flatten(screen.getByTestId('detail-collection-chevron-slot').props.style)).toMatchObject({
      height: 20,
      marginLeft: -2,
      width: 20,
    });
    expect(StyleSheet.flatten(screen.getByTestId('detail-collection-summary-entry-3').props.style)).toMatchObject({
      fontSize: 14,
      lineHeight: 18,
    });
    expect(StyleSheet.flatten(screen.getByTestId('detail-collection-price-entry-3').props.style)).toMatchObject({
      fontSize: 16,
      lineHeight: 20,
    });
    expect(StyleSheet.flatten(screen.getByTestId('detail-collection-quantity-entry-3').props.style)).toMatchObject({
      fontSize: 14,
      lineHeight: 16,
    });
    expect(StyleSheet.flatten(screen.getByTestId('detail-collection-controls-entry-3').props.style)).toMatchObject({
      minHeight: 40,
      paddingHorizontal: 4,
    });

    fireEvent.press(screen.getByTestId('detail-collection-header-toggle'));
    expect(screen.queryByTestId('detail-collection-card')).toBeNull();
    expect(StyleSheet.flatten(screen.getByTestId('detail-collection-chevron-slot').props.style)).toMatchObject({
      height: 20,
      marginLeft: -2,
      width: 20,
    });

    fireEvent.press(screen.getByTestId('detail-collection-header-toggle'));
    expect(screen.getByTestId('detail-collection-card')).toBeTruthy();

    fireEvent.press(screen.getByTestId('detail-sell-card'));
    expect(onOpenSell).toHaveBeenCalledWith('entry-3');

    fireEvent.press(screen.getByTestId('detail-collection-edit-entry-3'));
    expect(onOpenAddToCollection).toHaveBeenCalledWith('xyp-111', 'entry-3');
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
    expect(screen.getByText('TCGPLAYER BUYING OPTIONS')).toBeTruthy();
    expect(screen.getByTestId('detail-similar-cards-button')).toBeTruthy();
    expect(screen.getByText('9 similar cards found')).toBeTruthy();
    expect(screen.queryByText('Best guess only. Check similar matches.')).toBeNull();
    expect(StyleSheet.flatten(screen.getByTestId('detail-similar-cards-button').props.style)).toMatchObject({
      minHeight: 48,
    });
    expect(StyleSheet.flatten(screen.getByTestId('detail-similar-cards-title').props.style)).toMatchObject({
      fontFamily: 'SpotlightBodySemiBold',
      fontSize: 15,
      lineHeight: 20,
      textAlign: 'left',
    });

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
    expect(screen.getByTestId('detail-scan-preview-market')).toBeTruthy();
    expect(screen.queryByText('Loading card...')).toBeNull();
    expect(screen.getByText('Oshawott')).toBeTruthy();
    expect(screen.getByText('#21/25 • McDonald\'s Collection 2021')).toBeTruthy();
    expect(screen.getByText('$0.56')).toBeTruthy();
    expect(screen.getByText('TCGPLAYER BUYING OPTIONS')).toBeTruthy();
    expect(screen.queryByText('Chart history is still populating.')).toBeNull();

    await waitFor(() => {
      expect(resolveDetail).toBeTruthy();
    });

    const resolvedDetail = await baseRepository.getCardDetail({ cardId: 'mcdonalds25-21' });
    await act(async () => {
      resolveDetail?.(resolvedDetail);
    });

    expect(await screen.findByTestId('detail-condition-chip-near_mint')).toBeTruthy();
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
    expect(screen.getByText('ADD TO COLLECTION')).toBeTruthy();
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
    expect(screen.queryByText('ADD TO COLLECTION')).toBeNull();
    expect(screen.getByTestId('detail-collection-card')).toBeTruthy();
    expect(screen.getAllByText('$56.78').length).toBeGreaterThan(0);
  });

  it('renders differentiated owned rows when the same card is held in multiple conditions', async () => {
    const onOpenAddToCollection = jest.fn();
    const repository = createTestSpotlightRepository();
    const addedVariant = await repository.createPortfolioBuy({
      boughtAt: '2026-04-24T12:00:00.000Z',
      cardID: 'xyp-111',
      condition: 'lightly_played',
      currencyCode: 'USD',
      paymentMethod: null,
      quantity: 1,
      slabContext: null,
      sourceScanID: null,
      unitPrice: 22,
      variantName: 'Reverse Holo',
    });

    renderWithProviders(
      <CardDetailScreen
        cardId="xyp-111"
        entryId="entry-3"
        onBack={jest.fn()}
        onOpenAddToCollection={onOpenAddToCollection}
        onOpenSell={jest.fn()}
      />,
      { spotlightRepository: repository },
    );

    expect(await screen.findByText('Celebi')).toBeTruthy();
    expect(screen.getByText('In your collection (2)')).toBeTruthy();
    expect(screen.getAllByTestId(/detail-collection-row-/)).toHaveLength(2);
    expect(screen.getByTestId('detail-collection-row-entry-3')).toBeTruthy();
    expect(screen.getByTestId(`detail-collection-row-${addedVariant.deckEntryID}`)).toBeTruthy();
    expect(screen.getByTestId('detail-collection-divider-1')).toBeTruthy();
    expect(screen.getByText('Near Mint • Raw')).toBeTruthy();
    expect(screen.getByText('Lightly Played • Reverse Holo')).toBeTruthy();

    fireEvent.press(screen.getByTestId(`detail-collection-edit-${addedVariant.deckEntryID}`));
    expect(onOpenAddToCollection).toHaveBeenCalledWith('xyp-111', addedVariant.deckEntryID);
  });

  it('shows the default variant label for older raw rows that were stored without an explicit variant name', async () => {
    const baseRepository = createTestSpotlightRepository();
    const repository = createTestSpotlightRepository({
      getCardDetail: async (query) => {
        const detail = await baseRepository.getCardDetail(query);
        if (!detail || query.cardId !== 'xyp-111') {
          return detail;
        }

        return {
          ...detail,
          variantOptions: [
            { id: 'Holofoil', label: 'Holofoil', currentPrice: detail.marketPrice },
            { id: 'Reverse Holofoil', label: 'Reverse Holofoil', currentPrice: detail.marketPrice + 1 },
          ],
          marketHistory: {
            ...detail.marketHistory,
            availableVariants: [
              { id: 'Holofoil', label: 'Holofoil', currentPrice: detail.marketPrice },
              { id: 'Reverse Holofoil', label: 'Reverse Holofoil', currentPrice: detail.marketPrice + 1 },
            ],
          },
          ownedEntries: detail.ownedEntries.map((entry) => ({
            ...entry,
            variantName: null,
          })),
        } satisfies CardDetailRecord;
      },
    });

    renderWithProviders(
      <CardDetailScreen
        cardId="xyp-111"
        entryId="entry-3"
        onBack={jest.fn()}
        onOpenAddToCollection={jest.fn()}
        onOpenSell={jest.fn()}
      />,
      { spotlightRepository: repository },
    );

    expect(await screen.findByText('Celebi')).toBeTruthy();
    expect(screen.getByText('Near Mint • Holofoil')).toBeTruthy();
  });

  it('decrements quantity from the trash control without opening sell', async () => {
    const repository = createTestSpotlightRepository();
    const onOpenSell = jest.fn();

    renderWithProviders(
      <CardDetailScreen
        cardId="mcdonalds25-21"
        entryId="entry-2"
        onBack={jest.fn()}
        onOpenAddToCollection={jest.fn()}
        onOpenSell={onOpenSell}
      />,
      { spotlightRepository: repository },
    );

    expect(await screen.findByText('Oshawott')).toBeTruthy();
    expect(screen.getByTestId('detail-collection-quantity-entry-2').props.children).toBe(2);

    fireEvent.press(screen.getByTestId('detail-collection-decrement-entry-2'));

    await waitFor(() => {
      expect(screen.getByTestId('detail-collection-quantity-entry-2').props.children).toBe(1);
    });
    expect(onOpenSell).not.toHaveBeenCalled();
  });

  it('removes the collection row when the last quantity is trashed', async () => {
    const repository = createTestSpotlightRepository();

    renderWithProviders(
      <CardDetailScreen
        cardId="xyp-111"
        entryId="entry-3"
        onBack={jest.fn()}
        onOpenAddToCollection={jest.fn()}
        onOpenSell={jest.fn()}
      />,
      { spotlightRepository: repository },
    );

    expect(await screen.findByText('Celebi')).toBeTruthy();
    expect(screen.getByTestId('detail-collection-card')).toBeTruthy();

    fireEvent.press(screen.getByTestId('detail-collection-decrement-entry-3'));

    await waitFor(() => {
      expect(screen.queryByTestId('detail-collection-card')).toBeNull();
    });
    expect(screen.getByTestId('detail-add-to-collection')).toBeTruthy();
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
