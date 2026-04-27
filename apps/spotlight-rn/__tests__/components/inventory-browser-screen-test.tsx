import { fireEvent, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import { InventoryBrowserScreen } from '@/features/inventory/screens/inventory-browser-screen';

import { renderWithProviders } from '../test-utils';

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

    expect(await screen.findByText('All cards')).toBeTruthy();
    expect(screen.getByText('Sell selected')).toBeTruthy();
    expect(StyleSheet.flatten(screen.getByText('Sell selected').props.style)).toMatchObject({
      fontSize: 15,
      lineHeight: 20,
    });
    expect(StyleSheet.flatten(screen.getByTestId('inventory-sell-selected').props.style)).toMatchObject({
      minHeight: 56,
    });

    fireEvent.press(screen.getByTestId('inventory-entry-entry-1'));
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

    expect(await screen.findByText('All cards')).toBeTruthy();
    expect(screen.getByText('Sell selected')).toBeTruthy();

    fireEvent.press(screen.getByTestId('inventory-clear-selection'));

    expect(screen.getByText('Sell selected')).toBeTruthy();

    fireEvent.press(screen.getByTestId('inventory-entry-entry-2'));
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

    expect(await screen.findByText('All cards')).toBeTruthy();

    fireEvent.changeText(screen.getByPlaceholderText('Search inventory cards'), 'tree');
    expect(await screen.findByText('No cards match that search')).toBeTruthy();
    expect(
      screen.getByText('Try a different name, set, card number, or raw/graded filter.'),
    ).toBeTruthy();
  });
});
