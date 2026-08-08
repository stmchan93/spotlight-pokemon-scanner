import { fireEvent, render, screen, within } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

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

  it('renders ruled rows with their testIDs', () => {
    renderGrid(entries);

    expect(screen.getByTestId('collection-masonry-grid')).toBeTruthy();
    // 4 entries → 2 rows of 2 columns.
    expect(screen.getByTestId('collection-masonry-grid-row-0')).toBeTruthy();
    expect(screen.getByTestId('collection-masonry-grid-row-1')).toBeTruthy();
    expect(screen.queryByTestId('collection-masonry-grid-row-2')).toBeNull();
  });

  // An odd card count leaves the last row half-full. The centre rule used to be
  // drawn only when the second cell HAD a card, so that row lost its divider and
  // the grid's centre line visibly broke on the final row.
  it('keeps the centre divider on a half-full last row', () => {
    renderGrid([...entries, makeEntry({ id: 'e' })]);

    const lastRow = screen.getByTestId('collection-masonry-grid-row-2');
    const dividers = lastRow.props.children
      .filter(Boolean)
      .map((cell: { props?: { style?: unknown } }) => StyleSheet.flatten(cell?.props?.style))
      .filter((style: { borderLeftWidth?: number } | undefined) => (style?.borderLeftWidth ?? 0) > 0);

    // The second cell rules against the first, empty or not.
    expect(dividers).toHaveLength(1);
  });

  it('renders a tile testID for every entry', () => {
    renderGrid(entries);

    for (const entry of entries) {
      expect(
        screen.getByTestId(`collection-masonry-grid-tile-${entry.id}`),
      ).toBeTruthy();
    }
  });

  it('lays entries left-to-right into rows of two', () => {
    renderGrid(entries);

    const rowZero = within(screen.getByTestId('collection-masonry-grid-row-0'));
    const rowOne = within(screen.getByTestId('collection-masonry-grid-row-1'));

    // First two entries fill row 0, next two fill row 1.
    expect(rowZero.getByTestId('collection-masonry-grid-tile-a')).toBeTruthy();
    expect(rowZero.getByTestId('collection-masonry-grid-tile-b')).toBeTruthy();
    expect(rowOne.getByTestId('collection-masonry-grid-tile-c')).toBeTruthy();
    expect(rowOne.getByTestId('collection-masonry-grid-tile-d')).toBeTruthy();
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
