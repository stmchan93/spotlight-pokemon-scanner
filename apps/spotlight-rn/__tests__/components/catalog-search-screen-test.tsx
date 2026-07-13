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
    let resolveSearch: ((page: Awaited<ReturnType<MockSpotlightRepository['searchCatalogCardsPage']>>) => void) | null = null;

    jest.spyOn(MockSpotlightRepository.prototype, 'searchCatalogCardsPage').mockImplementation(() => {
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
      resolveSearch?.({ cards: ownedCatalogResults, hasMore: false });
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

  it('shows the expansions browse grid when the box is empty and opens a set', async () => {
    const onSelectExpansion = jest.fn();
    jest.spyOn(MockSpotlightRepository.prototype, 'listExpansions').mockResolvedValue([
      { id: 'sv1', name: 'Scarlet & Violet', series: 'SV', code: 'sv1', releaseDate: '2023-03-31', imageUrl: '' },
      { id: 'sm7', name: 'Celestial Storm', series: 'SM', code: 'sm7', releaseDate: '2018-08-03', imageUrl: '' },
    ]);

    renderWithProviders(
      <CatalogSearchScreen
        onClose={jest.fn()}
        onOpenCard={jest.fn()}
        onSelectExpansion={onSelectExpansion}
      />,
    );

    // No query typed → the expansions grid loads (logos + set names).
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByTestId('catalog-expansion-sv1')).toBeTruthy();
    expect(screen.getByTestId('catalog-expansion-sm7')).toBeTruthy();
    // The set name is shown (rendered as the label, plus the no-image fallback).
    expect(screen.getAllByText('Scarlet & Violet').length).toBeGreaterThan(0);

    // Tapping a set drills into it; global card search still works by typing.
    fireEvent.press(screen.getByTestId('catalog-expansion-sv1'));
    expect(onSelectExpansion).toHaveBeenCalledWith(expect.objectContaining({ id: 'sv1' }));
  });

  it('hydrates and searches from an initial query', async () => {
    jest.spyOn(MockSpotlightRepository.prototype, 'searchCatalogCardsPage')
      .mockResolvedValue({ cards: ownedCatalogResults, hasMore: false });

    renderWithProviders(
      <CatalogSearchScreen initialQuery="tree" onClose={jest.fn()} onOpenCard={jest.fn()} />,
    );

    await advanceDebounce();

    expect(screen.getByDisplayValue('tree')).toBeTruthy();
    expect(await screen.findByTestId('catalog-result-sm7-1')).toBeTruthy();
  });

  it('clears the opening spinner after navigation starts so a returned result can be tapped again', async () => {
    const onOpenCard = jest.fn();
    jest.spyOn(MockSpotlightRepository.prototype, 'searchCatalogCardsPage')
      .mockResolvedValue({ cards: ownedCatalogResults, hasMore: false });

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
    jest.spyOn(MockSpotlightRepository.prototype, 'searchCatalogCardsPage')
      .mockResolvedValue({ cards: [], hasMore: false });

    renderWithProviders(
      <CatalogSearchScreen onClose={jest.fn()} onOpenCard={jest.fn()} />,
    );

    fireEvent.changeText(screen.getByPlaceholderText('Search by name, set, or number'), 'zzz');
    await advanceDebounce();

    expect(await screen.findByText('No matching cards')).toBeTruthy();
    expect(screen.getByText('Try a shorter query, a different set name, or just the collector number.')).toBeTruthy();
  });

  it('appends the next page of results on scroll-to-end (infinite scroll)', async () => {
    const page1 = ownedCatalogResults.slice(0, 2);
    const page2 = ownedCatalogResults.slice(2, 4);
    jest.spyOn(MockSpotlightRepository.prototype, 'searchCatalogCardsPage')
      .mockResolvedValueOnce({ cards: page1, hasMore: true })
      .mockResolvedValueOnce({ cards: page2, hasMore: false });

    renderWithProviders(
      <CatalogSearchScreen onClose={jest.fn()} onOpenCard={jest.fn()} />,
    );

    fireEvent.changeText(screen.getByPlaceholderText('Search by name, set, or number'), 'tree');
    await advanceDebounce();

    // Page 1 rendered; page 2 not yet.
    expect(await screen.findByTestId(`catalog-result-${page1[0].id}`)).toBeTruthy();
    expect(screen.queryByTestId(`catalog-result-${page2[0].id}`)).toBeNull();

    // Scroll to the end → page 2 fetched and appended (no duplicates).
    await act(async () => {
      fireEvent(screen.getByTestId('catalog-results-list'), 'endReached');
      await Promise.resolve();
    });

    expect(await screen.findByTestId(`catalog-result-${page2[0].id}`)).toBeTruthy();
    expect(screen.getByTestId(`catalog-result-${page1[0].id}`)).toBeTruthy();
  });

  it('shows the artwork fallback when a result is missing an image', async () => {
    jest.spyOn(MockSpotlightRepository.prototype, 'searchCatalogCardsPage').mockResolvedValue({
      cards: [
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
      ],
      hasMore: false,
    });

    renderWithProviders(
      <CatalogSearchScreen onClose={jest.fn()} onOpenCard={jest.fn()} />,
    );

    fireEvent.changeText(screen.getByPlaceholderText('Search by name, set, or number'), 'fallback');
    await advanceDebounce();

    expect(await screen.findByTestId('catalog-result-fallback-1')).toBeTruthy();
    expect(screen.getByTestId('catalog-artwork-fallback-fallback-1')).toBeTruthy();
  });

  it('surfaces the retry action after a failed search', async () => {
    jest.spyOn(MockSpotlightRepository.prototype, 'searchCatalogCardsPage')
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ cards: ownedCatalogResults.slice(0, 1), hasMore: false });

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
