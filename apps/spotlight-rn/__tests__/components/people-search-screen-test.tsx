import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { useNavigation, useRouter } from 'expo-router';

import { fetchSuggestedUsers, rankSearchMatches, searchUsers } from '@/features/profile/profile-service';
import { PeopleSearchScreen } from '@/features/profile/screens/people-search-screen';

import { renderWithProviders } from '../test-utils';

jest.mock('expo-router', () => ({
  useNavigation: jest.fn(),
  useRouter: jest.fn(),
}));

jest.mock('@/features/profile/profile-service', () => ({
  ...jest.requireActual('@/features/profile/profile-service'),
  fetchSuggestedUsers: jest.fn(),
  searchUsers: jest.fn(),
}));

function person(userID: string, displayName: string, handle: string | null) {
  return {
    userID,
    displayName,
    handle,
    avatarURL: null,
    labelerEnabled: false,
    adminEnabled: false,
  } as never;
}

describe('rankSearchMatches', () => {
  it('puts handle and name prefixes ahead of matches in the middle', () => {
    const middle = person('a', 'Vintage Vault', 'shopvault');
    const wordStart = person('b', 'Stephen Chan', 'schan');
    const prefix = person('c', 'Chansey Fan', 'chanseyfan');

    const ranked = rankSearchMatches([middle, wordStart, prefix], 'chan');

    expect(ranked.map((p: { userID: string }) => p.userID)).toEqual(['c', 'b', 'a']);
  });
});

describe('PeopleSearchScreen', () => {
  const push = jest.fn();

  beforeEach(() => {
    jest.useFakeTimers();
    (useRouter as jest.Mock).mockReturnValue({ back: jest.fn(), push });
    (useNavigation as jest.Mock).mockReturnValue({ addListener: jest.fn(() => () => undefined) });
    (fetchSuggestedUsers as jest.Mock).mockResolvedValue([person('pop-1', 'Poke Sean', 'pokesean')]);
    (searchUsers as jest.Mock).mockResolvedValue([person('hit-1', 'Stephen Chan', 'schan')]);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  it('lists popular collectors before anything is typed', async () => {
    renderWithProviders(<PeopleSearchScreen />);

    expect(await screen.findByText('Popular collectors')).toBeTruthy();
    expect(screen.getByText('Poke Sean')).toBeTruthy();
  });

  it('swaps the suggestions for search results once a query is typed', async () => {
    renderWithProviders(<PeopleSearchScreen />);
    await screen.findByText('Popular collectors');

    fireEvent.changeText(screen.getByPlaceholderText('Search collectors'), 'chan');
    await act(async () => {
      jest.advanceTimersByTime(300);
    });

    await waitFor(() => expect(screen.getByText('Stephen Chan')).toBeTruthy());
    expect(searchUsers).toHaveBeenCalledWith('chan');
    expect(screen.queryByText('Popular collectors')).toBeNull();
    expect(screen.queryByText('Poke Sean')).toBeNull();
  });
});
