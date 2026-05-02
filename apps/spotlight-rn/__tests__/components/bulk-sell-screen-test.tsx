import { act, fireEvent, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { mockInventoryEntries } from '@spotlight/api-client';
import { colors as themeColors } from '@spotlight/design-system';

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
    fireEvent.press(screen.getByTestId('bulk-sell-entry-1-calculator-key-2'));
    fireEvent.press(screen.getByTestId('bulk-sell-entry-1-calculator-key-×'));
    fireEvent.press(screen.getByTestId('bulk-sell-entry-1-calculator-key-3'));
  } else {
    fireEvent.press(screen.getByTestId('bulk-sell-entry-1-calculator-key-1'));
    fireEvent.press(screen.getByTestId('bulk-sell-entry-1-calculator-key-2'));
    fireEvent.press(screen.getByTestId('bulk-sell-entry-1-calculator-key-5'));
    fireEvent.press(screen.getByTestId('bulk-sell-entry-1-calculator-key-÷'));
    fireEvent.press(screen.getByTestId('bulk-sell-entry-1-calculator-key-1'));
    fireEvent.press(screen.getByTestId('bulk-sell-entry-1-calculator-key-0'));
  }

  fireEvent.press(screen.getByTestId('bulk-sell-entry-1-calculator-equals'));
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
    expect(screen.getByText('Enter a sell price for every selected card before reviewing the sale.')).toBeTruthy();
    expect(screen.getAllByText('Near Mint').length).toBeGreaterThan(0);
    expect(screen.queryByText('Condition')).toBeNull();
    expect(screen.getAllByText('*****').length).toBeGreaterThan(0);
    expect(screen.getByTestId('bulk-sell-toggle-bought-price-smoke-raw-mcdonalds25-16-hidden-icon')).toBeTruthy();
    expect(screen.getByTestId('bulk-sell-entry-1-edit-bought-price')).toBeTruthy();
    expect(screen.queryByText('Show')).toBeNull();
    expect(screen.getAllByText('Tap to enter').length).toBeGreaterThan(0);

    fireEvent.press(screen.getByTestId('bulk-sell-sold-price-smoke-raw-mcdonalds25-16'));

    expect(screen.getByTestId('bulk-sell-entry-1-calculator-sheet')).toBeTruthy();

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

    expect(screen.queryByTestId('bulk-sell-entry-1-calculator-sheet')).toBeNull();
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
    expect(screen.getByTestId('bulk-sell-entry-1-photo-camera-icon')).toBeTruthy();
    expect(screen.getByTestId('bulk-sell-entry-2-photo-camera-icon')).toBeTruthy();
    expect(StyleSheet.flatten(screen.getByTestId('bulk-sell-entry-1-transaction-photo').props.style)).toMatchObject({
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
    expect(screen.getByTestId('bulk-sell-swipe-rail').props.onMoveShouldSetResponder).toBeUndefined();
    expect(screen.getByTestId('bulk-sell-swipe-handle').props.onMoveShouldSetResponder).toEqual(expect.any(Function));
    expect(screen.getByTestId('bulk-sell-swipe-handle').props.onResponderMove).toEqual(expect.any(Function));
    expect(screen.getByTestId('bulk-sell-swipe-handle').props.onResponderRelease).toEqual(expect.any(Function));
  });

  it('moves into the review step once the rail is enabled', async () => {
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
    expect(screen.getByTestId('bulk-sell-swipe-rail').props.accessibilityState).toMatchObject({
      disabled: true,
    });
    expect(StyleSheet.flatten(screen.getByTestId('bulk-sell-swipe-rail').props.style)).toMatchObject({
      backgroundColor: themeColors.surface,
    });
    expect(
      StyleSheet.flatten(
        screen.getByText('Enter a sell price for every selected card before reviewing the sale.').props.style,
      ),
    ).toMatchObject({
      color: 'rgba(15, 15, 18, 0.46)',
    });

    await enterBulkSellPriceWithCalculator('12.5');

    expect(screen.getByTestId('bulk-sell-swipe-rail').props.accessibilityState).toMatchObject({
      disabled: false,
    });
    expect(StyleSheet.flatten(screen.getByTestId('bulk-sell-swipe-rail').props.style)).toMatchObject({
      backgroundColor: themeColors.brand,
    });
    expect(screen.getByTestId('bulk-sell-confirmation-prompt').props.pointerEvents).toBe('box-none');
    expect(
      StyleSheet.flatten(screen.getByText('Swipe up to review sale').props.style),
    ).toMatchObject({
      color: 'rgba(15, 15, 18, 0.86)',
      fontSize: 16,
      lineHeight: 22,
    });

    const rail = screen.getByTestId('bulk-sell-swipe-rail');
    await act(async () => {
      rail.props.onAccessibilityAction?.({ nativeEvent: { actionName: 'activate' } });
    });

    expect(await screen.findByText('Review before confirm')).toBeTruthy();
    expect(screen.getByTestId('bulk-sell-back-to-edit')).toBeTruthy();
    expect(screen.getByText('Swipe up to confirm sale')).toBeTruthy();
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

    fireEvent.press(screen.getByTestId('bulk-sell-entry-1-edit-bought-price'));

    expect(screen.getByTestId('bulk-sell-entry-1-bought-price-input').props.value).toBe('0.18');
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

    fireEvent.press(screen.getByTestId('bulk-sell-entry-no-cost-edit-bought-price'));

    expect(screen.getByTestId('bulk-sell-entry-no-cost-bought-price-input').props.value).toBe('');
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
