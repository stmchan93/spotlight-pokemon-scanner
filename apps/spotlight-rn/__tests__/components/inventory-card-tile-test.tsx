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
    dayChangeLabel: '+ $3.99',
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
  it('renders the name, set+number, condition, quantity, and price for a raw entry', () => {
    renderTile({
      kind: 'raw',
      conditionLabel: 'Lightly Played',
      quantity: 4,
      priceLabel: '$12.50',
    });

    expect(screen.getByText('Charizard ex')).toBeTruthy();
    expect(screen.getByText('Perfect Order #193/162')).toBeTruthy();
    expect(screen.getByText('Lightly Played')).toBeTruthy();
    expect(screen.getByText('Qty: 4')).toBeTruthy();
    expect(screen.getByText('$12.50')).toBeTruthy();
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

  it('hides the favorite star when isFavorite is false', () => {
    renderTile({ isFavorite: false });

    expect(screen.queryByTestId('tile-star')).toBeNull();
  });

  it('shows the favorite star when isFavorite is true', () => {
    renderTile({ isFavorite: true });

    expect(screen.getByTestId('tile-star')).toBeTruthy();
  });

  it('hides the day-change pill when dayChangeLabel is null', () => {
    renderTile({ dayChangeLabel: null });

    expect(screen.queryByTestId('tile-delta')).toBeNull();
    expect(screen.queryByText('+ $3.99')).toBeNull();
  });

  it('renders the day-change pill when dayChangeLabel is provided', () => {
    renderTile({ dayChangeLabel: '+ $3.99' });

    expect(screen.getByTestId('tile-delta')).toBeTruthy();
    expect(screen.getByText('+ $3.99')).toBeTruthy();
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
