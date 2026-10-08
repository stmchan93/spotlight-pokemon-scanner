import { fireEvent, render, screen, within } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import { SpotlightThemeProvider, cardGrid } from '@spotlight/design-system';
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

  it('renders rows with their testIDs', () => {
    renderGrid(entries);

    expect(screen.getByTestId('collection-masonry-grid')).toBeTruthy();
    // 4 entries → 2 rows of 2 columns.
    expect(screen.getByTestId('collection-masonry-grid-row-0')).toBeTruthy();
    expect(screen.getByTestId('collection-masonry-grid-row-1')).toBeTruthy();
    expect(screen.queryByTestId('collection-masonry-grid-row-2')).toBeNull();
  });

  function rowStyle(rowIndex: number) {
    return StyleSheet.flatten(
      screen.getByTestId(`collection-masonry-grid-row-${rowIndex}`).props.style,
    ) as { borderTopWidth?: number; paddingBottom?: number; paddingTop?: number };
  }

  // Figma 5722:21021: tiles separated by gray-50 gaps, no hairlines. Each row
  // paints its top gap; only the last row also paints the bottom one, so no
  // boundary gets a double gap.
  it('separates rows with gaps instead of rules', () => {
    renderGrid([...entries, makeEntry({ id: 'e' })]);

    for (const rowIndex of [0, 1, 2]) {
      expect(rowStyle(rowIndex).paddingTop).toBe(cardGrid.gap);
      expect(rowStyle(rowIndex).borderTopWidth ?? 0).toBe(0);
    }
    expect(rowStyle(0).paddingBottom ?? 0).toBe(0);
    expect(rowStyle(2).paddingBottom).toBe(cardGrid.gap);
  });

  // An odd count leaves the last row half-full; the empty cell must stay page
  // background rather than drawing a blank white tile.
  it('leaves the empty cell of a half-full row unfilled', () => {
    renderGrid([...entries, makeEntry({ id: 'e' })]);

    const fills = screen
      .getByTestId('collection-masonry-grid-row-2')
      .props.children.filter(Boolean)
      .map((cell: { props?: { style?: unknown } }) =>
        (StyleSheet.flatten(cell?.props?.style) as { backgroundColor?: string } | undefined)?.backgroundColor);

    expect(fills).toEqual([cardGrid.tileFill, undefined]);
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

  // An owned alt-art copy shows its printing's art, not the card's base art.
  it('shows the printing image for an alt-art copy and the card image otherwise', () => {
    renderGrid([
      makeEntry({
        id: 'saa',
        variantName: 'Special Alt Art',
        printingImageUrl: 'https://tcgplayer-cdn.tcgplayer.com/product/541670_in_1000x1000.jpg',
        printingImageSmallUrl: 'https://tcgplayer-cdn.tcgplayer.com/product/541670_400w.jpg',
      }),
      makeEntry({ id: 'base', variantName: 'Foil' }),
    ]);

    expect(screen.getByTestId('collection-masonry-grid-tile-saa-image').props.source).toEqual({
      uri: 'https://tcgplayer-cdn.tcgplayer.com/product/541670_400w.jpg',
    });
    expect(screen.getByTestId('collection-masonry-grid-tile-base-image').props.source).toEqual({
      uri: 'https://example.com/c-sm.png',
    });
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
