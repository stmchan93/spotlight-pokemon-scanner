import { fireEvent, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { mockInventoryEntries } from '@spotlight/api-client';

import { BulkSellScreen } from '@/features/sell/screens/bulk-sell-screen';

import { createTestSpotlightRepository, renderWithProviders } from '../test-utils';

function makeBulkSellRepository(entries = mockInventoryEntries) {
  return createTestSpotlightRepository({
    getInventoryEntries: async () => entries,
  });
}

describe('BulkSellScreen', () => {
  it('renders the batch summary and updates selected quantity per line', async () => {
    renderWithProviders(
      <BulkSellScreen
        entryIds={['entry-1', 'entry-2']}
        onClose={jest.fn()}
        onComplete={jest.fn()}
      />,
      {
        spotlightRepository: makeBulkSellRepository(),
      },
    );

    expect(await screen.findByText('3 cards selected')).toBeTruthy();
    expect(screen.getByTestId('bulk-sell-summary-card')).toBeTruthy();
    expect(screen.getByTestId('bulk-sell-line-smoke-raw-mcdonalds25-16')).toBeTruthy();
    expect(screen.getByTestId('bulk-sell-line-smoke-raw-mcdonalds25-21')).toBeTruthy();
    expect(screen.getByText('Swipe up to confirm sale')).toBeTruthy();
    expect(screen.getAllByText('Near Mint').length).toBeGreaterThan(0);
    expect(screen.getAllByText('*****').length).toBeGreaterThan(0);
    expect(screen.getByTestId('bulk-sell-toggle-bought-price-smoke-raw-mcdonalds25-16-hidden-icon')).toBeTruthy();
    expect(screen.queryByText('Show')).toBeNull();
    expect(screen.getByTestId('bulk-sell-offer-smoke-raw-mcdonalds25-16').props.placeholder).toBe('$0.00');
    expect(screen.getByTestId('bulk-sell-your-price-smoke-raw-mcdonalds25-16').props.placeholder).toBe('$0.00');
    expect(screen.getByTestId('bulk-sell-sold-price-smoke-raw-mcdonalds25-16').props.placeholder).toBe('$0.00');

    fireEvent.press(screen.getByTestId('bulk-sell-toggle-bought-price-smoke-raw-mcdonalds25-16'));

    expect(screen.getByText('$0.18')).toBeTruthy();
    expect(screen.getByTestId('bulk-sell-toggle-bought-price-smoke-raw-mcdonalds25-16-visible-icon')).toBeTruthy();

    fireEvent.press(screen.getByTestId('bulk-sell-toggle-bought-price-smoke-raw-mcdonalds25-16'));

    expect(screen.getAllByText('*****').length).toBeGreaterThan(0);
    expect(screen.getByTestId('bulk-sell-toggle-bought-price-smoke-raw-mcdonalds25-16-hidden-icon')).toBeTruthy();

    fireEvent.press(screen.getByTestId('bulk-sell-decrement-smoke-raw-mcdonalds25-16'));

    expect(await screen.findByText('2 cards selected')).toBeTruthy();
    expect(screen.getByText('Not included')).toBeTruthy();
  });

  it('shows the reversed YP percent on the right-side calculator line', async () => {
    renderWithProviders(
      <BulkSellScreen
        entryIds={['entry-1']}
        onClose={jest.fn()}
        onComplete={jest.fn()}
      />,
      {
        spotlightRepository: makeBulkSellRepository(),
      },
    );

    await screen.findByText('1 card selected');

    fireEvent.changeText(screen.getByTestId('bulk-sell-offer-smoke-raw-mcdonalds25-16'), '0.45');
    fireEvent.changeText(screen.getByTestId('bulk-sell-your-price-smoke-raw-mcdonalds25-16'), '0.51');

    expect(screen.getByText('88.23% YP')).toBeTruthy();
  });

  it('renders the compact photo row on bulk sell', async () => {
    renderWithProviders(
      <BulkSellScreen
        entryIds={['entry-1', 'entry-2']}
        onClose={jest.fn()}
        onComplete={jest.fn()}
      />,
      {
        spotlightRepository: makeBulkSellRepository(),
      },
    );

    await screen.findByText('3 cards selected');

    expect(screen.getAllByText('Photo (optional)')).toHaveLength(2);
    expect(screen.queryByText('Transaction Photo')).toBeNull();
    expect(screen.queryByText('Add photo')).toBeNull();
    expect(screen.getByTestId('bulk-sell-entry-1-photo-camera-icon')).toBeTruthy();
    expect(screen.getByTestId('bulk-sell-entry-2-photo-camera-icon')).toBeTruthy();
    expect(StyleSheet.flatten(screen.getByTestId('bulk-sell-entry-1-transaction-photo').props.style)).toMatchObject({
      gap: 6,
      paddingVertical: 4,
    });
  });

  it('supports closing the sheet directly from the top chrome', async () => {
    const onClose = jest.fn();

    renderWithProviders(
      <BulkSellScreen
        entryIds={['entry-1']}
        onClose={onClose}
        onComplete={jest.fn()}
      />,
      {
        spotlightRepository: makeBulkSellRepository(),
      },
    );

    expect(await screen.findByText('1 card selected')).toBeTruthy();

    fireEvent.press(screen.getByTestId('bulk-sell-close'));
    expect(onClose).toHaveBeenCalled();
  });

  it('wires the top chrome with responder handlers for swipe-down dismissal', async () => {
    renderWithProviders(
      <BulkSellScreen
        entryIds={['entry-1']}
        onClose={jest.fn()}
        onComplete={jest.fn()}
      />,
      {
        spotlightRepository: makeBulkSellRepository(),
      },
    );

    expect(await screen.findByText('1 card selected')).toBeTruthy();
    expect(screen.getByTestId('bulk-sell-top-chrome').props.onMoveShouldSetResponder).toBeDefined();
    expect(screen.getByTestId('bulk-sell-top-chrome').props.onResponderMove).toBeDefined();
    expect(screen.getByTestId('bulk-sell-top-chrome').props.onResponderRelease).toBeDefined();
  });

  it('uses the full swipe rail as the responder surface and body typography for the prompt', async () => {
    renderWithProviders(
      <BulkSellScreen
        entryIds={['entry-1']}
        onClose={jest.fn()}
        onComplete={jest.fn()}
      />,
      {
        spotlightRepository: makeBulkSellRepository(),
      },
    );

    expect(await screen.findByText('1 card selected')).toBeTruthy();

    expect(screen.getByTestId('bulk-sell-swipe-rail').props.onMoveShouldSetResponder).toBeDefined();
    expect(screen.getByTestId('bulk-sell-swipe-rail').props.onResponderMove).toBeDefined();
    expect(screen.getByTestId('bulk-sell-swipe-rail').props.onResponderRelease).toBeDefined();
    expect(screen.getByTestId('bulk-sell-confirmation-prompt').props.pointerEvents).toBe('none');
    expect(
      StyleSheet.flatten(screen.getByText('Swipe up to confirm sale').props.style),
    ).toMatchObject({
      fontSize: 16,
      lineHeight: 22,
    });
  });

  it('keeps the bulk sell smoke selectors stable even if entry ids change', async () => {
    renderWithProviders(
      <BulkSellScreen
        entryIds={['entry-1-rekeyed', 'entry-2-rekeyed']}
        onClose={jest.fn()}
        onComplete={jest.fn()}
      />,
      {
        spotlightRepository: createTestSpotlightRepository({
          getInventoryEntries: async () => [
            {
              ...mockInventoryEntries[0],
              id: 'entry-1-rekeyed',
            },
            {
              ...mockInventoryEntries[1],
              id: 'entry-2-rekeyed',
            },
          ],
        }),
      },
    );

    expect(await screen.findByText('3 cards selected')).toBeTruthy();
    expect(screen.getByTestId('bulk-sell-line-smoke-raw-mcdonalds25-16')).toBeTruthy();
    expect(screen.getByTestId('bulk-sell-line-smoke-raw-mcdonalds25-21')).toBeTruthy();
  });
});
