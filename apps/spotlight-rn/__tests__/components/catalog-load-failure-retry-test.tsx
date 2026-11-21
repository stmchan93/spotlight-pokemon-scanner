import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { AppState } from 'react-native';

import {
  CARD_GAMES,
  MockSpotlightRepository,
  type CatalogSearchResult,
  type ExpansionRecord,
} from '@spotlight/api-client';

import { CatalogSearchScreen } from '@/features/catalog/screens/catalog-search-screen';
import { ExpansionDetailScreen } from '@/features/catalog/screens/expansion-detail-screen';
import { GameSetsScreen } from '@/features/catalog/screens/game-sets-screen';

import { renderWithProviders } from '../test-utils';

/*
  Endless spinners (post-show plan P5): every catalog load that can fail ends
  in an error card with Retry, a hung load ends there at the deadline, and a
  failed load re-runs when the app comes back to the foreground.
*/

jest.mock('expo-router', () => ({
  useFocusEffect: (callback: () => void | (() => void)) => require('react').useEffect(callback, [callback]),
  useRouter: () => ({ push: jest.fn(), back: jest.fn() }),
}));

const SET: ExpansionRecord = {
  id: 'sv8',
  name: 'Surging Sparks',
  series: null,
  code: 'SV8',
  language: 'English',
  releaseDate: '2024-11-08',
  imageUrl: 'https://cdn.spotlight.test/logo.png',
  cardCount: 1,
};

const CARD: CatalogSearchResult = {
  id: 'sv8-1',
  cardId: 'sv8-1',
  name: 'Pikachu ex',
  cardNumber: '#001/191',
  setName: 'Surging Sparks',
  imageUrl: 'https://cdn.spotlight.test/card.png',
  marketPrice: 1,
  currencyCode: 'USD',
  game: 'pokemon',
  ownedQuantity: 0,
};

function mockExpansions(failing: { value: boolean }) {
  return jest.spyOn(MockSpotlightRepository.prototype, 'listExpansions').mockImplementation(async (game) => {
    if (failing.value) {
      throw new Error('offline');
    }
    return game === 'pokemon' ? [SET] : [];
  });
}

const originalAddEventListener = AppState.addEventListener;

// Reassigned, not spied: restoring a spy on RN's AppState mock leaves it returning undefined.
function captureAppState() {
  const listeners: ((state: string) => void)[] = [];
  AppState.addEventListener = ((_type: string, handler: (state: string) => void) => {
    listeners.push(handler);
    return { remove: jest.fn() };
  }) as unknown as typeof AppState.addEventListener;
  return () => act(async () => {
    listeners.forEach((listener) => listener('background'));
    listeners.forEach((listener) => listener('active'));
  });
}

