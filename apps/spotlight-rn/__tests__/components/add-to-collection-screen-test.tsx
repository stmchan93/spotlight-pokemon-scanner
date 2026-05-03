import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import { MockSpotlightRepository } from '@spotlight/api-client';

import { AddToCollectionScreen } from '@/features/collection/screens/add-to-collection-screen';

import { createTestSpotlightRepository, renderWithProviders } from '../test-utils';

describe('AddToCollectionScreen', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('renders the sheet hero, supports graded selection, and submits', async () => {
    const onClose = jest.fn();

    renderWithProviders(
      <AddToCollectionScreen cardId="sm7-1" onClose={onClose} />,
    );

    expect(screen.queryByTestId('add-to-collection-loading')).toBeNull();
    expect(screen.getByTestId('add-to-collection-header')).toBeTruthy();
    expect(StyleSheet.flatten(screen.getByTestId('add-to-collection-header').props.style)).toMatchObject({
      paddingBottom: 8,
    });
    expect(screen.getByTestId('add-to-collection-close')).toBeTruthy();
    expect(screen.getByText('Add to Collection')).toBeTruthy();
    expect(screen.getByTestId('add-to-collection-hero')).toBeTruthy();
    expect(await screen.findByText('Treecko')).toBeTruthy();
    expect(await screen.findByText('#001/096 • 裂空のカリスマ')).toBeTruthy();
    expect(await screen.findByText('Variant')).toBeTruthy();
    expect(await screen.findByText('Grader')).toBeTruthy();
    expect(await screen.findByText('Grade')).toBeTruthy();
    expect(await screen.findByText('Near Mint')).toBeTruthy();
    expect(await screen.findByText('Lightly Played')).toBeTruthy();
    expect(await screen.findByText('Quantity')).toBeTruthy();
    expect(screen.getByText('Add to collection')).toBeTruthy();
    expect(StyleSheet.flatten(screen.getByText('Add to collection').props.style)).toMatchObject({
      fontFamily: 'SpotlightBodySemiBold',
      fontSize: 15,
      lineHeight: 20,
    });

    fireEvent.press(screen.getByTestId('add-to-collection-grader-PSA'));
    expect(screen.getByTestId('add-to-collection-grade-10')).toBeTruthy();

    fireEvent.press(screen.getByTestId('add-to-collection-quantity-increase'));
    expect(screen.getByTestId('add-to-collection-quantity-value').props.children).toBe(2);

    fireEvent.press(screen.getByTestId('submit-add-to-collection'));

    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
  });

  it('persists a meaningful default raw variant instead of collapsing it to generic raw', async () => {
    const onClose = jest.fn();
    const createPortfolioBuy = jest.fn();
    const spotlightRepository = createTestSpotlightRepository({
      getAddToCollectionOptions: async () => ({
        variants: [
          { id: 'Holofoil', label: 'Holofoil' },
          { id: 'Reverse Holofoil', label: 'Reverse Holofoil' },
        ],
        defaultVariant: 'Holofoil',
        defaultPrice: 0.31,
      }),
      createPortfolioBuy: async (payload) => {
        createPortfolioBuy(payload);
        return {
          deckEntryID: 'entry-holofoil',
          cardID: payload.cardID,
          inserted: true,
          quantityAdded: payload.quantity,
          totalSpend: payload.quantity * payload.unitPrice,
          boughtAt: payload.boughtAt,
        };
      },
    });

    renderWithProviders(
      <AddToCollectionScreen cardId="sm7-1" onClose={onClose} />,
      { spotlightRepository },
    );

    expect(await screen.findByText('Holofoil')).toBeTruthy();

    fireEvent.press(screen.getByTestId('submit-add-to-collection'));

    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
    expect(createPortfolioBuy).toHaveBeenCalledWith(expect.objectContaining({
      cardID: 'sm7-1',
      variantName: 'Holofoil',
    }));
  });

  it('prefills the selected row in edit mode and saves through replacePortfolioEntry', async () => {
    const onClose = jest.fn();
    const replacePortfolioEntry = jest.fn();
    const spotlightRepository = createTestSpotlightRepository({
      replacePortfolioEntry: async (payload) => {
        replacePortfolioEntry(payload);
        return {
          previousDeckEntryID: payload.deckEntryID,
          deckEntryID: payload.deckEntryID,
          cardID: payload.cardID,
          quantity: payload.quantity,
          unitPrice: payload.unitPrice,
          updatedAt: payload.updatedAt,
        };
      },
    });
    const added = await spotlightRepository.createPortfolioBuy({
      boughtAt: '2026-04-24T12:00:00.000Z',
      cardID: 'xyp-111',
      condition: 'lightly_played',
      currencyCode: 'USD',
      paymentMethod: null,
      quantity: 2,
      slabContext: null,
      sourceScanID: null,
      unitPrice: 22,
      variantName: 'raw',
    });

    renderWithProviders(
      <AddToCollectionScreen
        cardId="xyp-111"
        entryId={added.deckEntryID}
        onClose={onClose}
      />,
      { spotlightRepository },
    );

    expect(await screen.findByText('Edit Collection')).toBeTruthy();
    expect(screen.getByTestId('add-to-collection-quantity-value').props.children).toBe(2);

    fireEvent.press(screen.getByTestId('submit-add-to-collection'));

    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
    expect(replacePortfolioEntry).toHaveBeenCalledWith(expect.objectContaining({
      deckEntryID: added.deckEntryID,
      cardID: 'xyp-111',
      condition: 'lightly_played',
      quantity: 2,
      variantName: null,
    }));
  });

  it('shows the load error state and retries back into the sheet flow', async () => {
    jest.spyOn(MockSpotlightRepository.prototype, 'getAddToCollectionOptions')
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({
        variants: [{ id: 'normal', label: 'Normal' }],
        defaultVariant: 'normal',
        defaultPrice: 0.31,
      });

    renderWithProviders(
      <AddToCollectionScreen cardId="sm7-1" onClose={jest.fn()} />,
    );

    expect(await screen.findByText('Unable to load card')).toBeTruthy();
    expect(screen.getByText('Unable to load this card right now.')).toBeTruthy();
    expect(StyleSheet.flatten(screen.getByText('Retry').props.style)).toMatchObject({
      fontFamily: 'SpotlightBodySemiBold',
      fontSize: 15,
      lineHeight: 20,
    });

    fireEvent.press(screen.getByTestId('add-to-collection-retry'));

    expect(await screen.findByTestId('add-to-collection-hero')).toBeTruthy();
    expect(screen.getByText('Treecko')).toBeTruthy();
  });

  it('keeps the sheet open and shows a submission error when the buy call fails', async () => {
    const onClose = jest.fn();
    const spotlightRepository = createTestSpotlightRepository({
      createPortfolioBuy: async () => {
        throw new Error('write failed');
      },
    });

    renderWithProviders(
      <AddToCollectionScreen cardId="sm7-1" onClose={onClose} />,
      { spotlightRepository },
    );

    expect(await screen.findByText('Treecko')).toBeTruthy();

    fireEvent.press(screen.getByTestId('submit-add-to-collection'));

    expect(await screen.findByText('Unable to add this card right now.')).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes immediately from the top back button', async () => {
    const onClose = jest.fn();

    renderWithProviders(
      <AddToCollectionScreen cardId="sm7-1" onClose={onClose} />,
    );

    expect(await screen.findByTestId('add-to-collection-close')).toBeTruthy();

    fireEvent.press(screen.getByTestId('add-to-collection-close'));
    expect(onClose).toHaveBeenCalled();
  });
});
