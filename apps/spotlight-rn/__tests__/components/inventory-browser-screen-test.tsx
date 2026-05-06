import { fireEvent, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import { InventoryBrowserScreen } from '@/features/inventory/screens/inventory-browser-screen';

import { mockInventoryEntries } from '../mock-api-client';
import { createTestSpotlightRepository, renderWithProviders } from '../test-utils';

describe('InventoryBrowserScreen', () => {
  it('opens directly into selectable sell mode from inventory', async () => {
    const onOpenBulkSell = jest.fn();

    renderWithProviders(
      <InventoryBrowserScreen
        initialMode="select"
        onBack={jest.fn()}
        onOpenBulkSell={onOpenBulkSell}
        onOpenEntry={jest.fn()}
      />,
    );

    expect(await screen.findByText('View all cards')).toBeTruthy();
    expect(screen.getByText('Sell selected')).toBeTruthy();
    expect(StyleSheet.flatten(screen.getByText('Sell selected').props.style)).toMatchObject({
      fontSize: 15,
      lineHeight: 20,
    });
    expect(StyleSheet.flatten(screen.getByTestId('inventory-sell-selected').props.style)).toMatchObject({
      minHeight: 56,
    });

    fireEvent.press(screen.getByTestId('inventory-entry-smoke-raw-mcdonalds25-16'));
    fireEvent.press(screen.getByTestId('inventory-sell-selected'));

    expect(onOpenBulkSell).toHaveBeenCalledWith(['entry-1']);
  });

  it('clears selected cards without leaving selection mode', async () => {
    const onOpenBulkSell = jest.fn();

    renderWithProviders(
      <InventoryBrowserScreen
        initialMode="select"
        initialSelectedIds={['entry-1']}
        onBack={jest.fn()}
        onOpenBulkSell={onOpenBulkSell}
        onOpenEntry={jest.fn()}
      />,
    );

    expect(await screen.findByText('View all cards')).toBeTruthy();
    expect(screen.getByText('Sell selected')).toBeTruthy();

    fireEvent.press(screen.getByTestId('inventory-clear-selection'));

    expect(screen.getByText('Sell selected')).toBeTruthy();

    fireEvent.press(screen.getByTestId('inventory-entry-smoke-raw-mcdonalds25-21'));
    fireEvent.press(screen.getByTestId('inventory-sell-selected'));

    expect(onOpenBulkSell).toHaveBeenCalledWith(['entry-2']);
  });

  it('shows the SwiftUI no-results copy for search misses', async () => {
    renderWithProviders(
      <InventoryBrowserScreen
        onBack={jest.fn()}
        onOpenBulkSell={jest.fn()}
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

  it('updates visible inventory results when filter chips change', async () => {
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
        onOpenBulkSell={jest.fn()}
        onOpenEntry={jest.fn()}
      />,
      { spotlightRepository },
    );

    expect(await screen.findByText('7 shown')).toBeTruthy();
    expect(screen.getByText('Scorbunny')).toBeTruthy();
    expect(screen.getByText('Charizard')).toBeTruthy();

    fireEvent.press(screen.getByTestId('inventory-filter-graded'));

    expect(screen.getByText('1 shown')).toBeTruthy();
    expect(screen.getByText('Charizard')).toBeTruthy();
    expect(screen.queryByText('Scorbunny')).toBeNull();

    fireEvent.press(screen.getByTestId('inventory-filter-raw'));

    expect(screen.getByText('6 shown')).toBeTruthy();
    expect(screen.getByText('Scorbunny')).toBeTruthy();
    expect(screen.queryByText('Charizard')).toBeNull();

    fireEvent.press(screen.getByTestId('inventory-filter-favorite'));

    expect(screen.getByText('2 shown')).toBeTruthy();
    expect(screen.getByText('Scorbunny')).toBeTruthy();
    expect(screen.getByText('Charizard')).toBeTruthy();
    expect(screen.queryByText('Oshawott')).toBeNull();
  });
});