describe('catalog load failures end in Retry, never a spinner', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    AppState.addEventListener = originalAddEventListener;
  });

  it('sets list: a failed load shows Retry, and Retry re-runs it', async () => {
    const failing = { value: true };
    const listExpansions = mockExpansions(failing);

    renderWithProviders(
      <GameSetsScreen game="pokemon" onClose={jest.fn()} onOpenCard={jest.fn()} onSelectExpansion={jest.fn()} />,
    );

    expect(await screen.findByTestId('game-sets-retry')).toBeTruthy();
    expect(screen.queryByText('No sets available')).toBeNull();
    const calls = listExpansions.mock.calls.length;

    failing.value = false;
    await act(async () => {
      fireEvent.press(screen.getByTestId('game-sets-retry'));
    });

    expect(await screen.findByTestId('game-sets-expansion-sv8')).toBeTruthy();
    expect(listExpansions.mock.calls.length).toBe(calls + CARD_GAMES.length);
  });

  it('sets list: re-reads on return to the foreground only after a failure', async () => {
    const foreground = captureAppState();
    const failing = { value: true };
    const listExpansions = mockExpansions(failing);

    renderWithProviders(
      <GameSetsScreen game="pokemon" onClose={jest.fn()} onOpenCard={jest.fn()} onSelectExpansion={jest.fn()} />,
    );
    expect(await screen.findByTestId('game-sets-retry')).toBeTruthy();

    failing.value = false;
    const afterFailure = listExpansions.mock.calls.length;
    await foreground();
    expect(await screen.findByTestId('game-sets-expansion-sv8')).toBeTruthy();
    expect(listExpansions.mock.calls.length).toBe(afterFailure + CARD_GAMES.length);

    // A fresh success is not refetched.
    await foreground();
    expect(listExpansions.mock.calls.length).toBe(afterFailure + CARD_GAMES.length);
  });

  it('sets list: a hung load ends in the error card at the 20 s deadline', async () => {
    jest.useFakeTimers();
    jest.spyOn(MockSpotlightRepository.prototype, 'listExpansions').mockImplementation(
      () => new Promise<ExpansionRecord[]>(() => undefined),
    );

    renderWithProviders(
      <GameSetsScreen game="pokemon" onClose={jest.fn()} onOpenCard={jest.fn()} onSelectExpansion={jest.fn()} />,
    );
    await act(async () => {
      await jest.advanceTimersByTimeAsync(19_000);
    });
    expect(screen.queryByTestId('game-sets-retry')).toBeNull();
    expect(screen.getByText('Loading sets')).toBeTruthy();

    await act(async () => {
      await jest.advanceTimersByTimeAsync(1_000);
    });
    expect(screen.getByTestId('game-sets-retry')).toBeTruthy();
    expect(screen.queryByText('Loading sets')).toBeNull();
  });

  it('search screen browse grid: a failed sets load shows Retry, and Retry re-runs it', async () => {
    const failing = { value: true };
    const listExpansions = mockExpansions(failing);

    renderWithProviders(
      <CatalogSearchScreen onClose={jest.fn()} onOpenCard={jest.fn()} onSelectGame={jest.fn()} />,
    );

    expect(await screen.findByTestId('catalog-sets-retry')).toBeTruthy();
    const calls = listExpansions.mock.calls.length;

    failing.value = false;
    await act(async () => {
      fireEvent.press(screen.getByTestId('catalog-sets-retry'));
    });

    expect(await screen.findByTestId('catalog-game-grid')).toBeTruthy();
    expect(listExpansions.mock.calls.length).toBe(calls + CARD_GAMES.length);
  });

  it('card search: a hung search ends in "Search unavailable" + Retry at the deadline', async () => {
    jest.useFakeTimers();
    const search = jest.spyOn(MockSpotlightRepository.prototype, 'searchCatalogCardsPage').mockImplementation(
      () => new Promise(() => undefined),
    );

    renderWithProviders(<CatalogSearchScreen onClose={jest.fn()} onOpenCard={jest.fn()} />);
    fireEvent.changeText(screen.getByPlaceholderText(/search by name, set, or number/i), 'pikachu');
    await act(async () => {
      await jest.advanceTimersByTimeAsync(300);
    });
    expect(screen.getByText('Searching catalog')).toBeTruthy();

    await act(async () => {
      await jest.advanceTimersByTimeAsync(20_000);
    });
    expect(screen.getByTestId('catalog-retry')).toBeTruthy();

    search.mockResolvedValue({ cards: [CARD], hasMore: false });
    const calls = search.mock.calls.length;
    await act(async () => {
      fireEvent.press(screen.getByTestId('catalog-retry'));
    });
    await act(async () => {
      await jest.advanceTimersByTimeAsync(300);
    });
    expect(search.mock.calls.length).toBeGreaterThan(calls);
    expect(screen.getByTestId('catalog-result-sv8-1')).toBeTruthy();
  });

  it("set page: a failed cards load shows Retry, and Retry re-runs it", async () => {
    jest.spyOn(MockSpotlightRepository.prototype, 'listExpansions').mockResolvedValue([SET]);
    jest.spyOn(MockSpotlightRepository.prototype, 'listSealedInExpansion').mockResolvedValue([]);
    jest.spyOn(MockSpotlightRepository.prototype, 'getInventoryEntries').mockResolvedValue([]);
    const listCards = jest.spyOn(MockSpotlightRepository.prototype, 'listCardsInExpansion')
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue([CARD]);

    renderWithProviders(
      <ExpansionDetailScreen expansionId="sv8" expansionName="Surging Sparks" game="pokemon" onClose={jest.fn()} onOpenCard={jest.fn()} />,
    );

    expect(await screen.findByTestId('expansion-detail-retry')).toBeTruthy();
    expect(screen.queryByText('No cards')).toBeNull();

    await act(async () => {
      fireEvent.press(screen.getByTestId('expansion-detail-retry'));
    });

    expect(await screen.findByTestId('set-card-sv8-1')).toBeTruthy();
    expect(listCards).toHaveBeenCalledTimes(2);
  });

  it('set page: re-reads cards on return to the foreground after a failure', async () => {
    const foreground = captureAppState();
    jest.spyOn(MockSpotlightRepository.prototype, 'listExpansions').mockResolvedValue([SET]);
    jest.spyOn(MockSpotlightRepository.prototype, 'listSealedInExpansion').mockResolvedValue([]);
    jest.spyOn(MockSpotlightRepository.prototype, 'getInventoryEntries').mockResolvedValue([]);
    const listCards = jest.spyOn(MockSpotlightRepository.prototype, 'listCardsInExpansion')
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue([CARD]);

    renderWithProviders(
      <ExpansionDetailScreen expansionId="sv8" expansionName="Surging Sparks" game="pokemon" onClose={jest.fn()} onOpenCard={jest.fn()} />,
    );
    expect(await screen.findByTestId('expansion-detail-retry')).toBeTruthy();

    await foreground();
    await waitFor(() => expect(screen.getByTestId('set-card-sv8-1')).toBeTruthy());
    expect(listCards).toHaveBeenCalledTimes(2);

    await foreground();
    expect(listCards).toHaveBeenCalledTimes(2);
  });
});
