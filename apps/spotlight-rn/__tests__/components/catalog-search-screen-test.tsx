import { act, fireEvent, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import {
  MockSpotlightRepository,
  mockCatalogResults,
} from '@spotlight/api-client';

import { CatalogSearchScreen } from '@/features/catalog/screens/catalog-search-screen';

import { renderWithProviders } from '../test-utils';

async function advanceDebounce() {
  await act(async () => {
    jest.advanceTimersByTime(300);
    await Promise.resolve();
  });
}

const ownedCatalogResults = mockCatalogResults.map((result) => ({
  ...result,
  ownedQuantity: result.ownedQuantity ?? 0,
}));

describe('CatalogSearchScreen', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('renders the modal chrome, lists card matches directly, then opens a card', async () => {
    const onOpenCard = jest.fn();
    const onClose = jest.fn();
    let resolveSearch: ((results: Awaited<ReturnType<MockSpotlightRepository['searchCatalogCards']>>) => void) | null = null;

    jest.spyOn(MockSpotlightRepository.prototype, 'searchCatalogCards').mockImplementation(() => {
      return new Promise((resolve) => {
        resolveSearch = resolve;
      });
    });

    renderWithProviders(
      <CatalogSearchScreen onClose={onClose} onOpenCard={onOpenCard} />,
    );

    expect(screen.getByText('Add Card')).toBeTruthy();
    expect(StyleSheet.flatten(screen.getByTestId('catalog-header-back-row').props.style)).toMatchObject({
      alignSelf: 'flex-start',
    });

    fireEvent.press(screen.getByTestId('catalog-close'));
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.changeText(screen.getByPlaceholderText('Search by name, set, or number'), 'tree');
    await advanceDebounce();

    expect(await screen.findByText('Searching catalog')).toBeTruthy();

    await act(async () => {
      resolveSearch?.(ownedCatalogResults);
      await Promise.resolve();
    });

    expect(await screen.findByTestId('catalog-result-sm7-1')).toBeTruthy();
    expect(screen.getByTestId('catalog-result-smoke-sm7-1')).toBeTruthy();
    expect(screen.getByTestId('catalog-result-sm7-2')).toBeTruthy();
    expect(screen.getByTestId('catalog-result-np-3')).toBeTruthy();
    expect(screen.queryByTestId('catalog-set-group-sm7-1')).toBeNull();

    fireEvent.press(screen.getByTestId('catalog-result-smoke-sm7-1'));
    expect(onOpenCard).toHaveBeenCalledWith(expect.objectContaining({
      cardId: 'sm7-1',
      name: 'Treecko',
    }));
  });

  it('hydrates and searches from an initial query', async () => {
    jest.spyOn(MockSpotlightRepository.prototype, 'searchCatalogCards').mockResolvedValue(ownedCatalogResults);

    renderWithProviders(
      <CatalogSearchScreen initialQuery="tree" onClose={jest.fn()} onOpenCard={jest.fn()} />,
    );

    await advanceDebounce();

    expect(screen.getByDisplayValue('tree')).toBeTruthy();
    expect(await screen.findByTestId('catalog-result-sm7-1')).toBeTruthy();
  });

  it('clears the opening spinner after navigation starts so a returned result can be tapped again', async () => {
    const onOpenCard = jest.fn();
    jest.spyOn(MockSpotlightRepository.prototype, 'searchCatalogCards').mockResolvedValue(ownedCatalogResults);

    renderWithProviders(
      <CatalogSearchScreen onClose={jest.fn()} onOpenCard={onOpenCard} />,
    );

    fireEvent.changeText(screen.getByPlaceholderText('Search by name, set, or number'), 'tree');
    await advanceDebounce();

    const resultRow = await screen.findByTestId('catalog-result-smoke-sm7-1');
    fireEvent.press(resultRow);
    expect(onOpenCard).toHaveBeenCalledTimes(1);

    fireEvent.press(resultRow);
    expect(onOpenCard).toHaveBeenCalledTimes(1);

    await act(async () => {
      jest.advanceTimersByTime(350);
      await Promise.resolve();
    });

    fireEvent.press(resultRow);
    expect(onOpenCard).toHaveBeenCalledTimes(2);
  });

  it('renders the empty state when a query returns no matches', async () => {
    jest.spyOn(MockSpotlightRepository.prototype, 'searchCatalogCards').mockResolvedValue([]);

    renderWithProviders(
      <CatalogSearchScreen onClose={jest.fn()} onOpenCard={jest.fn()} />,
    );

    fireEvent.changeText(screen.getByPlaceholderText('Search by name, set, or number'), 'zzz');
    await advanceDebounce();

    expect(await screen.findByText('No matching cards')).toBeTruthy();
    expect(screen.getByText('Try a shorter query, a different set name, or just the collector number.')).toBeTruthy();
  });

  it('shows the artwork fallback when a result is missing an image', async () => {
    jest.spyOn(MockSpotlightRepository.prototype, 'searchCatalogCards').mockResolvedValue([
      {
        id: 'fallback-1',
        cardId: 'fallback-1',
        name: 'Fallback Card',
        cardNumber: '#999',
        setName: 'Parity Set',
        imageUrl: '',
        marketPrice: null,
        currencyCode: 'USD',
        ownedQuantity: 0,
      },
    ]);

    renderWithProviders(
      <CatalogSearchScreen onClose={jest.fn()} onOpenCard={jest.fn()} />,
    );

    fireEvent.changeText(screen.getByPlaceholderText('Search by name, set, or number'), 'fallback');
    await advanceDebounce();

    expect(await screen.findByTestId('catalog-result-fallback-1')).toBeTruthy();
    expect(screen.getByTestId('catalog-artwork-fallback-fallback-1')).toBeTruthy();
  });

  it('surfaces the retry action after a failed search', async () => {
    jest.spyOn(MockSpotlightRepository.prototype, 'searchCatalogCards')
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(ownedCatalogResults.slice(0, 1));

    renderWithProviders(
      <CatalogSearchScreen onClose={jest.fn()} onOpenCard={jest.fn()} />,
    );

    fireEvent.changeText(screen.getByPlaceholderText('Search by name, set, or number'), 'tree');
    await advanceDebounce();

    expect(await screen.findByText('Search unavailable')).toBeTruthy();

    fireEvent.press(screen.getByTestId('catalog-retry'));
    await advanceDebounce();

    expect(await screen.findByTestId('catalog-result-sm7-1')).toBeTruthy();
    expect(screen.getByText('#001/096')).toBeTruthy();
  });
});
