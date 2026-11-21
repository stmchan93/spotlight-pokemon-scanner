/**
 * Guest gating outside Events: a public profile's Follow / Message, the comment
 * thread's send and like, and the write-only routes a guest can deep-link into.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { PropsWithChildren } from 'react';
import { Text } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { SpotlightThemeProvider } from '@spotlight/design-system';

import type { UserProfile } from '@/features/auth/auth-models';
import { GuestRouteGuard } from '@/features/auth/components/guest-route-guard';
import { fetchProfileByHandle, followUser, isFollowing } from '@/features/profile/profile-service';
import { PublicProfileScreen } from '@/features/profile/screens/public-profile-screen';
import { CommentsSheet } from '@/features/social/components/comments-sheet';
import { findOrCreateDm } from '@/features/social/dm-service';
import { addComment, fetchComments, likeComment, type PostComment } from '@/features/social/social-service';

import { createTestSpotlightRepository, renderWithProviders } from '../../test-utils';

const mockPush = jest.fn();
const mockRedirect = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, back: jest.fn(), replace: jest.fn(), navigate: jest.fn() }),
  Redirect: ({ href }: { href: string }) => {
    mockRedirect(href);
    return null;
  },
}));

let mockIsGuest = true;
jest.mock('@/providers/auth-provider', () => ({
  useAuth: () => ({
    accessToken: null,
    applyFollowingDelta: jest.fn(),
    currentUser: { id: 'guest-anon' },
    ensureGuestSession: jest.fn(),
    isGuest: mockIsGuest,
  }),
}));

jest.mock('@/features/social/dm-service', () => ({ findOrCreateDm: jest.fn(async () => 'conv-1') }));

jest.mock('@/features/profile/profile-service', () => ({
  fetchProfileByHandle: jest.fn(),
  fetchProfileById: jest.fn(async () => null),
  isFollowing: jest.fn(async () => false),
  followUser: jest.fn(async () => true),
  unfollowUser: jest.fn(async () => true),
}));

jest.mock('@/features/social/social-service', () => ({
  fetchAuthorActivity: jest.fn(async () => []),
  fetchRepostedPostIds: jest.fn(async () => new Set()),
  fetchLikedPostIds: jest.fn(async () => new Set()),
  fetchComments: jest.fn(async () => []),
  fetchLikedCommentIds: jest.fn(async () => new Set()),
  addComment: jest.fn(async () => ({ ok: true })),
  likeComment: jest.fn(async () => true),
  unlikeComment: jest.fn(async () => true),
  deleteComment: jest.fn(async () => true),
}));

const profile: UserProfile = {
  userID: 'user-1',
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
  followerCount: 12,
  followingCount: 34,
  postCount: 0,
} as UserProfile;

function Wrapper({ children }: PropsWithChildren) {
  return (
    <SafeAreaProvider
      initialMetrics={{ frame: { height: 852, width: 393, x: 0, y: 0 }, insets: { top: 59, right: 0, bottom: 34, left: 0 } }}
    >
      <SpotlightThemeProvider>{children}</SpotlightThemeProvider>
    </SafeAreaProvider>
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockIsGuest = true;
  jest.mocked(fetchProfileByHandle).mockResolvedValue(profile);
});

describe('public profile, as a guest', () => {
  it('Follow and Message open login and write nothing', async () => {
    renderWithProviders(<PublicProfileScreen handle="ash" />, {
      spotlightRepository: createTestSpotlightRepository({
        getProfileDeckEntries: async () => [],
        getProfilePortfolioSummary: async () => ({ userId: 'user-1', totalValue: 0, cardCount: 0, currency: 'USD' }),
      }),
    });
    await waitFor(() => expect(screen.getByTestId('public-profile-follow-button')).toBeTruthy());
    await waitFor(() => expect(isFollowing).toHaveBeenCalled());

    fireEvent.press(screen.getByTestId('public-profile-follow-button'));
    expect(mockPush).toHaveBeenCalledWith('/login');
    expect(followUser).not.toHaveBeenCalled();
    expect(screen.getByText('12')).toBeTruthy();

    mockPush.mockClear();
    await act(async () => fireEvent.press(screen.getByTestId('public-profile-message-button')));
    expect(mockPush).toHaveBeenCalledWith('/login');
    expect(findOrCreateDm).not.toHaveBeenCalled();
  });
});

describe('comment thread, as a guest', () => {
  it('send closes the sheet and opens login without writing', async () => {
    const onClose = jest.fn();
    render(<CommentsSheet onClose={onClose} postId="post-1" testID="comments-sheet" visible />, { wrapper: Wrapper });
    await screen.findByTestId('comments-sheet-empty');

    fireEvent.changeText(screen.getByTestId('comments-sheet-input'), 'Guest comment');
    fireEvent.press(screen.getByTestId('comments-sheet-send'));

    expect(addComment).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
    expect(mockPush).toHaveBeenCalledWith('/login');
  });

  it('liking a comment opens login without writing', async () => {
    jest.mocked(fetchComments).mockResolvedValue([
      {
        id: 'c1',
        postId: 'post-1',
        authorId: 'a1',
        author: { displayName: 'Misty', handle: 'misty', avatarUrl: null, isVerified: false },
        body: 'Great card!',
        parentCommentId: null,
        likeCount: 0,
        createdAt: '2026-05-01T00:00:00.000Z',
      } as PostComment,
    ]);
    render(<CommentsSheet onClose={jest.fn()} postId="post-1" testID="comments-sheet" visible />, { wrapper: Wrapper });
    await screen.findByText('Great card!');
    fireEvent.press(screen.getByTestId('comments-sheet-comment-c1-like'));
    expect(likeComment).not.toHaveBeenCalled();
    expect(mockPush).toHaveBeenCalledWith('/login');
  });
});

describe('GuestRouteGuard', () => {
  it('sends a guest to login in place of the route', () => {
    render(
      <GuestRouteGuard>
        <Text>compose</Text>
      </GuestRouteGuard>,
    );
    expect(mockRedirect).toHaveBeenCalledWith('/login');
    expect(screen.queryByText('compose')).toBeNull();
  });

  it('renders the route for a signed-in user', () => {
    mockIsGuest = false;
    render(
      <GuestRouteGuard>
        <Text>compose</Text>
      </GuestRouteGuard>,
    );
    expect(mockRedirect).not.toHaveBeenCalled();
    expect(screen.getByText('compose')).toBeTruthy();
  });
});
