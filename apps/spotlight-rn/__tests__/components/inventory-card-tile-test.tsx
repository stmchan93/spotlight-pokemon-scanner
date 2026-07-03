import { fireEvent, render, screen } from '@testing-library/react-native';

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
    dayChangeLabel: '$3.99',
    dayChangeDirection: 'up',
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
  it('renders the name, number · set, variant, condition, quantity chip, and price', () => {
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
    // Quantity is the corner chip (box icon + count, Figma 2368:43362) — the
    // old "Qty: N" text line is gone.
    expect(screen.getByTestId('tile-quantity')).toBeTruthy();
    expect(screen.getByText('4')).toBeTruthy();
    expect(screen.queryByText('Qty: 4')).toBeNull();
    expect(screen.getByText('$12.50')).toBeTruthy();
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

  it('hides the day-change pill when dayChangeLabel is null', () => {
    renderTile({ dayChangeLabel: null, dayChangeDirection: null });

    expect(screen.queryByTestId('tile-delta')).toBeNull();
    expect(screen.queryByText('$3.99')).toBeNull();
  });

  it('renders an up arrow in the day-change pill when direction is up', () => {
    renderTile({ dayChangeLabel: '$3.99', dayChangeDirection: 'up' });

    expect(screen.getByTestId('tile-delta')).toBeTruthy();
    expect(screen.getByTestId('tile-delta-arrow-up')).toBeTruthy();
    expect(screen.queryByTestId('tile-delta-arrow-down')).toBeNull();
    expect(screen.getByText('$3.99')).toBeTruthy();
    expect(screen.queryByText('+ $3.99')).toBeNull();
  });

  it('renders a down arrow in the day-change pill when direction is down', () => {
    renderTile({ dayChangeLabel: '$3.99', dayChangeDirection: 'down' });

    expect(screen.getByTestId('tile-delta')).toBeTruthy();
    expect(screen.getByTestId('tile-delta-arrow-down')).toBeTruthy();
    expect(screen.queryByTestId('tile-delta-arrow-up')).toBeNull();
    expect(screen.queryByText('- $3.99')).toBeNull();
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
