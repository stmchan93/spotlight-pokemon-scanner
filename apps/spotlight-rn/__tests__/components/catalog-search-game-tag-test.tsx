import { act, fireEvent, screen } from '@testing-library/react-native';

import { MockSpotlightRepository, type CatalogSearchResult } from '@spotlight/api-client';

import {
  CatalogSearchScreen,
  resultsSpanMultipleGames,
} from '@/features/catalog/screens/catalog-search-screen';

import { renderWithProviders } from '../test-utils';

jest.mock('expo-router', () => ({
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  useFocusEffect: (callback: () => void | (() => void)) => require('react').useEffect(callback, [callback]),
}));

async function advanceDebounce() {
  await act(async () => {
    jest.advanceTimersByTime(300);
    await Promise.resolve();
  });
}

function result(over: Partial<CatalogSearchResult>): CatalogSearchResult {
  return {
    id: 'row',
    cardId: 'card',
    name: 'Card',
    cardNumber: '1',
    setName: 'Set',
    imageUrl: 'https://example.test/card.png',
    marketPrice: 1,
    currencyCode: 'USD',
    ownedQuantity: 0,
    ...over,
  } as CatalogSearchResult;
}

/**
 * Catalog search is game-agnostic — the backend searches the whole card table —
 * so a query like "Ace" comes back with One Piece and Pokémon rows interleaved
 * and nothing on the row saying which is which.
 */
describe('catalog search game tags', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('only calls a result set mixed when it really spans games', () => {
    expect(resultsSpanMultipleGames([result({ game: 'pokemon' }), result({ game: 'pokemon' })])).toBe(false);
    expect(resultsSpanMultipleGames([result({ game: 'pokemon' }), result({ game: 'onepiece' })])).toBe(true);
    // A row with no game is Pokémon, so an all-legacy page is single-game.
    expect(resultsSpanMultipleGames([result({}), result({ game: 'pokemon' })])).toBe(false);
    expect(resultsSpanMultipleGames([result({}), result({ game: 'onepiece' })])).toBe(true);
  });

  it('tags every row once the results span games', async () => {
    jest.spyOn(MockSpotlightRepository.prototype, 'searchCatalogCardsPage').mockResolvedValue({
      cards: [
        result({ id: 'luffy', cardId: 'op16-001', name: 'Ace', game: 'onepiece' }),
        result({ id: 'ace', cardId: 'sv1-1', name: 'Ace Spec', game: 'pokemon' }),
      ],
      hasMore: false,
    });

    renderWithProviders(<CatalogSearchScreen onClose={jest.fn()} onOpenCard={jest.fn()} />);

    fireEvent.changeText(screen.getByPlaceholderText('Search by name, set, or number'), 'ace');
    await advanceDebounce();
    await act(async () => {
      await Promise.resolve();
    });

    // Both rows, not just the non-Pokémon one: a tag on one side only reads as
    // an annotation on that row rather than as the column it is.
    expect(screen.getByTestId('catalog-result-game-luffy')).toHaveTextContent('One Piece');
    expect(screen.getByTestId('catalog-result-game-ace')).toHaveTextContent('Pokémon');
  });

  it('leaves single-game results untagged', async () => {
    // Repeating "Pokémon" down every row of a Pokémon-only search says nothing.
    jest.spyOn(MockSpotlightRepository.prototype, 'searchCatalogCardsPage').mockResolvedValue({
      cards: [
        result({ id: 'a', cardId: 'sv1-1', name: 'Skwovet', game: 'pokemon' }),
        result({ id: 'b', cardId: 'sv1-2', name: 'Greavard' }),
      ],
      hasMore: false,
    });

    renderWithProviders(<CatalogSearchScreen onClose={jest.fn()} onOpenCard={jest.fn()} />);

    fireEvent.changeText(screen.getByPlaceholderText('Search by name, set, or number'), 'sk');
    await advanceDebounce();
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.queryByTestId('catalog-result-game-a')).toBeNull();
    expect(screen.queryByTestId('catalog-result-game-b')).toBeNull();
  });
});
