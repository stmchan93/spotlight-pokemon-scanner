import { act, fireEvent, screen } from '@testing-library/react-native';
import { ScrollView, StyleSheet } from 'react-native';

import { mockInventoryEntries, type InventoryCardEntry } from '@spotlight/api-client';
import { colors as themeColors } from '@spotlight/design-system';

import { SingleSellScreen } from '@/features/sell/screens/single-sell-screen';

import { createTestSpotlightRepository, renderWithProviders } from '../test-utils';

const { useKeepAwake } = jest.requireMock('expo-keep-awake') as {
  useKeepAwake: jest.Mock;
};

async function enterSingleSellPriceWithCalculator(value: '2.5' | '12.5') {
  fireEvent.press(screen.getByTestId('single-sell-sold-price'));

  if (value === '2.5') {
    fireEvent.press(screen.getByTestId('single-sell-calculator-key-1'));
    fireEvent.press(screen.getByTestId('single-sell-calculator-key-0'));
    fireEvent.press(screen.getByTestId('single-sell-calculator-key-÷'));
    fireEvent.press(screen.getByTestId('single-sell-calculator-key-4'));
  } else {
    fireEvent.press(screen.getByTestId('single-sell-calculator-key-1'));
    fireEvent.press(screen.getByTestId('single-sell-calculator-key-2'));
    fireEvent.press(screen.getByTestId('single-sell-calculator-key-5'));
    fireEvent.press(screen.getByTestId('single-sell-calculator-key-÷'));
    fireEvent.press(screen.getByTestId('single-sell-calculator-key-1'));
    fireEvent.press(screen.getByTestId('single-sell-calculator-key-0'));
  }

  fireEvent.press(screen.getByTestId('single-sell-calculator-equals'));
}


