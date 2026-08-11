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

  function ruleOf(rowIndex: number) {
    return StyleSheet.flatten(
      screen.getByTestId(`collection-masonry-grid-row-${rowIndex}`).props.style,
    ) as { borderTopWidth?: number; borderBottomWidth?: number };
  }

  /*
    Figma 3670:47296 hangs the 0.5pt rule off the TOP of every card, not the
    bottom of every row — which is what stops an interior boundary being drawn
    twice, once by the row above and once by the row below.

    INTERIOR rows therefore have no bottom rule. The LAST one does, because
    there is no next row to draw that edge; see the next test for why the grid
    has to close at all.
  */
  it('rules interior rows on top only, so no boundary is drawn twice', () => {
    renderGrid(entries);

    expect(ruleOf(0).borderTopWidth).toBe(0.5);
    expect(ruleOf(0).borderBottomWidth ?? 0).toBe(0);
    expect(ruleOf(1).borderTopWidth).toBe(0.5);
  });

  /*
    THE REPORTED BUG. A wishlist of three cards leaves the last row half-full,
    and the centre divider is drawn there whether or not the second cell has a
    card (see the test above — skipping it broke the grid's centre line). With
    no closing rule that vertical hairline ran down beside blank space and
    terminated in mid-air, so the grid looked torn off rather than finished.

    The card component in Figma cannot specify this: a card knows its own
    strokes, not whether it is the last one on the screen.
  */
  it('closes the grid under the final row', () => {
    renderGrid([...entries, makeEntry({ id: 'e' })]);

    expect(screen.getByTestId('collection-masonry-grid-row-2')).toBeTruthy();
    expect(ruleOf(2).borderBottomWidth).toBe(0.5);
    // …and only the final row. An interior bottom rule would double up with the
    // next row's top rule, which is the bug the top-only scheme exists to fix.
    expect(ruleOf(0).borderBottomWidth ?? 0).toBe(0);
    expect(ruleOf(1).borderBottomWidth ?? 0).toBe(0);
  });

  // A single full row is both the first and the last, so it carries both rules.
  it('closes a grid that is only one row tall', () => {
    renderGrid([makeEntry({ id: 'a' }), makeEntry({ id: 'b' })]);

    expect(ruleOf(0).borderTopWidth).toBe(0.5);
    expect(ruleOf(0).borderBottomWidth).toBe(0.5);
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
