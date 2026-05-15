import { fireEvent, screen, waitFor } from '@testing-library/react-native';

import { mockInventoryEntries } from '@spotlight/api-client';

import { TradeSheet } from '@/features/payments/screens/trade-sheet';

import { createTestSpotlightRepository, renderWithProviders } from '../test-utils';

describe('TradeSheet', () => {
  it('does not submit until at least one outbound card is selected', async () => {
    const createPortfolioBuy = jest.fn();
    const createPortfolioSale = jest.fn();
    const repository = createTestSpotlightRepository({
      getInventoryEntries: async () => mockInventoryEntries,
      createPortfolioBuy,
      createPortfolioSale,
    });

    renderWithProviders(
      <TradeSheet cardId="mcdonalds25-16" onClose={jest.fn()} onComplete={jest.fn()} />,
      { spotlightRepository: repository },
    );

    await waitFor(() => {
      expect(screen.getByTestId('trade-sheet-submit')).toBeTruthy();
    });

    fireEvent.press(screen.getByTestId('trade-sheet-submit'));
    expect(createPortfolioSale).not.toHaveBeenCalled();
    expect(createPortfolioBuy).not.toHaveBeenCalled();
  });

  it('records a sale per selected outbound entry, then a buy on the inbound card with the cash delta', async () => {
    const createPortfolioBuy = jest.fn(async () => ({
      deckEntryID: 'entry-x',
      cardID: 'mcdonalds25-16',
      inserted: true,
      quantityAdded: 1,
      totalSpend: 5,
      boughtAt: new Date().toISOString(),
    }));
    const createPortfolioSale = jest.fn(async () => ({
      saleID: 'sale-x',
      deckEntryID: 'entry-2',
      remainingQuantity: 1,
      grossTotal: 0.56,
      soldAt: new Date().toISOString(),
      showSessionID: null,
    }));
    const onComplete = jest.fn();
    const repository = createTestSpotlightRepository({
      getInventoryEntries: async () => mockInventoryEntries,
      createPortfolioBuy,
      createPortfolioSale,
    });

    renderWithProviders(
      <TradeSheet cardId="mcdonalds25-16" onClose={jest.fn()} onComplete={onComplete} />,
      { spotlightRepository: repository },
    );

    await waitFor(() => {
      expect(screen.getByTestId('trade-sheet-inventory-row-entry-2')).toBeTruthy();
    });

    fireEvent.press(screen.getByTestId('trade-sheet-inventory-row-entry-2'));
    fireEvent.changeText(screen.getByTestId('trade-sheet-cash-delta-input'), '5');
    fireEvent.press(screen.getByTestId('trade-sheet-submit'));

    await waitFor(() => {
      expect(createPortfolioSale).toHaveBeenCalledTimes(1);
    });
    expect(createPortfolioBuy).toHaveBeenCalledWith(
      expect.objectContaining({
        cardID: 'mcdonalds25-16',
        unitPrice: 5,
        quantity: 1,
        paymentMethod: 'trade',
      }),
    );
    expect(onComplete).toHaveBeenCalledTimes(1);
  });
});
