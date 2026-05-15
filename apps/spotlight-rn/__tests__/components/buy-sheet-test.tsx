import { fireEvent, screen, waitFor } from '@testing-library/react-native';

import { BuySheet } from '@/features/payments/screens/buy-sheet';

import { createTestSpotlightRepository, renderWithProviders } from '../test-utils';

describe('BuySheet', () => {
  it('does not call createPortfolioBuy when price is empty', async () => {
    const createPortfolioBuy = jest.fn();
    const repository = createTestSpotlightRepository({
      getCardDetail: async () => null,
      createPortfolioBuy,
    });

    renderWithProviders(
      <BuySheet cardId="mcdonalds25-16" onClose={jest.fn()} onComplete={jest.fn()} />,
      { spotlightRepository: repository },
    );

    await waitFor(() => {
      expect(screen.getByTestId('buy-sheet-submit')).toBeTruthy();
    });

    fireEvent.press(screen.getByTestId('buy-sheet-submit'));
    expect(createPortfolioBuy).not.toHaveBeenCalled();
    expect(screen.getByText('Could not log buy')).toBeTruthy();
  });

  it('submits the buy with the entered price and condition', async () => {
    const createPortfolioBuy = jest.fn(async () => ({
      deckEntryID: 'entry-x',
      cardID: 'mcdonalds25-16',
      inserted: true,
      quantityAdded: 1,
      totalSpend: 12,
      boughtAt: new Date().toISOString(),
    }));
    const onComplete = jest.fn();
    const repository = createTestSpotlightRepository({
      getCardDetail: async () => null,
      createPortfolioBuy,
    });

    renderWithProviders(
      <BuySheet cardId="mcdonalds25-16" onClose={jest.fn()} onComplete={onComplete} />,
      { spotlightRepository: repository },
    );

    await waitFor(() => {
      expect(screen.getByTestId('buy-sheet-price-input')).toBeTruthy();
    });

    fireEvent.changeText(screen.getByTestId('buy-sheet-price-input'), '12');
    fireEvent.press(screen.getByTestId('buy-sheet-condition-lightly_played'));
    fireEvent.press(screen.getByTestId('buy-sheet-submit'));

    await waitFor(() => {
      expect(createPortfolioBuy).toHaveBeenCalledTimes(1);
    });
    expect(createPortfolioBuy).toHaveBeenCalledWith(
      expect.objectContaining({
        cardID: 'mcdonalds25-16',
        condition: 'lightly_played',
        unitPrice: 12,
        quantity: 1,
      }),
    );
    expect(onComplete).toHaveBeenCalledTimes(1);
  });
});
