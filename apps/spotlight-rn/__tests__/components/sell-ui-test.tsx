import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Animated, StyleSheet } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { SpotlightThemeProvider } from '@spotlight/design-system';
import type { InventoryCardEntry } from '@spotlight/api-client';

import {
  BoughtPriceVisibilityToggle,
  SellBackdrop,
  SellFormFields,
  SellIdentityChips,
  SellPriceField,
  SellStatusOverlay,
  SellSwipeConfirmationSheet,
  SellTransactionPhotoCapture,
} from '@/features/sell/components/sell-ui';

const safeAreaMetrics = {
  frame: { height: 852, width: 393, x: 0, y: 0 },
  insets: { top: 59, right: 0, bottom: 34, left: 0 },
};

const gradedEntry: InventoryCardEntry = {
  addedAt: '2026-05-05T00:00:00.000Z',
  cardId: 'base1-4',
  cardNumber: '4/102',
  conditionCode: null,
  conditionLabel: null,
  conditionShortLabel: null,
  costBasisPerUnit: null,
  costBasisTotal: null,
  currencyCode: 'USD',
  hasMarketPrice: true,
  id: 'entry-1',
  imageUrl: 'https://images.example/base1-4.png',
  kind: 'graded',
  largeImageUrl: 'https://images.example/base1-4-large.png',
  marketPrice: 2250,
  name: 'Charizard',
  quantity: 1,
  setName: 'Base Set',
  slabContext: {
    certNumber: '12345678',
    grade: '9',
    grader: 'PSA',
    variantName: 'Unlimited Holofoil',
  },
  smallImageUrl: 'https://images.example/base1-4-small.png',
  variantName: 'Unlimited Holofoil',
};

function renderSellUI(node: React.ReactNode) {
  return render(
    <SafeAreaProvider initialMetrics={safeAreaMetrics}>
      <SpotlightThemeProvider>
        {node}
      </SpotlightThemeProvider>
    </SafeAreaProvider>,
  );
}

function renderOverlay(
  state: 'processing' | 'success',
  testIDPrefix: string,
  title: string,
  headline: string,
  detail: string,
) {
  return renderSellUI(
    <SellStatusOverlay
      detail={detail}
      headline={headline}
      state={state}
      testIDPrefix={testIDPrefix}
      title={title}
    />,
  );
}

