import { fireEvent, render, screen } from '@testing-library/react-native';

import { SpotlightThemeProvider } from '@spotlight/design-system';

import {
  CollectionFilterChipRow,
  COLLECTION_FILTER_ORDER,
} from '@/features/portfolio/components/collection-filter-chip-row';

describe('CollectionFilterChipRow', () => {
  it('renders all 12 filter chips with their testIDs', () => {
    render(
      <SpotlightThemeProvider>
        <CollectionFilterChipRow activeFilter="all" onFilterChange={jest.fn()} />
      </SpotlightThemeProvider>,
    );

    // 7 base chips + the 5 rarity chips (sir/illustration/ultra/secret/shiny).
    expect(COLLECTION_FILTER_ORDER).toHaveLength(12);
    for (const key of COLLECTION_FILTER_ORDER) {
      expect(screen.getByTestId(`collection-filter-chip-row-${key}`)).toBeTruthy();
    }
  });

  it('renders the rarity chips after the base chips with labels from the api-client', () => {
    render(
      <SpotlightThemeProvider>
        <CollectionFilterChipRow activeFilter="all" onFilterChange={jest.fn()} />
      </SpotlightThemeProvider>,
    );

    expect(COLLECTION_FILTER_ORDER.slice(7)).toEqual(['sir', 'illustration', 'ultra', 'secret', 'shiny']);
    expect(screen.getByText('SIR')).toBeTruthy();
    expect(screen.getByText('ILLUS. RARE')).toBeTruthy();
    expect(screen.getByText('FULL ART')).toBeTruthy();
    expect(screen.getByText('SECRET')).toBeTruthy();
    expect(screen.getByText('SHINY')).toBeTruthy();
  });

  it('labels the price chip "Price" (Figma 5938:16835)', () => {
    render(
      <SpotlightThemeProvider>
        <CollectionFilterChipRow activeFilter="all" onFilterChange={jest.fn()} />
      </SpotlightThemeProvider>,
    );

    expect(screen.getByText('PRICE')).toBeTruthy();
    expect(screen.queryByText('$$$')).toBeNull();
  });

  it('fires onFilterChange with the correct key when a chip is tapped', () => {
    const onFilterChange = jest.fn();
    render(
      <SpotlightThemeProvider>
        <CollectionFilterChipRow activeFilter="all" onFilterChange={onFilterChange} />
      </SpotlightThemeProvider>,
    );

    fireEvent.press(screen.getByTestId('collection-filter-chip-row-favorites'));
    expect(onFilterChange).toHaveBeenCalledWith('favorites');

    fireEvent.press(screen.getByTestId('collection-filter-chip-row-graded'));
    expect(onFilterChange).toHaveBeenCalledWith('graded');
  });

  it('marks the active filter chip as selected via accessibilityState', () => {
    render(
      <SpotlightThemeProvider>
        <CollectionFilterChipRow activeFilter="price" onFilterChange={jest.fn()} />
      </SpotlightThemeProvider>,
    );

    const activeChip = screen.getByTestId('collection-filter-chip-row-price');
    expect(activeChip.props.accessibilityState).toMatchObject({ selected: true });

    const otherChip = screen.getByTestId('collection-filter-chip-row-all');
    expect(otherChip.props.accessibilityState).toMatchObject({ selected: false });
  });

  it('offers no game chip to a single-game collection', () => {
    // Almost every collection is Pokémon-only. A chip that can only ever return
    // the whole list is clutter, so it simply isn't there.
    render(
      <SpotlightThemeProvider>
        <CollectionFilterChipRow
          activeFilter="all"
          games={['pokemon']}
          onFilterChange={jest.fn()}
        />
      </SpotlightThemeProvider>,
    );

    expect(screen.queryByTestId('collection-filter-chip-row-game:pokemon')).toBeNull();
  });

  it('offers one chip per game once a collection spans more than one', () => {
    const onFilterChange = jest.fn();
    render(
      <SpotlightThemeProvider>
        <CollectionFilterChipRow
          activeFilter="all"
          games={['pokemon', 'onepiece']}
          onFilterChange={onFilterChange}
        />
      </SpotlightThemeProvider>,
    );

    // Labelled from the capability table, so "onepiece" reads as "One Piece".
    expect(screen.getByText('ONE PIECE')).toBeTruthy();
    expect(screen.getByText('POKÉMON')).toBeTruthy();
    // A game the user owns nothing from is not offered.
    expect(screen.queryByTestId('collection-filter-chip-row-game:lorcana')).toBeNull();

    fireEvent.press(screen.getByTestId('collection-filter-chip-row-game:onepiece'));
    expect(onFilterChange).toHaveBeenCalledWith('game:onepiece');
  });

  it('puts the game chips between the lane chips and the rarity chips', () => {
    // "Which game" is a coarser cut than "which rarity", so it reads to the
    // left of it — and the fixed chips keep their existing order either way.
    render(
      <SpotlightThemeProvider>
        <CollectionFilterChipRow
          activeFilter="all"
          games={['pokemon', 'onepiece']}
          onFilterChange={jest.fn()}
        />
      </SpotlightThemeProvider>,
    );

    const row = screen.getByTestId('collection-filter-chip-row');
    const keys = screen
      .getAllByTestId(/^collection-filter-chip-row-/)
      .map((node) => String(node.props.testID).replace('collection-filter-chip-row-', ''));

    expect(row).toBeTruthy();
    expect(keys).toEqual([
      'all',
      'favorites',
      'az',
      'price',
      'date',
      'ungraded',
      'graded',
      'game:pokemon',
      'game:onepiece',
      'sir',
      'illustration',
      'ultra',
      'secret',
      'shiny',
    ]);
  });

  it('draws the PRICE / DATE sort arrows: down at rest, up once the active sort is flipped', () => {
    const { rerender } = render(
      <SpotlightThemeProvider>
        <CollectionFilterChipRow activeFilter="all" onFilterChange={jest.fn()} />
      </SpotlightThemeProvider>,
    );
    expect(screen.getByText('DATE')).toBeTruthy();
    expect(screen.getByTestId('sort-arrow-price-desc')).toBeTruthy();
    expect(screen.getByTestId('sort-arrow-date-desc')).toBeTruthy();

    rerender(
      <SpotlightThemeProvider>
        <CollectionFilterChipRow activeFilter="price" onFilterChange={jest.fn()} sortDirection="asc" />
      </SpotlightThemeProvider>,
    );
    expect(screen.getByTestId('sort-arrow-price-asc')).toBeTruthy();
    // Only the ACTIVE sort carries the flipped direction.
    expect(screen.getByTestId('sort-arrow-date-desc')).toBeTruthy();
  });
});
