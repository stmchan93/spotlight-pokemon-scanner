import { act, fireEvent, screen, waitFor, within } from '@testing-library/react-native';

import { MockSpotlightRepository, type CardGame, type ExpansionRecord } from '@spotlight/api-client';

import { ExpansionBrowserScreen } from '@/features/catalog/screens/expansion-browser-screen';
import { fetchFollowers, fetchFollowing, fetchSuggestedUsers, searchUsers } from '@/features/profile/profile-service';
import { fetchUnreadNotificationCount } from '@/features/social/social-service';
import * as authProvider from '@/providers/auth-provider';

import { renderWithProviders } from '../test-utils';

/**
 * Search as a tab / sheet (Figma 6725:9509): a white header with the Chat pill
 * and bell (tab) or close (sheet), CARDS | PEOPLE tabs each searching only its
 * own kind, a filter sheet with the shared Sealed / rarity model, PEOPLE's
 * ALL / FOLLOWERS / FOLLOWING chips, and PEOPLE cards carrying each collector's
 * most valuable holdings from ONE batched read.
 */

const mockPush = jest.fn();
jest.mock('expo-router', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  return {
    useFocusEffect: (effect: () => void | (() => void)) => {
      React.useEffect(() => effect(), [effect]);
    },
    useGlobalSearchParams: () => ({}),
    usePathname: () => '/search',
    useRouter: () => ({ back: jest.fn(), canGoBack: jest.fn(() => false), push: mockPush, replace: jest.fn() }),
  };
});

jest.mock('@/features/profile/profile-service', () => ({
  ...jest.requireActual('@/features/profile/profile-service'),
  fetchFollowers: jest.fn(),
  fetchFollowing: jest.fn(),
  fetchSuggestedUsers: jest.fn(),
  searchUsers: jest.fn(),
}));

