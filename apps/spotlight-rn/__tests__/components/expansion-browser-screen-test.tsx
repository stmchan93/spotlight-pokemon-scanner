import { fireEvent, screen, waitFor } from '@testing-library/react-native';

import { CARD_GAMES, MockSpotlightRepository, type CardGame, type ExpansionRecord, type SetProgress } from '@spotlight/api-client';

import { ExpansionBrowserScreen } from '@/features/catalog/screens/expansion-browser-screen';
import { GameSetsScreen } from '@/features/catalog/screens/game-sets-screen';

import { renderWithProviders } from '../test-utils';

/**
 * Sets list with set progress (Figma 6552:1913). Game CHIPS switch games in
 * place — they replaced the old game grid — and every set is a card with a
 * progress bar, "X of Y CARDS" and the percent, 0% sets included.
 */

function expansion(overrides: Partial<ExpansionRecord> & { id: string; name: string }): ExpansionRecord {
  return {
    series: null,
    code: null,
    language: 'English',
    releaseDate: '2024-01-01',
    imageUrl: 'https://cdn.spotlight.test/logo.png',
    ...overrides,
  };
}

const SETS_BY_GAME: Partial<Record<CardGame, ExpansionRecord[]>> = {
  // Newest first, the order the backend returns.
  pokemon: [
    expansion({ id: 'sv8', name: 'Surging Sparks', releaseDate: '2024-11-08', cardCount: 252 }),
    expansion({ id: 'sv-jp-1', name: 'Terastal Festival', language: 'Japanese', releaseDate: '2024-09-13', cardCount: 0 }),
    expansion({ id: 'sm7', name: 'Celestial Storm', releaseDate: '2018-08-03', cardCount: 183 }),
  ],
  onepiece: [expansion({ id: 'op01', name: 'Romance Dawn', code: 'OP01', cardCount: 154 })],
};

const PROGRESS_BY_GAME: Partial<Record<CardGame, SetProgress['sets']>> = {
  // sv8 complete, sm7 partial, the Japanese set absent → 0%.
  pokemon: [
    { expansionId: 'sv8', ownedCount: 252 },
    { expansionId: 'sm7', ownedCount: 84 },
  ],
  onepiece: [{ expansionId: 'op01', ownedCount: 31 }],
};

function mockSetProgress() {
  return jest
    .spyOn(MockSpotlightRepository.prototype, 'getSetProgress')
    .mockImplementation(async (game: CardGame) => ({ game, sets: PROGRESS_BY_GAME[game] ?? [] }));
}

function mockListExpansions() {
  mockSetProgress();
  return jest
    .spyOn(MockSpotlightRepository.prototype, 'listExpansions')
    .mockImplementation(async (game?: CardGame) => SETS_BY_GAME[game ?? 'pokemon'] ?? []);
}

describe('ExpansionBrowserScreen', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('opens on Pokémon\'s sets with a chip per game that has sets', async () => {
    const listExpansions = mockListExpansions();

    renderWithProviders(
      <ExpansionBrowserScreen onClose={jest.fn()} onOpenCard={jest.fn()} onSelectExpansion={jest.fn()} />,
    );

    // Every game is asked for — the endpoint is single-game by design.
    await waitFor(() => {
      CARD_GAMES.forEach((game) => expect(listExpansions).toHaveBeenCalledWith(game));
    });
    expect(await screen.findByTestId('game-sets-expansion-sv8')).toBeTruthy();
    expect(screen.getByTestId('game-sets-game-pokemon').props.accessibilityState).toMatchObject({ selected: true });
    expect(screen.getByTestId('game-sets-game-onepiece')).toBeTruthy();
    // Games with no sets get no chip.
    expect(screen.queryByTestId('game-sets-game-lorcana')).toBeNull();
  });
});

