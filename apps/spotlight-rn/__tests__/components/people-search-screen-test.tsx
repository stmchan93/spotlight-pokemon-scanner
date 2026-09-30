import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { useNavigation, useRouter } from 'expo-router';
import { TextInput } from 'react-native';

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

type TransitionListener = (event: { data?: { closing?: boolean } }) => void;

type FakeNavigation = {
  addListener: jest.Mock;
  emitTransitionEnd: (closing: boolean) => void;
  getParent: jest.Mock;
  getState: jest.Mock;
  isFocused: jest.Mock;
};

/** A navigation object whose `transitionEnd` listeners the test can fire. */
function fakeNavigation(routeCount: number, parent?: FakeNavigation): FakeNavigation {
  const listeners: TransitionListener[] = [];
  return {
    addListener: jest.fn((_event: string, listener: TransitionListener) => {
      listeners.push(listener);
      return () => {
        listeners.splice(listeners.indexOf(listener), 1);
      };
    }),
    emitTransitionEnd(closing: boolean) {
      [...listeners].forEach((listener) => listener({ data: { closing } }));
    },
    getParent: jest.fn(() => parent),
    getState: jest.fn(() => ({ routes: Array.from({ length: routeCount }, (_, i) => ({ key: `r${i}` })) })),
    isFocused: jest.fn(() => true),
  };
}

describe('PeopleSearchScreen', () => {
  const push = jest.fn();
  const focus = (TextInput as unknown as { prototype: { focus: jest.Mock } }).prototype.focus;

  beforeEach(() => {
    jest.useFakeTimers();
    focus.mockClear();
    (useRouter as jest.Mock).mockReturnValue({ back: jest.fn(), push });
    (useNavigation as jest.Mock).mockReturnValue(fakeNavigation(1, fakeNavigation(2)));
    (fetchSuggestedUsers as jest.Mock).mockResolvedValue({
      failed: false,
      profiles: [person('pop-1', 'Poke Sean', 'pokesean')],
    });
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

  it('shows a loading state, not a blank screen, while suggestions load', async () => {
    let resolve: (value: unknown) => void = () => undefined;
    (fetchSuggestedUsers as jest.Mock).mockReturnValue(new Promise((r) => (resolve = r)));
    renderWithProviders(<PeopleSearchScreen />);

    expect(screen.getByTestId('people-search-suggested-loading')).toBeTruthy();
    await act(async () => {
      resolve({ failed: false, profiles: [person('pop-1', 'Poke Sean', 'pokesean')] });
    });
    expect(screen.getByText('Poke Sean')).toBeTruthy();
    expect(screen.queryByTestId('people-search-suggested-loading')).toBeNull();
  });

  it('shows a search hint when there is genuinely nobody to suggest', async () => {
    (fetchSuggestedUsers as jest.Mock).mockResolvedValue({ failed: false, profiles: [] });
    renderWithProviders(<PeopleSearchScreen />);

    expect(await screen.findByTestId('people-search-suggested-empty')).toBeTruthy();
    expect(screen.queryByText('Popular collectors')).toBeNull();
  });

  it('offers a retry when suggestions fail to load', async () => {
    (fetchSuggestedUsers as jest.Mock)
      .mockResolvedValueOnce({ failed: true, profiles: [] })
      .mockResolvedValueOnce({ failed: false, profiles: [person('pop-1', 'Poke Sean', 'pokesean')] });
    renderWithProviders(<PeopleSearchScreen />);

    fireEvent.press(await screen.findByTestId('people-search-suggested-retry'));

    expect(await screen.findByText('Poke Sean')).toBeTruthy();
    expect(fetchSuggestedUsers).toHaveBeenCalledTimes(2);
  });

  it('focuses the field exactly once, after the PARENT push when it is its stack root', async () => {
    const parent = fakeNavigation(2);
    const navigation = fakeNavigation(1, parent);
    (useNavigation as jest.Mock).mockReturnValue(navigation);
    renderWithProviders(<PeopleSearchScreen />);
    await screen.findByText('Poke Sean');

    // The nested stack's own early "appear" is not what the user sees sliding.
    expect(navigation.addListener).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();

    act(() => parent.emitTransitionEnd(false));
    expect(focus).toHaveBeenCalledTimes(1);

    // Pushing a profile (closing) and coming back must not re-pop the keyboard,
    // and neither may the fallback timer.
    act(() => {
      parent.emitTransitionEnd(true);
      parent.emitTransitionEnd(false);
      jest.advanceTimersByTime(2000);
    });
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it('listens on its own navigation when pushed deeper inside the stack', async () => {
    const parent = fakeNavigation(2);
    const navigation = fakeNavigation(3, parent);
    (useNavigation as jest.Mock).mockReturnValue(navigation);
    renderWithProviders(<PeopleSearchScreen />);
    await screen.findByText('Poke Sean');

    act(() => navigation.emitTransitionEnd(false));
    expect(parent.addListener).not.toHaveBeenCalled();
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it('falls back to focusing once if no transition is ever reported', async () => {
    renderWithProviders(<PeopleSearchScreen />);
    await screen.findByText('Poke Sean');

    act(() => {
      jest.advanceTimersByTime(1000);
    });
    expect(focus).toHaveBeenCalledTimes(1);
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
