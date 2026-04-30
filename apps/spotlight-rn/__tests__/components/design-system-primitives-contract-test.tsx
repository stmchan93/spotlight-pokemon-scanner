import { fireEvent, render, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import {
  AppText,
  Badge,
  CardThumbnail,
  colors,
  ListRow,
  PriceText,
  QuantityStepper,
  radii,
  SheetSurface,
  SkeletonBlock,
  SpotlightThemeProvider,
  textStyles,
} from '@spotlight/design-system';

function renderPrimitive(node: React.ReactElement) {
  return render(<SpotlightThemeProvider>{node}</SpotlightThemeProvider>);
}

function flattenStyle(style: unknown) {
  if (typeof style === 'function') {
    return StyleSheet.flatten(style({ pressed: false }));
  }

  return StyleSheet.flatten(style);
}

describe('design-system primitive contracts', () => {
  it('renders AppText and PriceText with typography tokens instead of ad-hoc text styles', () => {
    renderPrimitive(
      <>
        <AppText testID="app-text" variant="headline">Token headline</AppText>
        <PriceText amount={42} testID="price-text" variant="display" />
      </>,
    );

    expect(flattenStyle(screen.getByTestId('app-text').props.style)).toEqual(
      expect.objectContaining(textStyles.headline),
    );
    expect(flattenStyle(screen.getByTestId('price-text').props.style)).toEqual(
      expect.objectContaining({
        ...textStyles.display,
        color: colors.textPrimary,
      }),
    );
    expect(screen.getByText('$42.00')).toBeTruthy();
  });

  it('keeps Badge, SkeletonBlock, SheetSurface, and CardThumbnail on shared color/radius tokens', () => {
    renderPrimitive(
      <>
        <Badge label="Raw" testID="badge" tone="brand" />
        <SkeletonBlock testID="skeleton" />
        <SheetSurface testID="sheet">
          <AppText>Sheet content</AppText>
        </SheetSurface>
        <CardThumbnail testID="thumbnail" />
      </>,
    );

    expect(flattenStyle(screen.getByTestId('badge').props.style)).toEqual(
      expect.objectContaining({
        backgroundColor: colors.brand,
        borderColor: colors.brand,
        borderRadius: radii.pill,
      }),
    );
    expect(flattenStyle(screen.getByTestId('skeleton').props.style)).toEqual(
      expect.objectContaining({
        backgroundColor: colors.field,
        borderRadius: radii.md,
      }),
    );
    expect(flattenStyle(screen.getByTestId('sheet').props.style)).toEqual(
      expect.objectContaining({
        backgroundColor: colors.canvasElevated,
        borderColor: colors.outlineSubtle,
        borderTopLeftRadius: radii.xxl,
        borderTopRightRadius: radii.xxl,
      }),
    );
    expect(flattenStyle(screen.getByTestId('thumbnail').props.style)).toEqual(
      expect.objectContaining({
        backgroundColor: colors.field,
        borderColor: colors.outlineSubtle,
      }),
    );
  });

  it('keeps ListRow and QuantityStepper token-based and exposes simple interactions', () => {
    const onRowPress = jest.fn();
    const onQuantityChange = jest.fn();

    renderPrimitive(
      <>
        <ListRow
          meta="$18"
          onPress={onRowPress}
          subtitle="Base Set - 4/102"
          testID="list-row"
          title="Charizard"
        />
        <QuantityStepper
          min={1}
          onChange={onQuantityChange}
          testID="quantity"
          value={2}
        />
      </>,
    );

    expect(flattenStyle(screen.getByTestId('list-row').props.style)).toEqual(
      expect.objectContaining({
        backgroundColor: colors.canvasElevated,
        borderColor: colors.outlineSubtle,
        borderRadius: radii.lg,
      }),
    );
    expect(flattenStyle(screen.getByTestId('quantity').props.style)).toEqual(
      expect.objectContaining({
        backgroundColor: colors.field,
        borderColor: colors.outlineSubtle,
        borderRadius: radii.pill,
      }),
    );

    fireEvent.press(screen.getByTestId('list-row'));
    fireEvent.press(screen.getByTestId('quantity-increment'));
    fireEvent.press(screen.getByTestId('quantity-decrement'));

    expect(onRowPress).toHaveBeenCalledTimes(1);
    expect(onQuantityChange).toHaveBeenNthCalledWith(1, 3);
    expect(onQuantityChange).toHaveBeenNthCalledWith(2, 1);
  });
});
