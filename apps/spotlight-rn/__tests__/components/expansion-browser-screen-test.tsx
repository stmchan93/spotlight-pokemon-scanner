import { fireEvent, screen, waitFor, within } from '@testing-library/react-native';
import { State } from 'react-native-gesture-handler';
import { fireGestureHandler, getByGestureTestId } from 'react-native-gesture-handler/jest-utils';

import { CARD_GAMES, MockSpotlightRepository, type CardGame, type ExpansionRecord, type SetProgress } from '@spotlight/api-client';

import { ExpansionBrowserScreen } from '@/features/catalog/screens/expansion-browser-screen';
import { GameSetsScreen } from '@/features/catalog/screens/game-sets-screen';

import { type SetListRow } from '@/features/catalog/set-progress';

import { renderWithProviders } from '../test-utils';

/**
 * Search (Figma 6597:5654). Game CHIPS switch games in place — they replaced
 * the old game grid. The landing has SINGLES and SEALED rails and the first
 * sets; VIEW ALL opens the full era-grouped sets list (`view="sets"`), where
 * every set is a card with a progress bar, "X of Y CARDS" and the percent.
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

  it('closes on a pull down, with the landing locked at the top', async () => {
    mockListExpansions();
    const onClose = jest.fn();
    renderWithProviders(
      <ExpansionBrowserScreen onClose={onClose} onOpenCard={jest.fn()} onSelectExpansion={jest.fn()} />,
    );
    await screen.findByTestId('game-sets-expansion-sv8');
    expect(screen.getByTestId('game-sets-pull-down')).toBeTruthy();
    expect(screen.getByTestId('game-sets-landing').props.bounces).toBe(false);

    fireGestureHandler(getByGestureTestId('pull-down-to-dismiss'), [
      { state: State.BEGAN, translationY: 0, velocityY: 0 },
      { state: State.ACTIVE, translationY: 150, velocityY: 0 },
      { state: State.END, translationY: 150, velocityY: 0 },
    ]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('GameSetsScreen', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('a side-pushed set list keeps its normal scroll bounce', async () => {
    mockListExpansions();
    renderWithProviders(
      <GameSetsScreen game="pokemon" onClose={jest.fn()} onOpenCard={jest.fn()} onSelectExpansion={jest.fn()} view="sets" />,
    );
    await screen.findByTestId('game-sets-expansion-sv8');
    expect(screen.getByTestId('game-sets-list').props.bounces).toBeUndefined();
  });

  it('VIEW ALL sets lists every set newest first with its progress, 0% sets included', async () => {
    mockListExpansions();

    renderWithProviders(
      <GameSetsScreen
        game="pokemon"
        onClose={jest.fn()}
        onOpenCard={jest.fn()}
        onSelectExpansion={jest.fn()}
        view="sets"
      />,
    );

    const list = await screen.findByTestId('game-sets-list');
    expect(list.props.data.map((row: SetListRow) => (row.kind === 'set' ? row.expansion.id : row.era))).toEqual([
      'sv8',
      'sv-jp-1',
      'sm7',
    ]);
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

  it('has no assistant button of its own (the floating Ekalight bubble replaces it)', async () => {
    mockListExpansions();
    renderWithProviders(
      <GameSetsScreen game="pokemon" onClose={jest.fn()} onOpenCard={jest.fn()} onSelectExpansion={jest.fn()} />,
    );
    await screen.findByTestId('game-sets-landing');
    expect(screen.queryByTestId('game-sets-assistant')).toBeNull();
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
    expect(await screen.findByTestId('game-sets-landing')).toBeTruthy();

    fireEvent.changeText(
      screen.getByPlaceholderText(/search card/i),
      'maui',
    );
    // One list at a time: the landing is what you browse, the results are
    // what you asked for.
    expect(await screen.findByTestId('game-sets-results')).toBeTruthy();
    expect(screen.queryByTestId('game-sets-landing')).toBeNull();
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
    await waitFor(() => expect(screen.queryByTestId('game-sets-landing')).not.toBeOnTheScreen());

    expect(screen.getByTestId('game-sets-search')).toBe(field);
  });

  const MAUI = {
    id: 'lorcana~FBL-106',
    cardId: 'lorcana~FBL-106',
    name: 'Maui',
    cardNumber: '106/204',
    setName: 'Fabled',
    game: 'lorcana',
  } as never;
  const MAUI_BOX = {
    id: 'tcgp-sealed-9',
    cardId: 'tcgp-sealed-9',
    name: 'Fabled Booster Box',
    cardNumber: '',
    setName: 'Fabled',
    productKind: 'sealed',
    sealedProductType: 'Booster Box',
    marketPrice: 120,
    currencyCode: 'USD',
    game: 'lorcana',
  } as never;

  function mockSearch(cards: never[], sealed: never[], hasMore = false) {
    return jest
      .spyOn(MockSpotlightRepository.prototype, 'searchCatalogCardsPage')
      .mockImplementation(async (_query, _limit, _offset, options) => (
        options?.kind === 'sealed' ? { cards: sealed, hasMore: false } : { cards, hasMore }
      ));
  }

  function renderLorcana(onOpenCard = jest.fn()) {
    renderWithProviders(
      <GameSetsScreen game="lorcana" onClose={jest.fn()} onOpenCard={onOpenCard} onSelectExpansion={jest.fn()} />,
    );
    return onOpenCard;
  }

  /** Render-order position of a testID in the tree. */
  function positionOf(testID: string): number {
    const order: unknown[] = [];
    const walk = (node: unknown) => {
      if (!node || typeof node !== 'object') {
        return;
      }
      if (Array.isArray(node)) {
        node.forEach(walk);
        return;
      }
      const { props, children } = node as { props?: { testID?: unknown }; children?: unknown[] | null };
      order.push(props?.testID);
      (children ?? []).forEach(walk);
    };
    walk(screen.toJSON());
    return order.indexOf(testID);
  }

  it('lists matching sealed for THIS game after the card results', async () => {
    mockListExpansions();
    const searchPage = mockSearch([MAUI], [MAUI_BOX]);
    const onOpenCard = renderLorcana();

    fireEvent.changeText(await screen.findByPlaceholderText(/search card/i), 'fabled');

    expect(await screen.findByTestId('game-sets-sealed')).toBeTruthy();
    expect(searchPage).toHaveBeenCalledWith('fabled', expect.any(Number), 0, { game: 'lorcana', kind: 'sealed' });
    expect(screen.getByText('SEALED')).toBeTruthy();
    expect(positionOf('catalog-result-lorcana~FBL-106')).toBeGreaterThan(-1);
    expect(positionOf('catalog-result-lorcana~FBL-106')).toBeLessThan(positionOf('game-sets-sealed'));
    expect(screen.getByText('$120.00')).toBeTruthy();

    // Sealed opens through the same card-page route as a card result.
    fireEvent.press(screen.getByTestId('game-sets-sealed-tile-smoke-tcgp-sealed-9'));
    expect(onOpenCard).toHaveBeenCalledWith(expect.objectContaining({ cardId: 'tcgp-sealed-9' }));
  });

  it('holds sealed back until every card page has loaded', async () => {
    mockListExpansions();
    mockSearch([MAUI], [MAUI_BOX], true);
    renderLorcana();

    fireEvent.changeText(await screen.findByPlaceholderText(/search card/i), 'fabled');

    expect(await screen.findByTestId('game-sets-results')).toBeTruthy();
    await waitFor(() => expect(screen.getByText('Maui')).toBeTruthy());
    expect(screen.queryByTestId('game-sets-sealed')).toBeNull();
  });

  it('shows sealed alone, not "no matching cards", when only sealed matched', async () => {
    mockListExpansions();
    mockSearch([], [MAUI_BOX]);
    renderLorcana();

    fireEvent.changeText(await screen.findByPlaceholderText(/search card/i), 'booster box');

    expect(await screen.findByTestId('game-sets-sealed')).toBeTruthy();
    expect(screen.queryByText('No matching cards')).toBeNull();
  });
});

