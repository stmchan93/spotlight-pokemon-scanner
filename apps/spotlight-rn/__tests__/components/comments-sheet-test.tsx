import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { ComponentProps, PropsWithChildren } from 'react';
import { Alert, StyleSheet } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { SpotlightThemeProvider, colors } from '@spotlight/design-system';

import {
  CommentsSheet,
  collectDescendantIds,
  isTombstone,
  shouldDismissOnDrag,
  visibleCommentCount,
} from '@/features/social/components/comments-sheet';
import {
  addComment,
  deleteComment,
  fetchComments,
  fetchLikedCommentIds,
  likeComment,
  type PostComment,
  unlikeComment,
} from '@/features/social/social-service';

jest.mock('@/features/social/social-service', () => ({
  fetchComments: jest.fn(async () => []),
  fetchLikedCommentIds: jest.fn(async () => new Set()),
  addComment: jest.fn(async () => null),
  deleteComment: jest.fn(async () => true),
  likeComment: jest.fn(async () => true),
  unlikeComment: jest.fn(async () => true),
}));

// The sheet stamps a just-posted comment with the signed-in user's identity, so
// it needs the auth context. Stub it rather than booting the whole provider.
jest.mock('@/providers/auth-provider', () => ({
  useAuth: () => ({
    currentUser: {
      id: 'me',
      displayName: 'Ash Ketchum',
      handle: 'ash',
      avatarURL: null,
      email: 'ash@example.com',
      isVerified: false,
    },
  }),
}));

const safeAreaMetrics = {
  frame: { height: 852, width: 393, x: 0, y: 0 },
  insets: { top: 59, right: 0, bottom: 34, left: 0 },
};

function Wrapper({ children }: PropsWithChildren) {
  return (
    <SafeAreaProvider initialMetrics={safeAreaMetrics}>
      <SpotlightThemeProvider>{children}</SpotlightThemeProvider>
    </SafeAreaProvider>
  );
}

/**
 * `isDeleted` is written as an explicit widening rather than assumed present on
 * `PostComment`: the flag is added by `social-service.ts`, and typing it here
 * keeps these tests compiling on either side of that landing (and keeps the name
 * they depend on to a single line).
 */
type CommentOverrides = Partial<PostComment> & { isDeleted?: boolean };

function buildComment(overrides: CommentOverrides = {}): PostComment {
  return {
    id: 'c1',
    postId: 'post-1',
    authorId: 'a1',
    author: { displayName: 'Misty', handle: 'misty', avatarUrl: null, isVerified: false },
    body: 'Great card!',
    parentCommentId: null,
    likeCount: 0,
    createdAt: '2026-05-01T00:00:00.000Z',
    ...overrides,
  } as PostComment;
}

/** A comment as the server sends it once it has been soft-deleted: no body, no author. */
function buildTombstone(overrides: CommentOverrides = {}): PostComment {
  return buildComment({ author: null, body: null, isDeleted: true, ...overrides });
}

function renderSheet(props: Partial<ComponentProps<typeof CommentsSheet>> = {}) {
  return render(
    <CommentsSheet onClose={jest.fn()} postId="post-1" testID="comments-sheet" visible {...props} />,
    { wrapper: Wrapper },
  );
}

type AlertButton = { text?: string; style?: string; onPress?: () => void };

/** The buttons on the most recent `Alert.alert`. */
function lastAlertButtons(): AlertButton[] {
  const calls = (Alert.alert as unknown as jest.Mock).mock.calls;
  return (calls[calls.length - 1]?.[2] ?? []) as AlertButton[];
}

/** Tap the destructive button on the confirmation alert. */
async function confirmDestructive() {
  const button = lastAlertButtons().find((entry) => entry.style === 'destructive');
  expect(button).toBeDefined();
  await act(async () => {
    button?.onPress?.();
  });
}