jest.mock('@/features/social/social-service', () => ({
  ...jest.requireActual('@/features/social/social-service'),
  fetchUnreadNotificationCount: jest.fn(),
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
    (fetchFollowers as jest.Mock).mockResolvedValue([
      person('44444444-4444-4444-8444-444444444444', 'Misty Waters'),
      person('55555555-5555-4555-8555-555555555555', 'Brock Rocks'),
    ]);
    (fetchFollowing as jest.Mock).mockResolvedValue([person('66666666-6666-4666-8666-666666666666', 'Gary Oak')]);
    (fetchUnreadNotificationCount as jest.Mock).mockResolvedValue(0);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  it('tab mode has the Chat pill and the bell, no close; the sheet keeps its close and no bell', async () => {
    mockCatalog();
    renderSearch('tab');
    expect(await screen.findByTestId('search-tabs')).toBeTruthy();
    expect(screen.getByTestId('game-sets-chat-pill')).toBeTruthy();
    expect(screen.getByTestId('game-sets-notifications')).toBeTruthy();
    expect(screen.queryByTestId('game-sets-back')).toBeNull();
    // White header: no banner, no big game title.
    expect(screen.queryByTestId('game-sets-banner')).toBeNull();
    expect(screen.queryByText('Pokémon')).toBeNull();
    fireEvent.press(screen.getByTestId('game-sets-notifications'));
    expect(mockPush).toHaveBeenCalledWith('/notifications');
    screen.unmount();

    mockCatalog();
    const { onClose } = renderSearch('sheet');
    fireEvent.press(await screen.findByTestId('game-sets-back'));
    expect(onClose).toHaveBeenCalled();
    expect(screen.getByLabelText('Close')).toBeTruthy();
    expect(screen.queryByTestId('game-sets-chat-pill')).toBeNull();
    expect(screen.queryByTestId('game-sets-notifications')).toBeNull();
  });

  it('the bell carries the unread badge', async () => {
    mockCatalog();
    (fetchUnreadNotificationCount as jest.Mock).mockResolvedValue(3);
    renderSearch('tab');
    expect(await screen.findByTestId('game-sets-notifications-badge')).toBeTruthy();
    expect(screen.getByText('3')).toBeTruthy();
    expect(screen.getByLabelText('Notifications, 3 unread')).toBeTruthy();
  });

  it('Figma 6711:4679: CARDS | COLLECTORS | EVENTS, a full-width field, and ALL leading the game chips', async () => {
    mockCatalog();
    renderSearch('tab');

    expect(await screen.findByTestId('game-sets-game-chips')).toBeTruthy();
    expect(screen.getByPlaceholderText('SEARCH BY CARDS, SETS, PEOPLE')).toBeTruthy();
    // No filter button beside the field.
    expect(screen.queryByTestId('game-sets-filter')).toBeNull();
    // ALL is selected on open, ahead of the games.
    expect(screen.getByTestId('game-sets-game-all').props.accessibilityState).toEqual(
      expect.objectContaining({ selected: true }),
    );
    expect(screen.getByText('COLLECTORS')).toBeTruthy();
    expect(screen.getByText('EVENTS')).toBeTruthy();

    fireEvent.press(screen.getByTestId('search-tabs-tab-people'));
    expect(await screen.findByPlaceholderText('SEARCH BY NAME, PROFILE')).toBeTruthy();
  });

  it('ALL searches every game; a game chip scopes the search to it', async () => {
    const searchPage = mockCatalog();
    renderSearch('tab');

    fireEvent.changeText(await screen.findByTestId('game-sets-search'), 'gengar');
    await waitFor(() =>
      expect(searchPage).toHaveBeenCalledWith('gengar', expect.any(Number), 0, expect.objectContaining({ game: 'all' })),
    );
    fireEvent.press(screen.getByTestId('game-sets-game-pokemon'));
    await waitFor(() =>
      expect(searchPage).toHaveBeenCalledWith('gengar', expect.any(Number), 0, expect.objectContaining({ game: 'pokemon' })),
    );
  });

  // Owner, 2026-11-24: VIEW ALL on SETS / SEALED works with ALL selected too.
  it('VIEW ALL on SETS opens every game\'s sets while ALL is selected', async () => {
    mockCatalog();
    const onViewAll = jest.fn();
    renderSearch('tab', { onViewAll });

    fireEvent.press(await screen.findByTestId('game-sets-sets-header-view-all'));
    expect(onViewAll).toHaveBeenCalledWith('sets', 'all');

    fireEvent.press(screen.getByTestId('game-sets-game-pokemon'));
    fireEvent.press(await screen.findByTestId('game-sets-sets-header-view-all'));
    expect(onViewAll).toHaveBeenLastCalledWith('sets', 'pokemon');
  });

  // Owner, 2026-11-24: a CARDS search also finds collectors and sets, above the cards.
  it('a CARDS search shows matching COLLECTORS and SETS; COLLECTORS VIEW ALL opens that tab', async () => {
    mockCatalog();
    (searchUsers as jest.Mock).mockResolvedValue([person('33333333-3333-4333-8333-333333333333', 'Surge Collector')]);
    const handlers = renderSearch('tab');

    fireEvent.changeText(await screen.findByTestId('game-sets-search'), 'surging');

    expect(await screen.findByTestId('game-sets-mixed-sets-header')).toBeTruthy();
    // The mock lists the same set for every game, so ALL shows it once per game.
    expect(within(screen.getByTestId('game-sets-mixed')).getAllByTestId('game-sets-expansion-sv8').length).toBeGreaterThan(0);
    const person33 = await screen.findByTestId('game-sets-mixed-person-33333333-3333-4333-8333-333333333333');
    expect(searchUsers).toHaveBeenCalledWith('surging');

    fireEvent.press(person33);
    expect(handlers.onOpenProfile).toHaveBeenCalledWith(expect.objectContaining({ displayName: 'Surge Collector' }));

    jest.spyOn(MockSpotlightRepository.prototype, 'getProfilesTopHoldings').mockResolvedValue([]);
    await act(async () => {
      fireEvent.press(screen.getByTestId('game-sets-mixed-people-header-view-all'));
    });
    expect(screen.getByTestId('game-sets-search').props.value).toBe('surging');
    expect(await screen.findByTestId('search-people')).toBeTruthy();
  });

  it('EVENTS swaps the field for the events list', async () => {
    mockCatalog();
    renderSearch('tab');

    fireEvent.press(await screen.findByTestId('search-tabs-tab-events'));
    expect(screen.queryByTestId('game-sets-search')).toBeNull();
    expect(screen.getByTestId('search-events')).toBeTruthy();
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
      expect(searchPage).toHaveBeenCalledWith('stephen', expect.any(Number), 0, expect.objectContaining({ game: 'all' })),
    );
  });

  it('PEOPLE: ALL / FOLLOWERS / FOLLOWING chips; FOLLOWERS lists the viewer\'s followers filtered by the query', async () => {
    mockCatalog();
    jest.spyOn(MockSpotlightRepository.prototype, 'getProfilesTopHoldings').mockResolvedValue([]);
    renderSearch('tab');

    fireEvent.press(await screen.findByTestId('search-tabs-tab-people'));
    expect(screen.getByPlaceholderText('SEARCH BY NAME, PROFILE')).toBeTruthy();
    expect(screen.getByTestId('search-people-relation-all').props.accessibilityState).toMatchObject({ selected: true });
    expect(await screen.findByText('Wabi Sabi')).toBeTruthy();
    expect(fetchFollowers).not.toHaveBeenCalled();

    fireEvent.press(screen.getByTestId('search-people-relation-followers'));
    expect(await screen.findByText('Misty Waters')).toBeTruthy();
    expect(fetchFollowers).toHaveBeenCalledWith('00000000-0000-0000-0000-000000000001');
    expect(screen.getByText('Brock Rocks')).toBeTruthy();
    expect(screen.queryByText('Wabi Sabi')).toBeNull();
    expect(screen.getByTestId('search-people-relation-followers').props.accessibilityState).toMatchObject({ selected: true });

    // Narrowed on device: no server search for a follow list.
    fireEvent.changeText(screen.getByTestId('game-sets-search'), 'MIST');
    await waitFor(() => expect(screen.queryByText('Brock Rocks')).not.toBeOnTheScreen());
    expect(screen.getByText('Misty Waters')).toBeTruthy();
    expect(searchUsers).not.toHaveBeenCalled();

    fireEvent.press(screen.getByTestId('search-people-relation-following'));
    fireEvent.changeText(screen.getByTestId('game-sets-search'), '');
    expect(await screen.findByText('Gary Oak')).toBeTruthy();
    expect(fetchFollowing).toHaveBeenCalledWith('00000000-0000-0000-0000-000000000001');
  });

  it('PEOPLE hides the follow chips for a guest, whose bell opens sign-in', async () => {
    mockCatalog();
    const realUseAuth = authProvider.useAuth;
    jest.spyOn(authProvider, 'useAuth').mockImplementation(() => ({ ...realUseAuth(), currentUser: null, isGuest: true }));
    renderSearch('tab');

    fireEvent.press(await screen.findByTestId('search-tabs-tab-people'));
    expect(await screen.findByText('Wabi Sabi')).toBeTruthy();
    expect(screen.queryByTestId('search-people-relations')).toBeNull();
    expect(fetchFollowers).not.toHaveBeenCalled();

    // A guest's bell opens sign-in, never the notifications list.
    fireEvent.press(screen.getByTestId('game-sets-notifications'));
    expect(mockPush).toHaveBeenCalledTimes(1);
    expect(mockPush).not.toHaveBeenCalledWith('/notifications');
  });
});
