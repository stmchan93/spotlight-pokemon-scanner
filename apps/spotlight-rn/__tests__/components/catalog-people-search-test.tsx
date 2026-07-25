import { act, fireEvent, screen } from '@testing-library/react-native';

import { MockSpotlightRepository } from '@spotlight/api-client';

import type { UserProfile } from '@/features/auth/auth-models';
import { CatalogSearchScreen } from '@/features/catalog/screens/catalog-search-screen';
import { searchUsers } from '@/features/profile/profile-service';

import { renderWithProviders } from '../test-utils';

// The People lane's only dependency is the profile-service data layer; mock it so
// the tests drive it directly and never touch Supabase.
jest.mock('@/features/profile/profile-service', () => ({
  searchUsers: jest.fn(),
}));

const mockSearchUsers = searchUsers as jest.MockedFunction<typeof searchUsers>;

function buildProfile(
  overrides: Partial<UserProfile> & Pick<UserProfile, 'userID'>,
): UserProfile {
  return {
    displayName: 'Ash Ketchum',
    avatarURL: null,
    labelerEnabled: false,
    adminEnabled: false,
    handle: 'ash',
    bio: null,
    location: null,
    socialLink: null,
    isVerified: false,
    reputation: 0,
    followerCount: 0,
    followingCount: 0,
    postCount: 0,
    ...overrides,
  };
}

async function advanceDebounce() {
  await act(async () => {
    jest.advanceTimersByTime(300);
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('CatalogSearchScreen — People discovery', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockSearchUsers.mockReset();
    // Typing also fires the card lane; keep it inert so it can't interfere.
    jest.spyOn(MockSpotlightRepository.prototype, 'searchCatalogCardsPage')
      .mockResolvedValue({ cards: [], hasMore: false });
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('surfaces people results when the People tab is selected for a query', async () => {
    mockSearchUsers.mockResolvedValue([
      buildProfile({ userID: 'user-1', displayName: 'Ash Ketchum', handle: 'ash', isVerified: true }),
      buildProfile({ userID: 'user-2', displayName: 'Misty', handle: 'misty' }),
    ]);

    renderWithProviders(
      <CatalogSearchScreen
        onClose={jest.fn()}
        onOpenCard={jest.fn()}
        onOpenPerson={jest.fn()}
      />,
    );

    // No query yet → no People segment.
    expect(screen.queryByTestId('catalog-search-tabs')).toBeNull();

    fireEvent.changeText(screen.getByPlaceholderText('Search by name, set, or number'), 'ash');
    await advanceDebounce();

    // The segment appears once there's a text query; switch to People.
    fireEvent.press(screen.getByTestId('catalog-search-tabs-people'));
    await advanceDebounce();

    expect(mockSearchUsers).toHaveBeenCalledWith('ash');
    expect(await screen.findByTestId('people-result-user-1')).toBeTruthy();
    expect(screen.getByTestId('people-result-user-2')).toBeTruthy();
    // Ash is verified; Misty is not.
    expect(screen.getByTestId('people-verified-user-1')).toBeTruthy();
    expect(screen.queryByTestId('people-verified-user-2')).toBeNull();
    expect(screen.getByText('@ash')).toBeTruthy();
  });

  it('routes to a profile when a person row is tapped', async () => {
    const onOpenPerson = jest.fn();
    mockSearchUsers.mockResolvedValue([
      buildProfile({ userID: 'user-1', displayName: 'Ash Ketchum', handle: 'ash' }),
    ]);

    renderWithProviders(
      <CatalogSearchScreen
        onClose={jest.fn()}
        onOpenCard={jest.fn()}
        onOpenPerson={onOpenPerson}
      />,
    );

    fireEvent.changeText(screen.getByPlaceholderText('Search by name, set, or number'), 'ash');
    await advanceDebounce();
    fireEvent.press(screen.getByTestId('catalog-search-tabs-people'));
    await advanceDebounce();

    fireEvent.press(await screen.findByTestId('people-result-user-1'));
    expect(onOpenPerson).toHaveBeenCalledWith(
      expect.objectContaining({ userID: 'user-1', handle: 'ash' }),
    );
  });

  it('shows no People segment or results for a blank query', async () => {
    mockSearchUsers.mockResolvedValue([buildProfile({ userID: 'user-1' })]);

    renderWithProviders(
      <CatalogSearchScreen
        onClose={jest.fn()}
        onOpenCard={jest.fn()}
        onOpenPerson={jest.fn()}
      />,
    );

    await advanceDebounce();

    expect(screen.queryByTestId('catalog-search-tabs')).toBeNull();
    expect(screen.queryByTestId('people-results-list')).toBeNull();
    expect(mockSearchUsers).not.toHaveBeenCalled();
  });

  it('drops a stale people response so it cannot overwrite a newer query', async () => {
    let resolveFirst: ((users: UserProfile[]) => void) | null = null;
    mockSearchUsers
      .mockImplementationOnce(
        () => new Promise<UserProfile[]>((resolve) => {
          resolveFirst = resolve;
        }),
      )
      .mockResolvedValueOnce([buildProfile({ userID: 'user-new', displayName: 'Newer', handle: 'newer' })]);

    renderWithProviders(
      <CatalogSearchScreen
        onClose={jest.fn()}
        onOpenCard={jest.fn()}
        onOpenPerson={jest.fn()}
      />,
    );

    fireEvent.changeText(screen.getByPlaceholderText('Search by name, set, or number'), 'ash');
    await advanceDebounce();
    fireEvent.press(screen.getByTestId('catalog-search-tabs-people'));
    await advanceDebounce();

    // Second query issued before the first resolves.
    fireEvent.changeText(screen.getByPlaceholderText('Search by name, set, or number'), 'ashe');
    await advanceDebounce();

    // The slow first response arrives late; it must be discarded.
    await act(async () => {
      resolveFirst?.([buildProfile({ userID: 'user-stale', displayName: 'Stale', handle: 'stale' })]);
      await Promise.resolve();
    });

    expect(await screen.findByTestId('people-result-user-new')).toBeTruthy();
    expect(screen.queryByTestId('people-result-user-stale')).toBeNull();
  });
});