describe('CommentsSheet', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (fetchComments as jest.Mock).mockResolvedValue([]);
    (fetchLikedCommentIds as jest.Mock).mockResolvedValue(new Set());
    (addComment as jest.Mock).mockResolvedValue(null);
    (deleteComment as jest.Mock).mockResolvedValue(true);
    (likeComment as jest.Mock).mockResolvedValue(true);
    (unlikeComment as jest.Mock).mockResolvedValue(true);
    jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('loads and renders the thread', async () => {
    (fetchComments as jest.Mock).mockResolvedValue([buildComment()]);
    renderSheet();

    expect(await screen.findByText('Great card!')).toBeTruthy();
    expect(screen.getByText('Misty')).toBeTruthy();
    expect(fetchComments as jest.Mock).toHaveBeenCalledWith('post-1');
  });

  it('shows the empty state when there are no comments', async () => {
    renderSheet();
    expect(await screen.findByTestId('comments-sheet-empty')).toBeTruthy();
    expect(screen.getByText('Be the first to comment')).toBeTruthy();
  });

  it('optimistically appends a new comment', async () => {
    (addComment as jest.Mock).mockResolvedValue('c-new');
    const onCommentAdded = jest.fn();
    render(
      <CommentsSheet
        onClose={jest.fn()}
        onCommentAdded={onCommentAdded}
        postId="post-1"
        testID="comments-sheet"
        visible
      />,
      { wrapper: Wrapper },
    );
    await screen.findByTestId('comments-sheet-empty');

    fireEvent.changeText(screen.getByTestId('comments-sheet-input'), 'My first comment');
    fireEvent.press(screen.getByTestId('comments-sheet-send'));

    expect(await screen.findByText('My first comment')).toBeTruthy();
    // The new row is attributed to the signed-in user, not the anonymous
    // "Collector" fallback used when an author can't be resolved.
    expect(screen.getByText('Ash Ketchum')).toBeTruthy();
    expect(screen.queryByText('Collector')).toBeNull();
    expect(addComment as jest.Mock).toHaveBeenCalledWith('post-1', 'My first comment', null);
    await waitFor(() => expect(onCommentAdded).toHaveBeenCalled());
  });

  it('reports the loaded thread size so a stale post comment_count can be corrected', async () => {
    (fetchComments as jest.Mock).mockResolvedValue([
      buildComment(),
      buildComment({ id: 'c2', body: 'Second' }),
    ]);
    const onCommentCountResolved = jest.fn();
    render(
      <CommentsSheet
        onClose={jest.fn()}
        onCommentCountResolved={onCommentCountResolved}
        postId="post-1"
        testID="comments-sheet"
        visible
      />,
      { wrapper: Wrapper },
    );

    await waitFor(() => expect(onCommentCountResolved).toHaveBeenCalledWith(2));
  });

  it('shows a comment you already liked as liked, so tapping it unlikes', async () => {
    (fetchComments as jest.Mock).mockResolvedValue([buildComment({ likeCount: 5 })]);
    (fetchLikedCommentIds as jest.Mock).mockResolvedValue(new Set(['c1']));
    renderSheet();
    await screen.findByText('Great card!');

    await waitFor(() =>
      expect(fetchLikedCommentIds as jest.Mock).toHaveBeenCalledWith(['c1']),
    );
    // Already liked → the next tap is an UNLIKE, not a second like.
    fireEvent.press(screen.getByTestId('comments-sheet-comment-c1-like'));
    await waitFor(() => expect(unlikeComment as jest.Mock).toHaveBeenCalledWith('c1'));
    expect(likeComment as jest.Mock).not.toHaveBeenCalled();
    expect(screen.getByText('4')).toBeTruthy();
  });

  it('optimistically toggles the comment like and count', async () => {
    (fetchComments as jest.Mock).mockResolvedValue([buildComment({ likeCount: 5 })]);
    renderSheet();
    await screen.findByText('Great card!');

    expect(screen.getByText('5')).toBeTruthy();

    fireEvent.press(screen.getByTestId('comments-sheet-comment-c1-like'));

    // Optimistic bump before the write resolves.
    expect(screen.getByText('6')).toBeTruthy();
    await waitFor(() => expect(likeComment as jest.Mock).toHaveBeenCalledWith('c1'));
    // Success → no rollback.
    expect(screen.getByText('6')).toBeTruthy();
  });

  it('rolls the like back when the write fails', async () => {
    (likeComment as jest.Mock).mockResolvedValue(false);
    (fetchComments as jest.Mock).mockResolvedValue([buildComment({ likeCount: 5 })]);
    renderSheet();
    await screen.findByText('Great card!');

    fireEvent.press(screen.getByTestId('comments-sheet-comment-c1-like'));
    expect(screen.getByText('6')).toBeTruthy();

    await waitFor(() => expect(screen.getByText('5')).toBeTruthy());
  });

  it('hides replies behind the "N replies" toggle and reveals them with a blue @mention', async () => {
    (fetchComments as jest.Mock).mockResolvedValue([
      buildComment({ id: 'c1', body: 'Top level', likeCount: 0 }),
      buildComment({
        id: 'r1',
        author: { displayName: 'Brock', handle: 'brock', avatarUrl: null, isVerified: false },
        body: 'Nice one',
        parentCommentId: 'c1',
      }),
    ]);
    renderSheet();
    await screen.findByText('Top level');

    // Reply is hidden until the toggle is tapped.
    expect(screen.queryByTestId('comments-sheet-comment-r1')).toBeNull();
    const toggle = screen.getByTestId('comments-sheet-comment-c1-replies-toggle');
    expect(screen.getByText('1 reply')).toBeTruthy();

    fireEvent.press(toggle);

    // Reply now visible; the parent author's handle renders as an inline @mention.
    expect(await screen.findByTestId('comments-sheet-comment-r1')).toBeTruthy();
    expect(screen.getByText('@misty')).toBeTruthy();
    expect(screen.getByText('Hide replies')).toBeTruthy();

    // Tapping again collapses.
    fireEvent.press(toggle);
    await waitFor(() => expect(screen.queryByTestId('comments-sheet-comment-r1')).not.toBeOnTheScreen());
  });

  it('makes the header a drag target so the sheet can be swiped down, not only tapped', async () => {
    renderSheet();
    const header = await screen.findByTestId('comments-sheet-header');

    // PanResponder attaches its move/release handlers to the header, so the
    // whole handle + title strip drags — the tap-to-close Pressable is still
    // there underneath for a stationary tap.
    expect(typeof header.props.onMoveShouldSetResponder).toBe('function');
    expect(typeof header.props.onResponderMove).toBe('function');
    expect(typeof header.props.onResponderRelease).toBe('function');
  });

  it('dismisses on a long drag or a flick, and springs back otherwise', () => {
    expect(shouldDismissOnDrag(120, 0)).toBe(true);
    expect(shouldDismissOnDrag(20, 1.2)).toBe(true);
    expect(shouldDismissOnDrag(20, 0.1)).toBe(false);
  });

  describe('tombstones (soft-deleted comments that still hold replies)', () => {
    /** A soft-deleted parent whose reply survived it — the whole reason the row exists. */
    const tombstonedThread = () => [
      buildTombstone({ authorId: 'a1' }),
      buildComment({
        id: 'r1',
        author: { displayName: 'Brock', handle: 'brock', avatarUrl: null, isVerified: false },
        authorId: 'a2',
        body: 'Still here',
        parentCommentId: 'c1',
      }),
    ];

    it('renders a muted "deleted" line with no author, avatar or timestamp', async () => {
      (fetchComments as jest.Mock).mockResolvedValue(tombstonedThread());
      renderSheet();

      const line = await screen.findByTestId('comments-sheet-comment-c1-tombstone');
      expect(line).toHaveTextContent('This comment was deleted');
      // Muted, not body-coloured: it is an absence, not something to read.
      expect(StyleSheet.flatten(line.props.style)).toMatchObject({ color: colors.gray400 });
      expect(StyleSheet.flatten(line.props.style).color).not.toBe(colors.gray700);

      // Anonymised on purpose. A name attached to a withdrawn comment still tells
      // the thread who said something and took it back.
      expect(screen.queryByText('Misty')).toBeNull();
      expect(screen.queryByText('@misty')).toBeNull();
      // No initials fallback avatar either — the row carries no identity at all.
      expect(screen.queryByText('M')).toBeNull();
      expect(screen.queryByText('C')).toBeNull();
    });

    it('offers no like, no reply and no long-press delete', async () => {
      // Authored by the signed-in user, so the delete affordance would appear if
      // tombstones weren't suppressed.
      (fetchComments as jest.Mock).mockResolvedValue([
        buildTombstone({ authorId: 'me' }),
        buildComment({ id: 'r1', authorId: 'a2', body: 'Still here', parentCommentId: 'c1' }),
      ]);
      renderSheet();

      const row = await screen.findByTestId('comments-sheet-comment-c1');
      expect(screen.queryByTestId('comments-sheet-comment-c1-like')).toBeNull();
      expect(screen.queryByTestId('comments-sheet-comment-c1-reply')).toBeNull();
      expect(row.props.accessibilityHint).toBeUndefined();

      fireEvent(row, 'longPress');
      expect(Alert.alert as unknown as jest.Mock).not.toHaveBeenCalled();
      expect(deleteComment as jest.Mock).not.toHaveBeenCalled();
    });

    it('keeps the replies reachable and drops the @mention back to the deleted author', async () => {
      (fetchComments as jest.Mock).mockResolvedValue(tombstonedThread());
      renderSheet();

      // The replies toggle is thread navigation, not an action on the comment, so
      // it survives — without it the replies would be unreachable.
      fireEvent.press(await screen.findByTestId('comments-sheet-comment-c1-replies-toggle'));

      expect(await screen.findByText('Still here')).toBeTruthy();
      // No "@misty" handing back the attribution the tombstone withholds.
      expect(screen.queryByText('@misty')).toBeNull();
    });

    it('does not count tombstones toward the post comment count', async () => {
      (fetchComments as jest.Mock).mockResolvedValue(tombstonedThread());
      const onCommentCountResolved = jest.fn();
      renderSheet({ onCommentCountResolved });

      // Two rows load, but only one of them is a comment somebody wrote.
      await waitFor(() => expect(onCommentCountResolved).toHaveBeenCalledWith(1));
      // Nor is a tombstone asked about for likes.
      expect(fetchLikedCommentIds as jest.Mock).toHaveBeenCalledWith(['r1']);
    });

    it('identifies tombstones and counts only real comments', () => {
      const rows = [buildComment(), buildTombstone({ id: 'c2' }), buildComment({ id: 'c3' })];
      expect(rows.map(isTombstone)).toEqual([false, true, false]);
      expect(visibleCommentCount(rows)).toBe(2);
      expect(visibleCommentCount([])).toBe(0);
    });
  });

  describe('deleting your own comment', () => {
    const mine = () => buildComment({ authorId: 'me', body: 'My take' });
    const theirs = () => buildComment({ id: 'c2', authorId: 'a1', body: 'Their take' });

    it('offers no delete affordance on someone else’s comment', async () => {
      (fetchComments as jest.Mock).mockResolvedValue([theirs()]);
      renderSheet();
      const row = await screen.findByTestId('comments-sheet-comment-c2');

      expect(row.props.accessibilityHint).toBeUndefined();

      // Even if a long press reaches the row, nothing confirms and nothing deletes.
      fireEvent(row, 'longPress');
      expect(Alert.alert as unknown as jest.Mock).not.toHaveBeenCalled();
      expect(deleteComment as jest.Mock).not.toHaveBeenCalled();
    });

    it('long-presses your own comment into a confirmation, and only then deletes', async () => {
      (fetchComments as jest.Mock).mockResolvedValue([mine()]);
      renderSheet();
      const row = await screen.findByTestId('comments-sheet-comment-c1');

      expect(row.props.accessibilityHint).toBe('Press and hold to delete your comment');

      fireEvent(row, 'longPress');

      const [title, message] = (Alert.alert as unknown as jest.Mock).mock.calls[0];
      expect(title).toBe('Delete comment?');
      expect(message).toBe("This can't be undone.");
      // Confirmation first — the long press alone must not delete anything.
      expect(deleteComment as jest.Mock).not.toHaveBeenCalled();
      expect(screen.getByText('My take')).toBeTruthy();

      await confirmDestructive();
      expect(deleteComment as jest.Mock).toHaveBeenCalledWith('c1');
    });

    it('removes a childless comment optimistically and updates the post count', async () => {
      (fetchComments as jest.Mock).mockResolvedValue([mine(), theirs()]);
      // Never resolves: proves the row leaves the thread BEFORE the write returns.
      (deleteComment as jest.Mock).mockReturnValue(new Promise(() => {}));
      const onCommentCountResolved = jest.fn();
      renderSheet({ onCommentCountResolved });

      await waitFor(() => expect(onCommentCountResolved).toHaveBeenCalledWith(2));
      fireEvent(screen.getByTestId('comments-sheet-comment-c1'), 'longPress');
      await confirmDestructive();

      expect(screen.queryByText('My take')).toBeNull();
      expect(screen.getByText('Their take')).toBeTruthy();
      // Nothing depended on the row, so it leaves no tombstone behind.
      expect(screen.queryByTestId('comments-sheet-comment-c1')).toBeNull();
      // The card's comment_count follows the thread down, matching the DB trigger.
      expect(onCommentCountResolved).toHaveBeenLastCalledWith(1);
    });

    it('restores the comment and the count, and says so, when the delete fails', async () => {
      (fetchComments as jest.Mock).mockResolvedValue([mine(), theirs()]);
      (deleteComment as jest.Mock).mockResolvedValue(false);
      const onCommentCountResolved = jest.fn();
      renderSheet({ onCommentCountResolved });

      await waitFor(() => expect(onCommentCountResolved).toHaveBeenCalledWith(2));
      fireEvent(screen.getByTestId('comments-sheet-comment-c1'), 'longPress');
      await confirmDestructive();

      expect(await screen.findByText('My take')).toBeTruthy();
      expect(onCommentCountResolved).toHaveBeenLastCalledWith(2);
      // Restoring silently would read as "the delete worked, then didn't".
      expect(Alert.alert as unknown as jest.Mock).toHaveBeenLastCalledWith(
        "Couldn't delete",
        'That comment is still there. Please try again.',
      );
    });

    /** A comment of mine with two other people's replies hanging off it. */
    const parentWithReplies = () => [
      buildComment({ authorId: 'me', body: 'Parent' }),
      buildComment({
        id: 'r1',
        author: { displayName: 'Brock', handle: 'brock', avatarUrl: null, isVerified: false },
        authorId: 'a1',
        body: 'A reply',
        parentCommentId: 'c1',
      }),
      buildComment({
        id: 'r2',
        author: { displayName: 'Erika', handle: 'erika', avatarUrl: null, isVerified: false },
        authorId: 'a2',
        body: 'Reply to the reply',
        parentCommentId: 'r1',
      }),
    ];

    it('promises the replies survive, instead of warning that they go too', async () => {
      (fetchComments as jest.Mock).mockResolvedValue(parentWithReplies());
      renderSheet();

      fireEvent(await screen.findByTestId('comments-sheet-comment-c1'), 'longPress');

      const [, message] = (Alert.alert as unknown as jest.Mock).mock.calls[0];
      // The old copy ("This also deletes the 2 replies underneath it") described
      // a cascade that no longer happens.
      expect(message).not.toMatch(/also deletes/);
      expect(message).toBe(
        'Your words are removed, but the 2 replies underneath stay, under a “comment was deleted” line. This can\'t be undone.',
      );
    });

    it('leaves a tombstone in place of a parent, keeping other people’s replies readable', async () => {
      (fetchComments as jest.Mock).mockResolvedValue(parentWithReplies());
      const onCommentCountResolved = jest.fn();
      renderSheet({ onCommentCountResolved });

      await waitFor(() => expect(onCommentCountResolved).toHaveBeenCalledWith(3));
      fireEvent(screen.getByTestId('comments-sheet-comment-c1'), 'longPress');
      await confirmDestructive();

      // The body is gone…
      expect(screen.queryByText('Parent')).toBeNull();
      // …but the row is still there, holding the thread up.
      expect(screen.getByTestId('comments-sheet-comment-c1')).toBeTruthy();
      expect(screen.getByTestId('comments-sheet-comment-c1-tombstone')).toBeTruthy();
      // The whole point of the change: nobody else's reply was destroyed, and
      // they are shown straight away rather than collapsed behind the toggle.
      // (Asserted on the rows, not the strings — a deeper reply's body renders
      // alongside an inline @mention in the same Text.)
      expect(screen.getByTestId('comments-sheet-comment-r1')).toHaveTextContent(/A reply/);
      expect(screen.getByTestId('comments-sheet-comment-r2')).toHaveTextContent(
        /Reply to the reply/,
      );
      expect(deleteComment as jest.Mock).toHaveBeenCalledTimes(1);
    });

    it('drops the post count by exactly one, not by the size of the subtree', async () => {
      (fetchComments as jest.Mock).mockResolvedValue(parentWithReplies());
      const onCommentCountResolved = jest.fn();
      renderSheet({ onCommentCountResolved });

      await waitFor(() => expect(onCommentCountResolved).toHaveBeenCalledWith(3));
      fireEvent(screen.getByTestId('comments-sheet-comment-c1'), 'longPress');
      await confirmDestructive();

      // 3 → 2: the two replies still count, and the tombstone counts for nothing.
      // The old cascade behaviour reported 0 here.
      expect(onCommentCountResolved).toHaveBeenLastCalledWith(2);
    });

    it('puts the body back under a restored tombstone when the delete fails', async () => {
      (fetchComments as jest.Mock).mockResolvedValue(parentWithReplies());
      (deleteComment as jest.Mock).mockResolvedValue(false);
      const onCommentCountResolved = jest.fn();
      renderSheet({ onCommentCountResolved });

      await waitFor(() => expect(onCommentCountResolved).toHaveBeenCalledWith(3));
      fireEvent(screen.getByTestId('comments-sheet-comment-c1'), 'longPress');
      await confirmDestructive();

      // Restoring a tombstone means the body — and the author — come back.
      expect(await screen.findByText('Parent')).toBeTruthy();
      expect(screen.queryByTestId('comments-sheet-comment-c1-tombstone')).toBeNull();
      expect(screen.getByText('Misty')).toBeTruthy();
      expect(onCommentCountResolved).toHaveBeenLastCalledWith(3);
      expect(Alert.alert as unknown as jest.Mock).toHaveBeenLastCalledWith(
        "Couldn't delete",
        'That comment is still there. Please try again.',
      );
    });

    it('titles the confirmation for a reply when the row is a reply', async () => {
      (fetchComments as jest.Mock).mockResolvedValue([
        theirs(),
        buildComment({ id: 'r1', authorId: 'me', body: 'My reply', parentCommentId: 'c2' }),
      ]);
      renderSheet();
      fireEvent.press(await screen.findByTestId('comments-sheet-comment-c2-replies-toggle'));

      fireEvent(await screen.findByTestId('comments-sheet-comment-r1'), 'longPress');
      expect((Alert.alert as unknown as jest.Mock).mock.calls[0][0]).toBe('Delete reply?');
    });

    it('collects every descendant of a comment, at any depth', () => {
      const comments = [
        buildComment({ id: 'c1' }),
        buildComment({ id: 'r1', parentCommentId: 'c1' }),
        buildComment({ id: 'r2', parentCommentId: 'r1' }),
        buildComment({ id: 'other' }),
      ];
      expect(collectDescendantIds(comments, 'c1').sort()).toEqual(['r1', 'r2']);
      expect(collectDescendantIds(comments, 'r1')).toEqual(['r2']);
      expect(collectDescendantIds(comments, 'other')).toEqual([]);
    });
  });
});
