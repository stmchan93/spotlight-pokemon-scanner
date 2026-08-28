import { fireEvent, render, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import { InventoryCardTile, SpotlightThemeProvider } from '@spotlight/design-system';

import * as mockApiClient from '../mock-api-client';

jest.mock('@spotlight/api-client', () => mockApiClient);

type RenderOptions = Partial<React.ComponentProps<typeof InventoryCardTile>>;

function renderTile(overrides: RenderOptions = {}) {
  const props: React.ComponentProps<typeof InventoryCardTile> = {
    imageUrl: 'https://example.com/card.png',
    name: 'Charizard ex',
    setName: 'Perfect Order',
    cardNumber: '193/162',
    kind: 'raw',
    conditionLabel: 'Near Mint',
    quantity: 2,
    priceLabel: '$450.12',
    isFavorite: false,
    onPress: jest.fn(),
    testID: 'tile',
    ...overrides,
  };

  const utils = render(
    <SpotlightThemeProvider>
      <InventoryCardTile {...props} />
    </SpotlightThemeProvider>,
  );

  return { ...utils, props };
}

describe('InventoryCardTile', () => {
  it('renders the name, number · set, variant, condition, quantity, and price', () => {
    renderTile({
      kind: 'raw',
      variantName: 'Holofoil',
      conditionLabel: 'Lightly Played',
      quantity: 4,
      priceLabel: '$12.50',
    });

    expect(screen.getByText('Charizard ex')).toBeTruthy();
    expect(screen.getByText('193/162 · Perfect Order')).toBeTruthy();
    // Variant renders ABOVE the condition line.
    expect(screen.getByText('Holofoil')).toBeTruthy();
    expect(screen.getByText('Lightly Played')).toBeTruthy();
    // Quantity renders at the right edge of the price row (count + box icon,
    // Figma 2489:6459) — the old top-left corner chip is gone.
    expect(screen.getByTestId('tile-quantity')).toBeTruthy();
    expect(screen.getByText('4')).toBeTruthy();
    expect(screen.queryByText('Qty: 4')).toBeNull();
    expect(screen.getByText('$12.50')).toBeTruthy();
  });

  it('hides the quantity readout when showQuantity is false', () => {
    renderTile({ showQuantity: false });

    expect(screen.queryByTestId('tile-quantity')).toBeNull();
  });

  it('strips a leading # from cardNumber so the metadata line has no hash', () => {
    renderTile({ cardNumber: '#No.003', setName: 'Dark Challenge' });

    expect(screen.getByText('No.003 · Dark Challenge')).toBeTruthy();
    expect(screen.queryByText(/#/)).toBeNull();
  });

  it('renders only the card number when setName is empty', () => {
    renderTile({ cardNumber: '193/162', setName: '' });

    expect(screen.getByText('193/162')).toBeTruthy();
  });

  it('renders only the set name when cardNumber is null', () => {
    renderTile({ cardNumber: null, setName: 'Perfect Order' });

    expect(screen.getByText('Perfect Order')).toBeTruthy();
  });

  it('renders the grader and grade as the quality line for a slab entry', () => {
    renderTile({
      kind: 'slab',
      conditionLabel: null,
      graderLabel: 'PSA',
      gradeLabel: '10',
    });

    expect(screen.getByText('PSA 10')).toBeTruthy();
  });

  it('renders an outlined star when isFavorite is false', () => {
    renderTile({ isFavorite: false });

    expect(screen.getByTestId('tile-star')).toBeTruthy();
    expect(screen.getByTestId('tile-star-outlined')).toBeTruthy();
    expect(screen.queryByTestId('tile-star-filled')).toBeNull();
  });

  it('renders a filled star when isFavorite is true', () => {
    renderTile({ isFavorite: true });

    expect(screen.getByTestId('tile-star')).toBeTruthy();
    expect(screen.getByTestId('tile-star-filled')).toBeTruthy();
    expect(screen.queryByTestId('tile-star-outlined')).toBeNull();
  });

  it('renders no day-change delta pill (removed in Figma 2489:6459)', () => {
    renderTile();

    expect(screen.queryByTestId('tile-delta')).toBeNull();
    expect(screen.queryByTestId('tile-delta-arrow-up')).toBeNull();
    expect(screen.queryByTestId('tile-delta-arrow-down')).toBeNull();
  });

  it('shows the selection check-circle badge (not a purple overlay) in selectable mode', () => {
    renderTile({ selectable: true, selected: true });

    // Selection now reads via the check-circle badge in the top-right slot…
    expect(screen.getByTestId('tile-select')).toBeTruthy();
    // …and the old purple square border + veil overlay are gone.
    expect(screen.queryByTestId('tile-selection-overlay')).toBeNull();
  });

  it('renders no selection badge or overlay when not in selectable mode', () => {
    renderTile({ selectable: false, selected: true });

    expect(screen.queryByTestId('tile-select')).toBeNull();
    expect(screen.queryByTestId('tile-selection-overlay')).toBeNull();
  });

  it('invokes onPress and onLongPress when interacted with', () => {
    const onPress = jest.fn();
    const onLongPress = jest.fn();
    renderTile({ onPress, onLongPress });

    const tile = screen.getByTestId('tile');
    fireEvent.press(tile);
    fireEvent(tile, 'longPress');

    expect(onPress).toHaveBeenCalledTimes(1);
    expect(onLongPress).toHaveBeenCalledTimes(1);
  });

  it('renders an em-dash when priceLabel is null', () => {
    renderTile({ priceLabel: null });

    expect(screen.getByText('—')).toBeTruthy();
  });

  function trendLabelColors(text: string): unknown[] {
    const label = screen.getByText(text);
    const flat = (Array.isArray(label.props.style)
      ? label.props.style.flat(Infinity)
      : [label.props.style]
    ).filter(Boolean);
    return flat
      .map((s: { color?: string } | null | undefined) => s && s.color)
      .filter(Boolean);
  }

  it('renders an up arrow + signed green percent under the price when positive', () => {
    renderTile({ trendChangePercent: 10.46, marketPrice: 450.12 });

    expect(screen.getByTestId('tile-trend')).toBeTruthy();
    expect(screen.getByTestId('tile-trend-arrow-up')).toBeTruthy();
    expect(screen.queryByTestId('tile-trend-arrow-down')).toBeNull();
    // green400 — matches the list rows' up color
    expect(trendLabelColors('+10.46%')).toContain('#4CAF6E');
  });

  it('renders a down arrow + signed red percent when negative', () => {
    renderTile({ trendChangePercent: -12.5, marketPrice: 450.12 });

    expect(screen.getByTestId('tile-trend')).toBeTruthy();
    expect(screen.getByTestId('tile-trend-arrow-down')).toBeTruthy();
    expect(screen.queryByTestId('tile-trend-arrow-up')).toBeNull();
    // red400 — matches the list rows' down color
    expect(trendLabelColors('-12.50%')).toContain('#E0524C');
  });

  it('renders a quiet gray 0.00% with NO arrow when exactly 0 (tracked but flat)', () => {
    renderTile({ trendChangePercent: 0, marketPrice: 450.12 });

    expect(screen.getByTestId('tile-trend')).toBeTruthy();
    expect(screen.queryByTestId('tile-trend-arrow-up')).toBeNull();
    expect(screen.queryByTestId('tile-trend-arrow-down')).toBeNull();
    // gray600 — flat is information, not direction
    expect(trendLabelColors('0.00%')).toContain('#717171');
  });

  it('hides the trend line when trendChangePercent is null', () => {
    renderTile({ trendChangePercent: null, marketPrice: 450.12 });

    expect(screen.queryByTestId('tile-trend')).toBeNull();
  });

  it('suppresses the trend line entirely for penny cards (marketPrice < $1)', () => {
    renderTile({ trendChangePercent: -50, marketPrice: 0.04, priceLabel: '$0.04' });

    // A −50% on $0.04 is technically true but misleads — render nothing.
    expect(screen.queryByTestId('tile-trend')).toBeNull();
    expect(screen.queryByText('-50.00%')).toBeNull();
    // The price itself still renders.
    expect(screen.getByText('$0.04')).toBeTruthy();
  });

  it('still renders the trend when marketPrice is absent (guard needs the number)', () => {
    renderTile({ trendChangePercent: 2.26 });

    expect(screen.getByTestId('tile-trend')).toBeTruthy();
    expect(screen.getByText('+2.26%')).toBeTruthy();
  });

  it('keeps the square art frame by default (existing consumers unchanged)', () => {
    renderTile();

    const frame = StyleSheet.flatten(
      screen.getByTestId('tile-image-frame').props.style,
    );
    expect(frame.aspectRatio).toBe(1);
  });

  it("renders the art frame at the trading-card aspect for artAspect='card'", () => {
    renderTile({ artAspect: 'card' });

    const frame = StyleSheet.flatten(
      screen.getByTestId('tile-image-frame').props.style,
    );
    expect(frame.aspectRatio).toBe(0.716);
  });

  it('renders a 1px #F2F2F2 hairline border around the tile', () => {
    renderTile();

    const tile = screen.getByTestId('tile');
    const flattened = Object.assign(
      {},
      ...(Array.isArray(tile.props.style)
        ? tile.props.style
        : [tile.props.style]),
    );

    expect(flattened.borderWidth).toBe(1);
    expect(flattened.borderColor).toBe('#F2F2F2');
  });

  it('renders a plain tile with no border or rounding when bordered={false}', () => {
    renderTile({ bordered: false });

    const tile = screen.getByTestId('tile');
    const flattened = Object.assign(
      {},
      ...(Array.isArray(tile.props.style)
        ? tile.props.style
        : [tile.props.style]),
    );

    expect(flattened.borderWidth).toBe(0);
    expect(flattened.borderRadius).toBe(0);
    expect(flattened.backgroundColor).toBe('transparent');
  });
});
