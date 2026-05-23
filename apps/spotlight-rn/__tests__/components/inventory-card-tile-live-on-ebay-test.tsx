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
    quantity: 1,
    priceLabel: '$450.12',
    dayChangeLabel: null,
    dayChangeDirection: null,
    isFavorite: false,
    onPress: jest.fn(),
    testID: 'tile',
    ...overrides,
  };

  return render(
    <SpotlightThemeProvider>
      <InventoryCardTile {...props} />
    </SpotlightThemeProvider>,
  );
}

describe('InventoryCardTile · liveOnEbay', () => {
  it('renders the Live on eBay footer when liveOnEbay is true', () => {
    renderTile({ liveOnEbay: true, onOpenListing: jest.fn() });

    expect(screen.getByTestId('tile-live-on-ebay')).toBeTruthy();
    expect(screen.getByText('Live on eBay')).toBeTruthy();
  });

  it('does not render the footer when liveOnEbay is false (default)', () => {
    renderTile({ liveOnEbay: false });

    expect(screen.queryByTestId('tile-live-on-ebay')).toBeNull();
    expect(screen.queryByText('Live on eBay')).toBeNull();
  });

  it('does not render the footer when liveOnEbay is omitted entirely', () => {
    renderTile({});

    expect(screen.queryByTestId('tile-live-on-ebay')).toBeNull();
  });

  it('fires onOpenListing when the footer is tapped', () => {
    const onOpenListing = jest.fn();
    renderTile({ liveOnEbay: true, onOpenListing });

    fireEvent.press(screen.getByTestId('tile-live-on-ebay'));
    expect(onOpenListing).toHaveBeenCalledTimes(1);
  });

  it('renders the favorite star at 20x20', () => {
    renderTile({ isFavorite: false });

    const outlined = screen.getByTestId('tile-star-outlined');
    expect(outlined.props.height).toBe(20);
    expect(outlined.props.width).toBe(20);
  });

  it('renders the filled favorite star at 20x20', () => {
    renderTile({ isFavorite: true });

    const filled = screen.getByTestId('tile-star-filled');
    expect(filled.props.height).toBe(20);
    expect(filled.props.width).toBe(20);
  });
});
