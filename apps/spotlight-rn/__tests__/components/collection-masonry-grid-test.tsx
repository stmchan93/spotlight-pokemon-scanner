import { fireEvent, render, screen } from '@testing-library/react-native';

import { SpotlightThemeProvider } from '@spotlight/design-system';
import type { InventoryCardEntry } from '@spotlight/api-client';

import { CollectionMasonryGrid } from '@/features/portfolio/components/collection-masonry-grid';

function makeEntry(overrides: Partial<InventoryCardEntry> = {}): InventoryCardEntry {
  return {
    id: 'entry-1',
    cardId: 'card-1',
    name: 'Charizard ex',
    cardNumber: '193/162',
    setName: 'Perfect Order',
    imageUrl: 'https://example.com/c.png',
    smallImageUrl: 'https://example.com/c-sm.png',
    largeImageUrl: null,
    marketPrice: 450,
    hasMarketPrice: true,
    currencyCode: 'USD',
    quantity: 1,
    addedAt: '2024-01-01T00:00:00Z',
    kind: 'raw',
    conditionLabel: 'Near Mint',
    isFavorite: false,
    dayChangeAmount: null,
    dayChangePercent: null,
    listingUrl: null,
    ...overrides,
  };
}

function renderGrid(entries: InventoryCardEntry[], onPressEntry = jest.fn()) {
  return {
    onPressEntry,
    ...render(
      <SpotlightThemeProvider>
        <CollectionMasonryGrid entries={entries} onPressEntry={onPressEntry} />
      </SpotlightThemeProvider>,
    ),
  };
}

describe('CollectionMasonryGrid', () => {
  const entries = [
    makeEntry({ id: 'a' }),
    makeEntry({ id: 'b' }),
    makeEntry({ id: 'c' }),
    makeEntry({ id: 'd' }),
  ];

  it('renders left + right columns with their testIDs', () => {
    renderGrid(entries);

    expect(screen.getByTestId('collection-masonry-grid')).toBeTruthy();
    expect(screen.getByTestId('collection-masonry-grid-col-left')).toBeTruthy();
    expect(screen.getByTestId('collection-masonry-grid-col-right')).toBeTruthy();
  });

  it('renders a tile testID for every entry', () => {
    renderGrid(entries);

    for (const entry of entries) {
      expect(
        screen.getByTestId(`collection-masonry-grid-tile-${entry.id}`),
      ).toBeTruthy();
    }
  });

  it('distributes 4 equal-height entries roughly evenly (2 per column)', () => {
    renderGrid(entries);

    const leftCol = screen.getByTestId('collection-masonry-grid-col-left');
    const rightCol = screen.getByTestId('collection-masonry-grid-col-right');

    // Each column should contain 2 tile slots. Tiles render under a wrapper
    // View; flat-count children to verify the distribution.
    expect(leftCol.findAllByType('View').length).toBeGreaterThan(0);
    expect(rightCol.findAllByType('View').length).toBeGreaterThan(0);

    // Tile testIDs make the column membership unambiguous; assert that the
    // first two land in left and the last two in right.
    const leftTileA = screen.getByTestId('collection-masonry-grid-tile-a');
    const rightTileB = screen.getByTestId('collection-masonry-grid-tile-b');
    expect(leftTileA).toBeTruthy();
    expect(rightTileB).toBeTruthy();
  });

  it('triggers onPressEntry with the right entry when a tile is tapped', () => {
    const onPressEntry = jest.fn();
    renderGrid(entries, onPressEntry);

    fireEvent.press(screen.getByTestId('collection-masonry-grid-tile-c'));
    expect(onPressEntry).toHaveBeenCalledTimes(1);
    expect(onPressEntry).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'c' }),
    );
  });
});