describe('SellStatusOverlay', () => {
  it('renders a full-bleed yellow processing screen', () => {
    renderOverlay('processing', 'single-sell', 'Processing sale', 'Selling $12.50', 'Locking in the sale.');

    expect(screen.getByTestId('single-sell-status-screen')).toBeTruthy();
    expect(screen.getByText('Processing sale')).toBeTruthy();
  });

  it('renders the success confirmation copy for bulk sell', () => {
    renderOverlay('success', 'bulk-sell', 'Congrats!', 'Batch sale confirmed', '3 cards sold for $18.50.');

    expect(screen.getByTestId('bulk-sell-status-screen')).toBeTruthy();
    expect(screen.getByText('Congrats!')).toBeTruthy();
    expect(screen.getByText('Batch sale confirmed')).toBeTruthy();
  });

  it('renders backdrop variants and only shows the image when provided', () => {
    const { rerender } = renderSellUI(<SellBackdrop imageUrl={null} />);

    expect(screen.getByTestId('sell-backdrop')).toBeTruthy();
    expect(screen.queryByTestId('sell-backdrop-image')).toBeNull();

    rerender(
      <SafeAreaProvider initialMetrics={safeAreaMetrics}>
        <SpotlightThemeProvider>
          <SellBackdrop imageUrl="https://images.example/card.png" variant="bulk" />
        </SpotlightThemeProvider>
      </SafeAreaProvider>,
    );

    const imageStyle = StyleSheet.flatten(screen.getByTestId('sell-backdrop-image').props.style);
    expect(imageStyle).toMatchObject({ opacity: 0.4 });
  });

  it('sanitizes sold-price input text before forwarding changes', () => {
    const onChangeText = jest.fn();
    renderSellUI(
      <SellPriceField
        onChangeText={onChangeText}
        testID="sell-price-input"
        value=""
      />,
    );

    fireEvent.changeText(screen.getByTestId('sell-price-input'), '$12..345abc');

    expect(onChangeText).toHaveBeenCalledWith('12.34');
  });

  it('fires accessibility confirmation from the swipe rail', () => {
    const onAccessibilityConfirm = jest.fn();
    renderSellUI(
      <SellSwipeConfirmationSheet
        bottomInset={12}
        disabled={false}
        onAccessibilityConfirm={onAccessibilityConfirm}
        prompt="Slide to sell"
        promptOpacity={new Animated.Value(1)}
        promptScale={new Animated.Value(1)}
        swipeSheetHeight={96}
        testIDPrefix="single-sell"
        translateY={new Animated.Value(0)}
      />,
    );

    fireEvent(screen.getByTestId('single-sell-swipe-rail'), 'accessibilityAction', {
      nativeEvent: { actionName: 'activate' },
    });

    expect(onAccessibilityConfirm).toHaveBeenCalledTimes(1);
  });

  it('filters slab chips when grade details are hidden', () => {
    const { rerender } = renderSellUI(
      <SellIdentityChips entry={gradedEntry} includeSlabGrade={false} testIDPrefix="sell-chip" />,
    );

    expect(screen.queryByTestId('sell-chip-meta-grader')).toBeNull();
    expect(screen.queryByTestId('sell-chip-meta-grade')).toBeNull();
    expect(screen.getByTestId('sell-chip-meta-variant')).toBeTruthy();

    rerender(
      <SafeAreaProvider initialMetrics={safeAreaMetrics}>
        <SpotlightThemeProvider>
          <SellIdentityChips entry={gradedEntry} includeSlabGrade testIDPrefix="sell-chip" />
        </SpotlightThemeProvider>
      </SafeAreaProvider>,
    );

    expect(screen.getByTestId('sell-chip-meta-grader')).toBeTruthy();
    expect(screen.getByTestId('sell-chip-meta-grade')).toBeTruthy();
  });

  it('renders bought-price visibility icon states and labels', () => {
    const onPress = jest.fn();
    const { rerender } = renderSellUI(
      <BoughtPriceVisibilityToggle
        onPress={onPress}
        revealsValue={false}
        testID="bought-price-toggle"
      />,
    );

    expect(screen.getByLabelText('Show bought price')).toBeTruthy();
    expect(screen.getByTestId('bought-price-toggle-hidden-icon')).toBeTruthy();
    fireEvent.press(screen.getByTestId('bought-price-toggle'));
    expect(onPress).toHaveBeenCalledTimes(1);

    rerender(
      <SafeAreaProvider initialMetrics={safeAreaMetrics}>
        <SpotlightThemeProvider>
          <BoughtPriceVisibilityToggle
            onPress={onPress}
            revealsValue
            testID="bought-price-toggle"
          />
        </SpotlightThemeProvider>
      </SafeAreaProvider>,
    );

    expect(screen.getByLabelText('Hide bought price')).toBeTruthy();
    expect(screen.getByTestId('bought-price-toggle-visible-icon')).toBeTruthy();
  });

  it('supports calculator-driven sold price entry and bought-price editor actions', async () => {
    const onBoughtPriceChangeText = jest.fn();
    const onCancelBoughtPriceEdit = jest.fn();
    const onDecrement = jest.fn();
    const onFocus = jest.fn();
    const onIncrement = jest.fn();
    const onSaveBoughtPrice = jest.fn();
    const onSoldPriceChangeText = jest.fn();
    const onToggleBoughtPrice = jest.fn();

    renderSellUI(
      <SellFormFields
        boughtPriceActionLabel="Edit"
        boughtPriceEditorErrorMessage="Enter a valid bought price."
        boughtPriceEditorText="12.50"
        boughtPriceEditorVisible
        boughtPriceInputTestID="single-sell-bought-input"
        boughtPriceLabel="$12.50"
        marketPriceLabel="$25.00"
        onBoughtPriceChangeText={onBoughtPriceChangeText}
        onCancelBoughtPriceEdit={onCancelBoughtPriceEdit}
        onDecrement={onDecrement}
        onEditBoughtPrice={jest.fn()}
        onFocus={onFocus}
        onIncrement={onIncrement}
        onSaveBoughtPrice={onSaveBoughtPrice}
        onSoldPriceChangeText={onSoldPriceChangeText}
        onToggleBoughtPrice={onToggleBoughtPrice}
        quantity={2}
        revealsBoughtPrice={false}
        soldPriceTestID="single-sell-sold-price"
        soldPriceText=""
        stepperTestIDs={{ decrement: 'single-sell-dec', increment: 'single-sell-inc' }}
        testIDPrefix="single-sell"
        toggleBoughtPriceTestID="single-sell-toggle-bought"
      />,
    );

    fireEvent.press(screen.getByTestId('single-sell-dec'));
    fireEvent.press(screen.getByTestId('single-sell-inc'));
    expect(onDecrement).toHaveBeenCalledTimes(1);
    expect(onIncrement).toHaveBeenCalledTimes(1);

    fireEvent.press(screen.getByTestId('single-sell-save-bought-price'));
    fireEvent.press(screen.getByTestId('single-sell-cancel-bought-price'));
    expect(onSaveBoughtPrice).toHaveBeenCalledTimes(1);
    expect(onCancelBoughtPriceEdit).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('single-sell-bought-price-error')).toBeTruthy();

    fireEvent.press(screen.getByTestId('single-sell-sold-price'));
    expect(screen.getByTestId('single-sell-calculator-sheet')).toBeTruthy();

    fireEvent.press(screen.getByTestId('single-sell-calculator-equals'));
    expect(screen.getByText('Enter a valid calculation.')).toBeTruthy();

    fireEvent.press(screen.getByTestId('single-sell-calculator-key-1'));
    fireEvent.press(screen.getByTestId('single-sell-calculator-key-+'));
    fireEvent.press(screen.getByTestId('single-sell-calculator-key-2'));
    fireEvent.press(screen.getByTestId('single-sell-calculator-equals'));

    await waitFor(() => {
      expect(onSoldPriceChangeText).toHaveBeenCalledWith('3');
    });
    expect(onFocus).toHaveBeenCalled();
  });

  it('captures an optional transaction photo and shows the thumbnail', async () => {
    renderSellUI(<SellTransactionPhotoCapture testIDPrefix="single-sell" />);

    fireEvent.press(screen.getByTestId('single-sell-photo-trigger'));
    expect(screen.getByTestId('single-sell-camera-modal')).toBeTruthy();

    fireEvent.press(screen.getByTestId('single-sell-capture-photo'));

    await waitFor(() => {
      expect(screen.getByTestId('single-sell-photo-thumbnail')).toBeTruthy();
    });
    expect(screen.getByTestId('single-sell-retake-photo')).toBeTruthy();
  });
});