describe('GameSetsScreen era grouping', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('groups sets under era headings, newest era first, promos after mains', async () => {
    mockSetProgress();
    jest.spyOn(MockSpotlightRepository.prototype, 'listExpansions').mockImplementation(async () => [
      expansion({ id: 'tcgplayer-group-1', name: "McDonald's Promos 2026", releaseDate: '2026/11/06', era: 'Mega Evolution', isPromo: true, imageUrl: null }),
      expansion({ id: 'me2', name: 'Phantasmal Flames', releaseDate: '2025/11/14', era: 'Mega Evolution', isPromo: false }),
      expansion({ id: 'sv10', name: 'Destined Rivals', releaseDate: '2025/05/30', era: 'Scarlet & Violet', isPromo: false }),
      expansion({ id: 'svp', name: 'SV Black Star Promos', releaseDate: '2023/01/01', era: 'Scarlet & Violet', isPromo: true }),
      expansion({ id: 'sv1', name: 'Scarlet & Violet', releaseDate: '2023/03/31', era: 'Scarlet & Violet', isPromo: false }),
    ]);

    renderWithProviders(
      <GameSetsScreen game="pokemon" onClose={jest.fn()} onOpenCard={jest.fn()} onSelectExpansion={jest.fn()} view="sets" />,
    );

    const list = await screen.findByTestId('game-sets-list');
    expect(
      list.props.data.map((row: SetListRow) => (row.kind === 'era' ? `# ${row.era}` : row.expansion.id)),
    ).toEqual(['# Mega Evolution', 'me2', 'tcgplayer-group-1', '# Scarlet & Violet', 'sv10', 'sv1', 'svp']);
    expect(screen.getByText('MEGA EVOLUTION')).toBeTruthy();
    expect(screen.getByText('SCARLET & VIOLET')).toBeTruthy();
  });

  it('shows the set name in place of a missing logo, and the logo when there is one', async () => {
    mockSetProgress();
    jest.spyOn(MockSpotlightRepository.prototype, 'listExpansions').mockImplementation(async () => [
      expansion({ id: 'no-logo', name: 'ME06: Delta Reign', releaseDate: '2026/11/06', imageUrl: null }),
      expansion({ id: 'with-logo', name: 'Phantasmal Flames', releaseDate: '2025/11/14' }),
    ]);

    renderWithProviders(
      <GameSetsScreen game="pokemon" onClose={jest.fn()} onOpenCard={jest.fn()} onSelectExpansion={jest.fn()} />,
    );

    const slot = await screen.findByTestId('game-sets-expansion-no-logo-logo-name');
    expect(slot).toHaveTextContent('ME06: Delta Reign');
    expect(screen.queryByTestId('game-sets-expansion-no-logo-logo')).toBeNull();
    // Shown once, not again in the title row.
    expect(screen.getAllByText('ME06: Delta Reign')).toHaveLength(1);

    expect(screen.getByTestId('game-sets-expansion-with-logo-logo')).toBeTruthy();
    expect(screen.queryByTestId('game-sets-expansion-with-logo-logo-name')).toBeNull();
    expect(screen.getByText('Phantasmal Flames')).toBeTruthy();
  });

  it('closes with an X: Search slides up, so it is not a back arrow', async () => {
    mockListExpansions();
    renderWithProviders(
      <ExpansionBrowserScreen onClose={jest.fn()} onOpenCard={jest.fn()} onSelectExpansion={jest.fn()} />,
    );
    const close = await screen.findByTestId('game-sets-back');
    expect(close.props.accessibilityLabel).toBe('Close');
  });
});

