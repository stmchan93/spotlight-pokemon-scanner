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
    // redDelta token value
    expect(colors).toContain('#E0524C');
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
});
