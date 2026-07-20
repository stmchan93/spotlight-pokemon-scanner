import { fireEvent, render, screen } from '@testing-library/react-native';

import { SpotlightThemeProvider } from '@spotlight/design-system';
import type { InventoryCardEntry } from '@spotlight/api-client';

import { InventoryDropdown } from '@/features/cards/components/inventory-dropdown';

function makeEntry(overrides: Partial<InventoryCardEntry> = {}): InventoryCardEntry {
  return {
    id: 'entry-1',
    cardId: 'card-1',
    name: 'Gengar',
    cardNumber: '5/64',
    setName: 'Neo Revelation',
    imageUrl: 'https://example.com/c.png',
    smallImageUrl: 'https://example.com/c-sm.png',
    largeImageUrl: null,
    marketPrice: 450.86,
    hasMarketPrice: true,
    currencyCode: 'USD',
    quantity: 1,
    addedAt: '2024-01-01T00:00:00Z',
    kind: 'raw',
    conditionLabel: 'Near Mint',
    conditionShortLabel: 'NM',
    variantName: 'Holofoil',
    isFavorite: false,
    dayChangeAmount: null,
    dayChangePercent: null,
    listingUrl: null,
    ...overrides,
  };
}

function renderDropdown(
  props: Partial<React.ComponentProps<typeof InventoryDropdown>> = {},
) {
  const onPressEntryMenu = jest.fn();
  const utils = render(
    <SpotlightThemeProvider>
      <InventoryDropdown
        entries={[makeEntry()]}
        language="EN"
        onPressEntryMenu={onPressEntryMenu}
        testID="detail-inventory"
        {...props}
      />
    </SpotlightThemeProvider>,
  );
  return { ...utils, onPressEntryMenu };
}

describe('InventoryDropdown', () => {
  it('starts collapsed and expands when the header is tapped', () => {
    renderDropdown();

    expect(screen.getByText('Inventory')).toBeTruthy();
    expect(screen.queryByTestId('detail-inventory-row-entry-1')).toBeNull();

    fireEvent.press(screen.getByTestId('detail-inventory-header'));

    expect(screen.getByTestId('detail-inventory-row-entry-1')).toBeTruthy();

    fireEvent.press(screen.getByTestId('detail-inventory-header'));
    expect(screen.queryByTestId('detail-inventory-row-entry-1')).toBeNull();
  });

  it('renders one row per entry with the summary line, quantity, and price', () => {
    renderDropdown({
      entries: [
        makeEntry({ id: 'a', quantity: 2 }),
        makeEntry({
          id: 'b',
          kind: 'graded',
          conditionLabel: null,
          conditionShortLabel: null,
          marketPrice: 1450.12,
          slabContext: {
            grader: 'PSA',
            grade: '10',
            variantName: 'Holofoil',
          } as InventoryCardEntry['slabContext'],
        }),
      ],
      initiallyExpanded: true,
    });

    expect(screen.getByTestId('detail-inventory-row-a')).toBeTruthy();
    expect(screen.getByTestId('detail-inventory-row-b')).toBeTruthy();
    // Raw entry: condition code · variant · language.
    expect(screen.getByText('NM · Holofoil · EN')).toBeTruthy();
    // Graded entry: grader+grade replaces the condition code.
    expect(screen.getByText('PSA 10 · Holofoil · EN')).toBeTruthy();
    expect(screen.getByText('2')).toBeTruthy();
    expect(screen.getByText('$450.86')).toBeTruthy();
    expect(screen.getByText('$1,450.12')).toBeTruthy();
  });

  it('renders no day-change delta and an em-dash when there is no market price', () => {
    renderDropdown({
      entries: [
        makeEntry({
          hasMarketPrice: false,
          marketPrice: undefined,
          dayChangeAmount: 12.5,
          dayChangePercent: 3.1,
        }),
      ],
      initiallyExpanded: true,
    });

    expect(screen.getByText('—')).toBeTruthy();
    // The design removes price-change chips from inventory rows entirely.
    expect(screen.queryByText(/\+\$/)).toBeNull();
    expect(screen.queryByTestId('detail-inventory-row-entry-1-delta')).toBeNull();
  });

  it('fires onPressEntryMenu for the row whose menu is tapped', () => {
    const { onPressEntryMenu } = renderDropdown({
      entries: [makeEntry({ id: 'a' }), makeEntry({ id: 'b' })],
      initiallyExpanded: true,
    });

    fireEvent.press(screen.getByTestId('detail-inventory-row-b-menu'));

    expect(onPressEntryMenu).toHaveBeenCalledTimes(1);
    // Second arg is the measured anchor (null in the test env, where
    // measureInWindow isn't implemented).
    expect(onPressEntryMenu).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'b' }),
      null,
    );
  });

  it('fires onPressEntry when a row is tapped', () => {
    const onPressEntry = jest.fn();
    renderDropdown({
      entries: [makeEntry({ id: 'a' })],
      initiallyExpanded: true,
      onPressEntry,
    });

    fireEvent.press(screen.getByTestId('detail-inventory-row-a'));

    expect(onPressEntry).toHaveBeenCalledTimes(1);
    expect(onPressEntry).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }));
  });
});
