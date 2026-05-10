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
  it('renders the name, number · set, condition, quantity, and price for a raw entry', () => {
    renderTile({
      kind: 'raw',
      conditionLabel: 'Lightly Played',
      quantity: 4,
      priceLabel: '$12.50',
    });

    expect(screen.getByText('Charizard ex')).toBeTruthy();
    expect(screen.getByText('#193/162 · Perfect Order')).toBeTruthy();
    expect(screen.getByText('Lightly Played')).toBeTruthy();
    expect(screen.getByText('Qty: 4')).toBeTruthy();
    expect(screen.getByText('$12.50')).toBeTruthy();
  });

  it('strips a leading # from cardNumber so the metadata line uses a single hash', () => {
    renderTile({ cardNumber: '#No.003', setName: 'Dark Challenge' });

    expect(screen.getByText('#No.003 · Dark Challenge')).toBeTruthy();
    expect(screen.queryByText('##No.003')).toBeNull();
    expect(screen.queryByText(/##/)).toBeNull();
  });

  it('renders only the card number when setName is empty', () => {
    renderTile({ cardNumber: '193/162', setName: '' });

    expect(screen.getByText('#193/162')).toBeTruthy();
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
    expect(screen.getByText('☆')).toBeTruthy();
  });

  it('renders a filled star when isFavorite is true', () => {
    renderTile({ isFavorite: true });

    expect(screen.getByTestId('tile-star')).toBeTruthy();
    expect(screen.getByTestId('tile-star-filled')).toBeTruthy();
    expect(screen.queryByTestId('tile-star-outlined')).toBeNull();
    expect(screen.getByText('★')).toBeTruthy();
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
    expect(screen.getByText('↑')).toBeTruthy();
    expect(screen.getByText('$3.99')).toBeTruthy();
    expect(screen.queryByText('+ $3.99')).toBeNull();
  });

  it('renders a down arrow in the day-change pill when direction is down', () => {
    renderTile({ dayChangeLabel: '$3.99', dayChangeDirection: 'down' });

    expect(screen.getByTestId('tile-delta')).toBeTruthy();
    expect(screen.getByTestId('tile-delta-arrow-down')).toBeTruthy();
    expect(screen.queryByTestId('tile-delta-arrow-up')).toBeNull();
    expect(screen.getByText('↓')).toBeTruthy();
    expect(screen.queryByText('- $3.99')).toBeNull();
  });

  it('renders a selection overlay when selected is true', () => {
    renderTile({ selected: true });

    expect(screen.getByTestId('tile-selection-overlay')).toBeTruthy();
  });

  it('does not render a selection overlay when selected is false', () => {
    renderTile({ selected: false });

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
});
