import { fireEvent, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import type { RecentSaleRecord } from '@spotlight/api-client';

import { SalePriceEditSheet } from '@/features/portfolio/components/sale-price-edit-sheet';

import { renderWithProviders } from '../test-utils';

const sale: RecentSaleRecord = {
  id: 'sale-1',
  cardId: 'sm7-1',
  kind: 'sold',
  name: 'Treecko',
  cardNumber: '#001/096',
  setName: 'Celestial Storm',
  soldPrice: 12.5,
  currencyCode: 'USD',
  soldAtLabel: 'Apr 26',
  soldAtISO: '2026-04-26T12:00:00.000Z',
  imageUrl: 'https://example.com/treecko.png',
};

describe('SalePriceEditSheet', () => {
  it('renders the shared sheet header, field shell, and confirm action', () => {
    const onClose = jest.fn();
    const onConfirm = jest.fn();
    const onChangePriceText = jest.fn();

    renderWithProviders(
      <SalePriceEditSheet
        canConfirm
        onChangePriceText={onChangePriceText}
        onClose={onClose}
        onConfirm={onConfirm}
        priceText="13.25"
        sale={sale}
      />,
    );

    expect(screen.getByText('Edit Sale Price')).toBeTruthy();
    expect(screen.getByText('Treecko • Apr 26')).toBeTruthy();
    expect(screen.getByTestId('edit-sale-card-image').props.source).toEqual({
      uri: sale.imageUrl,
    });
    expect(screen.getByText('Previous $12.50')).toBeTruthy();
    expect(StyleSheet.flatten(screen.getByTestId('edit-sale-price-input').props.style)).toMatchObject({
      fontSize: 34,
      lineHeight: 40,
    });
    expect(StyleSheet.flatten(screen.getByText('Confirm price').props.style)).toMatchObject({
      fontSize: 15,
      lineHeight: 20,
    });

    fireEvent.changeText(screen.getByTestId('edit-sale-price-input'), '14.75');
    expect(onChangePriceText).toHaveBeenCalledWith('14.75');

    fireEvent.press(screen.getByTestId('edit-sale-close'));
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.press(screen.getByTestId('edit-sale-confirm'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
