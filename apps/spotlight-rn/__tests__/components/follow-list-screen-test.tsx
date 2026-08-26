import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';

import type { UserProfile } from '@/features/auth/auth-models';
import { fetchFollowers, fetchFollowing } from '@/features/profile/profile-service';
import { FollowListScreen } from '@/features/profile/screens/follow-list-screen';

import { renderWithProviders } from '../test-utils';

jest.mock('expo-router', () => ({
  useRouter: jest.fn(),
}));

jest.mock('@/features/profile/profile-service', () => ({
  fetchFollowers: jest.fn(),
  fetchFollowing: jest.fn(),
}));

function buildProfile(overrides: Partial<UserProfile> & Pick<UserProfile, 'userID'>): UserProfile {
  return {
    displayName: `Collector ${overrides.userID}`,
    avatarURL: null,
    labelerEnabled: false,
    adminEnabled: false,
    handle: null,
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

const push = jest.fn();

describe('FollowListScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (useRouter as jest.Mock).mockReturnValue({ push, back: jest.fn() });
  });

  it('loads followers and renders a row per profile', async () => {
    (fetchFollowers as jest.Mock).mockResolvedValue([
      buildProfile({ userID: 'u-1', displayName: 'Ash', handle: 'ash' }),
      buildProfile({ userID: 'u-2', displayName: 'Misty', handle: 'misty' }),
    ]);

    renderWithProviders(<FollowListScreen mode="followers" userID="owner" />);

    await waitFor(() => {
      expect(screen.getByText('Ash')).toBeTruthy();
    });
    expect(fetchFollowers).toHaveBeenCalledWith('owner');
    expect(fetchFollowing).not.toHaveBeenCalled();
    expect(screen.getByText('@ash')).toBeTruthy();
    expect(screen.getByText('Misty')).toBeTruthy();
    expect(screen.getByText('@misty')).toBeTruthy();
  });

  /*
    Figma 4279:92461 draws this as a nav toolbar: the back button and the
    centered title share ONE row (title stays centered whether or not a back
    button is present), unlike Search Cards' stacked display header.
  */
  it('centers the title beside the back button in one toolbar row', async () => {
    (fetchFollowers as jest.Mock).mockResolvedValue([]);

    renderWithProviders(<FollowListScreen mode="followers" onBack={jest.fn()} userID="owner" />);

    await screen.findByText('Followers');
    expect(
      StyleSheet.flatten(screen.getByTestId('follow-list-toolbar').props.style),
    ).toMatchObject({ alignItems: 'center', justifyContent: 'center' });
    expect(screen.getByTestId('follow-list-back')).toBeTruthy();
  });

  it('reads the following graph in following mode', async () => {
    (fetchFollowing as jest.Mock).mockResolvedValue([
      buildProfile({ userID: 'u-3', displayName: 'Brock', handle: 'brock' }),
    ]);

    renderWithProviders(<FollowListScreen mode="following" userID="owner" />);

    await waitFor(() => {
      expect(screen.getByText('Brock')).toBeTruthy();
    });
    expect(fetchFollowing).toHaveBeenCalledWith('owner');
    expect(fetchFollowers).not.toHaveBeenCalled();
  });

  it('routes to /u/<handle> with an explicit userId when a row is tapped', async () => {
    (fetchFollowers as jest.Mock).mockResolvedValue([
      buildProfile({ userID: 'u-1', displayName: 'Ash', handle: 'ash' }),
    ]);

    renderWithProviders(<FollowListScreen mode="followers" userID="owner" />);

    await waitFor(() => {
      expect(screen.getByTestId('follow-list-row-u-1')).toBeTruthy();
    });

    fireEvent.press(screen.getByTestId('follow-list-row-u-1'));

    expect(push).toHaveBeenCalledWith({
      pathname: '/u/[handle]',
      params: { handle: 'ash', userId: 'u-1' },
    });
  });

  it('routes by user id when the tapped profile has no handle', async () => {
    (fetchFollowers as jest.Mock).mockResolvedValue([
      buildProfile({ userID: 'u-9', displayName: 'Handleless', handle: null }),
    ]);

    renderWithProviders(<FollowListScreen mode="followers" userID="owner" />);

    await waitFor(() => {
      expect(screen.getByTestId('follow-list-row-u-9')).toBeTruthy();
    });

    fireEvent.press(screen.getByTestId('follow-list-row-u-9'));

    expect(push).toHaveBeenCalledWith({
      pathname: '/u/[handle]',
      params: { handle: 'u-9', userId: 'u-9' },
    });
  });

  it('shows an empty state when nobody follows this user', async () => {
    (fetchFollowers as jest.Mock).mockResolvedValue([]);

    renderWithProviders(<FollowListScreen mode="followers" userID="owner" />);

    await waitFor(() => {
      expect(screen.getByTestId('follow-list-empty')).toBeTruthy();
    });
    expect(screen.getByText('No followers yet.')).toBeTruthy();
  });

  it('shows a loading state before the list resolves', () => {
    (fetchFollowers as jest.Mock).mockReturnValue(new Promise(() => {}));

    renderWithProviders(<FollowListScreen mode="followers" userID="owner" />);

    expect(screen.getByTestId('follow-list-loading')).toBeTruthy();
  });
});