describe('GameSetsScreen Search landing (Figma 6597:5654)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  function card(id: string, name: string, marketPrice: number | null) {
    return {
      id,
      cardId: id,
      name,
      cardNumber: `#${id}/252`,
      setName: 'Surging Sparks',
      marketPrice,
      currencyCode: 'USD',
      game: 'pokemon',
    } as never;
  }

  const BOX = {
    id: 'tcgp-sealed-1',
    cardId: 'tcgp-sealed-1',
    name: 'Surging Sparks Booster Box',
    cardNumber: '',
    setName: 'Surging Sparks',
    productKind: 'sealed',
    sealedProductType: 'Booster Box',
    marketPrice: 160,
    currencyCode: 'USD',
    game: 'pokemon',
  } as never;

  function mockRails(cardsBySet: Record<string, never[]> = { sv8: [card('001', 'Pichu', 0.5), card('238', 'Pikachu ex', 120), card('100', 'Unpriced', null)] }) {
    mockListExpansions();
    const listCards = jest
      .spyOn(MockSpotlightRepository.prototype, 'listCardsInExpansion')
      .mockImplementation(async (expansionId: string) => cardsBySet[expansionId] ?? []);
    const searchPage = jest
      .spyOn(MockSpotlightRepository.prototype, 'searchCatalogCardsPage')
      .mockImplementation(async (_query, _limit, _offset, options) => (
        options?.kind === 'sealed' ? { cards: [BOX], hasMore: false } : { cards: [], hasMore: false }
      ));
    return { listCards, searchPage };
  }

  function renderLanding(props: Partial<Parameters<typeof GameSetsScreen>[0]> = {}) {
    const handlers = {
      onOpenCard: jest.fn(),
      onSelectExpansion: jest.fn(),
      onViewAll: jest.fn(),
    };
    renderWithProviders(
      <GameSetsScreen game="pokemon" onClose={jest.fn()} {...handlers} {...props} />,
    );
    return handlers;
  }

  it('shows SINGLES from the newest English set, priciest first, with the game\'s card count', async () => {
    const { listCards } = mockRails();
    const { onOpenCard, onSelectExpansion } = renderLanding();

    expect(await screen.findByTestId('game-sets-singles')).toBeTruthy();
    expect(listCards).toHaveBeenCalledWith('sv8', '', 1000, 'pokemon');
    // 252 + 0 + 183 cards across the game's sets.
    expect(screen.getByTestId('game-sets-singles-header-count')).toHaveTextContent('(435 RESULTS)');
    const tiles = screen.getByTestId('game-sets-singles');
    expect(within(tiles).getAllByText(/Pichu|Pikachu ex|Unpriced/).map((node) => node.props.children)).toEqual([
      'Pikachu ex',
      'Pichu',
      'Unpriced',
    ]);
    expect(screen.getByText('238/252 · Surging Sparks')).toBeTruthy();
    expect(screen.getByTestId('game-sets-singles-238-price')).toHaveTextContent('$120.00');
    expect(screen.queryByTestId('game-sets-singles-100-price')).toBeNull();

    fireEvent.press(screen.getByTestId('game-sets-singles-238'));
    expect(onOpenCard).toHaveBeenCalledWith(expect.objectContaining({ cardId: '238' }));

    // VIEW ALL opens the set the rail came from.
    fireEvent.press(screen.getByTestId('game-sets-singles-header-view-all'));
    expect(onSelectExpansion).toHaveBeenCalledWith(expect.objectContaining({ id: 'sv8' }), 'pokemon');
  });

  it('falls through to the next set when the newest has no cards yet', async () => {
    const { listCards } = mockRails({ sm7: [card('109', 'Rayquaza GX', 6.4)] });
    renderLanding();

    expect(await screen.findByText('Rayquaza GX')).toBeTruthy();
    expect(listCards).toHaveBeenCalledWith('sv8', '', 1000, 'pokemon');
    expect(listCards).toHaveBeenCalledWith('sm7', '', 1000, 'pokemon');
  });

  it('shows the game\'s SEALED product with no query; VIEW ALL opens the sealed list', async () => {
    const { searchPage } = mockRails();
    const { onViewAll } = renderLanding();

    expect(await screen.findByTestId('game-sets-sealed-rail')).toBeTruthy();
    expect(searchPage).toHaveBeenCalledWith('', expect.any(Number), 0, { game: 'pokemon', kind: 'sealed' });
    expect(screen.getByText('Surging Sparks Booster Box')).toBeTruthy();
    // No game-level sealed total exists, so no count.
    expect(screen.queryByTestId('game-sets-sealed-header-count')).toBeNull();

    fireEvent.press(screen.getByTestId('game-sets-sealed-header-view-all'));
    expect(onViewAll).toHaveBeenCalledWith('sealed', 'pokemon');
  });

  it('shows the first sets with TOTAL VALUE and the percent in the bar; VIEW ALL opens every set', async () => {
    mockSetProgress();
    jest.spyOn(MockSpotlightRepository.prototype, 'listExpansions').mockImplementation(async () => [
      expansion({ id: 's1', name: 'Delta Reign', releaseDate: '2026-05-22', cardCount: 120, setValue: 1012.78 }),
      expansion({ id: 's2', name: 'Two', releaseDate: '2026-03-01', cardCount: 100 }),
      expansion({ id: 's3', name: 'Three', releaseDate: '2026-01-01', cardCount: 100 }),
      expansion({ id: 's4', name: 'Four', releaseDate: '2025-11-01', cardCount: 100 }),
    ]);
    jest.spyOn(MockSpotlightRepository.prototype, 'getSetProgress').mockResolvedValue({
      game: 'pokemon',
      sets: [{ expansionId: 's1', ownedCount: 54 }],
    });
    const { onViewAll } = renderLanding();

    const first = await screen.findByTestId('game-sets-expansion-s1');
    expect(screen.getByTestId('game-sets-sets-header-count')).toHaveTextContent('(4 RESULTS)');
    expect(within(first).getByText('5/22/2026')).toBeTruthy();
    expect(await within(first).findByText('54 of 120 CARDS')).toBeTruthy();
    expect(screen.getByTestId('game-sets-expansion-s1-progress-label')).toHaveTextContent('45%');
    expect(screen.getByTestId('game-sets-expansion-s1-total-value')).toHaveTextContent('TOTAL VALUE: $1,012.78');
    // An unvalued set hides the line rather than reading $0.
    expect(screen.queryByTestId('game-sets-expansion-s2-total-value')).toBeNull();
    // Three on the landing; the rest are behind VIEW ALL.
    expect(screen.getByTestId('game-sets-expansion-s3')).toBeTruthy();
    expect(screen.queryByTestId('game-sets-expansion-s4')).toBeNull();

    fireEvent.press(screen.getByTestId('game-sets-sets-header-view-all'));
    expect(onViewAll).toHaveBeenCalledWith('sets', 'pokemon');
  });

  it('VIEW ALL sealed pages through every sealed product of the game', async () => {
    const { searchPage } = mockRails();
    renderLanding({ view: 'sealed' });

    expect(await screen.findByTestId('game-sets-sealed-list')).toBeTruthy();
    expect(searchPage).toHaveBeenCalledWith('', expect.any(Number), 0, { game: 'pokemon', kind: 'sealed' });
    expect(screen.getByText('Surging Sparks Booster Box')).toBeTruthy();
    expect(screen.queryByTestId('game-sets-landing')).toBeNull();
  });
});
