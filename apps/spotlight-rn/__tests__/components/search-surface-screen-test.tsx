import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';

import { MockSpotlightRepository, type CardGame, type ExpansionRecord } from '@spotlight/api-client';

import { ExpansionBrowserScreen } from '@/features/catalog/screens/expansion-browser-screen';
import { fetchSuggestedUsers, searchUsers } from '@/features/profile/profile-service';

import { renderWithProviders } from '../test-utils';

/**
 * Search as a tab / sheet (Figma 6642:12483 CARDS, 6642:14400 PEOPLE): CARDS |
 * PEOPLE tabs on the banner, each searching only its own kind, a filter sheet
 * with the shared Sealed / rarity model, and PEOPLE cards carrying each
 * collector's most valuable holdings from ONE batched read.
 */

jest.mock('@/features/profile/profile-service', () => ({
  ...jest.requireActual('@/features/profile/profile-service'),
  fetchSuggestedUsers: jest.fn(),
  searchUsers: jest.fn(),
}));

function person(userID: string, displayName: string, extra: Record<string, unknown> = {}) {
  return {
    userID,
    displayName,
    handle: displayName.toLowerCase().replace(/\s+/g, ''),
    avatarURL: null,
    labelerEnabled: false,
    adminEnabled: false,
    followerCount: 2,
    followingCount: 3,
    reputation: 7,
    ...extra,
  } as never;
}

function holding(id: string, name: string, marketPrice: number, quantity: number) {
  return {
    id,
    cardId: id,
    name,
    cardNumber: '#193/162',
    setName: 'Perfect Order',
    imageUrl: '',
    marketPrice,
    hasMarketPrice: true,
    priceStatus: null,
    currencyCode: 'USD',
    quantity,
    addedAt: '2026-11-01T00:00:00Z',
    kind: 'raw',
    conditionLabel: 'Near Mint',
  } as never;
}

const SETS: ExpansionRecord[] = [
  {
    id: 'sv8',
    name: 'Surging Sparks',
    series: null,
    code: null,
    language: 'English',
    releaseDate: '2024-11-08',
    imageUrl: null,
    cardCount: 252,
  } as ExpansionRecord,
];

function mockCatalog() {
  jest.spyOn(MockSpotlightRepository.prototype, 'getSetProgress').mockImplementation(async (game: CardGame) => ({ game, sets: [] }));
  jest.spyOn(MockSpotlightRepository.prototype, 'listExpansions').mockImplementation(async () => SETS);
  jest.spyOn(MockSpotlightRepository.prototype, 'listCardsInExpansion').mockResolvedValue([]);
  return jest
    .spyOn(MockSpotlightRepository.prototype, 'searchCatalogCardsPage')
    .mockResolvedValue({ cards: [], hasMore: false });
}

function renderSearch(mode: 'tab' | 'sheet', extra: Record<string, unknown> = {}) {
  const handlers = {
    onClose: jest.fn(),
    onOpenAssistant: jest.fn(),
    onOpenCard: jest.fn(),
    onOpenHolding: jest.fn(),
    onOpenProfile: jest.fn(),
    onSelectExpansion: jest.fn(),
  };
  renderWithProviders(<ExpansionBrowserScreen mode={mode} {...handlers} {...extra} />);
  return handlers;
}

