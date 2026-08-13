import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import type { ComponentProps, PropsWithChildren } from 'react';
import { Alert, Dimensions, Keyboard, Platform, ScrollView, StyleSheet } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { SpotlightThemeProvider, colors } from '@spotlight/design-system';

import {
  CommentsSheet,
  collectDescendantIds,
  composerBottomPadding,
  isTombstone,
  sheetHeightForKeyboard,
  systemBottomInset,
  shouldDismissOnDrag,
  tombstoneLabel,
  topLevelAncestorId,
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
    THE SEVENTH REPORT — AND THE ONE THE PREVIOUS SIX ALL MISSED.

    Confirmed with the user: the first tap on send with the keyboard up posts
    nothing and just drops the keyboard; tapping a SECOND time posts. That is
    React Native's `ScrollView` behaving exactly as documented in its own source
    — `_handleStartShouldSetResponderCapture` returns true, taking the touch
    away from every descendant, whenever `keyboardShouldPersistTaps` is unset or
    `'never'`, a `TextInput` is focused, and the target is not itself an input.
    Its comment there says it outright: "the first tap should be sent to the
    scroll view and dismiss the keyboard, then the second tap goes to the actual
    interior view."

    The scroller that does it is NOT in this component. Capture is dispatched
    root → target, so an ancestor is asked first, and this sheet is a `Modal`
    mounted by `PostCard` inside the host screen's list. Nothing rendered inside
    the Modal can outrank that — which is why six fixes aimed at this button
    changed nothing.

    WHAT THESE TESTS CAN AND CANNOT DO
    Jest cannot reproduce the interception itself: there is no responder
    negotiation here, no focused native input, and no ancestor list in the tree.
    So they do NOT prove the fix works on the phone. What they DO pin is the
    thing the fix rests on — that the send button posts from the RAW touch pair,
    which React Native dispatches through a separate event plugin that responder
    theft cannot suppress — and that adding those paths did not give one tap two
    ways to post. The device check is: one tap, keyboard up, one comment.
  */
  describe('the first tap while the keyboard is up', () => {
    /*
      The repro. An ancestor scroller took the responder on touch-down, so
      `onPressIn` and `onPress` — both responder-driven — never run. The raw
      touch pair is all that survives, and it has to be enough.
    */
    it('posts from the raw touch pair alone, when the responder was taken away', async () => {
      (addComment as jest.Mock).mockResolvedValue({ ok: true, id: 'c-new' });
      renderSheet();
      await screen.findByTestId('comments-sheet-empty');

      fireEvent.changeText(screen.getByTestId('comments-sheet-input'), 'First tap counts');
      // Deliberately NO pressIn and NO press: that is what being stolen from
      // looks like from inside this component.
      await act(async () => {
        fireEvent(screen.getByTestId('comments-sheet-send'), 'touchStart');
        fireEvent(screen.getByTestId('comments-sheet-send'), 'touchEnd');
      });

      expect(addComment as jest.Mock).toHaveBeenCalledTimes(1);
      expect(addComment as jest.Mock).toHaveBeenCalledWith('post-1', 'First tap counts', null);
      expect(await screen.findByText('First tap counts')).toBeTruthy();
      expect(screen.getByTestId('comments-sheet-input').props.value).toBe('');
    });

    /*
      The other half of the same change, and the one that would bite hardest if
      it were wrong: a tap that is NOT stolen now runs four handlers, and the
      user has already produced duplicate rows on this screen once today.
    */
    it('posts exactly once for a whole tap, through all four handlers', async () => {
      (addComment as jest.Mock).mockResolvedValue({ ok: true, id: 'c-new' });
      renderSheet();
      await screen.findByTestId('comments-sheet-empty');

      fireEvent.changeText(screen.getByTestId('comments-sheet-input'), 'Only one row');
      // The full sequence the runtime delivers when the button DOES win the
      // responder, in order.
      await act(async () => {
        fireEvent(screen.getByTestId('comments-sheet-send'), 'touchStart');
        fireEvent(screen.getByTestId('comments-sheet-send'), 'pressIn');
        fireEvent.press(screen.getByTestId('comments-sheet-send'));
        fireEvent(screen.getByTestId('comments-sheet-send'), 'touchEnd');
      });

      expect(addComment as jest.Mock).toHaveBeenCalledTimes(1);
      expect(screen.queryAllByText('Only one row')).toHaveLength(1);
    });

    /*
      VoiceOver activates through a bare `onPress` with no touch events around
      it. The per-gesture guard therefore has to be cleared at the END of a
      gesture rather than when a handler consumes it — clear it too early and
      `onTouchEnd` posts a second row; never clear it and the button goes deaf
      to a screen reader after the first tap of the session.
    */
    it('still posts for a bare press after a completed tap, so VoiceOver keeps working', async () => {
      (addComment as jest.Mock).mockResolvedValue({ ok: true, id: 'c-new' });
      renderSheet();
      await screen.findByTestId('comments-sheet-empty');

      fireEvent.changeText(screen.getByTestId('comments-sheet-input'), 'By touch');
      await act(async () => {
        fireEvent(screen.getByTestId('comments-sheet-send'), 'touchStart');
        fireEvent(screen.getByTestId('comments-sheet-send'), 'touchEnd');
      });

      /*
        The focus is not decoration. A successful send arms
        `ignoreNextDraftChangeRef`, which swallows the NEXT change event
        whatever it carries, and only `onFocus` disarms it. On iOS that is
        harmless because `Keyboard.dismiss()` resigns the field, so coming back
        to the composer always fires focus first — which is what this models.
        It is NOT harmless on Android, where dismissing the keyboard need not
        blur: with no focus event to disarm it, the guard eats the first
        character of the next comment. Left alone here (it is not this bug), but
        it is real, and this line is where it shows.
      */
      await act(async () => {
        fireEvent(screen.getByTestId('comments-sheet-input'), 'focus');
      });
      fireEvent.changeText(screen.getByTestId('comments-sheet-input'), 'By rotor');
      await act(async () => {
        fireEvent.press(screen.getByTestId('comments-sheet-send'));
      });

      expect(addComment as jest.Mock).toHaveBeenCalledTimes(2);
      expect(addComment as jest.Mock).toHaveBeenLastCalledWith('post-1', 'By rotor', null);
    });

    /*
      Why this sheet's OWN `keyboardShouldPersistTaps` was never going to fix
      it. The prop only governs touches inside the scroller that carries it, and
      the composer is a SIBLING of the thread list, not a descendant — so the
      button's taps were never in its scope. Pinned because the obvious "fix" is
      to set that prop and declare victory, and this asserts why that is empty.
    */
    it('leaves the send button outside the scroller that persists taps', async () => {
      renderSheet();
      await screen.findByTestId('comments-sheet-empty');

      const list = screen.getByTestId('comments-sheet-list');
      expect(list.props.keyboardShouldPersistTaps).toBe('handled');
      // The button the user taps is not in that subtree, so the prop above
      // cannot speak for it.
      expect(within(list).queryByTestId('comments-sheet-send')).toBeNull();
      expect(screen.getByTestId('comments-sheet-send')).toBeTruthy();
    });
  });

  // The composer empties on the PRESS, not when the write comes back. A field
  // that still holds your sentence for the length of a round trip is a field
  // that looks like it ignored you — which is exactly what invites the second
  // press this sheet has spent five fixes trying to stop.
  it('empties the composer on the press, before the write has come back', async () => {
    let settle: (value: { ok: true; id: string }) => void = () => undefined;
    (addComment as jest.Mock).mockReturnValue(
      new Promise<{ ok: true; id: string }>((resolve) => {
        settle = resolve;
      }),
    );
    renderSheet();
    await screen.findByTestId('comments-sheet-empty');

    fireEvent.changeText(screen.getByTestId('comments-sheet-input'), 'In flight');
    await act(async () => {
      fireEvent(screen.getByTestId('comments-sheet-send'), 'pressIn');
    });

    // The write has NOT resolved yet.
    expect(screen.getByTestId('comments-sheet-input').props.value).toBe('');

    await act(async () => {
      settle({ ok: true, id: 'c-new' });
    });
    expect(screen.getByTestId('comments-sheet-input').props.value).toBe('');
  });

  /*
    THE SIXTH REPORT, AND THE ACTUAL MECHANISM.

    "I press send, the keyboard goes away, and my text is still in the box." The
    row really was written every time — the staging table has the proof, including
    pairs fifteen seconds apart where the same sentence was sent twice by someone
    who had no way of knowing the first one landed. The text came BACK afterwards.

    iOS commits a pending autocorrect/predictive suggestion when the field resigns
    first responder, and RN reports that commit as an ordinary text change:
    `RCTBackedTextInputDelegateAdapter.textFieldDidEndEditing` fires
    `textInputDidChange` if the field's string differs from the last one it told
    JS about. The post-send `Keyboard.dismiss()` is what triggers the resign — so
    the sheet's own success path summoned the change event that refilled the
    composer with the comment it had just posted.

    Note the committed string here is NOT the string that was typed: autocorrect
    is what makes this fire at all, so a guard that only recognised an exact echo
    of the draft would let the corrected form straight through.
  */
  it('stays empty when the keyboard dismissal echoes the committed text back', async () => {
    (addComment as jest.Mock).mockResolvedValue({ ok: true, id: 'c-new' });
    renderSheet();
    await screen.findByTestId('comments-sheet-empty');

    fireEvent.changeText(screen.getByTestId('comments-sheet-input'), 'teh cards are great');
    await act(async () => {
      fireEvent(screen.getByTestId('comments-sheet-send'), 'pressIn');
      fireEvent.press(screen.getByTestId('comments-sheet-send'));
    });
    expect(addComment as jest.Mock).toHaveBeenCalledWith('post-1', 'teh cards are great', null);

    // The field resigning first responder, as RN delivers it: the autocorrected
    // sentence arriving as a change event after the send has already finished.
    await act(async () => {
      fireEvent.changeText(screen.getByTestId('comments-sheet-input'), 'the cards are great');
    });

    expect(screen.getByTestId('comments-sheet-input').props.value).toBe('');

    // One-shot, and only for that echo: coming back to write again is ordinary
    // typing and must land in the field.
    await act(async () => {
      fireEvent(screen.getByTestId('comments-sheet-input'), 'focus');
    });
    fireEvent.changeText(screen.getByTestId('comments-sheet-input'), 'a second one');
    expect(screen.getByTestId('comments-sheet-input').props.value).toBe('a second one');
  });

  // The echo is also how the same comment got posted twice: it put a full draft
  // back under a live send button, so the next press — by someone who thought
  // nothing had happened, or by a stray tap — had something to send.
  it('leaves nothing for a second press to post after the dismissal echo', async () => {
    (addComment as jest.Mock).mockResolvedValue({ ok: true, id: 'c-new' });
    renderSheet();
    await screen.findByTestId('comments-sheet-empty');

    fireEvent.changeText(screen.getByTestId('comments-sheet-input'), 'Sent once');
    await act(async () => {
      fireEvent(screen.getByTestId('comments-sheet-send'), 'pressIn');
      fireEvent.press(screen.getByTestId('comments-sheet-send'));
    });
    await act(async () => {
      fireEvent.changeText(screen.getByTestId('comments-sheet-input'), 'Sent once');
    });

    await act(async () => {
      fireEvent(screen.getByTestId('comments-sheet-send'), 'pressIn');
      fireEvent.press(screen.getByTestId('comments-sheet-send'));
    });

    expect(addComment as jest.Mock).toHaveBeenCalledTimes(1);
    expect(screen.queryAllByText('Sent once')).toHaveLength(1);
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

  // The post-send scroll is hung off MEASUREMENTS, never off a timer: a timed
  // scroll raced the sheet's own resize and landed short on a long thread (or at
  // the top of a short one). Where it is hung is the thing that must not
  // regress; where it lands is asserted below, in "where the thread sits".
  it('drives the post-send scroll from measurements, not from a timer', async () => {
    renderSheet();
    await screen.findByTestId('comments-sheet-empty');

    const list = screen.getByTestId('comments-sheet-list');
    expect(typeof list.props.onContentSizeChange).toBe('function');
    // The list's own height is half of the target arithmetic, so it has to be
    // measured rather than assumed.
    expect(typeof list.props.onLayout).toBe('function');
  });

  /*
    ─────────────────────────────────────────────────────────────────────────
    WHERE THE THREAD SITS, AND WHEN IT IS ALLOWED TO MOVE
    ─────────────────────────────────────────────────────────────────────────
    Three reports from one session, all of them this sheet's scroll/keyboard
    behaviour, and all three interacting:

      1. ~150pt of dead white between the last comment and the composer with
         the keyboard up. The sheet GROWS from 0.6 to 0.9 of the screen when
         the keyboard arrives, and a top-anchored short thread leaves the whole
         remainder as white.
      2. "when u post it should scroll down to the bottom so u can see ur
         comment; it should not scroll to the top after u post."
      3. "with lots of comments, for some reason it scrolls to like the middle
         of the comment page" on focusing the composer — being yanked away from
         the comment you scrolled up to in order to reply to it.

    (1) is why (2) looked like a scroll to the TOP: the offset was computed
    against a viewport that was still resizing, and on a short thread the clamp
    puts that at 0. And (3) was partly masking (2), so it cannot be removed
    without (2) being fixed properly.
  */
  describe('where the thread sits, and when it is allowed to move', () => {
    let scrollTo: jest.SpyInstance;
    let scrollToEnd: jest.SpyInstance;

    beforeEach(() => {
      // The RN jest mock hangs both on `ScrollView.prototype`, so a ref-less
      // test can still see exactly where the list was told to go.
      scrollTo = jest.spyOn(ScrollView.prototype, 'scrollTo').mockImplementation(() => undefined);
      scrollToEnd = jest
        .spyOn(ScrollView.prototype, 'scrollToEnd')
        .mockImplementation(() => undefined);
    });

    /** The runtime reporting a measured box, which is what releases the scroll. */
    function layout(elementTestID: string, box: { height: number; y?: number }) {
      fireEvent(screen.getByTestId(elementTestID), 'layout', {
        nativeEvent: { layout: { height: box.height, width: 361, x: 0, y: box.y ?? 0 } },
      });
    }

    // (1) The screenshot: three short comments, then a tall band of white, then
    // the composer. The thread has to sit ON the composer instead.
    it('bottom-anchors a short thread so it rests on the composer, 16 above it', async () => {
      (fetchComments as jest.Mock).mockResolvedValue([buildComment()]);
      renderSheet();
      await screen.findByText('Great card!');

      const content = StyleSheet.flatten(
        screen.getByTestId('comments-sheet-list').props.contentContainerStyle,
      );
      // `flexGrow` alone makes the container the viewport's height and leaves
      // the comments at the top of it — which IS the dead space. Anchoring to
      // the end is what puts a short thread against the composer, and a thread
      // taller than the viewport has no free space to distribute so it scrolls
      // exactly as before.
      expect(content.flexGrow).toBe(1);
      expect(content.justifyContent).toBe('flex-end');

      // And the gap it rests at is the 16 that was asked for: half under the
      // last comment, half above the field, divider centred in it.
      const composer = StyleSheet.flatten(
        screen.getByTestId('comments-sheet-composer').props.style,
      );
      expect(content.paddingBottom + composer.paddingTop).toBe(16);
    });

    /*
      ─────────────────────────────────────────────────────────────────────────
      A LONG THREAD OPENS AT ITS END
      ─────────────────────────────────────────────────────────────────────────
      A comment thread is read newest-last, so opening at comment #1 of forty
      drops the reader in the archive with nothing to say there is more below.
      Reported as the sheet "feeling like it's in the middle" — the only way to
      reach the conversation was to tap the composer, which is the focus scroll
      doing this job by proxy.

      INSTANT, not animated. This is where the thread RESTS: arriving already at
      the end reads as its natural position, whereas an animated scroll on the
      first frame reads as the sheet jumping the moment you look at it. The
      animated scrolls are the ones that answer something the reader just did.

      And through the same computed `scrollTo` as everything else — a
      `scrollToEnd` here would put the unclamped command on the FIRST FRAME,
      which is the worst possible place for the white gap.
    */
    it('opens a long thread at its end, instantly', async () => {
      (fetchComments as jest.Mock).mockResolvedValue([
        buildComment({ id: 'c1', body: 'One' }),
        buildComment({ id: 'c2', body: 'Two' }),
      ]);
      renderSheet();
      await screen.findByText('One');

      // Nothing can be aimed at before the list and the blocks have reported
      // their boxes — which is why this is hung on the measurements and not on a
      // load-time timer racing the first layout.
      expect(scrollTo).not.toHaveBeenCalled();

      layout('comments-sheet-list', { height: 300 });
      layout('comments-sheet-thread-c1', { height: 600, y: 12 });
      expect(scrollTo).not.toHaveBeenCalled();

      layout('comments-sheet-thread-c2', { height: 600, y: 632 });

      // The LAST block's bottom at the bottom of the list: 632 + 600 + 8 - 300.
      expect(scrollTo).toHaveBeenCalledWith({ animated: false, y: 940 });
      expect(scrollTo).toHaveBeenCalledTimes(1);
      expect(scrollToEnd).not.toHaveBeenCalled();
    });

    /*
      And a SHORT thread does not move at all. Its target clamps to 0, which is
      where a freshly-opened list already is, so no command is issued — the
      bottom anchor above has that case right on its own and does not need to be
      helped.
    */
    it('does not move a short thread when the sheet opens', async () => {
      (fetchComments as jest.Mock).mockResolvedValue([buildComment({ id: 'c1', body: 'One' })]);
      renderSheet();
      await screen.findByText('One');

      layout('comments-sheet-list', { height: 400 });
      layout('comments-sheet-thread-c1', { height: 100, y: 12 });

      expect(scrollTo).not.toHaveBeenCalled();
      expect(scrollToEnd).not.toHaveBeenCalled();
    });

    // The other half of bottom-anchoring: an EMPTY thread must not end up with
    // its prompt shoved down onto the composer.
    it('still centres the empty state rather than pinning it to the composer', async () => {
      renderSheet();
      const empty = await screen.findByTestId('comments-sheet-empty');

      // `flex: 1` absorbs the free space `justifyContent: flex-end` would
      // otherwise push down, so the prompt keeps the middle of the sheet.
      expect(StyleSheet.flatten(empty.props.style)).toMatchObject({
        flex: 1,
        justifyContent: 'center',
      });
    });

    /*
      (2) The scroll is aimed at a MEASURED box, and only once the sheet has
      stopped moving under it.

      `Keyboard.dismiss()` on a successful send drops the composer's padding
      from `keyboardHeight + 8` to 16 immediately while the sheet's height eases
      from 0.9 to 0.6 of the screen over 250ms — so for a quarter of a second
      the list viewport is a third of a screen taller than it is about to be.
      The old scroll fired inside that window from `onContentSizeChange` alone
      and stopped short; on a short thread it was clamped back to 0, which is
      the reported "it scrolls to the top after you post".
    */
    it('scrolls to the comment you just posted, once its block has been measured', async () => {
      (addComment as jest.Mock).mockResolvedValue({ ok: true, id: 'c-new' });
      (fetchComments as jest.Mock).mockResolvedValue([buildComment({ id: 'c1', body: 'One' })]);
      renderSheet();
      await screen.findByText('One');

      layout('comments-sheet-list', { height: 400 });
      layout('comments-sheet-thread-c1', { height: 480, y: 12 });
      // Also releases the opening scroll to the end of the thread; forget it so
      // the assertions below are about the post-send scroll under test.
      scrollTo.mockClear();

      fireEvent.changeText(screen.getByTestId('comments-sheet-input'), 'Mine');
      await act(async () => {
        fireEvent.press(screen.getByTestId('comments-sheet-send'));
      });
      expect(await screen.findByText('Mine')).toBeTruthy();

      // The row is in state, but nothing has measured it — the exact frame the
      // old timed scroll fired on.
      expect(scrollTo).not.toHaveBeenCalled();

      layout('comments-sheet-thread-c-new', { height: 90, y: 500 });

      // 500 (top of the new block) + 90 (its height) + 8 (the list's own bottom
      // padding) - 400 of viewport: its bottom edge, at the bottom of the list.
      expect(scrollTo).toHaveBeenCalledWith({ animated: true, y: 198 });
    });

    /*
      (2), the case "scroll to the bottom" gets WRONG — and (4), the case the
      BLOCK gets wrong.

      A reply is inserted under its parent, not appended to the thread, so the end
      of the list is not where it went: scrolling there would carry you away from
      the reply you just wrote. But the block that parent sits in is not the
      answer either. The thread flattens every depth under one top-level block, so
      the block's bottom is only the reply's bottom while the reply happens to be
      the last row in it — and what was asked for is the REPLY at the bottom of
      the viewport with the list's own padding above the composer.

      So the reply row is measured in its own right, inside its block, and the two
      coordinates are added. The numbers here pull them apart on purpose: the
      block ends at 612 and the reply at 492, and the target has to come from the
      reply.
    */
    it('lands on the REPLY itself, not on the end of the thread or the end of its block', async () => {
      (addComment as jest.Mock).mockResolvedValue({ ok: true, id: 'r-new' });
      (fetchComments as jest.Mock).mockResolvedValue([
        buildComment({ id: 'c1', body: 'Reply to me' }),
        buildComment({ id: 'c2', body: 'Last word' }),
      ]);
      renderSheet();
      await screen.findByText('Reply to me');

      layout('comments-sheet-list', { height: 400 });
      layout('comments-sheet-thread-c1', { height: 300, y: 12 });
      layout('comments-sheet-thread-c2', { height: 100, y: 332 });
      // Also releases the opening scroll to the end of the thread; forget it so
      // the assertions below are about the post-send scroll under test.
      scrollTo.mockClear();

      fireEvent.press(screen.getByTestId('comments-sheet-comment-c1-reply'));
      fireEvent.changeText(screen.getByTestId('comments-sheet-input'), 'Under yours');
      await act(async () => {
        fireEvent.press(screen.getByTestId('comments-sheet-send'));
      });
      expect(addComment as jest.Mock).toHaveBeenCalledWith('post-1', 'Under yours', 'c1');

      /*
        The content-size change arrives from the same layout pass as the row's own
        measurement, in an order this component does not choose — so it is fired
        FIRST here, before anything has been re-measured. It must not be allowed
        to release the scroll: c1's box is still the one from before the reply
        existed, and an offset computed from it lands above the reply (and on a
        short thread is clamped to 0, which is the "it scrolled to the top"
        report). The old code's answer to it was `scrollToEnd`.
      */
      await act(async () => {
        fireEvent(screen.getByTestId('comments-sheet-list'), 'contentSizeChange', 361, 500);
      });
      // c2 is the end of the thread and has nothing to do with what was posted,
      // so nothing has moved yet in either direction.
      expect(scrollToEnd).not.toHaveBeenCalled();
      expect(scrollTo).not.toHaveBeenCalled();

      // c1's block grew by the reply that was just added to it. On its own that
      // is NOT enough any more — the block's bottom is 12 + 600 = 612, which is
      // not where the reply is.
      layout('comments-sheet-thread-c1', { height: 600, y: 12 });
      expect(scrollTo).not.toHaveBeenCalled();

      // The reply row's own box, reported inside its block.
      layout('comments-sheet-reply-row-r-new', { height: 80, y: 400 });

      // 12 (block) + 400 (row within it) + 80 (its height) + 8 (the list's own
      // bottom padding) - 400 of viewport: the REPLY's bottom edge at the bottom
      // of the list, with the padding as breathing room above the composer.
      // The block's bottom would have said 220.
      expect(scrollTo).toHaveBeenCalledWith({ animated: true, y: 100 });
      expect(scrollTo).toHaveBeenCalledTimes(1);
      expect(scrollToEnd).not.toHaveBeenCalled();
    });

    /*
      (3) Focus ARMS a scroll; it never performs one.

      Opening the composer does owe the thread a move — the end of it for the
      field, the comment you tapped for Reply — but not yet and not from here.
      The composer's `paddingBottom` jumps on the keyboard event while the
      sheet's height eases over `SHEET_RESIZE_MS`, so an offset computed at focus
      is computed against a viewport a third of a screen away from the one it
      will be measured against. Aiming there is what put the thread "in the
      middle of the comment page" and, through the unclamped `scrollToEnd`, what
      left dead white space under it.

      So with no keyboard, nothing moves — the target waits for the sheet to
      settle. Where it lands once it does is pinned in "opening the composer over
      a live keyboard" below.
    */
    it('performs no scroll at the moment the composer is focused', async () => {
      (fetchComments as jest.Mock).mockResolvedValue([buildComment({ id: 'c1', body: 'One' })]);
      renderSheet();
      await screen.findByText('One');

      await act(async () => {
        fireEvent(screen.getByTestId('comments-sheet-input'), 'focus');
        // The scroll this replaced was hung on a `requestAnimationFrame`, which
        // jest polyfills as `setTimeout(…, 0)` — so let one turn run before
        // concluding that nothing happened.
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      expect(scrollTo).not.toHaveBeenCalled();
      expect(scrollToEnd).not.toHaveBeenCalled();
    });

    /*
      The interaction the focus change could have broken. Reply focuses the
      composer, and `onBlur` ends the reply — so if focus were ever to cost the
      field its focus (or the banner its state) the reply would silently become
      a top-level comment posted at the bottom of the thread.
    */
    it('keeps "replying to" through the focus that Reply asks for, and posts under the parent', async () => {
      (addComment as jest.Mock).mockResolvedValue({ ok: true, id: 'r-new' });
      (fetchComments as jest.Mock).mockResolvedValue([
        buildComment({ id: 'c1', body: 'Way up top' }),
      ]);
      renderSheet();
      await screen.findByText('Way up top');

      fireEvent.press(screen.getByTestId('comments-sheet-comment-c1-reply'));
      await act(async () => {
        fireEvent(screen.getByTestId('comments-sheet-input'), 'focus');
      });

      expect(screen.getByTestId('comments-sheet-reply-banner')).toHaveTextContent(
        'Replying to Misty',
      );
      expect(screen.getByTestId('comments-sheet-input').props.placeholder).toBe('Add a reply…');

      fireEvent.changeText(screen.getByTestId('comments-sheet-input'), 'Right here');
      await act(async () => {
        fireEvent.press(screen.getByTestId('comments-sheet-send'));
      });

      expect(addComment as jest.Mock).toHaveBeenCalledWith('post-1', 'Right here', 'c1');
      // Under its parent and revealed, not hidden behind the replies toggle.
      // A regex, not the exact string: a reply's body renders alongside the
      // inline blue @mention in the same `Text`.
      expect(await screen.findByTestId('comments-sheet-comment-r-new')).toHaveTextContent(
        /Right here/,
      );
    });

    /*
      (1), and the reason it was never actually fixed: the sheet's keyboard-up
      height and the composer's keyboard-up padding were two INDEPENDENT numbers.

      The height was a flat `SCREEN_HEIGHT * 0.9` — a growth of 0.3 of the screen,
      whatever the keyboard turned out to be — while the same view padded its
      bottom by the measured `keyboardHeight + 8`. The comment beside the padding
      claimed "the sheet grew by the same amount, so the thread keeps its height";
      it only did when those two happened to agree. Where they disagreed the
      difference landed in the list: a keyboard shorter than the fixed growth left
      the thread taller than it needs to be, which bottom-anchored is dead white
      space, and a taller one quietly shortened the thread instead.

      So the growth is now derived from the padding it is paying for, and the
      claim is testable: the list's height is the sheet minus its bottom padding
      (minus the header and composer, which do not change), and that has to come
      out the same with the keyboard up as with it down.
    */
    describe('how tall the sheet gets for the keyboard', () => {
      const SCREEN_HEIGHT = Dimensions.get('window').height;
      const RESTING = SCREEN_HEIGHT * 0.6;
      const MAX = SCREEN_HEIGHT * 0.9;
      /** Everything the thread does NOT get: the sheet's own bottom padding. */
      const composerPadding = (keyboardHeight: number) =>
        keyboardHeight > 0 ? keyboardHeight + 8 : 16;
      /** What the list is left with, up to the fixed header/composer chrome. */
      const threadHeight = (keyboardHeight: number) =>
        sheetHeightForKeyboard(keyboardHeight) - composerPadding(keyboardHeight);

      it('rests at 0.6 of the screen with the keyboard down', () => {
        expect(sheetHeightForKeyboard(0)).toBe(RESTING);
        expect(sheetHeightForKeyboard(-1)).toBe(RESTING);
      });

      it('grows by exactly what the composer pays, so the thread keeps its height', () => {
        // Small enough to fit inside the 0.3-of-the-screen headroom, which is
        // where the old fixed height overshot and left white space.
        const keyboard = 120;
        expect(sheetHeightForKeyboard(keyboard)).toBe(RESTING + keyboard + 8 - 16);
        // The claim in the comment beside `paddingBottom`, stated as arithmetic.
        expect(threadHeight(keyboard)).toBeCloseTo(threadHeight(0), 5);
        expect(threadHeight(200)).toBeCloseTo(threadHeight(0), 5);
      });

      it('stops at 0.9 of the screen, and says so by shortening the thread instead', () => {
        // A full-size phone keyboard is taller than there is room to grow into.
        expect(sheetHeightForKeyboard(SCREEN_HEIGHT)).toBe(MAX);
        // Past the cap the thread does pay the remainder — the alternative is a
        // sheet taller than the screen. It must never GAIN height, which is the
        // white-space direction.
        expect(threadHeight(SCREEN_HEIGHT)).toBeLessThan(threadHeight(0));
      });

      it('does not grow when the platform resizes the window instead of overlaying', () => {
        /*
          The growth exists solely to pay for the composer's keyboard padding.
          A platform that shrinks the WINDOW for the keyboard has already lifted
          the composer, so growing there would make the sheet taller than the
          window it now lives in and push the composer out of what is left.

          NOTE: Android is NOT that platform today, and assuming it was is what
          buried the comment input. `softwareKeyboardLayoutMode` is unset so
          Expo asks for `adjustResize`, but EDGE-TO-EDGE (default on Expo SDK 55
          / RN 0.83, enforced by Android 15) means the window is never resized —
          the app draws behind the IME. Hence `KEYBOARD_OVERLAYS_CONTENT` is
          true everywhere and this branch is dormant. It is kept, and tested,
          because it is one config flag away from being live again.
        */
        expect(sheetHeightForKeyboard(336, false)).toBe(RESTING);
        expect(sheetHeightForKeyboard(120, false)).toBe(RESTING);
        // What actually ships: the keyboard overlays, so the sheet grows.
        expect(sheetHeightForKeyboard(120, true)).toBeGreaterThan(RESTING);
      });
    });

    it('attributes a reply of any depth to the block it is drawn in', () => {
      const comments = [
        buildComment({ id: 'c1' }),
        buildComment({ id: 'r1', parentCommentId: 'c1' }),
        buildComment({ id: 'r2', parentCommentId: 'r1' }),
      ];
      expect(topLevelAncestorId(comments, 'r2')).toBe('c1');
      expect(topLevelAncestorId(comments, 'c1')).toBe('c1');
      // A row the thread has never heard of — which is what a just-posted
      // top-level comment is — answers for itself.
      expect(topLevelAncestorId(comments, 'brand-new')).toBe('brand-new');
    });
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

  /*
    A notification about a reply has to land ON that reply. Replies are collapsed
    behind the "N replies" toggle, so without this the thread opened with the very
    comment the notification was about still hidden.
  */
  describe('opening on a notified comment', () => {
    const thread = [
      buildComment({ id: 'c1', body: 'Top level', likeCount: 0 }),
      buildComment({
        id: 'r1',
        author: { displayName: 'Brock', handle: 'brock', avatarUrl: null, isVerified: false },
        body: 'The reply you were told about',
        parentCommentId: 'c1',
      }),
    ];

    it('expands the thread the reply lives in, without a tap', async () => {
      (fetchComments as jest.Mock).mockResolvedValue(thread);

      renderSheet({ focusCommentId: 'r1' });

      // Visible immediately — no press on the replies toggle.
      expect(await screen.findByTestId('comments-sheet-comment-r1')).toBeTruthy();
      // Loose match: the body renders in segments beside the @mention.
      expect(screen.getByText(/The reply you were told about/)).toBeTruthy();
      expect(screen.getByText('Hide replies')).toBeTruthy();
    });

    it('leaves replies collapsed when no comment was notified', async () => {
      (fetchComments as jest.Mock).mockResolvedValue(thread);

      renderSheet();

      await screen.findByText('Top level');
      // The default remains a collapsed thread — this only changes for a
      // notification that names a comment.
      expect(screen.queryByTestId('comments-sheet-comment-r1')).toBeNull();
      expect(screen.getByText('1 reply')).toBeTruthy();
    });

    it('does not expand anything when the notified comment is top-level', async () => {
      (fetchComments as jest.Mock).mockResolvedValue(thread);

      renderSheet({ focusCommentId: 'c1' });

      await screen.findByText('Top level');
      expect(screen.queryByTestId('comments-sheet-comment-r1')).toBeNull();
    });
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
      // No replies to promise about — but the row does not disappear either, and
      // the confirmation has to say so now that it leaves a tombstone.
      expect(
        screen.getByText(
          "Your comment will be removed and the thread will show it was deleted. This can't be undone.",
        ),
      ).toBeTruthy();
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

    /*
      EVERY DELETE SAYS SO, INCLUDING THE ONE NOBODY REPLIED TO.

      Reported as "only the first deleted comment says 'This comment was
      deleted'". Nothing was broken: a tombstone survived only while it had
      replies to hold up, so the one comment that had been answered left a line
      and the rest were removed outright. The user's call is that the thread says
      the same thing about every comment that has been deleted, so a childless
      delete leaves a tombstone too.
    */
    it('leaves a tombstone for a childless comment, and still drops the post count by one', async () => {
      (fetchComments as jest.Mock).mockResolvedValue([mine(), theirs()]);
      // Never resolves: proves the row is soft-deleted BEFORE the write returns.
      (deleteComment as jest.Mock).mockReturnValue(new Promise(() => {}));
      const onCommentCountResolved = jest.fn();
      renderSheet({ onCommentCountResolved });

      await waitFor(() => expect(onCommentCountResolved).toHaveBeenCalledWith(2));
      fireEvent(screen.getByTestId('comments-sheet-comment-c1'), 'longPress');
      await confirmDelete();

      // The body is gone…
      expect(screen.queryByText('My take')).toBeNull();
      expect(screen.getByText('Their take')).toBeTruthy();
      // …and the row says so, with nothing hanging off it at all.
      expect(screen.getByTestId('comments-sheet-comment-c1-tombstone')).toHaveTextContent(
        'This comment was deleted',
      );
      // The count is unmoved by that: a tombstone is not a comment anybody wrote,
      // and the DB's own comment_count trigger decrements regardless of replies.
      expect(onCommentCountResolved).toHaveBeenLastCalledWith(1);
    });

    // The same rule one level down. A tombstoned REPLY is where "the thread
    // flattens every depth" could most easily have grown a second behaviour.
    it('leaves a tombstone for a childless REPLY too', async () => {
      (fetchComments as jest.Mock).mockResolvedValue([
        theirs(),
        buildComment({ id: 'r1', authorId: 'me', body: 'My reply', parentCommentId: 'c2' }),
      ]);
      const onCommentCountResolved = jest.fn();
      renderSheet({ onCommentCountResolved });

      fireEvent.press(await screen.findByTestId('comments-sheet-comment-c2-replies-toggle'));
      fireEvent(screen.getByTestId('comments-sheet-comment-r1'), 'longPress');
      await confirmDelete();

      expect(screen.queryByText('My reply')).toBeNull();
      expect(screen.getByTestId('comments-sheet-comment-r1-tombstone')).toHaveTextContent(
        'This reply was deleted',
      );
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
      DELETING EVERYTHING LEAVES A WALL OF TOMBSTONES, AND THAT IS THE POINT.

      This used to unwind: the parent stayed only because it had a reply, so
      deleting that reply stranded it and it was swept away, taking the whole
      chain with it. Two rules — "it says it was deleted" and "it silently
      disappears" — separated by whether somebody had answered you. Now the thread
      keeps both rows and keeps saying the same thing. The cost is real and
      accepted: a thread whose author deletes all of it reads as a column of
      "was deleted" lines.
    */
    it('keeps every tombstone when a whole branch is deleted, at both depths', async () => {
      (fetchComments as jest.Mock).mockResolvedValue([
        buildComment({ authorId: 'me', body: 'Parent' }),
        buildComment({ id: 'r1', authorId: 'me', body: 'My own reply', parentCommentId: 'c1' }),
      ]);
      const onCommentCountResolved = jest.fn();
      renderSheet({ onCommentCountResolved });

      fireEvent(await screen.findByTestId('comments-sheet-comment-c1'), 'longPress');
      await confirmDelete();
      expect(screen.getByTestId('comments-sheet-comment-c1-tombstone')).toBeTruthy();

      // Delete the reply too. Nothing hangs off the parent tombstone any more,
      // and it stays anyway.
      fireEvent(screen.getByTestId('comments-sheet-comment-r1'), 'longPress');
      await confirmDelete();

      expect(screen.getByTestId('comments-sheet-comment-c1-tombstone')).toHaveTextContent(
        'This comment was deleted',
      );
      expect(screen.getByTestId('comments-sheet-comment-r1-tombstone')).toHaveTextContent(
        'This reply was deleted',
      );
      // Nothing left to READ, though — which is what the count means, and why the
      // thread is not the empty state even at zero.
      expect(onCommentCountResolved).toHaveBeenLastCalledWith(0);
      expect(screen.queryByTestId('comments-sheet-empty')).toBeNull();
    });

    it('restores the reply under an existing tombstone when its delete fails', async () => {
      (fetchComments as jest.Mock).mockResolvedValue([
        buildTombstone({ authorId: 'me' }),
        buildComment({ id: 'r1', authorId: 'me', body: 'My own reply', parentCommentId: 'c1' }),
      ]);
      (deleteComment as jest.Mock).mockResolvedValue(false);
      renderSheet();

      fireEvent.press(await screen.findByTestId('comments-sheet-comment-c1-replies-toggle'));
      fireEvent(screen.getByTestId('comments-sheet-comment-r1'), 'longPress');
      await confirmDelete();

      // The reply's body comes back, and the older tombstone above it — which a
      // delete no longer touches at all — is still exactly where it was.
      expect(await screen.findByText('My own reply')).toBeTruthy();
      expect(screen.getByTestId('comments-sheet-comment-c1-tombstone')).toBeTruthy();
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

/*
  Opening the composer should move the thread to where you are about to write.

  This is NOT the old focus-scroll that was removed for landing "in the middle
  of the comment page". That one fired inside `onFocus`, while the keyboard was
  still travelling and the sheet still growing, so it aimed at a viewport that
  no longer existed a frame later. These arm a target on focus and spend it once
  the sheet's resize has completed — the same settled beat the post-send scroll
  waits for.
*/
describe('CommentsSheet — opening the composer over a live keyboard', () => {
  let scrollTo: jest.SpyInstance;
  let scrollToEnd: jest.SpyInstance;
  /**
   * The sheet subscribes with `Keyboard.addListener`, and RN's jest Keyboard has
   * no `emit`. Capturing the handler it registers is how the keyboard is raised
   * here — and it also pins that the sheet really does subscribe.
   */
  const keyboardHandlers = new Map<string, (event: unknown) => void>();

  beforeEach(() => {
    jest.clearAllMocks();
    (fetchComments as jest.Mock).mockResolvedValue([]);
    keyboardHandlers.clear();
    jest
      .spyOn(Keyboard, 'addListener')
      .mockImplementation((event: string, handler: (payload: never) => void) => {
        keyboardHandlers.set(event, handler as (payload: unknown) => void);
        return { remove: () => keyboardHandlers.delete(event) } as never;
      });
    scrollTo = jest.spyOn(ScrollView.prototype, 'scrollTo').mockImplementation(() => undefined);
    scrollToEnd = jest
      .spyOn(ScrollView.prototype, 'scrollToEnd')
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function layout(elementTestID: string, box: { height: number; y?: number }) {
    fireEvent(screen.getByTestId(elementTestID), 'layout', {
      nativeEvent: { layout: { height: box.height, width: 361, x: 0, y: box.y ?? 0 } },
    });
  }

  /** The keyboard coming up, on whichever event this platform listens for. */
  async function raiseKeyboard() {
    const show = Array.from(keyboardHandlers.entries()).find(([event]) =>
      event.toLowerCase().includes('show'),
    );
    expect(show).toBeDefined();
    await act(async () => {
      show?.[1]({ endCoordinates: { height: 300 } });
    });
  }

  /**
   * The keyboard event WITHOUT letting React commit it — the device ordering.
   * iOS posts `UIKeyboardWillShowNotification` from inside
   * `becomeFirstResponder`, so it is delivered before RN's `onFocus` and long
   * before the resize effect that reacts to it has run. Anything reading the
   * sheet's geometry in that gap sees a size it is about to leave.
   */
  function raiseKeyboardWithoutFlushing(height = 300) {
    const show = Array.from(keyboardHandlers.entries()).find(([event]) =>
      event.toLowerCase().includes('show'),
    );
    expect(show).toBeDefined();
    show?.[1]({ endCoordinates: { height } });
  }

  /** The keyboard going away, on whichever event this platform listens for. */
  async function lowerKeyboard() {
    const hide = Array.from(keyboardHandlers.entries()).find(([event]) =>
      event.toLowerCase().includes('hide'),
    );
    expect(hide).toBeDefined();
    await act(async () => {
      hide?.[1]({ endCoordinates: { height: 0 } });
    });
  }

  /** Past `SHEET_RESIZE_MS`, so the sheet's grow animation has really finished. */
  async function letTheSheetSettle() {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
    });
  }

  /**
   * A thread far taller than its viewport: 1232 of content in a 300 viewport.
   * This is the shape BOTH reported symptoms needed — `scrollToEnd`'s
   * `fmax(offsetY, 0)` pins anything shorter than the viewport to 0, so a short
   * thread can neither overshoot nor land in the middle.
   */
  function layoutLongThread() {
    layout('comments-sheet-list', { height: 300 });
    layout('comments-sheet-thread-c1', { height: 600, y: 12 });
    layout('comments-sheet-thread-c2', { height: 600, y: 632 });
    // These measurements are also what releases the sheet's OPENING scroll to
    // the end of the thread (pinned in "where the thread sits" below). Forget it
    // here so each assertion is about the scroll actually under test.
    scrollTo.mockClear();
  }

  /*
    ───────────────────────────────────────────────────────────────────────────
    ONE COMMAND CAUSED BOTH REPORTED SYMPTOMS
    ───────────────────────────────────────────────────────────────────────────
    "With lots of comments it scrolls to like the middle of the comment page",
    and later "I scroll to the top, click the input, and that awkward white
    space is there". Neither was a request to delete the scroll. Both were the
    scroll being executed as `scrollToEnd()`.

    `scrollToEnd` is the ONE scroll command React Native does not clamp on iOS.
    `RCTScrollViewComponentView.scrollTo:` (~line 915) builds a `maxRect` from
    `contentSize - bounds + contentInset` and clamps into it; `scrollToEnd:` at
    ~942 computes `contentSize.height - bounds.size.height` and applies only
    `fmax(offsetY, 0)`. UIScrollView keeps a programmatic offset past the end of
    its content, so any overshoot stays on screen as empty space under the last
    row.

    And this sheet handed it a viewport guaranteed to be mid-change: the
    composer's `paddingBottom` jumps to `keyboardHeight + 8` on the keyboard
    event while the sheet's height EASES over `SHEET_RESIZE_MS`, so the list is
    ~56pt tall on an 852pt iPhone against a settled ~312 — and the bounds a
    native command reads are the last MOUNTED layout, not the value JS just
    finished animating. Aim at the end against that and you land either past it
    (white space) or short of it (the middle of the thread).

    It never happened on Android because `ReactScrollViewManager.scrollToEnd`
    aims at `child.height + paddingBottom`, deliberately past the end, and
    `ScrollView.scrollTo`/`smoothScrollTo` clamp into the scroll range on the
    way in.

    So both scrolls survive, and both go through the clamped `scrollTo` with a
    target computed from a measured box, released only once the sheet has
    stopped moving. The three tests below are the two cases and the command that
    must never appear in either.
  */

  // CASE 1: tapping the field means "add to the end", so bring the end into view.
  it('scrolls to the bottom of a long thread when you tap the composer field', async () => {
    (fetchComments as jest.Mock).mockResolvedValue([
      buildComment({ id: 'c1', body: 'One' }),
      buildComment({ id: 'c2', body: 'Two' }),
    ]);
    renderSheet();
    await screen.findByText('One');
    layoutLongThread();

    fireEvent(screen.getByTestId('comments-sheet-input'), 'focus');
    // Nothing yet: the sheet has not started growing, let alone finished, and a
    // target computed here would be computed against a viewport about to change.
    expect(scrollTo).not.toHaveBeenCalled();

    await raiseKeyboard();
    await letTheSheetSettle();

    // The LAST block's bottom at the bottom of the list: 632 + 600 + 8 - 300.
    expect(scrollTo).toHaveBeenCalledWith({ animated: true, y: 940 });
    expect(scrollTo).toHaveBeenCalledTimes(1);
  });

  /*
    CASE 2: "the input should be right underneath the reply" — the comment you
    tapped sits immediately above the composer while you write.

    This target has now been wrong twice in two directions. First it aimed at
    the BLOCK's bottom (comment + all replies), which scrolled the tapped
    comment off the top. Then it clamped to the block's TOP, which kept the
    comment visible but parked it a whole screen away from the input, with the
    replies in between. The fix is to aim at the tapped comment's OWN ROW —
    measured in its own right, like reply rows always were — so its bottom edge
    lands against the composer whenever the thread has enough content below it.
  */
  it('lands the composer right under the tapped comment when the scroll can reach it', async () => {
    (fetchComments as jest.Mock).mockResolvedValue([
      buildComment({ id: 'c1', body: 'One' }),
      buildComment({ id: 'c2', body: 'Two' }),
    ]);
    renderSheet();
    await screen.findByText('One');
    layoutLongThread();
    // c2's own row, block-relative — the first 80 of its 600-tall block.
    layout('comments-sheet-comment-c2', { height: 80, y: 0 });

    fireEvent.press(screen.getByTestId('comments-sheet-comment-c2-reply'));
    await raiseKeyboard();
    await letTheSheetSettle();

    // Row bottom at the bottom of the list: 632 (block) + 0 + 80 + 8 - 300.
    // The BLOCK's bottom would have said 940; its top, 632.
    expect(scrollTo).toHaveBeenCalledWith({ animated: true, y: 420 });
    expect(scrollTo).toHaveBeenCalledTimes(1);
  });

  /*
    And when it CANNOT reach — the tapped comment is in the first viewport of
    content, so no legal offset puts its bottom against the composer — it gets
    as close as the clamp allows rather than giving up or overshooting.
  */
  it('gets as close as it can when the tapped comment is too near the top', async () => {
    (fetchComments as jest.Mock).mockResolvedValue([
      buildComment({ id: 'c1', body: 'One' }),
      buildComment({ id: 'c2', body: 'Two' }),
    ]);
    renderSheet();
    await screen.findByText('One');
    layoutLongThread();
    layout('comments-sheet-comment-c1', { height: 80, y: 0 });

    fireEvent.press(screen.getByTestId('comments-sheet-comment-c1-reply'));
    await raiseKeyboard();
    await letTheSheetSettle();

    expect(screen.getByTestId('comments-sheet-reply-banner')).toHaveTextContent(
      'Replying to Misty',
    );
    // 12 + 0 + 80 + 8 - 300 is negative: the row cannot come down to the
    // composer, so the clamp stops at 0 with the comment as low as it goes.
    expect(scrollTo).toHaveBeenCalledWith({ animated: true, y: 0 });
    expect(scrollTo).toHaveBeenCalledTimes(1);
  });

  /*
    And the clamp only ever binds when it has to. A block SHORTER than the
    viewport still gets the original treatment — its bottom brought up to sit
    just above the composer — because there the two answers agree and the bottom
    is the one that puts the comment nearest the field you are typing in.
  */
  it('still lifts a short block up against the composer', async () => {
    (fetchComments as jest.Mock).mockResolvedValue([
      buildComment({ id: 'c1', body: 'One' }),
      buildComment({ id: 'c2', body: 'Two' }),
    ]);
    renderSheet();
    await screen.findByText('One');
    layout('comments-sheet-list', { height: 300 });
    // c1 spans 12..212, comfortably inside a 300 viewport.
    layout('comments-sheet-thread-c1', { height: 200, y: 12 });
    layout('comments-sheet-thread-c2', { height: 600, y: 232 });
    layout('comments-sheet-comment-c1', { height: 180, y: 0 });
    scrollTo.mockClear();

    fireEvent.press(screen.getByTestId('comments-sheet-comment-c1-reply'));
    await raiseKeyboard();
    await letTheSheetSettle();

    /*
      12 + 0 + 180 + 8 - 300 is negative and clamps to 0. 0 is still ISSUED
      here, unlike the opening scroll's 0 — the list was left at 540 by the
      opening scroll, so this is a real move back up to the row being answered
      (see the `target === 0 && !pending.animated` skip).
    */
    expect(scrollTo).toHaveBeenCalledWith({ animated: true, y: 0 });
    expect(scrollTo).toHaveBeenCalledTimes(1);
  });

  /*
    A reply is aimed at as ITSELF, not as the block it is drawn in — the thread
    flattens every depth under one top-level block, so the block's bottom is only
    the reply's bottom while the reply happens to be the last row in it. Same
    two-coordinate arithmetic the post-send scroll uses for a just-posted reply.
  */
  it('lands on the reply itself when Reply is tapped on a reply', async () => {
    (fetchComments as jest.Mock).mockResolvedValue([
      buildComment({ id: 'c1', body: 'One' }),
      buildComment({ id: 'r1', body: 'A reply', parentCommentId: 'c1' }),
    ]);
    renderSheet();
    await screen.findByText('One');

    fireEvent.press(screen.getByTestId('comments-sheet-comment-c1-replies-toggle'));
    await screen.findByText(/A reply/);

    layout('comments-sheet-list', { height: 300 });
    layout('comments-sheet-thread-c1', { height: 600, y: 12 });
    layout('comments-sheet-reply-row-r1', { height: 80, y: 400 });
    // Also releases the opening scroll to the end of the thread; forget it so
    // the assertions below are about the scroll under test.
    scrollTo.mockClear();

    fireEvent.press(screen.getByTestId('comments-sheet-comment-r1-reply'));
    await raiseKeyboard();
    await letTheSheetSettle();

    // 12 (block) + 400 (row within it) + 80 (its height) + 8 - 300. The block's
    // bottom would have said 320, which is 200pt past the row.
    expect(scrollTo).toHaveBeenCalledWith({ animated: true, y: 200 });
  });

  /*
    REPORTED FROM A DEVICE: the SECOND time is the one that fails.

    "I clicked the text field and submitted my comment — great. And then after I
    submitted the comment I tried to make another comment and it did NOT scroll
    to the bottom."

    Two things this test does that the others do not, because the bug needs both:

    1. THE LIST'S VIEWPORT REALLY CHANGES between keyboard states (384 down, 312
       up), so a target computed against the wrong one is a DIFFERENT NUMBER and
       not merely early. That is what makes the failure visible at all: after a
       post the list is already sitting at the keyboard-DOWN end of the thread,
       so a target recomputed against that same viewport equals the current
       offset and nothing moves.

    2. THE KEYBOARD EVENT LANDS BEFORE `onFocus`, and before React commits. iOS
       posts `UIKeyboardWillShowNotification` from inside `becomeFirstResponder`,
       so it is delivered between the tap and RN's `onFocus` — hence the raw
       handler call outside `act` below. The listener writes `keyboardHeightRef`
       SYNCHRONOUSLY while the resize it implies is only claimed when the effect
       runs, so for that gap the sheet looks settled at a size it is about to
       leave.
  */
  it('scrolls to the end again when the composer is opened after posting', async () => {
    (addComment as jest.Mock).mockResolvedValue({ ok: true, id: 'c-new' });
    (fetchComments as jest.Mock).mockResolvedValue([
      buildComment({ id: 'c1', body: 'One' }),
      buildComment({ id: 'c2', body: 'Two' }),
    ]);
    renderSheet();
    await screen.findByText('One');

    // Keyboard-down viewport.
    layout('comments-sheet-list', { height: 384 });
    layout('comments-sheet-thread-c1', { height: 600, y: 12 });
    layout('comments-sheet-thread-c2', { height: 600, y: 632 });
    scrollTo.mockClear();

    // FIRST focus — the one the user says works.
    fireEvent(screen.getByTestId('comments-sheet-input'), 'focus');
    await raiseKeyboard();
    // The sheet grew, so the list is SHORTER with the keyboard up.
    layout('comments-sheet-list', { height: 312 });
    await letTheSheetSettle();
    expect(scrollTo).toHaveBeenCalledWith({ animated: true, y: 928 });

    // Post it. The send dismisses the keyboard itself; this suite's mocked
    // listener does not deliver that on its own.
    fireEvent.changeText(screen.getByTestId('comments-sheet-input'), 'Mine');
    await act(async () => {
      fireEvent.press(screen.getByTestId('comments-sheet-send'));
    });
    await screen.findByText('Mine');
    await lowerKeyboard();
    layout('comments-sheet-list', { height: 384 });
    layout('comments-sheet-thread-c-new', { height: 90, y: 1240 });
    await letTheSheetSettle();
    // Landed on the row just written, against the keyboard-DOWN viewport:
    // 1240 + 90 + 8 - 384. The list is now AT the end of the thread.
    expect(scrollTo).toHaveBeenCalledWith({ animated: true, y: 954 });

    scrollTo.mockClear();

    // SECOND focus, in the order the device delivers it: the keyboard
    // notification first and uncommitted, then `onFocus`.
    raiseKeyboardWithoutFlushing();
    fireEvent(screen.getByTestId('comments-sheet-input'), 'focus');
    layout('comments-sheet-list', { height: 312 });

    // The end of the thread with the keyboard UP: 1240 + 90 + 8 - 312. The list
    // has to travel the last 72pt, or the comment just written sits under the
    // composer. Polled rather than timed: the keyboard event above is delivered
    // WITHOUT `act`, exactly as the device delivers it, so React commits it —
    // and starts the resize this waits on — on its own schedule.
    await waitFor(() => expect(scrollTo).toHaveBeenCalledWith({ animated: true, y: 1026 }));
    // And specifically NOT the keyboard-down answer, which is where the list
    // already was — issuing that spends the target on a scroll that moves
    // nothing, and the real one never happens. That is the reported bug.
    expect(scrollTo).not.toHaveBeenCalledWith({ animated: true, y: 954 });
    expect(scrollToEnd).not.toHaveBeenCalled();
  });

  /*
    THE COMMAND THAT MUST NEVER APPEAR, from any path in this sheet.

    Kept as its own test rather than left implicit in the assertions above,
    because `scrollToEnd()` is the obvious way to write two of the three things
    this sheet does with the thread and it is the single call that produced both
    reported symptoms. If this fails, the white gap is back.
  */
  it('never reaches for the one scroll command iOS does not clamp', async () => {
    (addComment as jest.Mock).mockResolvedValue({ ok: true, id: 'c-new' });
    (fetchComments as jest.Mock).mockResolvedValue([
      buildComment({ id: 'c1', body: 'One' }),
      buildComment({ id: 'c2', body: 'Two' }),
    ]);
    renderSheet();
    await screen.findByText('One');
    layoutLongThread();

    // A whole session: open the composer (case 1), post (the post-send scroll),
    // then Reply (case 2) — every path that moves the thread.
    fireEvent(screen.getByTestId('comments-sheet-input'), 'focus');
    await raiseKeyboard();
    await letTheSheetSettle();

    fireEvent.changeText(screen.getByTestId('comments-sheet-input'), 'Mine');
    await act(async () => {
      fireEvent.press(screen.getByTestId('comments-sheet-send'));
    });
    await screen.findByText('Mine');
    // The send's own `Keyboard.dismiss()`, which this suite's mocked listener
    // does not deliver on its own. It is what releases the post-send scroll.
    await lowerKeyboard();
    layout('comments-sheet-thread-c-new', { height: 90, y: 1240 });
    await letTheSheetSettle();

    fireEvent.press(screen.getByTestId('comments-sheet-comment-c1-reply'));
    await raiseKeyboard();
    await letTheSheetSettle();

    // Three scrolls, all of them the clamped command.
    expect(scrollTo).toHaveBeenCalledTimes(3);
    expect(scrollToEnd).not.toHaveBeenCalled();
  });

  /*
    THE POST-SEND SCROLL WAITS FOR THE VIEWPORT, NOT FOR THE KEYBOARD.

    Its guard used to read `keyboardHeightRef.current > 0 || sheetResizingRef.current`,
    and the first half was only ever shorthand for the second: the one way to get
    here was a send that had just called `Keyboard.dismiss()`, so "keyboard still
    up" meant "the hide has not landed yet". As a standing rule it silently
    ABANDONS scrolls. Post a comment, tap the composer again before the new row's
    block has been measured, and the measurement arrives with the keyboard back
    up — the target then sat there forever and the thread never moved to what you
    wrote.

    `sheetResizingRef` is the real signal, and the send path claims it itself
    before dismissing, so the window this guard was actually written for is still
    covered.
  */
  it('lands a post-send scroll measured after the keyboard came back up', async () => {
    (addComment as jest.Mock).mockResolvedValue({ ok: true, id: 'c-new' });
    (fetchComments as jest.Mock).mockResolvedValue([buildComment({ id: 'c1', body: 'One' })]);
    renderSheet();
    await screen.findByText('One');

    layout('comments-sheet-list', { height: 400 });
    layout('comments-sheet-thread-c1', { height: 480, y: 12 });
    // Also releases the opening scroll to the end of the thread; forget it so
    // the assertions below are about the scroll under test.
    scrollTo.mockClear();

    // Posted with the keyboard already down, so no resize is owed on the way out
    // and the only thing the pending scroll is still waiting for is a box.
    fireEvent.changeText(screen.getByTestId('comments-sheet-input'), 'Mine');
    await act(async () => {
      fireEvent.press(screen.getByTestId('comments-sheet-send'));
    });
    await screen.findByText('Mine');
    expect(scrollTo).not.toHaveBeenCalled();

    // Back into the composer before the new block has ever been measured.
    fireEvent(screen.getByTestId('comments-sheet-input'), 'focus');
    await raiseKeyboard();
    layout('comments-sheet-thread-c-new', { height: 90, y: 500 });

    // 500 + 90 + 8 - 400, once the sheet has stopped growing. Under the old
    // guard this never ran at all.
    await waitFor(() => expect(scrollTo).toHaveBeenCalledWith({ animated: true, y: 198 }));
    // And it is the ONLY thing that moved the thread: re-opening the composer
    // no longer fires the unclamped `scrollToEnd` that left dead space under a
    // long thread. This is the "even worse after you post" half of the report —
    // the same beat now releases one measured, clamped scroll and nothing else.
    expect(scrollToEnd).not.toHaveBeenCalled();
    expect(scrollTo).toHaveBeenCalledTimes(1);
  });
});

/*
  ─────────────────────────────────────────────────────────────────────────────
  THE ANDROID NAVIGATION BAR
  ─────────────────────────────────────────────────────────────────────────────
  Reported on a Galaxy A17 as two separate bugs, which are one:

    1. keyboard DOWN — "the comment input is being covered by the ||| and the
       home and back button white bar underneath".
    2. keyboard UP   — "when the keyboard pops up it also hides the text field
       input for the comment too, when I try to type in it".

  The sheet had NO safe-area handling at all, and on Android the navigation bar
  is missing from BOTH numbers the composer is positioned by:

    - the sheet's `Modal` is an edge-to-edge dialog window (RN sets
      ADJUST_RESIZE but `enableEdgeToEdge()` makes it inert — see
      ReactModalHostView.kt and android/gradle.properties `edgeToEdgeEnabled`),
      so the nav bar is painted OVER the composer. 16pt does not clear it.
    - `keyboardDidShow`'s height on Android is `imeInsets.bottom -
      barInsets.bottom` (ReactRootView.checkForKeyboardEvents), i.e. the
      keyboard MINUS the nav bar — so padding by `keyboardHeight + 8` fell short
      by the nav bar's height and the keyboard drew over the field.

  The inset is therefore added in BOTH states, which is also what keeps it
  harmless: it is the same number in each, so it cancels out of the difference
  and `sheetHeightForKeyboard` is untouched.

  iOS reserves nothing extra and must not start to — the keyboard's reported
  frame already reaches the bottom of the screen there, and 16 over the home
  indicator is the design spec (34 was tried and left the composer floating).
*/
describe('CommentsSheet — clearing the system bars', () => {
  /** The bottom inset the wrapper publishes. */
  const SAFE_BOTTOM = safeAreaMetrics.insets.bottom; // 34
  const KEYBOARD = 300;

  const keyboardHandlers = new Map<string, (event: unknown) => void>();

  beforeEach(() => {
    jest.clearAllMocks();
    (fetchComments as jest.Mock).mockResolvedValue([]);
    (fetchLikedCommentIds as jest.Mock).mockResolvedValue(new Set());
    keyboardHandlers.clear();
    jest
      .spyOn(Keyboard, 'addListener')
      .mockImplementation((event: string, handler: (payload: never) => void) => {
        keyboardHandlers.set(event, handler as (payload: unknown) => void);
        return { remove: () => keyboardHandlers.delete(event) } as never;
      });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  /** The sheet's own bottom padding — what the composer reserves under itself. */
  function composerPadding(): number {
    return StyleSheet.flatten(screen.getByTestId('comments-sheet').props.style).paddingBottom;
  }

  /** Raise the keyboard on whichever event this platform subscribed to. */
  async function raiseKeyboard(height = KEYBOARD) {
    const show = Array.from(keyboardHandlers.entries()).find(([event]) =>
      event.toLowerCase().includes('show'),
    );
    expect(show).toBeDefined();
    await act(async () => {
      show?.[1]({ endCoordinates: { height } });
    });
  }

  describe('the inset itself', () => {
    it('is the navigation bar on Android and nothing on iOS', () => {
      expect(systemBottomInset(48, 'android')).toBe(48);
      // Gesture navigation is a smaller strip, but still a strip.
      expect(systemBottomInset(24, 'android')).toBe(24);
      // iOS: the home indicator is an overlay content may sit under, and 34
      // here was tried and rejected as visibly floating.
      expect(systemBottomInset(34, 'ios')).toBe(0);
      // Never negative, whatever a provider reports before it has measured.
      expect(systemBottomInset(-10, 'android')).toBe(0);
    });
  });

  describe('what the composer reserves', () => {
    it('adds the system strip to BOTH keyboard states', () => {
      // Keyboard down: the design gap ON TOP OF the nav bar, not instead of it.
      expect(composerBottomPadding(0, 48)).toBe(48 + 16);
      // Keyboard up: the nav bar is NOT in the reported keyboard height, so the
      // top of the keyboard is at keyboardHeight + navBar above the window.
      expect(composerBottomPadding(KEYBOARD, 48)).toBe(48 + KEYBOARD + 8);
    });

    it('is exactly what it always was where there is no system strip (iOS)', () => {
      expect(composerBottomPadding(0, 0)).toBe(16);
      expect(composerBottomPadding(KEYBOARD, 0)).toBe(KEYBOARD + 8);
    });

    it('leaves the sheet-growth arithmetic alone, because the strip cancels', () => {
      // The quantity `sheetHeightForKeyboard` grows the sheet by is the
      // DIFFERENCE between the two states. The inset is in both, identically,
      // so it drops out — which is why fixing Android cannot reintroduce the
      // height/padding mismatch documented on `composerLift`.
      for (const inset of [0, 24, 48]) {
        expect(composerBottomPadding(120, inset) - composerBottomPadding(0, inset)).toBe(
          sheetHeightForKeyboard(120) - sheetHeightForKeyboard(0),
        );
      }
    });

    it('still reserves nothing for a keyboard that resizes the window instead', () => {
      // Dormant today (`KEYBOARD_OVERLAYS_CONTENT`), but the nav bar is a
      // property of the window, not of the keyboard, so it stays either way.
      expect(composerBottomPadding(KEYBOARD, 48, false)).toBe(48 + 16);
    });
  });

  describe('on Android', () => {
    beforeEach(() => {
      jest.replaceProperty(Platform, 'OS', 'android');
    });

    // (1) The reported bug.
    it('clears the navigation bar with the keyboard down', async () => {
      renderSheet();
      await screen.findByTestId('comments-sheet-empty');
      expect(composerPadding()).toBe(SAFE_BOTTOM + 16);
    });

    // (2) The second report: the keyboard covering the field.
    it('sits above the keyboard, which is reported without the navigation bar', async () => {
      renderSheet();
      await screen.findByTestId('comments-sheet-empty');
      await raiseKeyboard();
      expect(composerPadding()).toBe(SAFE_BOTTOM + KEYBOARD + 8);
    });

    it('goes back to clearing just the navigation bar when the keyboard drops', async () => {
      renderSheet();
      await screen.findByTestId('comments-sheet-empty');
      await raiseKeyboard();

      const hide = Array.from(keyboardHandlers.entries()).find(([event]) =>
        event.toLowerCase().includes('hide'),
      );
      await act(async () => {
        hide?.[1]({ endCoordinates: { height: 0 } });
      });
      expect(composerPadding()).toBe(SAFE_BOTTOM + 16);
    });
  });

  describe('on iOS', () => {
    // iOS is the platform where both states already worked. These pin that
    // nothing moved by so much as a point.
    it('still rests at a flat 16, not at the 34pt home-indicator inset', async () => {
      renderSheet();
      await screen.findByTestId('comments-sheet-empty');
      expect(composerPadding()).toBe(16);
      expect(composerPadding()).not.toBe(SAFE_BOTTOM + 16);
    });

    it('still lifts by exactly the keyboard it was told about', async () => {
      renderSheet();
      await screen.findByTestId('comments-sheet-empty');
      await raiseKeyboard();
      expect(composerPadding()).toBe(KEYBOARD + 8);
    });
  });
});
