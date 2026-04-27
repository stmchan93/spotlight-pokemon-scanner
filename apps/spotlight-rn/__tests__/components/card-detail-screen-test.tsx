import { fireEvent, screen, waitFor, within } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import type { CardDetailRecord } from '@spotlight/api-client';
import { CardDetailScreen } from '@/features/cards/screens/card-detail-screen';

import { createTestSpotlightRepository, renderWithProviders } from '../test-utils';

describe('CardDetailScreen', () => {
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
