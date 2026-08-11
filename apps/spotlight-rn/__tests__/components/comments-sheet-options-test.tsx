import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { ComponentProps, PropsWithChildren } from 'react';
import { Alert, StyleSheet } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { SpotlightThemeProvider } from '@spotlight/design-system';

import { CommentsSheet } from '@/features/social/components/comments-sheet';
import {
  blockUser,
  deleteComment,
  fetchComments,
  fetchLikedCommentIds,
  type PostComment,
  reportContent,
} from '@/features/social/social-service';

/*
  The ⋯ menu on a comment row.

  Deleting your own comment was already fully built, but the ONLY way to reach it
  was a long press — invisible, and reported as "there's no UI I can see to delete
  the comment". Reporting someone else's comment had no entry point at all. These
  tests are about the affordance being THERE and opening the right one action for
  the right person; the delete mechanics themselves live in `comments-sheet-test`.

  A separate file rather than an addition to that one because this surface needs
  `reportContent` in the service mock.
*/
jest.mock('@/features/social/social-service', () => ({
  fetchComments: jest.fn(async () => []),
  fetchLikedCommentIds: jest.fn(async () => new Set()),
  addComment: jest.fn(async () => null),
  deleteComment: jest.fn(async () => true),
  likeComment: jest.fn(async () => true),
  unlikeComment: jest.fn(async () => true),
  reportContent: jest.fn(async () => true),
  blockUser: jest.fn(async () => true),
}));

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

function renderSheet(props: Partial<ComponentProps<typeof CommentsSheet>> = {}) {
  return render(
    <CommentsSheet onClose={jest.fn()} postId="post-1" testID="comments-sheet" visible {...props} />,
    { wrapper: Wrapper },
  );
}

/*
  The ⋯ menu and both confirmations are VIEWS now, not `Alert`s.

  This sheet is a `Modal`, and stacking a second native Modal over one is
  unreliable on iOS, which is why these were OS alerts. `ConfirmDeleteSheet`
  takes `presentation="inline"` — the same component the post delete uses,
  rendered inside this sheet's own Modal tree with no second view controller to
  collide with — so the comment surface now confirms exactly like the post
  surface does. The only `Alert`s left are the outcome ACKNOWLEDGEMENTS
  ("Thanks for reporting", "Couldn't block"), which are not confirmations and
  which the post card also raises as alerts.
*/
const OPTIONS = 'comments-sheet-options';
const DELETE_CONFIRM = 'comments-sheet-delete-confirm';
const BLOCK_CONFIRM = 'comments-sheet-block-confirm';

async function pressById(testID: string) {
  await act(async () => {
    fireEvent.press(screen.getByTestId(testID));
  });
}

