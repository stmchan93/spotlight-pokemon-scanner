import { fireEvent, render, screen } from '@testing-library/react-native';

import { SpotlightThemeProvider } from '@spotlight/design-system';

import {
  CollectionFilterChipRow,
  COLLECTION_FILTER_ORDER,
} from '@/features/portfolio/components/collection-filter-chip-row';

describe('CollectionFilterChipRow', () => {
  it('renders all 6 filter chips with their testIDs', () => {
    render(
      <SpotlightThemeProvider>
        <CollectionFilterChipRow activeFilter="all" onFilterChange={jest.fn()} />
      </SpotlightThemeProvider>,
    );

    expect(COLLECTION_FILTER_ORDER).toHaveLength(6);
    for (const key of COLLECTION_FILTER_ORDER) {
      expect(screen.getByTestId(`collection-filter-chip-row-${key}`)).toBeTruthy();
    }
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
});
