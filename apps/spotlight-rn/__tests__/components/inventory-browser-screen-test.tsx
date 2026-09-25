import { act, fireEvent, screen } from '@testing-library/react-native';
import { Modal } from 'react-native';

import { InventoryBrowserScreen } from '@/features/inventory/screens/inventory-browser-screen';

import { mockInventoryEntries } from '../mock-api-client';
import { createTestSpotlightRepository, renderWithProviders } from '../test-utils';

// The popover exit's completion hops back to JS on a microtask (worklets mock).
const flushExit = () => act(async () => {});

describe('InventoryBrowserScreen', () => {
  it('shows the SwiftUI no-results copy for search misses', async () => {
    renderWithProviders(
      <InventoryBrowserScreen
        onBack={jest.fn()}
        onOpenAddCard={jest.fn()}
        onOpenEntry={jest.fn()}
      />,
    );

    expect(await screen.findByText('View all cards')).toBeTruthy();

    fireEvent.changeText(screen.getByPlaceholderText('Search collection cards'), 'tree');
    expect(await screen.findByText('No cards match that search')).toBeTruthy();
    expect(
      screen.getByText('Try a different name, set, card number, or collection filter.'),
    ).toBeTruthy();
  });

  it('renders the Add Card button and opens the add flow', async () => {
    const onOpenAddCard = jest.fn();

    renderWithProviders(
      <InventoryBrowserScreen
        onBack={jest.fn()}
        onOpenAddCard={onOpenAddCard}
        onOpenEntry={jest.fn()}
      />,
    );

    expect(await screen.findByText('View all cards')).toBeTruthy();

    expect(screen.getByTestId('inventory-add-card')).toBeTruthy();
    fireEvent.press(screen.getByTestId('inventory-add-card'));
    expect(onOpenAddCard).toHaveBeenCalledTimes(1);

    // Bulk sell was retired with the payment-coupled flow — no selection mode.
    expect(screen.queryByTestId('inventory-bulk-sell-toggle')).toBeNull();
    expect(screen.queryByTestId('inventory-sell-selected')).toBeNull();
  });

  it('updates visible inventory results when filter dropdown options change', async () => {
    const spotlightRepository = createTestSpotlightRepository({
      loadInventoryEntries: async () => ({
        state: 'success',
        errorMessage: null,
        data: [
          {
            ...mockInventoryEntries[0],
            isFavorite: true,
          },
          ...mockInventoryEntries.slice(1),
          {
            ...mockInventoryEntries[2],
            id: 'graded-entry-1',
            cardId: 'base1-4-psa9',
            name: 'Charizard',
            cardNumber: '#4/102',
            setName: 'Base Set',
            marketPrice: 420,
            quantity: 1,
            addedAt: '2026-04-22T11:00:00.000Z',
            kind: 'graded',
            isFavorite: true,
            slabContext: {
              grader: 'PSA',
              grade: '9',
              certNumber: '12345678',
            },
          },
        ],
      }),
    });

    renderWithProviders(
      <InventoryBrowserScreen
        onBack={jest.fn()}
        onOpenAddCard={jest.fn()}
        onOpenEntry={jest.fn()}
      />,
      { spotlightRepository },
    );

    expect(await screen.findByText('7 shown')).toBeTruthy();
    expect(screen.getByText('Scorbunny')).toBeTruthy();
    expect(screen.getByText('Charizard')).toBeTruthy();

    // Open the filter dropdown attached to the search field.
    fireEvent.press(screen.getByTestId('inventory-filter-button'));
    fireEvent.press(screen.getByTestId('inventory-filter-graded'));
    await flushExit();

    expect(screen.getByText('1 shown')).toBeTruthy();
    expect(screen.getByText('Charizard')).toBeTruthy();
    expect(screen.queryByText('Scorbunny')).toBeNull();

    fireEvent.press(screen.getByTestId('inventory-filter-button'));
    fireEvent.press(screen.getByTestId('inventory-filter-raw'));
    await flushExit();

    expect(screen.getByText('6 shown')).toBeTruthy();
    expect(screen.getByText('Scorbunny')).toBeTruthy();
    expect(screen.queryByText('Charizard')).toBeNull();

    fireEvent.press(screen.getByTestId('inventory-filter-button'));
    fireEvent.press(screen.getByTestId('inventory-filter-favorite'));
    await flushExit();

    expect(screen.getByText('2 shown')).toBeTruthy();
    expect(screen.getByText('Scorbunny')).toBeTruthy();
    expect(screen.getByText('Charizard')).toBeTruthy();
    expect(screen.queryByText('Oshawott')).toBeNull();
  });

  it('filter menu: a pick lands once, after the exit, and closes the menu', async () => {
    renderWithProviders(
      <InventoryBrowserScreen onBack={jest.fn()} onOpenAddCard={jest.fn()} onOpenEntry={jest.fn()} />,
    );
    expect(await screen.findByText('View all cards')).toBeTruthy();

    fireEvent.press(screen.getByTestId('inventory-filter-button'));
    fireEvent.press(screen.getByTestId('inventory-filter-graded'));
    // Further taps during the exit are ignored.
    fireEvent.press(screen.getByTestId('inventory-filter-raw'));
    fireEvent.press(screen.getByTestId('inventory-filter-backdrop'));
    // Still up while the card shrinks.
    expect(screen.getByTestId('inventory-filter-menu')).toBeTruthy();
    await flushExit();

    expect(screen.queryByTestId('inventory-filter-menu')).toBeNull();
    fireEvent.press(screen.getByTestId('inventory-filter-button'));
    expect(screen.getByTestId('inventory-filter-graded').props.accessibilityState).toEqual(
      expect.objectContaining({ selected: true }),
    );
  });

  it.each(['backdrop', 'back'] as const)('filter menu: %s closes it after the exit', async (path) => {
    renderWithProviders(
      <InventoryBrowserScreen onBack={jest.fn()} onOpenAddCard={jest.fn()} onOpenEntry={jest.fn()} />,
    );
    expect(await screen.findByText('View all cards')).toBeTruthy();

    fireEvent.press(screen.getByTestId('inventory-filter-button'));
    if (path === 'backdrop') {
      fireEvent.press(screen.getByTestId('inventory-filter-backdrop'));
      fireEvent.press(screen.getByTestId('inventory-filter-backdrop'));
    } else {
      const modal = screen.UNSAFE_getByType(Modal);
      fireEvent(modal, 'requestClose');
      fireEvent(modal, 'requestClose');
    }
    expect(screen.getByTestId('inventory-filter-menu')).toBeTruthy();
    await flushExit();
    expect(screen.queryByTestId('inventory-filter-menu')).toBeNull();

    // Reopens cleanly after an exit (transition resets on each open).
    fireEvent.press(screen.getByTestId('inventory-filter-button'));
    expect(screen.getByTestId('inventory-filter-menu')).toBeTruthy();
  });
});