describe('CommentsSheet ⋯ options', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (fetchComments as jest.Mock).mockResolvedValue([]);
    (fetchLikedCommentIds as jest.Mock).mockResolvedValue(new Set());
    (deleteComment as jest.Mock).mockResolvedValue(true);
    (reportContent as jest.Mock).mockResolvedValue(true);
    jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const mine = () => buildComment({ authorId: 'me', body: 'My take' });
  const theirs = () => buildComment({ id: 'c2', authorId: 'a1', body: 'Their take' });

  it('shows a ⋯ button on every live comment, yours and other people’s', async () => {
    (fetchComments as jest.Mock).mockResolvedValue([mine(), theirs()]);
    renderSheet();

    expect(await screen.findByTestId('comments-sheet-comment-c1-more-button')).toBeTruthy();
    expect(screen.getByTestId('comments-sheet-comment-c2-more-button')).toBeTruthy();
    // Same label as the post card's, so the two menus read as one affordance.
    expect(
      screen.getByTestId('comments-sheet-comment-c1-more-button').props.accessibilityLabel,
    ).toBe('Comment options');
  });

  it('opens the same delete confirmation as a post from ⋯ on your own comment', async () => {
    (fetchComments as jest.Mock).mockResolvedValue([mine()]);
    renderSheet();

    fireEvent.press(await screen.findByTestId('comments-sheet-comment-c1-more-button'));

    // The post-delete sheet's own shape: title, consequence, Cancel + red Delete.
    expect(screen.getByTestId(DELETE_CONFIRM)).toBeTruthy();
    expect(screen.getByText('Delete comment?')).toBeTruthy();
    // Nothing hangs off this comment, and it still does not disappear — a delete
    // always leaves a "was deleted" line now, so the confirmation says so.
    expect(
      screen.getByText(
        "Your comment will be removed and the thread will show it was deleted. This can't be undone.",
      ),
    ).toBeTruthy();
    expect(screen.getByTestId(`${DELETE_CONFIRM}-cancel`)).toBeTruthy();
    // Not an OS alert any more.
    expect(Alert.alert as unknown as jest.Mock).not.toHaveBeenCalled();
    expect(deleteComment as jest.Mock).not.toHaveBeenCalled();

    await pressById(`${DELETE_CONFIRM}-confirm`);
    expect(deleteComment as jest.Mock).toHaveBeenCalledWith('c1');
    expect(reportContent as jest.Mock).not.toHaveBeenCalled();
  });

  it('keeps the long press working alongside the visible button', async () => {
    (fetchComments as jest.Mock).mockResolvedValue([mine()]);
    renderSheet();

    fireEvent(await screen.findByTestId('comments-sheet-comment-c1'), 'longPress');
    expect(screen.getByText('Delete comment?')).toBeTruthy();
  });

  it('offers Report AND Block on someone else’s comment, and never delete', async () => {
    (fetchComments as jest.Mock).mockResolvedValue([theirs()]);
    renderSheet();

    fireEvent.press(await screen.findByTestId('comments-sheet-comment-c2-more-button'));

    // NO chrome. The menu is its actions and nothing else: a heading naming the
    // surface you are looking at ("Comment options") and a subtitle about
    // anonymity were both read past on the way to the buttons. The anonymity
    // FACT is not gone from the product — see the acknowledgement asserted at
    // the bottom of this test, and the block confirmation in the next one.
    expect(screen.queryByText('Comment options')).toBeNull();
    expect(screen.queryByText('Reply options')).toBeNull();
    expect(
      screen.queryByText('The author is not told who reported or blocked them.'),
    ).toBeNull();
    // Block has to sit next to Report: reporting hides nothing until three
    // distinct people report the same target, so a report-only menu leaves the
    // viewer still reading what they just reported. `reportContent`'s own
    // contract spells this out.
    expect(screen.getByTestId(`${OPTIONS}-report`)).toBeTruthy();
    expect(screen.getByText('Report comment')).toBeTruthy();
    expect(screen.getByText('Block Misty')).toBeTruthy();
    expect(screen.getByTestId(`${OPTIONS}-cancel`)).toBeTruthy();
    expect(screen.queryByTestId(DELETE_CONFIRM)).toBeNull();
    expect(reportContent as jest.Mock).not.toHaveBeenCalled();

    await pressById(`${OPTIONS}-report`);

    // The polymorphic report collapses to the most specific id present, so the
    // comment id is what has to be sent — a post id here would file the report
    // against the whole post.
    expect(reportContent as jest.Mock).toHaveBeenCalledWith({
      reportedUserId: 'a1',
      commentId: 'c2',
      reason: '',
    });
    expect(deleteComment as jest.Mock).not.toHaveBeenCalled();
    // Word-for-word what the post card says. Pinned on BOTH surfaces because
    // reporting is one action and must not read as two different features
    // depending on whether you reported a post or a comment.
    await waitFor(() =>
      expect(Alert.alert as unknown as jest.Mock).toHaveBeenLastCalledWith(
        'Report sent',
        "Thanks for reporting this. We've received your report and will take a look at this as soon as possible.",
      ),
    );
  });

  /*
    A BARE list of actions must not read as two demolitions and a Cancel.

    Report and Block are not equivalent: a report is idempotent, hides nothing
    on its own and is read by a moderator before anything happens, while a block
    takes effect immediately and has no undo anywhere in the app. With the
    menu's heading gone there is nothing else to set the two apart, so the
    styling has to.
  */
  it('styles Report as the softer of the two — only Block is a red CTA', async () => {
    (fetchComments as jest.Mock).mockResolvedValue([theirs()]);
    renderSheet();

    fireEvent.press(await screen.findByTestId('comments-sheet-comment-c2-more-button'));

    const fill = (id: string) =>
      StyleSheet.flatten(screen.getByTestId(id).props.style).backgroundColor;
    const labelColor = (label: string) =>
      StyleSheet.flatten(screen.getByText(label).props.style).color;

    // Block is the filled red CTA (danger/strong).
    expect(fill(`${OPTIONS}-block`)).toBe('#D93025');
    // Report shares the neutral shell with Cancel…
    expect(fill(`${OPTIONS}-report`)).toBe(fill(`${OPTIONS}-cancel`));
    expect(fill(`${OPTIONS}-report`)).not.toBe('#D93025');
    // …and is told apart from it by a red LABEL, not a red slab.
    expect(labelColor('Report comment')).toBe('#D93025');
    expect(labelColor('Cancel')).not.toBe('#D93025');
  });

  it('blocks the comment author from the same menu, after confirming', async () => {
    (fetchComments as jest.Mock).mockResolvedValue([theirs()]);
    renderSheet();

    fireEvent.press(await screen.findByTestId('comments-sheet-comment-c2-more-button'));
    await pressById(`${OPTIONS}-block`);

    // The menu tap only opens the confirmation — blocking someone is the one
    // action here that changes what another account can see. Same sheet shape as
    // the delete confirmation, so the surface never mixes idioms.
    expect(screen.getByTestId(BLOCK_CONFIRM)).toBeTruthy();
    expect(screen.getByText('Block Misty?')).toBeTruthy();
    expect(screen.getByTestId(`${BLOCK_CONFIRM}-cancel`)).toBeTruthy();
    // The menu it replaced is gone.
    expect(screen.queryByTestId(OPTIONS)).toBeNull();
    expect(blockUser as jest.Mock).not.toHaveBeenCalled();

    await pressById(`${BLOCK_CONFIRM}-confirm`);

    expect(blockUser as jest.Mock).toHaveBeenCalledWith('a1');
    expect(reportContent as jest.Mock).not.toHaveBeenCalled();
    await waitFor(() =>
      expect((Alert.alert as unknown as jest.Mock).mock.calls.at(-1)?.[0]).toBe('Misty is blocked'),
    );
  });

  it('says so when the block does not go through', async () => {
    (blockUser as jest.Mock).mockResolvedValue(false);
    (fetchComments as jest.Mock).mockResolvedValue([theirs()]);
    renderSheet();

    fireEvent.press(await screen.findByTestId('comments-sheet-comment-c2-more-button'));
    await pressById(`${OPTIONS}-block`);
    await pressById(`${BLOCK_CONFIRM}-confirm`);

    await waitFor(() =>
      expect(Alert.alert as unknown as jest.Mock).toHaveBeenLastCalledWith(
        "Couldn't block",
        'Misty has not been blocked. Please try again in a moment.',
      ),
    );
  });

  it('backs out of the menu and out of the block confirmation without writing', async () => {
    (fetchComments as jest.Mock).mockResolvedValue([theirs()]);
    renderSheet();

    // Cancel straight out of the menu.
    fireEvent.press(await screen.findByTestId('comments-sheet-comment-c2-more-button'));
    await pressById(`${OPTIONS}-cancel`);
    expect(reportContent as jest.Mock).not.toHaveBeenCalled();
    expect(blockUser as jest.Mock).not.toHaveBeenCalled();

    // Or one step further in, then cancel the block.
    fireEvent.press(screen.getByTestId('comments-sheet-comment-c2-more-button'));
    await pressById(`${OPTIONS}-block`);
    await pressById(`${BLOCK_CONFIRM}-cancel`);
    expect(blockUser as jest.Mock).not.toHaveBeenCalled();
  });

  it('says so when the report does not go through', async () => {
    (reportContent as jest.Mock).mockResolvedValue(false);
    (fetchComments as jest.Mock).mockResolvedValue([theirs()]);
    renderSheet();

    fireEvent.press(await screen.findByTestId('comments-sheet-comment-c2-more-button'));
    await pressById(`${OPTIONS}-report`);

    await waitFor(() =>
      expect(Alert.alert as unknown as jest.Mock).toHaveBeenLastCalledWith(
        "Couldn't report",
        'That report did not go through. Please try again.',
      ),
    );
  });

  // The menu has no title to carry the noun any more, so the ACTION has to: a
  // reply's ⋯ must offer "Report reply", not "Report comment".
  it('names the row a reply in the action itself when the row is a reply', async () => {
    (fetchComments as jest.Mock).mockResolvedValue([
      mine(),
      buildComment({ id: 'r1', authorId: 'a2', body: 'Their reply', parentCommentId: 'c1' }),
    ]);
    renderSheet();

    fireEvent.press(await screen.findByTestId('comments-sheet-comment-c1-replies-toggle'));
    fireEvent.press(await screen.findByTestId('comments-sheet-comment-r1-more-button'));

    expect(screen.queryByText('Reply options')).toBeNull();
    expect(screen.getByText('Report reply')).toBeTruthy();
    expect(screen.getByText('Block Misty')).toBeTruthy();
  });

  it('files one report even when ⋯ is confirmed twice before the write lands', async () => {
    let resolveReport: ((ok: boolean) => void) | null = null;
    (reportContent as jest.Mock).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveReport = resolve;
        }),
    );
    (fetchComments as jest.Mock).mockResolvedValue([theirs()]);
    renderSheet();

    fireEvent.press(await screen.findByTestId('comments-sheet-comment-c2-more-button'));
    await pressById(`${OPTIONS}-report`);
    // Choosing Report closes the menu; it stays mounted while it slides away.
    await waitFor(() => expect(screen.queryByTestId(OPTIONS)).not.toBeOnTheScreen());

    // Second trip through the ⋯ while the first report is still in flight — the
    // menu does not even reopen.
    fireEvent.press(screen.getByTestId('comments-sheet-comment-c2-more-button'));

    expect(screen.queryByTestId(OPTIONS)).toBeNull();
    expect(reportContent as jest.Mock).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolveReport?.(true);
    });
  });

  /*
    THE ⋯ MUST HAVE A FOOTPRINT OF ITS OWN.

    It is a flex sibling of the comment body, which is `flex: 1` AND
    `flexShrink: 1`. With no size and no `flexShrink: 0`, a long comment or a
    narrow screen could compress the button toward zero width — the affordance
    the user is told to tap, squeezed out of existence. Asserted on both a
    top-level row and a reply, since a reply is indented by REPLY_INDENT and has
    the least horizontal room in the sheet.
  */
  it('gives the ⋯ an unshrinkable hit target on a comment AND on an indented reply', async () => {
    const wall = 'A very long comment '.repeat(40);
    (fetchComments as jest.Mock).mockResolvedValue([
      buildComment({ authorId: 'me', body: wall }),
      buildComment({ id: 'r1', authorId: 'me', body: wall, parentCommentId: 'c1' }),
    ]);
    renderSheet();

    fireEvent.press(await screen.findByTestId('comments-sheet-comment-c1-replies-toggle'));

    for (const id of ['comments-sheet-comment-c1', 'comments-sheet-comment-r1']) {
      const button = screen.getByTestId(`${id}-more-button`);
      const style = StyleSheet.flatten(button.props.style);
      expect(style.flexShrink).toBe(0);
      expect(style.width).toBeGreaterThan(0);
      expect(style.height).toBe(style.width);
      // Box + hitSlop clears the 44pt minimum target on both rows.
      expect(style.width + button.props.hitSlop * 2).toBeGreaterThanOrEqual(44);
    }
  });

  it('gives a tombstone no ⋯ at all', async () => {
    // Authored by the signed-in user, so the menu would appear if tombstones
    // weren't suppressed — and there is neither a body to delete nor an author
    // to report.
    (fetchComments as jest.Mock).mockResolvedValue([
      buildComment({ authorId: 'me', author: null, body: null, isDeleted: true }),
      buildComment({ id: 'r1', authorId: 'a2', body: 'Still here', parentCommentId: 'c1' }),
    ]);
    renderSheet();

    await screen.findByTestId('comments-sheet-comment-c1-tombstone');
    expect(screen.queryByTestId('comments-sheet-comment-c1-more-button')).toBeNull();
  });
});
