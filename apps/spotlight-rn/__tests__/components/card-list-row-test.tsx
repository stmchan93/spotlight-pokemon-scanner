import { fireEvent, render, screen } from '@testing-library/react-native';

import { CardListRow, SpotlightThemeProvider } from '@spotlight/design-system';

import * as mockApiClient from '../mock-api-client';

jest.mock('@spotlight/api-client', () => mockApiClient);

type RenderOptions = Partial<React.ComponentProps<typeof CardListRow>>;

function renderRow(overrides: RenderOptions = {}) {
  const props: React.ComponentProps<typeof CardListRow> = {
    imageUrl: 'https://example.com/card.png',
    name: 'Charizard ex',
    cardNumber: '100/101',
    setName: 'Dragon Frontiers',
    gradeLabel: 'PSA 10',
    marketPrice: 129198.3,
    trendChangePercent: 2.26,
    quantity: 2,
    onPress: jest.fn(),
    testID: 'row',
    ...overrides,
  };

  const utils = render(
    <SpotlightThemeProvider>
      <CardListRow {...props} />
    </SpotlightThemeProvider>,
  );

  return { ...utils, props };
}

describe('CardListRow', () => {
  it('renders the name, number · set, grade label, price, and quantity', () => {
    renderRow();

    expect(screen.getByText('Charizard ex')).toBeTruthy();
    expect(screen.getByText('100/101 · Dragon Frontiers')).toBeTruthy();
    expect(screen.getByText('PSA 10')).toBeTruthy();
    expect(screen.getByText('$129,198.30')).toBeTruthy();
    expect(screen.getByText('Qty: 2')).toBeTruthy();
  });

  it('invokes onPress when the row is pressed', () => {
    const onPress = jest.fn();
    renderRow({ onPress });

    fireEvent.press(screen.getByTestId('row'));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('hides the trend line when trendChangePercent is null', () => {
    renderRow({ trendChangePercent: null });

    expect(screen.queryByTestId('row-trend')).toBeNull();
  });

  it('renders a quiet gray 0.00% when trendChangePercent is exactly 0 (tracked but flat)', () => {
    renderRow({ trendChangePercent: 0 });

    const label = screen.getByText('0.00%');
    const flat = (Array.isArray(label.props.style)
      ? label.props.style.flat(Infinity)
      : [label.props.style]
    ).filter(Boolean);
    const colors = flat
      .map((s: { color?: string } | null | undefined) => s && s.color)
      .filter(Boolean);
    // gray600 — flat is information, not direction
    expect(colors).toContain('#717171');
  });

  it('renders a signed green percent under the price when positive', () => {
    renderRow({ trendChangePercent: 2.26 });

    expect(screen.getByTestId('row-trend')).toBeTruthy();
    const label = screen.getByText('+2.26%');
    const flat = (Array.isArray(label.props.style)
      ? label.props.style.flat(Infinity)
      : [label.props.style]
    ).filter(Boolean);
    const colors = flat
      .map((s: { color?: string } | null | undefined) => s && s.color)
      .filter(Boolean);
    // green400 — matches the balance header's up color
    expect(colors).toContain('#4CAF6E');
  });

  it('renders a signed red percent when negative', () => {
    renderRow({ trendChangePercent: -12.5 });

    const label = screen.getByText('-12.50%');
    const flat = (Array.isArray(label.props.style)
      ? label.props.style.flat(Infinity)
      : [label.props.style]
    ).filter(Boolean);
    const colors = flat
      .map((s: { color?: string } | null | undefined) => s && s.color)
      .filter(Boolean);
    // red400 — matches the balance header's down color
    expect(colors).toContain('#E0524C');
  });

  it('renders the thumbnail at the Figma dimensions (58x80, radius 2)', () => {
    renderRow();

    const thumbnail = screen.getByTestId('row-thumbnail');
    const flat = (Array.isArray(thumbnail.props.style)
      ? thumbnail.props.style.flat(Infinity)
      : [thumbnail.props.style]
    ).filter(Boolean);
    const merged = Object.assign({}, ...flat);
    expect(merged.width).toBe(58);
    expect(merged.height).toBe(80);
    expect(merged.borderRadius).toBe(2);
    // no thumbnail border in the Figma spec
    expect(merged.borderWidth).toBeUndefined();
  });

  it('omits the thumbnail when showThumbnail is false (wishlist row, Figma 992:10052)', () => {
    renderRow({ showThumbnail: false });

    expect(screen.queryByTestId('row-thumbnail')).toBeNull();
    expect(screen.queryByTestId('row-image')).toBeNull();
  });

  function mergedRowStyle() {
    const row = screen.getByTestId('row');
    const flat = (Array.isArray(row.props.style)
      ? row.props.style.flat(Infinity)
      : [row.props.style]
    ).filter(Boolean);
    return Object.assign({}, ...flat);
  }

  it('draws only a bottom hairline by default so adjacent rows share one divider', () => {
    renderRow();

    const merged = mergedRowStyle();
    expect(merged.borderBottomWidth).toBe(1);
    expect(merged.borderBottomColor).toBe('#F2F2F2');
    // No top border by default — the previous row's bottom hairline serves as
    // the divider, so stacked rows don't double their borders.
    expect(merged.borderTopWidth).toBeUndefined();
  });

  it('adds a top hairline when firstInSection so the list has a framed top edge', () => {
    renderRow({ firstInSection: true });

    const merged = mergedRowStyle();
    expect(merged.borderBottomWidth).toBe(1);
    expect(merged.borderBottomColor).toBe('#F2F2F2');
    expect(merged.borderTopWidth).toBe(1);
    expect(merged.borderTopColor).toBe('#F2F2F2');
  });

  it('renders the CARD placeholder when imageUrl is null and does not crash', () => {
    renderRow({ imageUrl: null });

    expect(screen.getByTestId('row-thumbnail-placeholder')).toBeTruthy();
    expect(screen.getByText('CARD')).toBeTruthy();
    expect(screen.queryByTestId('row-image')).toBeNull();
  });

  it('does not render the price block when marketPrice is null', () => {
    renderRow({ marketPrice: null });

    expect(screen.queryByTestId('row-price')).toBeNull();
  });

  it('omits the grade line when gradeLabel is null', () => {
    renderRow({ gradeLabel: null });

    expect(screen.queryByText('PSA 10')).toBeNull();
  });

  it('honors a non-USD currencyCode when formatting the price', () => {
    renderRow({ marketPrice: 10, currencyCode: 'EUR' });

    expect(screen.getByTestId('row-price')).toBeTruthy();
    // Intl output for EUR in en-US is typically "€10.00"
    expect(screen.getByText(/€\s?10\.00/)).toBeTruthy();
  });

  it('renders quantity in the left copy stack under the grade line', () => {
    renderRow({ quantity: 3 });

    expect(screen.getByTestId('row-quantity')).toBeTruthy();
    expect(screen.getByText('Qty: 3')).toBeTruthy();
  });

  it('hides quantity when showQuantity is false (wishlist rows)', () => {
    renderRow({ showQuantity: false });

    expect(screen.queryByTestId('row-quantity')).toBeNull();
  });

  it('renders the sparkline between the copy block and the price column when sparkPoints are provided', () => {
    renderRow({ sparkPoints: [1, 2, 1.5, 3], sparkTrendPct: 12 });

    expect(screen.getByTestId('row-sparkline')).toBeTruthy();
    // The rest of the row is unchanged.
    expect(screen.getByText('Charizard ex')).toBeTruthy();
    expect(screen.getByTestId('row-price')).toBeTruthy();
  });

  it('renders no sparkline when sparkPoints are absent or empty', () => {
    const bare = renderRow();
    expect(screen.queryByTestId('row-sparkline')).toBeNull();
    bare.unmount();

    renderRow({ sparkPoints: [] });
    expect(screen.queryByTestId('row-sparkline')).toBeNull();
  });
});
