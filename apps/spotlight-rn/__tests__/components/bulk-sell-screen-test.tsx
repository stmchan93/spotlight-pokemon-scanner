import { act, fireEvent, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { mockInventoryEntries } from '@spotlight/api-client';

import { BulkSellScreen } from '@/features/sell/screens/bulk-sell-screen';

import { createTestSpotlightRepository, renderWithProviders } from '../test-utils';

function makeBulkSellRepository(entries = mockInventoryEntries) {
  return createTestSpotlightRepository({
    getInventoryEntries: async () => entries,
  });
}

async function enterBulkSellPriceWithCalculator(value: '6' | '12.5') {
  fireEvent.press(screen.getByTestId('bulk-sell-sold-price-smoke-raw-mcdonalds25-16'));

  if (value === '6') {
    fireEvent.press(screen.getByTestId('bulk-sell-smoke-raw-mcdonalds25-16-calculator-key-2'));
    fireEvent.press(screen.getByTestId('bulk-sell-smoke-raw-mcdonalds25-16-calculator-key-×'));
    fireEvent.press(screen.getByTestId('bulk-sell-smoke-raw-mcdonalds25-16-calculator-key-3'));
  } else {
    fireEvent.press(screen.getByTestId('bulk-sell-smoke-raw-mcdonalds25-16-calculator-key-1'));
    fireEvent.press(screen.getByTestId('bulk-sell-smoke-raw-mcdonalds25-16-calculator-key-2'));
    fireEvent.press(screen.getByTestId('bulk-sell-smoke-raw-mcdonalds25-16-calculator-key-5'));
    fireEvent.press(screen.getByTestId('bulk-sell-smoke-raw-mcdonalds25-16-calculator-key-÷'));
    fireEvent.press(screen.getByTestId('bulk-sell-smoke-raw-mcdonalds25-16-calculator-key-1'));
    fireEvent.press(screen.getByTestId('bulk-sell-smoke-raw-mcdonalds25-16-calculator-key-0'));
  }

  fireEvent.press(screen.getByTestId('bulk-sell-smoke-raw-mcdonalds25-16-calculator-equals'));
}

async function enterSecondBulkSellPriceWithCalculator(value: '6') {
  fireEvent.press(screen.getByTestId('bulk-sell-sold-price-smoke-raw-mcdonalds25-21'));

  if (value === '6') {
    fireEvent.press(screen.getByTestId('bulk-sell-smoke-raw-mcdonalds25-21-calculator-key-2'));
    fireEvent.press(screen.getByTestId('bulk-sell-smoke-raw-mcdonalds25-21-calculator-key-×'));
    fireEvent.press(screen.getByTestId('bulk-sell-smoke-raw-mcdonalds25-21-calculator-key-3'));
  }

  fireEvent.press(screen.getByTestId('bulk-sell-smoke-raw-mcdonalds25-21-calculator-equals'));
}

async function moveBulkSellToReview() {
  await enterBulkSellPriceWithCalculator('12.5');
  fireEvent.press(screen.getByTestId('bulk-sell-review-sale'));
}

describe('BulkSellScreen', () => {
  it('renders the batch summary and updates selected quantity per line', async () => {
    renderWithProviders(
      <BulkSellScreen
        entryIds={['entry-1', 'entry-2']}
        onClose={jest.fn()}
        onComplete={jest.fn()}
      />,
      {
        spotlightRepository: makeBulkSellRepository(),
      },
    );

    expect(await screen.findByText('3 cards selected')).toBeTruthy();
    expect(screen.getByTestId('bulk-sell-summary-card')).toBeTruthy();
    expect(screen.getByTestId('bulk-sell-line-smoke-raw-mcdonalds25-16')).toBeTruthy();
    expect(screen.getByTestId('bulk-sell-line-smoke-raw-mcdonalds25-21')).toBeTruthy();
    expect(screen.getByTestId('bulk-sell-review-sale')).toBeTruthy();
    expect(screen.queryByTestId('bulk-sell-swipe-rail')).toBeNull();
    expect(screen.queryByText('Draft sale')).toBeNull();
    expect(screen.queryByText('3 cards selected. Set sold prices, then review the sale.')).toBeNull();
    expect(screen.getAllByText('Near Mint').length).toBeGreaterThan(0);
    expect(screen.queryByText('Condition')).toBeNull();
    expect(screen.getAllByText('*****').length).toBeGreaterThan(0);
    expect(screen.getByTestId('bulk-sell-toggle-bought-price-smoke-raw-mcdonalds25-16-hidden-icon')).toBeTruthy();
    expect(screen.getByTestId('bulk-sell-smoke-raw-mcdonalds25-16-edit-bought-price')).toBeTruthy();
    expect(screen.queryByText('Show')).toBeNull();
    expect(screen.getAllByText('Tap to enter').length).toBeGreaterThan(0);

    fireEvent.press(screen.getByTestId('bulk-sell-sold-price-smoke-raw-mcdonalds25-16'));

    expect(screen.getByTestId('bulk-sell-smoke-raw-mcdonalds25-16-calculator-sheet')).toBeTruthy();

    fireEvent.press(screen.getByTestId('bulk-sell-toggle-bought-price-smoke-raw-mcdonalds25-16'));

    expect(screen.getByText('$0.18')).toBeTruthy();
    expect(screen.getByTestId('bulk-sell-toggle-bought-price-smoke-raw-mcdonalds25-16-visible-icon')).toBeTruthy();

    fireEvent.press(screen.getByTestId('bulk-sell-toggle-bought-price-smoke-raw-mcdonalds25-16'));

    expect(screen.getAllByText('*****').length).toBeGreaterThan(0);
    expect(screen.getByTestId('bulk-sell-toggle-bought-price-smoke-raw-mcdonalds25-16-hidden-icon')).toBeTruthy();

    fireEvent.press(screen.getByTestId('bulk-sell-decrement-smoke-raw-mcdonalds25-16'));

    expect(await screen.findByText('2 cards selected')).toBeTruthy();
    expect(screen.getByText('Not included')).toBeTruthy();
  });

  it('applies a calculator result into the bulk sold price field', async () => {
    renderWithProviders(
      <BulkSellScreen
        entryIds={['entry-1']}
        onClose={jest.fn()}
        onComplete={jest.fn()}
      />,
      {
        spotlightRepository: makeBulkSellRepository(),
      },
    );

    await screen.findByText('1 card selected');

    await enterBulkSellPriceWithCalculator('6');

    expect(screen.queryByTestId('bulk-sell-smoke-raw-mcdonalds25-16-calculator-sheet')).toBeNull();
    expect(screen.getByText('$6')).toBeTruthy();
  });

  it('renders the compact photo row on bulk sell', async () => {
    renderWithProviders(
      <BulkSellScreen
        entryIds={['entry-1', 'entry-2']}
        onClose={jest.fn()}
        onComplete={jest.fn()}
      />,
      {
        spotlightRepository: makeBulkSellRepository(),
      },
    );

    await screen.findByText('3 cards selected');

    expect(screen.getAllByText('Photo (optional)')).toHaveLength(2);
    expect(screen.queryByText('Transaction Photo')).toBeNull();
    expect(screen.queryByText('Add photo')).toBeNull();
    expect(screen.getByTestId('bulk-sell-smoke-raw-mcdonalds25-16-photo-camera-icon')).toBeTruthy();
    expect(screen.getByTestId('bulk-sell-smoke-raw-mcdonalds25-21-photo-camera-icon')).toBeTruthy();
    expect(
      StyleSheet.flatten(screen.getByTestId('bulk-sell-smoke-raw-mcdonalds25-16-transaction-photo').props.style),
    ).toMatchObject({
      gap: 6,
      paddingVertical: 4,
    });
  });

  it('supports closing the sheet directly from the top chrome', async () => {
    const onClose = jest.fn();

    renderWithProviders(
      <BulkSellScreen
        entryIds={['entry-1']}
        onClose={onClose}
        onComplete={jest.fn()}
      />,
      {
        spotlightRepository: makeBulkSellRepository(),
      },
    );

    expect(await screen.findByText('1 card selected')).toBeTruthy();

    fireEvent.press(screen.getByTestId('bulk-sell-close'));
    expect(onClose).toHaveBeenCalled();
  });

  it('renders a static top chrome without swipe-down dismissal handlers', async () => {
    renderWithProviders(
      <BulkSellScreen
        entryIds={['entry-1']}
        onClose={jest.fn()}
        onComplete={jest.fn()}
      />,
      {
        spotlightRepository: makeBulkSellRepository(),
      },
    );

    expect(await screen.findByText('1 card selected')).toBeTruthy();
    expect(screen.getByTestId('bulk-sell-top-chrome').props.onMoveShouldSetResponder).toBeUndefined();
    expect(screen.getByTestId('bulk-sell-top-chrome').props.onResponderMove).toBeUndefined();
    expect(screen.getByTestId('bulk-sell-top-chrome').props.onResponderRelease).toBeUndefined();
  });

  it('binds the confirm swipe gesture to the centered handle instead of the full rail', async () => {
    renderWithProviders(
      <BulkSellScreen
        entryIds={['entry-1']}
        onClose={jest.fn()}
        onComplete={jest.fn()}
      />,
      {
        spotlightRepository: makeBulkSellRepository(),
      },
    );

    expect(await screen.findByText('1 card selected')).toBeTruthy();
    await moveBulkSellToReview();

    expect(screen.getByTestId('bulk-sell-swipe-rail').props.onMoveShouldSetResponder).toBeUndefined();
    expect(screen.getByTestId('bulk-sell-swipe-handle').props.onMoveShouldSetResponder).toEqual(expect.any(Function));
    expect(screen.getByTestId('bulk-sell-swipe-handle').props.onResponderMove).toEqual(expect.any(Function));
    expect(screen.getByTestId('bulk-sell-swipe-handle').props.onResponderRelease).toEqual(expect.any(Function));
  });

  it('moves into the review step once the review button is enabled', async () => {
    renderWithProviders(
      <BulkSellScreen
        entryIds={['entry-1']}
        onClose={jest.fn()}
        onComplete={jest.fn()}
      />,
      {
        spotlightRepository: makeBulkSellRepository(),
      },
    );

    expect(await screen.findByText('1 card selected')).toBeTruthy();
    expect(screen.queryByTestId('bulk-sell-swipe-rail')).toBeNull();

    fireEvent.press(screen.getByTestId('bulk-sell-review-sale'));
    expect(screen.queryByText('Review before confirm')).toBeNull();

    await enterBulkSellPriceWithCalculator('12.5');

    fireEvent.press(screen.getByTestId('bulk-sell-review-sale'));

    expect(await screen.findByText('Review before confirm')).toBeTruthy();
    expect(screen.getByTestId('bulk-sell-back-to-edit')).toBeTruthy();
    expect(screen.getByTestId('bulk-sell-review-line-entry-1')).toBeTruthy();
    expect(screen.getByTestId('bulk-sell-review-total-card')).toBeTruthy();
    expect(screen.getByText('Quantity')).toBeTruthy();
    expect(screen.getByText('Sold price')).toBeTruthy();
    expect(screen.getAllByText('$12.50').length).toBeGreaterThan(0);
    expect(screen.queryByText('Market price')).toBeNull();
    expect(screen.queryByText('Bought price')).toBeNull();
    expect(screen.queryByText('Photo (optional)')).toBeNull();
    expect(screen.queryByTestId('bulk-sell-smoke-raw-mcdonalds25-16-edit-bought-price')).toBeNull();
    expect(screen.getByTestId('bulk-sell-swipe-rail').props.accessibilityState).toMatchObject({
      disabled: false,
    });
    expect(screen.getByTestId('bulk-sell-confirmation-prompt').props.pointerEvents).toBe('box-none');
    expect(screen.getByText('Swipe up to confirm sale')).toBeTruthy();
  });

  it('keeps the review button disabled until every active card has a sold price', async () => {
    renderWithProviders(
      <BulkSellScreen
        entryIds={['entry-1', 'entry-2']}
        onClose={jest.fn()}
        onComplete={jest.fn()}
      />,
      {
        spotlightRepository: makeBulkSellRepository(),
      },
    );

    expect(await screen.findByText('3 cards selected')).toBeTruthy();
    fireEvent.press(screen.getByTestId('bulk-sell-review-sale'));
    expect(screen.queryByText('Review before confirm')).toBeNull();

    await enterBulkSellPriceWithCalculator('12.5');

    fireEvent.press(screen.getByTestId('bulk-sell-review-sale'));
    expect(screen.queryByText('Review before confirm')).toBeNull();

    await enterSecondBulkSellPriceWithCalculator('6');

    fireEvent.press(screen.getByTestId('bulk-sell-review-sale'));
    expect(screen.getByTestId('bulk-sell-swipe-rail').props.accessibilityState).toMatchObject({
      disabled: false,
    });
  });

  it('calls onComplete after a successful bulk sell finishes', async () => {
    jest.useFakeTimers();
    const onComplete = jest.fn();
    const createPortfolioSalesBatch = jest.fn(async () => ([
      {
        saleID: 'sale-1',
        deckEntryID: 'entry-1',
        remainingQuantity: 0,
        grossTotal: 12.5,
        soldAt: '2026-05-01T00:00:00.000Z',
        showSessionID: null,
      },
    ]));
    const repository = createTestSpotlightRepository({
      createPortfolioSalesBatch,
      getInventoryEntries: async () => [mockInventoryEntries[0]],
    });

    renderWithProviders(
      <BulkSellScreen
        entryIds={['entry-1']}
        onClose={jest.fn()}
        onComplete={onComplete}
      />,
      {
        spotlightRepository: repository,
      },
    );

    expect(await screen.findByText('1 card selected')).toBeTruthy();
    await moveBulkSellToReview();

    const rail = screen.getByTestId('bulk-sell-swipe-rail');
    await act(async () => {
      rail.props.onAccessibilityAction?.({ nativeEvent: { actionName: 'activate' } });
    });

    expect(screen.getByText('Processing sale')).toBeTruthy();

    await act(async () => {
      jest.runAllTimers();
    });

    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('prefills the bought price editor when a bought price already exists', async () => {
    renderWithProviders(
      <BulkSellScreen
        entryIds={['entry-1']}
        onClose={jest.fn()}
        onComplete={jest.fn()}
      />,
      {
        spotlightRepository: makeBulkSellRepository(),
      },
    );

    await screen.findByText('1 card selected');

    fireEvent.press(screen.getByTestId('bulk-sell-smoke-raw-mcdonalds25-16-edit-bought-price'));

    expect(screen.getByTestId('bulk-sell-smoke-raw-mcdonalds25-16-bought-price-input').props.value).toBe('0.18');
  });

  it('opens the bought price editor blank when no bought price exists yet', async () => {
    renderWithProviders(
      <BulkSellScreen
        entryIds={['entry-no-cost']}
        onClose={jest.fn()}
        onComplete={jest.fn()}
      />,
      {
        spotlightRepository: makeBulkSellRepository([
          {
            ...mockInventoryEntries[0],
            id: 'entry-no-cost',
            costBasisPerUnit: null,
            costBasisTotal: null,
          },
        ]),
      },
    );

    await screen.findByText('1 card selected');

    fireEvent.press(screen.getByTestId('bulk-sell-smoke-raw-mcdonalds25-16-edit-bought-price'));

    expect(screen.getByTestId('bulk-sell-smoke-raw-mcdonalds25-16-bought-price-input').props.value).toBe('');
  });

  it('keeps the bulk sell smoke selectors stable even if entry ids change', async () => {
    renderWithProviders(
      <BulkSellScreen
        entryIds={['entry-1-rekeyed', 'entry-2-rekeyed']}
        onClose={jest.fn()}
        onComplete={jest.fn()}
      />,
      {
        spotlightRepository: createTestSpotlightRepository({
          getInventoryEntries: async () => [
            {
              ...mockInventoryEntries[0],
              id: 'entry-1-rekeyed',
            },
            {
              ...mockInventoryEntries[1],
              id: 'entry-2-rekeyed',
            },
          ],
        }),
      },
    );

    expect(await screen.findByText('3 cards selected')).toBeTruthy();
    expect(screen.getByTestId('bulk-sell-line-smoke-raw-mcdonalds25-16')).toBeTruthy();
    expect(screen.getByTestId('bulk-sell-line-smoke-raw-mcdonalds25-21')).toBeTruthy();
  });
});
