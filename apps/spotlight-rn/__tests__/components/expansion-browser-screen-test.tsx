import { fireEvent, screen, waitFor } from '@testing-library/react-native';

import { CARD_GAMES, MockSpotlightRepository, type CardGame, type ExpansionRecord } from '@spotlight/api-client';

import { ExpansionBrowserScreen } from '@/features/catalog/screens/expansion-browser-screen';
import { GameSetsScreen } from '@/features/catalog/screens/game-sets-screen';

import { renderWithProviders } from '../test-utils';

/**
 * Browse Sets is a grid of GAMES; the sets themselves are a pushed route.
 *
 * It used to list ONE game's sets, whichever the scanner lane pointed at, so
 * every other game's catalog was invisible with nothing on screen saying a
 * filter had been applied (user, 2026-09-10). The game level is also what keeps
 * the list scannable: five games carry 215 sets today and production alone
 * holds 450 Pokémon sets.
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
    expansion({ id: 'sv8', name: 'Surging Sparks', releaseDate: '2024-11-08' }),
    expansion({ id: 'sv-jp-1', name: 'Terastal Festival', language: 'Japanese', releaseDate: '2024-09-13' }),
    expansion({ id: 'sm7', name: 'Celestial Storm', releaseDate: '2018-08-03' }),
  ],
  onepiece: [expansion({ id: 'op01', name: 'Romance Dawn', code: 'OP01' })],
};

function mockListExpansions() {
  return jest
    .spyOn(MockSpotlightRepository.prototype, 'listExpansions')
    .mockImplementation(async (game?: CardGame) => SETS_BY_GAME[game ?? 'pokemon'] ?? []);
}

describe('ExpansionBrowserScreen', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('shows a grid of games, not one game\'s sets', async () => {
    const listExpansions = mockListExpansions();

    renderWithProviders(<ExpansionBrowserScreen onClose={jest.fn()} onSelectGame={jest.fn()} />);

    // Every game is asked for — the endpoint is single-game by design, so the
    // grid fans out rather than asking for an "all" list that doesn't exist.
    await waitFor(() => {
      CARD_GAMES.forEach((game) => expect(listExpansions).toHaveBeenCalledWith(game));
    });
    expect(await screen.findByTestId('browse-game-pokemon')).toBeTruthy();
    expect(screen.getByTestId('browse-game-onepiece')).toBeTruthy();
    // No set is on screen: those live behind a push.
    expect(screen.queryByText('Romance Dawn')).toBeNull();
  });

  it('hands the picked game to the caller to push', async () => {
    mockListExpansions();
    const onSelectGame = jest.fn();

    renderWithProviders(<ExpansionBrowserScreen onClose={jest.fn()} onSelectGame={onSelectGame} />);

    fireEvent.press(await screen.findByTestId('browse-game-onepiece'));
    expect(onSelectGame).toHaveBeenCalledWith('onepiece');
  });
});

describe('GameSetsScreen', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('lists that game\'s sets newest first, under a search box, with no language tabs', async () => {
    mockListExpansions();

    renderWithProviders(
      <GameSetsScreen
        game="pokemon"
        onClose={jest.fn()}
        onOpenCard={jest.fn()}
        onSelectExpansion={jest.fn()}
      />,
    );

    const grid = await screen.findByTestId('game-sets-grid');
    expect(grid.props.data.map((item: ExpansionRecord) => item.id)).toEqual([
      'sv8',
      'sv-jp-1',
      'sm7',
    ]);

    /*
      The search FOLLOWS you down (user, 2026-09-10): it is the same card search
      the screen above has, not a second box that filters set names. The old
      set-filter field is what came out, along with the language tabs — a
      Japanese set now sits wherever its release date puts it, above Celestial
      Storm here.
    */
    expect(screen.getByPlaceholderText('Search by name, set, or number')).toBeTruthy();
    expect(screen.queryByPlaceholderText('Search by sets')).toBeNull();
    expect(screen.queryByTestId('browse-set-language-English')).toBeNull();
    expect(screen.queryByTestId('browse-set-language-Japanese')).toBeNull();
    expect(screen.getByTestId('game-sets-expansion-sv-jp-1')).toBeTruthy();
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
      await screen.findByPlaceholderText('Search by name, set, or number'),
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
    expect(await screen.findByTestId('game-sets-grid')).toBeTruthy();

    fireEvent.changeText(
      screen.getByPlaceholderText('Search by name, set, or number'),
      'maui',
    );
    // One list at a time: the sets are what you browse, the results are what
    // you asked for.
    expect(await screen.findByTestId('game-sets-results')).toBeTruthy();
    expect(screen.queryByTestId('game-sets-grid')).toBeNull();
  });
});