describe('GameSetsScreen', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('lists every set newest first with its progress, 0% sets included', async () => {
    mockListExpansions();

    renderWithProviders(
      <GameSetsScreen
        game="pokemon"
        onClose={jest.fn()}
        onOpenCard={jest.fn()}
        onSelectExpansion={jest.fn()}
      />,
    );

    const list = await screen.findByTestId('game-sets-list');
    expect(list.props.data.map((item: ExpansionRecord) => item.id)).toEqual(['sv8', 'sv-jp-1', 'sm7']);
    expect(screen.getByText('Pokémon')).toBeTruthy();
    expect(screen.getByPlaceholderText(/search card/i)).toBeTruthy();

    // Complete, partial, and a set missing from the progress response (0%).
    expect(await screen.findByText('252 of 252 CARDS')).toBeTruthy();
    expect(screen.getByText('100%')).toBeTruthy();
    expect(screen.getByText('84 of 183 CARDS')).toBeTruthy();
    expect(screen.getByText('46%')).toBeTruthy();
    expect(screen.getByText('0 of 0 CARDS')).toBeTruthy();
    expect(screen.getByText('11/8/2024')).toBeTruthy();
    expect(screen.getByTestId('game-sets-expansion-sm7-progress-fill').props.style).toEqual(
      expect.arrayContaining([expect.objectContaining({ width: `${(84 / 183) * 100}%` })]),
    );
  });

  it('switches games with the chips', async () => {
    mockListExpansions();

    renderWithProviders(
      <GameSetsScreen game="pokemon" onClose={jest.fn()} onOpenCard={jest.fn()} onSelectExpansion={jest.fn()} />,
    );

    fireEvent.press(await screen.findByTestId('game-sets-game-onepiece'));
    expect(await screen.findByTestId('game-sets-expansion-op01')).toBeTruthy();
    expect(screen.queryByTestId('game-sets-expansion-sv8')).toBeNull();
    expect(screen.getByText('One Piece')).toBeTruthy();
    expect(await screen.findByText('31 of 154 CARDS')).toBeTruthy();
  });

  it('shows the assistant sparkle only when it can open', async () => {
    mockListExpansions();
    const onOpenAssistant = jest.fn();

    const { rerender } = renderWithProviders(
      <GameSetsScreen game="pokemon" onClose={jest.fn()} onOpenCard={jest.fn()} onSelectExpansion={jest.fn()} />,
    );
    await screen.findByTestId('game-sets-list');
    expect(screen.queryByTestId('game-sets-assistant')).toBeNull();

    rerender(
      <GameSetsScreen
        game="pokemon"
        onClose={jest.fn()}
        onOpenAssistant={onOpenAssistant}
        onOpenCard={jest.fn()}
        onSelectExpansion={jest.fn()}
      />,
    );
    fireEvent.press(screen.getByTestId('game-sets-assistant'));
    expect(onOpenAssistant).toHaveBeenCalled();
  });

  it('carries the game with the chosen set', async () => {
    mockListExpansions();
    const onSelectExpansion = jest.fn();

    renderWithProviders(
      <GameSetsScreen
        game="onepiece"
        onClose={jest.fn()}
        onOpenCard={jest.fn()}
        onSelectExpansion={onSelectExpansion}
      />,
    );

    fireEvent.press(await screen.findByTestId('game-sets-expansion-op01'));

    // `set_id` is unique only WITHIN a game, so a One Piece set opened without
    // it drills into an empty list.
    expect(onSelectExpansion).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'op01' }),
      'onepiece',
    );
  });

  it('searches THIS game, not every game', async () => {
    mockListExpansions();
    const searchPage = jest
      .spyOn(MockSpotlightRepository.prototype, 'searchCatalogCardsPage')
      .mockResolvedValue({ cards: [], hasMore: false });

    renderWithProviders(
      <GameSetsScreen
        game="lorcana"
        onClose={jest.fn()}
        onOpenCard={jest.fn()}
        onSelectExpansion={jest.fn()}
      />,
    );

    fireEvent.changeText(
      await screen.findByPlaceholderText(/search card/i),
      'ace',
    );
    /*
      The top-level search deliberately sends `all` — a typed name there is
      someone naming a card, not a lane. Here the game is the screen you are
      standing on, so results from the other four would be noise.
    */
    // waitFor outlasts the field's 275ms debounce.
    await waitFor(() => {
      expect(searchPage).toHaveBeenCalledWith(
        'ace',
        expect.any(Number),
        0,
        expect.objectContaining({ game: 'lorcana' }),
      );
    });
  });

  it('swaps the set grid for the results while a query is live', async () => {
    mockListExpansions();
    jest.spyOn(MockSpotlightRepository.prototype, 'searchCatalogCardsPage').mockResolvedValue({
      cards: [
        {
          id: 'lorcana~FBL-106',
          cardId: 'lorcana~FBL-106',
          name: 'Maui',
          cardNumber: '106/204',
          setName: 'Fabled',
          game: 'lorcana',
        } as never,
      ],
      hasMore: false,
    });

    renderWithProviders(
      <GameSetsScreen
        game="lorcana"
        onClose={jest.fn()}
        onOpenCard={jest.fn()}
        onSelectExpansion={jest.fn()}
      />,
    );
    expect(await screen.findByTestId('game-sets-list')).toBeTruthy();

    fireEvent.changeText(
      screen.getByPlaceholderText(/search card/i),
      'maui',
    );
    // One list at a time: the sets are what you browse, the results are what
    // you asked for.
    expect(await screen.findByTestId('game-sets-results')).toBeTruthy();
    expect(screen.queryByTestId('game-sets-list')).toBeNull();
  });

  it('keeps the same search field mounted when the results replace the sets', async () => {
    /*
      The field used to ride along as the set grid's `ListHeaderComponent` and
      move into a plain View once a query went live — two different positions,
      so React unmounted and remounted it the moment the query reached two
      characters. On a device that drops first responder mid-word: typing
      "luffy" searched "lu" and swallowed the rest (user, 2026-09-10).

      Identity is the assertion, not presence — a remounted field is still
      findable, which is exactly why the bug survived the test above.
    */
    mockListExpansions();
    jest
      .spyOn(MockSpotlightRepository.prototype, 'searchCatalogCardsPage')
      .mockResolvedValue({ cards: [], hasMore: false });

    renderWithProviders(
      <GameSetsScreen
        game="onepiece"
        onClose={jest.fn()}
        onOpenCard={jest.fn()}
        onSelectExpansion={jest.fn()}
      />,
    );

    const field = await screen.findByTestId('game-sets-search');
    fireEvent.changeText(field, 'lu');
    await waitFor(() => expect(screen.queryByTestId('game-sets-list')).not.toBeOnTheScreen());

    expect(screen.getByTestId('game-sets-search')).toBe(field);
  });
});
