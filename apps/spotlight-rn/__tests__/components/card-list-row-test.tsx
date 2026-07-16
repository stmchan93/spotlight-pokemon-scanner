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
    trendChangeAmount: 3.99,
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

  it('hides the trend block when trendChangeAmount is null', () => {
    renderRow({ trendChangeAmount: null });

    expect(screen.queryByTestId('row-trend')).toBeNull();
  });

  it('hides the trend block when trendChangeAmount is 0', () => {
    renderRow({ trendChangeAmount: 0 });

    expect(screen.queryByTestId('row-trend')).toBeNull();
  });

  it('renders an up arrow with the absolute trend amount when positive', () => {
    renderRow({ trendChangeAmount: 3.99 });

    expect(screen.getByTestId('row-trend')).toBeTruthy();
    expect(screen.getByTestId('row-trend-arrow-up')).toBeTruthy();
    expect(screen.queryByTestId('row-trend-arrow-down')).toBeNull();
    expect(screen.getByText('$3.99')).toBeTruthy();
  });

  it('renders a down arrow with red color and the absolute amount when negative', () => {
    renderRow({ trendChangeAmount: -5.25 });

    expect(screen.getByTestId('row-trend')).toBeTruthy();
    expect(screen.getByTestId('row-trend-arrow-down')).toBeTruthy();
    expect(screen.queryByTestId('row-trend-arrow-up')).toBeNull();

    const label = screen.getByText('$5.25');
    const flat = (Array.isArray(label.props.style)
      ? label.props.style.flat(Infinity)
      : [label.props.style]
    ).filter(Boolean);
    const colors = flat
      .map((s: { color?: string } | null | undefined) => s && s.color)
      .filter(Boolean);
    // deltaDownText token value (Figma delta pill red/600, 1263:3148)
    expect(colors).toContain('#B22416');
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

  it('honors a non-USD currencyCode when formatting price and trend', () => {
    renderRow({ marketPrice: 10, trendChangeAmount: 2.5, currencyCode: 'EUR' });

    expect(screen.getByTestId('row-price')).toBeTruthy();
    // Intl output for EUR in en-US is typically "€10.00" / "€2.50"
    expect(screen.getByText(/€\s?10\.00/)).toBeTruthy();
    expect(screen.getByText(/€\s?2\.50/)).toBeTruthy();
  });

  it('appends the unsigned percent to the pill when trendChangePercent is provided', () => {
    renderRow({ trendChangeAmount: 142, trendChangePercent: 31 });

    // Two-decimal unsigned percent (balance-header formatting); the arrow
    // carries the direction.
    expect(screen.getByText('$142.00 (31.00%)')).toBeTruthy();
    expect(screen.getByTestId('row-trend-arrow-up')).toBeTruthy();
  });

  it('shows the unsigned percent with the down arrow for a negative trend', () => {
    renderRow({ trendChangeAmount: -5.25, trendChangePercent: -12.5 });

    expect(screen.getByText('$5.25 (12.50%)')).toBeTruthy();
    expect(screen.getByTestId('row-trend-arrow-down')).toBeTruthy();
  });

  it('keeps the amount-only pill when trendChangePercent is null', () => {
    renderRow({ trendChangeAmount: 3.99, trendChangePercent: null });

    expect(screen.getByText('$3.99')).toBeTruthy();
  });

  it('renders the trend caption under the pill', () => {
    renderRow({ trendChangeAmount: 3.99, trendCaption: 'since added' });

    expect(screen.getByTestId('row-trend-caption')).toBeTruthy();
    expect(screen.getByText('since added')).toBeTruthy();
  });

  it('hides the trend caption when the pill itself is hidden (0/null trend)', () => {
    const zero = renderRow({ trendChangeAmount: 0, trendCaption: 'since added' });
    expect(screen.queryByTestId('row-trend-caption')).toBeNull();
    zero.unmount();

    renderRow({ trendChangeAmount: null, trendCaption: 'since added' });
    expect(screen.queryByTestId('row-trend-caption')).toBeNull();
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
