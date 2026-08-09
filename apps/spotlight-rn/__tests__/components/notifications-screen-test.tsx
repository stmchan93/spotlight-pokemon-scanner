import { screen, waitFor } from '@testing-library/react-native';
import { useRouter } from 'expo-router';

import { NotificationsScreen } from '@/features/social/screens/notifications-screen';
import {
  fetchNotifications,
  markAllNotificationsRead,
  type AppNotification,
} from '@/features/social/social-service';

import { renderWithProviders } from '../test-utils';

jest.mock('expo-router', () => ({
  useRouter: jest.fn(),
}));

jest.mock('@/features/social/social-service', () => ({
  fetchNotifications: jest.fn(async () => []),
  markAllNotificationsRead: jest.fn(async () => true),
}));

// Post images come from the AUTHENTICATED backend proxy, so the row only draws a
// thumbnail when there is both a base URL and a bearer token. The test-bypass
// auth provider has no session, so supply one — otherwise the thumbnail and the
// @mention (which needs your own handle) are untestable.
jest.mock('@/providers/auth-provider', () => ({
  ...jest.requireActual('@/providers/auth-provider'),
  useAuth: () => ({
    accessToken: 'test-token',
    currentUser: { id: 'me', handle: 'schan93_' },
  }),
}));

jest.mock('@/providers/app-providers', () => ({
  ...jest.requireActual('@/providers/app-providers'),
  resolveRepositoryBaseUrl: () => 'https://staging.example.com',
}));

function buildNotification(overrides: Partial<AppNotification> & { id: string }): AppNotification {
  return {
    type: 'comment',
    actor: {
      displayName: 'sarahkim_',
      handle: 'sarahkim_',
      avatarUrl: null,
      isVerified: false,
    },
    postId: 'post-1',
    commentId: 'comment-1',
    createdAt: '2026-08-01T00:00:00.000Z',
    readAt: null,
    commentBody: 'ur down to go to Florida??',
    isReply: true,
    postAuthor: {
      displayName: 'Metamorphosis',
      handle: 'metamorphosis_amp',
      avatarUrl: null,
      isVerified: false,
    },
    postMediaId: 'media-1',
    ...overrides,
  };
}

describe('NotificationsScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (useRouter as jest.Mock).mockReturnValue({ push: jest.fn(), back: jest.fn() });
    (markAllNotificationsRead as jest.Mock).mockResolvedValue(true);
  });

  // The shape from the reference design: who, what they did, WHERE it happened,
  // the words themselves, and the post it landed on.
  it('reads as a sentence: who replied, on whose post, and what they said', async () => {
    (fetchNotifications as jest.Mock).mockResolvedValue([buildNotification({ id: 'n-1' })]);

    renderWithProviders(<NotificationsScreen />);

    await waitFor(() => expect(screen.getByTestId('notifications-row-n-1')).toBeTruthy());

    // "…on metamorphosis_amp's post:" — a reply arrives on someone else's post
    // as often as your own, and the row used to say only "replied to you".
    expect(
      screen.getByText("replied to your comment on metamorphosis_amp's post:"),
    ).toBeTruthy();
    // The comment itself, so the list answers "do I need to reply?" on its own,
    // addressed to you the way the thread addresses a reply.
    // The row's body composes a blue @you in front of the comment, so match the
    // whole line rather than either fragment.
    expect(screen.getByTestId('notifications-row-n-1-body')).toBeTruthy();
    expect(screen.getByText('@schan93_ ur down to go to Florida??')).toBeTruthy();
    expect(screen.getByTestId('notifications-row-n-1-thumbnail')).toBeTruthy();
  });

  it('names people by handle, falling back to display name only when there is none', async () => {
    (fetchNotifications as jest.Mock).mockResolvedValue([
      buildNotification({
        id: 'n-handle',
        // Both have a display name; only the actor has a handle. The handle wins
        // for them, the display name is all that is left for the other.
        actor: { displayName: 'Sarah Kim', handle: 'sarahkim_', avatarUrl: null, isVerified: false },
        postAuthor: { displayName: 'Metamorphosis', handle: null, avatarUrl: null, isVerified: false },
      }),
    ]);

    renderWithProviders(<NotificationsScreen />);

    await waitFor(() => expect(screen.getByTestId('notifications-row-n-handle')).toBeTruthy());
    // Handle for the actor, display name for the handle-less post owner — and no
    // leading "@" on either: that belongs to the mention in the body, not here.
    expect(screen.getByText(/^sarahkim_/)).toBeTruthy();
    expect(screen.getByText("replied to your comment on Metamorphosis's post:")).toBeTruthy();
    expect(screen.queryByText(/@sarahkim_/)).toBeNull();
  });

  it('says "your post" rather than naming you when the post is your own', async () => {
    (fetchNotifications as jest.Mock).mockResolvedValue([
      buildNotification({ id: 'n-2', isReply: false, postAuthor: null }),
    ]);

    renderWithProviders(<NotificationsScreen />);

    await waitFor(() => expect(screen.getByTestId('notifications-row-n-2')).toBeTruthy());
    expect(screen.getByText('commented on your post:')).toBeTruthy();
  });

  it('renders a row whose context never resolved, instead of dropping the event', async () => {
    // Every hydration read is allowed to come back empty (RLS, a deleted post, a
    // deleted comment). The notification still happened, so it still renders —
    // just without the body, the thumbnail or the owner's name.
    (fetchNotifications as jest.Mock).mockResolvedValue([
      buildNotification({
        id: 'n-3',
        commentBody: null,
        postAuthor: null,
        postMediaId: null,
        isReply: false,
      }),
    ]);

    renderWithProviders(<NotificationsScreen />);

    await waitFor(() => expect(screen.getByTestId('notifications-row-n-3')).toBeTruthy());
    expect(screen.queryByTestId('notifications-row-n-3-body')).toBeNull();
    expect(screen.queryByTestId('notifications-row-n-3-thumbnail')).toBeNull();
  });

  it('leaves like and follow rows alone — they carry no comment to quote', async () => {
    (fetchNotifications as jest.Mock).mockResolvedValue([
      buildNotification({ id: 'n-4', type: 'follow', commentId: null, commentBody: null, isReply: false }),
      buildNotification({ id: 'n-5', type: 'like', commentId: null, commentBody: null, isReply: false }),
    ]);

    renderWithProviders(<NotificationsScreen />);

    await waitFor(() => expect(screen.getByTestId('notifications-row-n-4')).toBeTruthy());
    expect(screen.getByText('started following you')).toBeTruthy();
    expect(screen.getByText("liked metamorphosis_amp's post")).toBeTruthy();
    expect(screen.queryByTestId('notifications-row-n-4-body')).toBeNull();
  });
});
