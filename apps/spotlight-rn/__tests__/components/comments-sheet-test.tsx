import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import type { ComponentProps, PropsWithChildren } from 'react';
import { Alert, Keyboard, StyleSheet } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { SpotlightThemeProvider, colors } from '@spotlight/design-system';

import {
  CommentsSheet,
  collectDescendantIds,
  isTombstone,
  pruneOrphanedTombstones,
  shouldDismissOnDrag,
  tombstoneLabel,
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
  addComment: jest.fn(async () => ({ ok: false, reason: 'nope' })),
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

/*
  The delete confirmation is the SAME component the post delete uses
  (`ConfirmDeleteSheet`), rendered `inline` inside this sheet's own Modal rather
  than as a second stacked Modal — so it is a real view in the tree, not an
  `Alert` whose buttons have to be reached through the spy.
*/
const DELETE_CONFIRM = 'comments-sheet-delete-confirm';

/** Tap the red Delete CTA on the confirmation sheet. */
async function confirmDelete() {
  await act(async () => {
    fireEvent.press(screen.getByTestId(`${DELETE_CONFIRM}-confirm`));
  });
}

/** Whether the delete confirmation is on screen at all. */
function deleteConfirmShown(): boolean {
  return screen.queryByTestId(DELETE_CONFIRM) != null;
}

describe('CommentsSheet', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (fetchComments as jest.Mock).mockResolvedValue([]);
    (fetchLikedCommentIds as jest.Mock).mockResolvedValue(new Set());
    (addComment as jest.Mock).mockResolvedValue({ ok: false, reason: 'nope' });
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
    (addComment as jest.Mock).mockResolvedValue({ ok: true, id: 'c-new' });
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

  // The bug this fixes: a tap next to a focused TextInput, inside a Modal whose
  // sheet is resizing to the keyboard, gets consumed before the finger lifts —
  // so `onPress` (release-only) never runs. Keyboard goes away, nothing posts,
  // draft still sitting there. Sending on touch-DOWN cannot be beaten by that.
  // The banner is a LABEL, not a control. Its X used to sit next to a focused
  // TextInput inside this Modal, so the first tap got eaten exactly like the
  // send button's did — the keyboard dropped, `onPress` never ran, and the
  // banner stayed up still claiming you were replying to someone.
  it('states who you are replying to with no way to X it out, and drops it on blur', async () => {
    (fetchComments as jest.Mock).mockResolvedValue([buildComment()]);
    renderSheet();
    await screen.findByText('Great card!');

    fireEvent.press(screen.getByTestId('comments-sheet-comment-c1-reply'));
    expect(screen.getByTestId('comments-sheet-reply-banner')).toBeTruthy();
    expect(screen.queryByTestId('comments-sheet-reply-cancel')).toBeNull();

    // Leaving the composer is what ends the reply.
    await act(async () => {
      fireEvent(screen.getByTestId('comments-sheet-input'), 'blur');
    });
    expect(screen.queryByTestId('comments-sheet-reply-banner')).toBeNull();
  });

  it('posts on touch-down, so a tap whose release never lands still sends', async () => {
    (addComment as jest.Mock).mockResolvedValue({ ok: true, id: 'c-new' });
    renderSheet();
    await screen.findByTestId('comments-sheet-empty');

    fireEvent.changeText(screen.getByTestId('comments-sheet-input'), 'Down only');
    // Deliberately only the touch-down half of a tap.
    await act(async () => {
      fireEvent(screen.getByTestId('comments-sheet-send'), 'pressIn');
    });

    expect(addComment as jest.Mock).toHaveBeenCalledWith('post-1', 'Down only', null);
    expect(await screen.findByText('Down only')).toBeTruthy();
    expect(screen.getByTestId('comments-sheet-input').props.value).toBe('');
  });

  // `onPress` has to stay for VoiceOver, which only ever fires that one — so a
  // normal tap runs BOTH handlers and must still post exactly once.
  it('posts once for a complete tap, not once per handler', async () => {
    (addComment as jest.Mock).mockResolvedValue({ ok: true, id: 'c-new' });
    renderSheet();
    await screen.findByTestId('comments-sheet-empty');

    fireEvent.changeText(screen.getByTestId('comments-sheet-input'), 'Exactly once');
    await act(async () => {
      fireEvent(screen.getByTestId('comments-sheet-send'), 'pressIn');
      fireEvent.press(screen.getByTestId('comments-sheet-send'));
    });

    expect(addComment as jest.Mock).toHaveBeenCalledTimes(1);
    expect(screen.queryAllByText('Exactly once')).toHaveLength(1);
  });

  /*
    A FAILED WRITE HAS TO SAY SO.

    This is the bug that outlived five fixes. `addComment` collapsed every
    failure — RLS rejection, raising trigger, dropped connection, signed-out
    session — into `null`, and the sheet's response to null was to keep the draft
    and do nothing. On the phone that is indistinguishable from a dead send
    button, which is why three rounds went into the button, the gesture and the
    keyboard while the WRITE was what was failing.

    The reason is the database's own message, so the next failure names itself
    instead of being guessed at from the outside.
  */
  it('reports why a comment could not be posted, and keeps the draft', async () => {
    (addComment as jest.Mock).mockResolvedValue({
      ok: false,
      reason: 'new row violates row-level security policy for table "comments"',
    });
    renderSheet();
    await screen.findByTestId('comments-sheet-empty');

    fireEvent.changeText(screen.getByTestId('comments-sheet-input'), 'Rejected by policy');
    await act(async () => {
      fireEvent(screen.getByTestId('comments-sheet-send'), 'pressIn');
    });

    expect(Alert.alert).toHaveBeenCalledWith(
      "Couldn't post comment",
      'new row violates row-level security policy for table "comments"',
    );
    // Still yours to retry: the text stays, and nothing was faked into the thread.
    expect(screen.getByTestId('comments-sheet-input').props.value).toBe('Rejected by policy');
    expect(screen.queryByText('Rejected by policy')).toBeNull();
  });

  it('posts once when send is pressed twice before the write lands', async () => {
    // The composer used to blur on submit, which collapsed the sheet over a
    // comment that had actually posted — so pressing send again was the natural
    // response, and `sending` being state meant both presses got through.
    let resolveAdd: ((result: { ok: true; id: string }) => void) | null = null;
    (addComment as jest.Mock).mockImplementation(
      () => new Promise((resolve) => {
        resolveAdd = resolve;
      }),
    );
    renderSheet();
    await screen.findByTestId('comments-sheet-empty');

    fireEvent.changeText(screen.getByTestId('comments-sheet-input'), 'Only once');
    fireEvent.press(screen.getByTestId('comments-sheet-send'));
    fireEvent.press(screen.getByTestId('comments-sheet-send'));

    expect(addComment as jest.Mock).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveAdd?.({ ok: true, id: 'c-new' });
    });
    expect(await screen.findByText('Only once')).toBeTruthy();
    expect(screen.queryAllByText('Only once')).toHaveLength(1);
  });

  /*
    SENDING NEVER TOUCHES THE KEYBOARD.

    It used to dismiss on success and then chase the resulting sheet collapse
    with a timed scroll. From the outside that is indistinguishable from the send
    doing nothing — the keyboard drops, the sheet shrinks, and the comment is at
    the end of a thread you are no longer looking at. Leaving the keyboard alone
    keeps the sheet at full height, so the new comment lands directly above the
    composer where you can see it.
  */
  it('sends first and puts the keyboard away second, and does neither when the write fails', async () => {
    const dismiss = jest.spyOn(Keyboard, 'dismiss').mockImplementation(() => undefined);

    // Failed write: keyboard stays up and the text stays in the composer,
    // because "try again" needs both.
    (addComment as jest.Mock).mockResolvedValue({ ok: false, reason: 'nope' });
    renderSheet();
    await screen.findByTestId('comments-sheet-empty');

    fireEvent.changeText(screen.getByTestId('comments-sheet-input'), 'Does not land');
    await act(async () => {
      fireEvent.press(screen.getByTestId('comments-sheet-send'));
    });
    expect(screen.getByTestId('comments-sheet-input').props.value).toBe('Does not land');

    // Successful write: the comment is in the thread and the composer is empty.
    (addComment as jest.Mock).mockResolvedValue({ ok: true, id: 'c-new' });
    await act(async () => {
      fireEvent.press(screen.getByTestId('comments-sheet-send'));
    });
    expect(await screen.findByText('Does not land')).toBeTruthy();
    expect(screen.getByTestId('comments-sheet-input').props.value).toBe('');

    // Dismissed ONCE — on the successful write, never on the failed one, where
    // the keyboard has to stay up for the retry.
    expect(dismiss).toHaveBeenCalledTimes(1);
  });

  // The just-posted comment is the LAST row, which on a long thread is below the
  // fold. The scroll rides the list's content-size change rather than a timer off
  // the send, because that is the one moment the new row is laid out and the end
  // position is final.
  it('drives the post-send scroll from the list growing, not from a timer', async () => {
    renderSheet();
    await screen.findByTestId('comments-sheet-empty');

    // The mechanism, not the pixels: jest lays nothing out, so a `scrollToEnd`
    // spy here would only prove the handler was called with a content size of
    // zero. What must not regress is WHERE the scroll is hung — off the send
    // with a timeout, it raced the layout and landed short on a long thread.
    expect(
      typeof screen.getByTestId('comments-sheet-list').props.onContentSizeChange,
    ).toBe('function');
  });

  it('keeps the keyboard up when the return key posts, so the sheet cannot collapse over the comment', async () => {
    renderSheet();
    await screen.findByTestId('comments-sheet-empty');

    // The return key is labelled "Send", so it is the obvious way to post.
    // `blurAndSubmit` (the single-line default) is what dropped the keyboard and
    // shrank the sheet from 0.9 to 0.6 of the screen.
    const input = screen.getByTestId('comments-sheet-input');
    expect(input.props.submitBehavior).toBe('submit');
    expect(input.props.returnKeyType).toBe('send');
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
      // A top-level row, so it is a "comment".
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
      expect(deleteConfirmShown()).toBe(false);
      expect(deleteComment as jest.Mock).not.toHaveBeenCalled();
    });

    /*
      THE NOUN HAS TO MATCH THE ROW.

      Reported by a user who deleted a reply, was asked "Delete reply?", and then
      watched the row it left behind call itself a comment.
    */
    it('calls a tombstoned REPLY a reply, not a comment', async () => {
      (fetchComments as jest.Mock).mockResolvedValue([
        buildComment({ id: 'c1', body: 'Top level' }),
        buildTombstone({ id: 'r1', parentCommentId: 'c1' }),
        buildComment({
          id: 'r2',
          author: { displayName: 'Brock', handle: 'brock', avatarUrl: null, isVerified: false },
          authorId: 'a2',
          body: 'Under the deleted reply',
          parentCommentId: 'r1',
        }),
      ]);
      renderSheet();

      fireEvent.press(await screen.findByTestId('comments-sheet-comment-c1-replies-toggle'));

      const line = await screen.findByTestId('comments-sheet-comment-r1-tombstone');
      expect(line).toHaveTextContent('This reply was deleted');
      expect(line).not.toHaveTextContent('This comment was deleted');
      // The reply it is holding up is still readable, which is the whole reason
      // the tombstone row exists.
      expect(screen.getByTestId('comments-sheet-comment-r2')).toHaveTextContent(
        /Under the deleted reply/,
      );
    });

    it('names the row it is standing in for', () => {
      expect(tombstoneLabel(false)).toBe('This comment was deleted');
      expect(tombstoneLabel(true)).toBe('This reply was deleted');
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
      expect(deleteConfirmShown()).toBe(false);
      expect(deleteComment as jest.Mock).not.toHaveBeenCalled();
    });

    it('long-presses your own comment into a confirmation, and only then deletes', async () => {
      (fetchComments as jest.Mock).mockResolvedValue([mine()]);
      renderSheet();
      const row = await screen.findByTestId('comments-sheet-comment-c1');

      expect(row.props.accessibilityHint).toBe('Press and hold to delete your comment');

      fireEvent(row, 'longPress');

      // The post-delete sheet's shape: a title, the consequence, then Cancel and
      // a red Delete — NOT an OS alert.
      expect(screen.getByTestId(DELETE_CONFIRM)).toBeTruthy();
      expect(screen.getByText('Delete comment?')).toBeTruthy();
      expect(screen.getByText("This can't be undone.")).toBeTruthy();
      expect(screen.getByTestId(`${DELETE_CONFIRM}-cancel`)).toBeTruthy();
      expect(Alert.alert as unknown as jest.Mock).not.toHaveBeenCalled();
      // Confirmation first — the long press alone must not delete anything.
      expect(deleteComment as jest.Mock).not.toHaveBeenCalled();
      expect(screen.getByText('My take')).toBeTruthy();

      await confirmDelete();
      expect(deleteComment as jest.Mock).toHaveBeenCalledWith('c1');
    });

    it('cancels out of the confirmation without deleting anything', async () => {
      (fetchComments as jest.Mock).mockResolvedValue([mine()]);
      renderSheet();

      fireEvent(await screen.findByTestId('comments-sheet-comment-c1'), 'longPress');
      await act(async () => {
        fireEvent.press(screen.getByTestId(`${DELETE_CONFIRM}-cancel`));
      });

      expect(deleteComment as jest.Mock).not.toHaveBeenCalled();
      expect(screen.getByText('My take')).toBeTruthy();
    });

    it('removes a childless comment optimistically and updates the post count', async () => {
      (fetchComments as jest.Mock).mockResolvedValue([mine(), theirs()]);
      // Never resolves: proves the row leaves the thread BEFORE the write returns.
      (deleteComment as jest.Mock).mockReturnValue(new Promise(() => {}));
      const onCommentCountResolved = jest.fn();
      renderSheet({ onCommentCountResolved });

      await waitFor(() => expect(onCommentCountResolved).toHaveBeenCalledWith(2));
      fireEvent(screen.getByTestId('comments-sheet-comment-c1'), 'longPress');
      await confirmDelete();

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
      await confirmDelete();

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

      // The old copy ("This also deletes the 2 replies underneath it") described
      // a cascade that no longer happens.
      expect(screen.queryByText(/also deletes/)).toBeNull();
      expect(
        screen.getByText(
          'Your comment will be removed but the replies will remain. Are you sure you want to continue?',
        ),
      ).toBeTruthy();
      // No reply count and no quoted tombstone line in the copy — precision
      // nobody needs at the moment they decide whether to delete something.
      // (Scoped to the confirmation: "2 replies" legitimately appears on the
      // thread's own replies toggle behind it.)
      const confirm = within(screen.getByTestId('comments-sheet-delete-confirm'));
      expect(confirm.queryByText(/replies underneath/)).toBeNull();
      expect(confirm.queryByText(/was deleted/)).toBeNull();
    });

    it('leaves a tombstone in place of a parent, keeping other people’s replies readable', async () => {
      (fetchComments as jest.Mock).mockResolvedValue(parentWithReplies());
      const onCommentCountResolved = jest.fn();
      renderSheet({ onCommentCountResolved });

      await waitFor(() => expect(onCommentCountResolved).toHaveBeenCalledWith(3));
      fireEvent(screen.getByTestId('comments-sheet-comment-c1'), 'longPress');
      await confirmDelete();

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
      await confirmDelete();

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
      await confirmDelete();

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
      expect(screen.getByText('Delete reply?')).toBeTruthy();
    });

    // The confirmation quotes the tombstone it is about to leave behind, so the
    // two have to agree: deleting a REPLY that holds replies of its own promises
    // a "reply was deleted" line, and that is what the row then says.
    it('quotes the reply wording when the row being deleted is a reply', async () => {
      (fetchComments as jest.Mock).mockResolvedValue([
        theirs(),
        buildComment({ id: 'r1', authorId: 'me', body: 'My reply', parentCommentId: 'c2' }),
        buildComment({
          id: 'r2',
          author: { displayName: 'Brock', handle: 'brock', avatarUrl: null, isVerified: false },
          authorId: 'a2',
          body: 'Under my reply',
          parentCommentId: 'r1',
        }),
      ]);
      renderSheet();
      fireEvent.press(await screen.findByTestId('comments-sheet-comment-c2-replies-toggle'));
      fireEvent(await screen.findByTestId('comments-sheet-comment-r1'), 'longPress');

      // Deleting a REPLY that has its own replies: the noun follows the row, so
      // the confirmation never calls a reply a comment.
      expect(
        screen.getByText(
          'Your reply will be removed but the replies will remain. Are you sure you want to continue?',
        ),
      ).toBeTruthy();

      await confirmDelete();
      expect(await screen.findByTestId('comments-sheet-comment-r1-tombstone')).toHaveTextContent(
        'This reply was deleted',
      );
    });

    /*
      A tombstone only earns its place while something still hangs off it.

      social_17's client rule (`pruneChildlessTombstones` in `social-service.ts`)
      applies that to a FETCHED thread. Local state could still strand one after
      the fact: tombstone a comment because it has a reply, then delete that
      reply, and the "was deleted" line sat there over nothing until the next
      fetch. Holds at every depth — the stranded row here is a top-level
      tombstone, and the nested case is covered by the unit test below.
    */
    it('takes a stranded tombstone with the last reply underneath it', async () => {
      (fetchComments as jest.Mock).mockResolvedValue([
        buildComment({ authorId: 'me', body: 'Parent' }),
        buildComment({ id: 'r1', authorId: 'me', body: 'My own reply', parentCommentId: 'c1' }),
      ]);
      const onCommentCountResolved = jest.fn();
      renderSheet({ onCommentCountResolved });

      // Delete the parent → it stays as a tombstone, holding the reply up.
      fireEvent(await screen.findByTestId('comments-sheet-comment-c1'), 'longPress');
      await confirmDelete();
      expect(screen.getByTestId('comments-sheet-comment-c1-tombstone')).toBeTruthy();

      // Delete the reply → nothing hangs off the tombstone any more, so it goes.
      fireEvent(screen.getByTestId('comments-sheet-comment-r1'), 'longPress');
      await confirmDelete();

      expect(screen.queryByTestId('comments-sheet-comment-c1-tombstone')).toBeNull();
      expect(screen.queryByTestId('comments-sheet-comment-c1')).toBeNull();
      expect(screen.queryByTestId('comments-sheet-comment-r1')).toBeNull();
      expect(onCommentCountResolved).toHaveBeenLastCalledWith(0);
      expect(screen.getByTestId('comments-sheet-empty')).toBeTruthy();
    });

    it('puts a stranded tombstone back when the delete that stranded it fails', async () => {
      (fetchComments as jest.Mock).mockResolvedValue([
        buildTombstone({ authorId: 'me' }),
        buildComment({ id: 'r1', authorId: 'me', body: 'My own reply', parentCommentId: 'c1' }),
      ]);
      (deleteComment as jest.Mock).mockResolvedValue(false);
      renderSheet();

      fireEvent.press(await screen.findByTestId('comments-sheet-comment-c1-replies-toggle'));
      fireEvent(screen.getByTestId('comments-sheet-comment-r1'), 'longPress');
      await confirmDelete();

      // The rollback restores BOTH the reply and the tombstone the prune swept
      // out with it — anything less would leave the thread short a row that the
      // server still has.
      expect(await screen.findByTestId('comments-sheet-comment-r1')).toBeTruthy();
      expect(screen.getByTestId('comments-sheet-comment-c1-tombstone')).toBeTruthy();
    });

    it('prunes tombstones nothing hangs off, to a fixed point and at any depth', () => {
      const live = buildComment({ id: 'live' });
      const rootTomb = buildTombstone({ id: 't-root' });
      const nestedTomb = buildTombstone({ id: 't-nested', parentCommentId: 't-root' });
      const survivor = buildComment({ id: 'survivor', parentCommentId: 't-nested' });

      // The nested tombstone still holds a real reply, so the chain above it stays.
      expect(pruneOrphanedTombstones([live, rootTomb, nestedTomb, survivor])).toEqual([
        live,
        rootTomb,
        nestedTomb,
        survivor,
      ]);
      // Drop the survivor and the whole chain unwinds in one call.
      expect(pruneOrphanedTombstones([live, rootTomb, nestedTomb])).toEqual([live]);
      // A thread with no tombstones is returned untouched.
      const plain = [live, buildComment({ id: 'c2' })];
      expect(pruneOrphanedTombstones(plain)).toBe(plain);
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
