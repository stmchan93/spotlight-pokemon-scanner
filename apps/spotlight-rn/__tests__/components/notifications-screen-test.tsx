import { fireEvent, screen, waitFor } from '@testing-library/react-native';
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

    // ONE paragraph: who, what they did, whose post, the comment, the date —
    // no hard line breaks between them.
    expect(
      screen.getByText(/replied to your comment on metamorphosis_amp's post:/),
    ).toBeTruthy();
    expect(screen.getByTestId('notifications-row-n-1-body')).toBeTruthy();
    expect(screen.getByText(/ur down to go to Florida\?\?/)).toBeTruthy();
    // Addressed to you, the way the thread addresses a reply.
    expect(screen.getByText(/@schan93_/)).toBeTruthy();
    // Calendar date, inline — not a "2d" relative clock on its own line. Derived
    // rather than hardcoded: "Aug 1" in UTC is "Jul 31" in US Pacific, and the
    // point being pinned is the FORMAT, not this machine's timezone.
    const expectedDate = new Date('2026-08-01T00:00:00.000Z').toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
    });
    expect(screen.getByText(new RegExp(`${expectedDate}\\s*$`))).toBeTruthy();
    expect(screen.queryByText(/\b\d+[mhd]\b/)).toBeNull();
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
    expect(screen.getByText(/replied to your comment on Metamorphosis's post:/)).toBeTruthy();
    expect(screen.queryByText(/@sarahkim_/)).toBeNull();
  });

  it('says "your post" rather than naming you when the post is your own', async () => {
    (fetchNotifications as jest.Mock).mockResolvedValue([
      buildNotification({ id: 'n-2', isReply: false, postAuthor: null }),
    ]);

    renderWithProviders(<NotificationsScreen />);

    await waitFor(() => expect(screen.getByTestId('notifications-row-n-2')).toBeTruthy());
    expect(screen.getByText(/commented on your post:/)).toBeTruthy();
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
    expect(screen.getByText(/started following you/)).toBeTruthy();
    // A like is always about something of YOURS, so it never names an owner.
    expect(screen.getByText(/liked your post/)).toBeTruthy();
    expect(screen.queryByTestId('notifications-row-n-4-body')).toBeNull();
  });

  /*
    A repost notification has to be RENDERABLE, not just written. The DB trigger
    inserts `type: 'repost'` (social_23), but `fetchNotifications` filters on
    `RENDERABLE_NOTIFICATION_TYPES` — so widening only the `NotificationType`
    union gets the row written and then silently dropped on the way to this
    screen, which looks exactly like the trigger not firing.
  */
  it('renders a repost row and sends it to the post', async () => {
    const push = jest.fn();
    (useRouter as jest.Mock).mockReturnValue({ push, back: jest.fn() });
    (fetchNotifications as jest.Mock).mockResolvedValue([
      buildNotification({
        id: 'n-repost',
        type: 'repost',
        commentId: null,
        commentBody: null,
        isReply: false,
      }),
    ]);

    renderWithProviders(<NotificationsScreen />);

    await waitFor(() => expect(screen.getByTestId('notifications-row-n-repost')).toBeTruthy());
    // Only posts are repostable, and the trigger skips self-reposts, so this is
    // always about a post of YOURS — it never names an owner and never quotes a
    // comment.
    expect(screen.getByText(/reposted your post/)).toBeTruthy();
    expect(screen.queryByTestId('notifications-row-n-repost-body')).toBeNull();

    fireEvent.press(screen.getByTestId('notifications-row-n-repost'));
    expect(push).toHaveBeenCalledWith(
      expect.objectContaining({ pathname: '/post/[postId]' }),
    );
  });

  it('opens the post, with its thread up when the notification is about a comment', async () => {
    const push = jest.fn();
    (useRouter as jest.Mock).mockReturnValue({ push, back: jest.fn() });
    (fetchNotifications as jest.Mock).mockResolvedValue([
      buildNotification({ id: 'n-comment' }),
      buildNotification({ id: 'n-like', type: 'like', commentId: null, commentBody: null, isReply: false }),
    ]);

    renderWithProviders(<NotificationsScreen />);
    await waitFor(() => expect(screen.getByTestId('notifications-row-n-comment')).toBeTruthy());

    // Comment rows used to be inert — there was no per-post route to send them
    // to, so a notification could tell you about a reply and then refuse to show
    // it to you.
    fireEvent.press(screen.getByTestId('notifications-row-n-comment'));
    expect(push).toHaveBeenLastCalledWith({
      pathname: '/post/[postId]',
      params: { postId: 'post-1', comments: '1' },
    });

    // A like on the post itself opens the post with the thread shut.
    fireEvent.press(screen.getByTestId('notifications-row-n-like'));
    expect(push).toHaveBeenLastCalledWith({
      pathname: '/post/[postId]',
      params: { postId: 'post-1', comments: '0' },
    });
  });

  it('leads nowhere when the post it points at is gone', async () => {
    const push = jest.fn();
    (useRouter as jest.Mock).mockReturnValue({ push, back: jest.fn() });
    (fetchNotifications as jest.Mock).mockResolvedValue([
      buildNotification({ id: 'n-orphan', postId: null, postMediaId: null, postAuthor: null }),
    ]);

    renderWithProviders(<NotificationsScreen />);
    await waitFor(() => expect(screen.getByTestId('notifications-row-n-orphan')).toBeTruthy());

    // No destination → a plain View, not a Pressable promising something will
    // happen. Pressing it must not navigate anywhere.
    fireEvent.press(screen.getByTestId('notifications-row-n-orphan'));
    expect(push).not.toHaveBeenCalled();
  });
});
