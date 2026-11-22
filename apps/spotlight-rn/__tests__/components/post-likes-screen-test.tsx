import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { useRouter } from 'expo-router';


import type { UserProfile } from '@/features/auth/auth-models';
import { fetchPostLikers } from '@/features/profile/profile-service';
import { PostMetricsRow } from '@/features/social/components/post-metrics-row';
import { PostLikesScreen } from '@/features/social/screens/post-likes-screen';

import { renderWithProviders } from '../test-utils';

jest.mock('expo-router', () => ({ useRouter: jest.fn() }));
jest.mock('@/features/profile/profile-service', () => ({ fetchPostLikers: jest.fn() }));

function profile(userID: string, displayName: string, handle: string | null): UserProfile {
  return {
    userID, displayName, handle, avatarURL: null, labelerEnabled: false, adminEnabled: false, bio: null,
    location: null, socialLink: null, isVerified: false, reputation: 0, followerCount: 0, followingCount: 0,
    postCount: 0,
  };
}

const push = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  (useRouter as jest.Mock).mockReturnValue({ push, back: jest.fn() });
});

describe('PostLikesScreen', () => {
  it('lists who liked the post with a count title, and opens a profile', async () => {
    (fetchPostLikers as jest.Mock).mockResolvedValue([profile('u-1', 'Ash', 'ash'), profile('u-2', 'Misty', null)]);
    renderWithProviders(<PostLikesScreen postId="p-1" />);
    await waitFor(() => expect(screen.getByText('Ash')).toBeTruthy());
    expect(fetchPostLikers).toHaveBeenCalledWith('p-1');
    expect(screen.getByText('2 Likes')).toBeTruthy();
    fireEvent.press(screen.getByTestId('post-likes-row-u-2'));
    expect(push).toHaveBeenCalledWith({ pathname: '/u/[handle]', params: { handle: 'u-2', userId: 'u-2' } });
  });

  it('shows an empty state with no likes', async () => {
    (fetchPostLikers as jest.Mock).mockResolvedValue([]);
    renderWithProviders(<PostLikesScreen postId="p-1" />);
    expect(await screen.findByTestId('post-likes-empty')).toBeTruthy();
  });
});

describe('PostMetricsRow like count', () => {
  const base = {
    liked: false, likeCount: 3, commentCount: 0, reposted: false, repostCount: 0,
    onOpenComments: jest.fn(), onToggleRepost: jest.fn(), onShare: jest.fn(), testID: 'post',
  };

  it('icon likes, count opens Liked by', () => {
    const onToggleLike = jest.fn();
    const onOpenLikes = jest.fn();
    renderWithProviders(<PostMetricsRow {...base} onOpenLikes={onOpenLikes} onToggleLike={onToggleLike} />);
    fireEvent.press(screen.getByTestId('post-like-count-button'));
    expect(onOpenLikes).toHaveBeenCalled();
    expect(onToggleLike).not.toHaveBeenCalled();
    fireEvent.press(screen.getByTestId('post-like-button'));
    expect(onToggleLike).toHaveBeenCalled();
  });

  it('without onOpenLikes the whole control likes (zero likes)', () => {
    const onToggleLike = jest.fn();
    renderWithProviders(<PostMetricsRow {...base} likeCount={0} onToggleLike={onToggleLike} />);
    expect(screen.queryByTestId('post-like-count-button')).toBeNull();
    fireEvent.press(screen.getByTestId('post-like-button'));
    expect(onToggleLike).toHaveBeenCalled();
  });
});