describe('Search surface (tab / sheet)', () => {
  beforeEach(() => {
    (fetchSuggestedUsers as jest.Mock).mockResolvedValue({
      failed: false,
      profiles: [
        person('11111111-1111-4111-8111-111111111111', 'Wabi Sabi', { bio: 'I buy and sell graded cards', isVerified: true }),
        person('22222222-2222-4222-8222-222222222222', 'Poke Sean', { followerCount: 1200, followingCount: 11, reputation: 12 }),
      ],
    });
    (searchUsers as jest.Mock).mockResolvedValue([person('33333333-3333-4333-8333-333333333333', 'Stephen Chan')]);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  it('tab mode has no close and no Ask button; the sheet keeps its close', async () => {
    mockCatalog();
    renderSearch('tab');
    expect(await screen.findByTestId('search-tabs')).toBeTruthy();
    expect(screen.queryByTestId('game-sets-back')).toBeNull();
    expect(screen.queryByTestId('game-sets-assistant')).toBeNull();
    expect(screen.getByTestId('game-sets-toolbar-spacer')).toBeTruthy();
    screen.unmount();

    mockCatalog();
    const { onClose } = renderSearch('sheet');
    fireEvent.press(await screen.findByTestId('game-sets-back'));
    expect(onClose).toHaveBeenCalled();
    expect(screen.getByLabelText('Close')).toBeTruthy();
  });

  it('CARDS shows the game chips under the tabs and the Figma placeholder', async () => {
    mockCatalog();
    renderSearch('tab');

    expect(await screen.findByTestId('game-sets-game-chips')).toBeTruthy();
    expect(screen.getByPlaceholderText('SEARCH CARDS, PEOPLE, SETS')).toBeTruthy();
    expect(screen.getByTestId('game-sets-filter')).toBeTruthy();
  });

  it('the filter sheet applies a rarity to the card search', async () => {
    const searchPage = mockCatalog();
    renderSearch('tab');

    fireEvent.press(await screen.findByTestId('game-sets-filter'));
    fireEvent.press(await screen.findByTestId('search-filter-sheet-rarity-chip-sir'));
    fireEvent.press(screen.getByTestId('search-filter-sheet-apply'));

    await waitFor(() =>
      expect(searchPage).toHaveBeenCalledWith('', expect.any(Number), 0, expect.objectContaining({
        game: 'pokemon',
        rarityBucket: 'sir',
      })),
    );
    expect(screen.getByTestId('game-sets-filter-active')).toBeTruthy();
    expect(screen.getByLabelText('Filters, SIR')).toBeTruthy();

    // Sealed replaces the rarity (single-select) and asks for sealed product.
    fireEvent.press(screen.getByTestId('game-sets-filter'));
    fireEvent.press(await screen.findByTestId('search-filter-sheet-sealed-chip'));
    fireEvent.press(screen.getByTestId('search-filter-sheet-apply'));
    await waitFor(() =>
      expect(searchPage).toHaveBeenLastCalledWith('', expect.any(Number), 0, expect.objectContaining({ kind: 'sealed' })),
    );
    expect(searchPage.mock.calls.at(-1)?.[3]).not.toHaveProperty('rarityBucket');
  });

  it('PEOPLE lists suggested collectors with their most valuable holdings from one batched read', async () => {
    mockCatalog();
    const topHoldings = jest
      .spyOn(MockSpotlightRepository.prototype, 'getProfilesTopHoldings')
      .mockImplementation(async (userIDs) =>
        userIDs.map((userId, index) => ({
          userId,
          available: true,
          entries: index === 0 ? [holding('gengar-psa', 'Gengar', 1450.12, 199)] : [],
        })),
      );
    const { onOpenHolding, onOpenProfile } = renderSearch('tab');

    fireEvent.press(await screen.findByTestId('search-tabs-tab-people'));

    const wabi = '11111111-1111-4111-8111-111111111111';
    expect(await screen.findByText('Wabi Sabi')).toBeTruthy();
    expect(screen.getByText('2 FOLLOWERS')).toBeTruthy();
    expect(screen.getByText('3 FOLLOWING')).toBeTruthy();
    expect(screen.getByText('7 FAME')).toBeTruthy();
    expect(screen.getByText('1,200 FOLLOWERS')).toBeTruthy();
    expect(screen.getByText('I buy and sell graded cards')).toBeTruthy();
    expect(screen.getByTestId(`search-people-person-${wabi}-verified`)).toBeTruthy();
    // No card chips or filter on PEOPLE: it searches people only.
    expect(screen.queryByTestId('game-sets-game-chips')).toBeNull();
    expect(screen.queryByTestId('game-sets-filter')).toBeNull();

    const tile = await screen.findByTestId(`search-people-person-${wabi}-holding-gengar-psa`);
    expect(screen.getByText('$1,450.12')).toBeTruthy();
    expect(screen.getByText('199')).toBeTruthy();
    // Every listed person in ONE request.
    expect(topHoldings).toHaveBeenCalledTimes(1);
    expect(topHoldings).toHaveBeenCalledWith(
      [wabi, '22222222-2222-4222-8222-222222222222'],
      { limit: 6 },
    );
    // A person with nothing priced gets no rail.
    expect(screen.queryByTestId('search-people-person-22222222-2222-4222-8222-222222222222-holdings')).toBeNull();

    fireEvent.press(tile);
    expect(onOpenHolding).toHaveBeenCalledWith(
      expect.objectContaining({ userID: wabi }),
      expect.objectContaining({ id: 'gengar-psa' }),
    );
    fireEvent.press(screen.getByTestId(`search-people-person-${wabi}-identity`));
    expect(onOpenProfile).toHaveBeenCalledWith(expect.objectContaining({ userID: wabi }));
  });

  it('typing on PEOPLE searches collectors, and the text follows you back to CARDS', async () => {
    const searchPage = mockCatalog();
    jest.spyOn(MockSpotlightRepository.prototype, 'getProfilesTopHoldings').mockResolvedValue([]);
    renderSearch('tab');

    fireEvent.press(await screen.findByTestId('search-tabs-tab-people'));
    fireEvent.changeText(screen.getByTestId('game-sets-search'), 'stephen');
    expect(await screen.findByText('Stephen Chan')).toBeTruthy();
    expect(searchUsers).toHaveBeenCalledWith('stephen');
    // The CARDS search is not run for a PEOPLE query.
    expect(searchPage).not.toHaveBeenCalledWith('stephen', expect.anything(), expect.anything(), expect.anything());

    await act(async () => {
      fireEvent.press(screen.getByTestId('search-tabs-tab-cards'));
    });
    expect(screen.getByTestId('game-sets-search').props.value).toBe('stephen');
    await waitFor(() =>
      expect(searchPage).toHaveBeenCalledWith('stephen', expect.any(Number), 0, expect.objectContaining({ game: 'pokemon' })),
    );
  });
});