describe('SingleSellScreen', () => {
  beforeEach(() => {
    useKeepAwake.mockClear();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('renders the sell summary and can reveal the bought price', async () => {
    renderWithProviders(
      <SingleSellScreen
        entryId="entry-2"
        onClose={jest.fn()}
        onComplete={jest.fn()}
      />,
    );

    expect(await screen.findByText('Oshawott')).toBeTruthy();
    expect(screen.getByTestId('single-sell-summary-card')).toBeTruthy();
    expect(StyleSheet.flatten(screen.getByTestId('single-sell-summary-card').props.style)).toMatchObject({
      marginTop: -24,
    });
    expect(screen.getByText('Swipe up to confirm sale')).toBeTruthy();
    expect(screen.queryByText('Condition')).toBeNull();
    expect(screen.getByText('Near Mint')).toBeTruthy();
    expect(StyleSheet.flatten(screen.getByTestId('single-sell-meta-condition').props.style)).toMatchObject({
      backgroundColor: 'rgba(255, 255, 255, 0.78)',
    });
    expect(StyleSheet.flatten(screen.getByText('Near Mint').props.style)).toMatchObject({
      color: '#0F0F12',
    });
    expect(screen.getByText('*****')).toBeTruthy();
    expect(screen.getByTestId('single-sell-toggle-bought-price-hidden-icon')).toBeTruthy();
    expect(screen.getByTestId('single-sell-edit-bought-price')).toBeTruthy();
    expect(screen.queryByText('Show')).toBeNull();
    expect(screen.queryByText('Offer Calculator')).toBeNull();
    expect(screen.queryByText('Your Price (YP)')).toBeNull();
    expect(screen.getByText('Tap to enter')).toBeTruthy();
    expect(screen.queryByText('Enter a sell price first.')).toBeNull();

    fireEvent.press(screen.getByTestId('single-sell-sold-price'));

    expect(screen.getByTestId('single-sell-calculator-sheet')).toBeTruthy();
    expect(screen.getByText('Calculator')).toBeTruthy();

    fireEvent.press(screen.getByTestId('single-sell-toggle-bought-price'));

    expect(screen.getByText('$0.25')).toBeTruthy();
    expect(screen.getByTestId('single-sell-toggle-bought-price-visible-icon')).toBeTruthy();

    fireEvent.press(screen.getByTestId('single-sell-toggle-bought-price'));

    expect(screen.getByText('*****')).toBeTruthy();
    expect(screen.getByTestId('single-sell-toggle-bought-price-hidden-icon')).toBeTruthy();
  });

  it('shows slab grade subtext under the title for graded entries', async () => {
    const gradedEntry: InventoryCardEntry = {
      id: 'graded-entry-1',
      name: 'Charizard',
      cardId: 'base1-4',
      quantity: 1,
      currencyCode: 'USD',
      costBasisPerUnit: 2500,
      costBasisTotal: 2500,
      kind: 'graded',
      conditionCode: null,
      conditionLabel: null,
      conditionShortLabel: null,
      imageUrl: 'https://example.com/charizard-psa6.png',
      marketPrice: 3027.12,
      hasMarketPrice: true,
      cardNumber: '#4/102',
      setName: 'Base',
      addedAt: '2026-05-01T00:00:00.000Z',
      variantName: 'First Edition Shadowless Holofoil',
      slabContext: {
        grader: 'PSA',
        grade: '6',
        certNumber: '76243431',
        variantName: 'First Edition Shadowless Holofoil',
      },
      isFavorite: false,
    };
    const repository = createTestSpotlightRepository({
      getInventoryEntries: async () => [gradedEntry],
    });

    renderWithProviders(
      <SingleSellScreen
        entryId="graded-entry-1"
        onClose={jest.fn()}
        onComplete={jest.fn()}
      />,
      { spotlightRepository: repository },
    );

    expect(await screen.findByText('Charizard')).toBeTruthy();
    expect(screen.getByTestId('single-sell-slab-meta')).toBeTruthy();
    expect(screen.getByText('PSA • 6')).toBeTruthy();
    expect(screen.getByText('First Edition Shadowless Holofoil')).toBeTruthy();
    expect(screen.queryByTestId('single-sell-meta-grader')).toBeNull();
    expect(screen.queryByTestId('single-sell-meta-grade')).toBeNull();
    expect(StyleSheet.flatten(screen.getByTestId('single-sell-meta-row').props.style)).toMatchObject({
      alignSelf: 'center',
      justifyContent: 'center',
    });
  });

  it('applies a built-in calculator result into the sold price field', async () => {
    renderWithProviders(
      <SingleSellScreen
        entryId="entry-2"
        onClose={jest.fn()}
        onComplete={jest.fn()}
      />,
    );

    await screen.findByText('Oshawott');

    await enterSingleSellPriceWithCalculator('2.5');

    expect(screen.queryByTestId('single-sell-calculator-sheet')).toBeNull();
    expect(screen.getByText('$2.5')).toBeTruthy();
  });

  it('keeps the confirm rail disabled until a sold price is entered', async () => {
    renderWithProviders(
      <SingleSellScreen
        entryId="entry-2"
        onClose={jest.fn()}
        onComplete={jest.fn()}
      />,
    );

    await screen.findByText('Oshawott');

    expect(screen.getByTestId('single-sell-swipe-rail').props.accessibilityState).toMatchObject({
      disabled: true,
    });
    expect(StyleSheet.flatten(screen.getByTestId('single-sell-swipe-rail').props.style)).toMatchObject({
      backgroundColor: themeColors.field,
    });
    expect(
      StyleSheet.flatten(screen.getByText('Swipe up to confirm sale').props.style),
    ).toMatchObject({
      color: 'rgba(15, 15, 18, 0.56)',
    });
    expect(screen.queryByTestId('single-sell-error-message')).toBeNull();
    expect(screen.queryByText('Enter a sell price before confirming sale.')).toBeNull();
  });

  it('renders a compact photo row and swaps the camera icon for a thumbnail after capture', async () => {
    renderWithProviders(
      <SingleSellScreen
        entryId="entry-2"
        onClose={jest.fn()}
        onComplete={jest.fn()}
      />,
    );

    await screen.findByText('Oshawott');

    expect(screen.getByText('Photo (optional)')).toBeTruthy();
    expect(screen.queryByText('Capture the deal table or receipt.')).toBeNull();
    expect(screen.queryByText('Transaction Photo')).toBeNull();
    expect(screen.queryByText('Add photo')).toBeNull();
    expect(screen.getByTestId('single-sell-photo-camera-icon')).toBeTruthy();
    expect(StyleSheet.flatten(screen.getByTestId('single-sell-transaction-photo').props.style)).toMatchObject({
      gap: 6,
      paddingVertical: 4,
    });

    fireEvent.press(screen.getByTestId('single-sell-photo-trigger'));
    expect(await screen.findByTestId('single-sell-camera')).toBeTruthy();
    expect(useKeepAwake).toHaveBeenCalledWith('single-sell-transaction-photo-camera');
    expect(screen.queryByTestId('single-sell-camera-zoom-0.5x')).toBeNull();
    expect(screen.queryByTestId('single-sell-camera-zoom-1x')).toBeNull();
    expect(screen.queryByText('Transaction photo')).toBeNull();
    expect(StyleSheet.flatten(screen.getByTestId('single-sell-camera-header').props.style)).toMatchObject({
      paddingTop: 67,
    });
    expect(screen.getByTestId('single-sell-camera').props.selectedLens).toBe('builtInWideAngleCamera');
    expect(StyleSheet.flatten(screen.getByText('Capture photo').props.style)).toMatchObject({
      fontFamily: 'SpotlightBodySemiBold',
      fontSize: 15,
      lineHeight: 20,
    });
    expect(StyleSheet.flatten(screen.getByText('Cancel').props.style)).toMatchObject({
      fontFamily: 'SpotlightBodySemiBold',
      fontSize: 15,
      lineHeight: 20,
    });

    await act(async () => {
      fireEvent.press(screen.getByTestId('single-sell-capture-photo'));
    });

    expect(screen.getByTestId('single-sell-photo-thumbnail')).toBeTruthy();
    expect(screen.getByText('Retake')).toBeTruthy();
    expect(screen.queryByTestId('single-sell-photo-camera-icon')).toBeNull();
  });

  it('supports closing directly from the top chrome', async () => {
    const onClose = jest.fn();

    renderWithProviders(
      <SingleSellScreen
        entryId="entry-1"
        onClose={onClose}
        onComplete={jest.fn()}
      />,
    );

    expect(await screen.findByText('Scorbunny')).toBeTruthy();

    fireEvent.press(screen.getByTestId('single-sell-close'));
    expect(onClose).toHaveBeenCalled();
  });

  it('can save the bought price more than once after replacePortfolioEntry returns a new deck entry id', async () => {
    const replaceCalls: string[] = [];
    let currentEntry: InventoryCardEntry = {
      id: 'entry-2',
      name: 'Oshawott',
      cardId: 'smoke-raw-mcdonalds25-16',
      quantity: 3,
      currencyCode: 'USD',
      costBasisPerUnit: 0.25,
      costBasisTotal: 0.75,
      kind: 'raw' as const,
      conditionCode: 'near_mint' as const,
      conditionLabel: 'Near Mint',
      conditionShortLabel: 'NM',
      imageUrl: 'https://example.com/osha.png',
      marketPrice: 1.5,
      hasMarketPrice: true,
      cardNumber: '#16',
      setName: 'McDonalds Collection',
      addedAt: '2026-05-01T00:00:00.000Z',
      variantName: null,
      slabContext: null,
      isFavorite: false,
    };
    const repository = createTestSpotlightRepository({
      getInventoryEntries: async () => [currentEntry],
      replacePortfolioEntry: async (payload) => {
        replaceCalls.push(payload.deckEntryID);
        const nextEntryId = `${payload.deckEntryID}-next`;
        if (payload.unitPrice == null) {
          throw new Error('Expected bought price update to provide a unit price.');
        }
        currentEntry = {
          ...currentEntry,
          id: nextEntryId,
          costBasisPerUnit: payload.unitPrice,
          costBasisTotal: Number((payload.unitPrice * currentEntry.quantity).toFixed(2)),
        };
        return {
          previousDeckEntryID: payload.deckEntryID,
          deckEntryID: nextEntryId,
          cardID: payload.cardID,
          quantity: payload.quantity,
          unitPrice: payload.unitPrice,
          updatedAt: payload.updatedAt,
        };
      },
    });

    renderWithProviders(
      <SingleSellScreen
        entryId="entry-2"
        onClose={jest.fn()}
        onComplete={jest.fn()}
      />,
      { spotlightRepository: repository },
    );

    await screen.findByText('Oshawott');

    fireEvent.press(screen.getByTestId('single-sell-edit-bought-price'));
    expect(screen.getByTestId('single-sell-bought-price-input').props.value).toBe('0.25');
    fireEvent.changeText(screen.getByTestId('single-sell-bought-price-input'), '0.40');
    await act(async () => {
      fireEvent.press(screen.getByTestId('single-sell-save-bought-price'));
    });

    fireEvent.press(screen.getByTestId('single-sell-edit-bought-price'));
    expect(screen.getByTestId('single-sell-bought-price-input').props.value).toBe('0.4');
    fireEvent.changeText(screen.getByTestId('single-sell-bought-price-input'), '0.55');
    await act(async () => {
      fireEvent.press(screen.getByTestId('single-sell-save-bought-price'));
    });

    expect(replaceCalls).toEqual(['entry-2', 'entry-2-next']);
    expect(screen.queryByText('$0.55')).toBeNull();
    expect(screen.getAllByText('*****').length).toBeGreaterThan(0);

    fireEvent.press(screen.getByTestId('single-sell-edit-bought-price'));
    expect(screen.getByTestId('single-sell-bought-price-input').props.value).toBe('0.55');
  });

  it('opens the bought price editor blank when no bought price exists yet', async () => {
    renderWithProviders(
      <SingleSellScreen
        entryId="entry-no-cost"
        onClose={jest.fn()}
        onComplete={jest.fn()}
      />,
      {
        spotlightRepository: createTestSpotlightRepository({
          getInventoryEntries: async () => [{
            ...mockInventoryEntries[1],
            id: 'entry-no-cost',
            costBasisPerUnit: null,
            costBasisTotal: null,
          }],
        }),
      },
    );

    await screen.findByText('Oshawott');

    fireEvent.press(screen.getByTestId('single-sell-edit-bought-price'));

    expect(screen.getByTestId('single-sell-bought-price-input').props.value).toBe('');
  });

  it('keeps the swipe-down dismissal handlers on the top chrome', async () => {
    renderWithProviders(
      <SingleSellScreen
        entryId="entry-1"
        onClose={jest.fn()}
        onComplete={jest.fn()}
      />,
    );

    expect(await screen.findByText('Scorbunny')).toBeTruthy();
    expect(screen.getByTestId('single-sell-top-chrome').props.onMoveShouldSetResponder).toEqual(expect.any(Function));
    expect(screen.getByTestId('single-sell-top-chrome').props.onResponderMove).toEqual(expect.any(Function));
    expect(screen.getByTestId('single-sell-top-chrome').props.onResponderRelease).toEqual(expect.any(Function));
  });

  it('binds the confirm swipe gesture to the centered handle instead of the full rail', async () => {
    renderWithProviders(
      <SingleSellScreen
        entryId="entry-1"
        onClose={jest.fn()}
        onComplete={jest.fn()}
      />,
    );

    expect(await screen.findByText('Scorbunny')).toBeTruthy();
    expect(screen.getByTestId('single-sell-swipe-rail').props.onMoveShouldSetResponder).toBeUndefined();
    expect(screen.getByTestId('single-sell-swipe-handle').props.onMoveShouldSetResponder).toEqual(expect.any(Function));
    expect(screen.getByTestId('single-sell-swipe-handle').props.onResponderMove).toEqual(expect.any(Function));
    expect(screen.getByTestId('single-sell-swipe-handle').props.onResponderRelease).toEqual(expect.any(Function));
  });

  it('enables the swipe rail once a sold price is entered', async () => {
    renderWithProviders(
      <SingleSellScreen
        entryId="entry-1"
        onClose={jest.fn()}
        onComplete={jest.fn()}
      />,
    );

    expect(await screen.findByText('Scorbunny')).toBeTruthy();

    expect(screen.getByTestId('single-sell-swipe-rail').props.accessibilityState).toMatchObject({
      disabled: true,
    });

    await enterSingleSellPriceWithCalculator('12.5');

    expect(screen.getByTestId('single-sell-swipe-rail').props.accessibilityState).toMatchObject({
      disabled: false,
    });
    expect(StyleSheet.flatten(screen.getByTestId('single-sell-swipe-rail').props.style)).toMatchObject({
      backgroundColor: themeColors.brand,
    });
    expect(screen.getByTestId('single-sell-confirmation-prompt').props.pointerEvents).toBe('box-none');
    expect(
      StyleSheet.flatten(screen.getByText('Swipe up to confirm sale').props.style),
    ).toMatchObject({
      color: 'rgba(15, 15, 18, 0.88)',
      fontSize: 16,
      lineHeight: 22,
    });
    expect(screen.queryByText('Enter a sell price before confirming sale.')).toBeNull();
  });

  it('submits the sale when the swipe rail confirm action fires', async () => {
    const createPortfolioSale = jest.fn(async () => ({
      saleID: 'sale-1',
      deckEntryID: 'entry-1',
      remainingQuantity: 0,
      grossTotal: 12.5,
      soldAt: '2026-05-01T00:00:00.000Z',
      showSessionID: null,
    }));
    const repository = createTestSpotlightRepository({
      createPortfolioSale,
    });

    renderWithProviders(
      <SingleSellScreen
        entryId="entry-1"
        onClose={jest.fn()}
        onComplete={jest.fn()}
      />,
      { spotlightRepository: repository },
    );

    expect(await screen.findByText('Scorbunny')).toBeTruthy();

    await enterSingleSellPriceWithCalculator('12.5');

    const rail = screen.getByTestId('single-sell-swipe-rail');

    await act(async () => {
      rail.props.onAccessibilityAction?.({ nativeEvent: { actionName: 'activate' } });
    });

    expect(createPortfolioSale).toHaveBeenCalledWith(expect.objectContaining({
      deckEntryID: 'entry-1',
      unitPrice: 12.5,
      quantity: 1,
    }));
    expect(screen.getByText('Processing sale')).toBeTruthy();
  });

  it('calls onComplete after a successful single sell finishes', async () => {
    jest.useFakeTimers();
    const onComplete = jest.fn();
    const createPortfolioSale = jest.fn(async () => ({
      saleID: 'sale-1',
      deckEntryID: 'entry-1',
      remainingQuantity: 0,
      grossTotal: 12.5,
      soldAt: '2026-05-01T00:00:00.000Z',
      showSessionID: null,
    }));
    const repository = createTestSpotlightRepository({
      createPortfolioSale,
    });

    renderWithProviders(
      <SingleSellScreen
        entryId="entry-1"
        onClose={jest.fn()}
        onComplete={onComplete}
      />,
      { spotlightRepository: repository },
    );

    expect(await screen.findByText('Scorbunny')).toBeTruthy();

    await enterSingleSellPriceWithCalculator('12.5');

    const rail = screen.getByTestId('single-sell-swipe-rail');
    await act(async () => {
      rail.props.onAccessibilityAction?.({ nativeEvent: { actionName: 'activate' } });
    });

    expect(screen.getByText('Processing sale')).toBeTruthy();

    await act(async () => {
      jest.runAllTimers();
    });

    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('keeps the sell screen interactive when the sold-price calculator and bought-price editor are opened', async () => {
    renderWithProviders(
      <SingleSellScreen
        entryId="entry-2"
        onClose={jest.fn()}
        onComplete={jest.fn()}
      />,
    );

    expect(await screen.findByText('Oshawott')).toBeTruthy();

    fireEvent.press(screen.getByTestId('single-sell-sold-price'));

    fireEvent.press(screen.getByTestId('single-sell-edit-bought-price'));
    fireEvent(screen.getByTestId('single-sell-bought-price-input'), 'focus');

    expect(screen.getByTestId('single-sell-scroll-view')).toBeTruthy();
    expect(screen.getByTestId('single-sell-sold-price')).toBeTruthy();
    expect(screen.getByTestId('single-sell-calculator-sheet')).toBeTruthy();
    expect(screen.getByTestId('single-sell-bought-price-input')).toBeTruthy();
  });
});
