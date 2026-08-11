import { FlatList, StyleSheet } from 'react-native';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react-native';
import { useRouter } from 'expo-router';

import {
  DEFAULT_MESSAGE_LIMIT,
  type DmMessage,
  fetchConversationBlocked,
  fetchMessages,
  markConversationRead,
  sendMessage,
} from '@/features/social/dm-service';
import { DmThreadScreen } from '@/features/social/screens/dm-thread-screen';

import { renderWithProviders } from '../test-utils';

jest.mock('expo-router', () => ({
  useRouter: jest.fn(),
}));

jest.mock('@/features/social/dm-service', () => ({
  // Mirrors the real constant. Not `requireActual`, which would pull the whole
  // module — and its Supabase client — into a file that mocks it precisely to
  // avoid that. A literal here is safe because the thread reads the SAME export,
  // so the assertion below still fails the moment the list stops using it.
  DEFAULT_MESSAGE_LIMIT: 50,
  fetchConversationBlocked: jest.fn(),
  fetchMessages: jest.fn(),
  markConversationRead: jest.fn(),
  sendMessage: jest.fn(),
}));

// The thread decides which side a bubble sits on from the signed-in user's id.
// `requireActual` keeps the real `AuthProvider` defined for the test harness.
/*
  The shared-profile card is STUBBED so this file controls when it reports ready.
  The real one resolves instantly here (no profile -> unavailable -> ready), which
  makes the pending state — the whole point of the thread's wait — unobservable.
*/
const mockSharedProfileReadyCallbacks: (() => void)[] = [];
jest.mock('@/features/social/components/shared-profile-bubble', () => {
  const { View } = jest.requireActual('react-native');
  const ReactActual = jest.requireActual('react');
  return {
    SharedProfileBubble: ({ onReady, testID }: { onReady?: () => void; testID?: string }) => {
      if (onReady && !mockSharedProfileReadyCallbacks.includes(onReady)) {
        mockSharedProfileReadyCallbacks.push(onReady);
      }
      return ReactActual.createElement(View, { testID });
    },
  };
});

jest.mock('@/providers/auth-provider', () => ({
  ...jest.requireActual('@/providers/auth-provider'),
  useAuth: () => ({ accessToken: null, currentUser: { id: 'me' } }),
}));

function buildMessage(overrides: Partial<DmMessage> & Pick<DmMessage, 'id'>): DmMessage {
  return {
    conversationId: 'c-1',
    senderId: 'them',
    body: 'hello',
    createdAt: '2026-07-28T12:00:00.000Z',
    // Plain text by default; an attachment is the exception, not the norm.
    sharedPostId: null,
    sharedProfileTab: null,
    sharedProfileUserId: null,
    ...overrides,
  };
}

/** `alignSelf` is what puts a bubble on its side of the thread. */
function alignSelfOf(testID: string): unknown {
  return StyleSheet.flatten(screen.getByTestId(testID).props.style)?.alignSelf;
}

const back = jest.fn();
const push = jest.fn();

describe('DmThreadScreen', () => {
  beforeEach(() => {
    mockSharedProfileReadyCallbacks.length = 0;
    jest.clearAllMocks();
    (useRouter as jest.Mock).mockReturnValue({ back, push });
    (fetchMessages as jest.Mock).mockResolvedValue([]);
    (markConversationRead as jest.Mock).mockResolvedValue(true);
    (sendMessage as jest.Mock).mockResolvedValue(null);
    (fetchConversationBlocked as jest.Mock).mockResolvedValue(false);
  });

  it('shows an empty state for a thread with no messages', async () => {
    renderWithProviders(<DmThreadScreen conversationId="c-1" title="Ash" />);

    await waitFor(() => {
      expect(screen.getByTestId('dm-thread-empty')).toBeTruthy();
    });
    expect(screen.getByText('Ash')).toBeTruthy();
  });

  /*
    THE PERSON YOU ARE TALKING TO IS REACHABLE FROM THE THREAD.

    The header was a bare name string and the bubbles carried no identity at all,
    which made this the one social surface in the app where someone's name was
    dead text — every other one (post cards, comments, search) routes to
    `/u/<handle>`.
  */
  describe('the counterparty', () => {
    const OTHER = { avatarUrl: null, displayName: 'Misty', handle: 'misty', userId: 'u-2' };

    it('shows their photo and handle in the header, and opens their profile', async () => {
      renderWithProviders(<DmThreadScreen conversationId="c-1" otherUser={OTHER} title="Misty" />);
      await waitFor(() => expect(screen.getByTestId('dm-thread-empty')).toBeTruthy());

      expect(screen.getByTestId('dm-thread-header-avatar')).toBeTruthy();
      expect(screen.getByText('@misty')).toBeTruthy();

      fireEvent.press(screen.getByTestId('dm-thread-header-identity'));
      expect(push).toHaveBeenCalledWith({
        pathname: '/u/[handle]',
        params: { handle: 'misty', userId: 'u-2' },
      });
    });

    it('puts their photo beside THEIR messages only, and it opens their profile too', async () => {
      (fetchMessages as jest.Mock).mockResolvedValue([
        buildMessage({ id: 'm-1', senderId: 'them', body: 'you coming?' }),
        buildMessage({ id: 'm-2', senderId: 'me', body: 'on my way' }),
      ]);
      renderWithProviders(<DmThreadScreen conversationId="c-1" otherUser={OTHER} title="Misty" />);
      await waitFor(() => expect(screen.getByText('you coming?')).toBeTruthy());

      // Your own face beside every line you sent is noise, and leads nowhere.
      expect(screen.queryByTestId('dm-thread-row-m-2-avatar')).not.toBeOnTheScreen();

      push.mockClear();
      fireEvent.press(screen.getByTestId('dm-thread-row-m-1-avatar'));
      expect(push).toHaveBeenCalledWith({
        pathname: '/u/[handle]',
        params: { handle: 'misty', userId: 'u-2' },
      });
    });

    // A collector who has not claimed a handle is still reachable by id; one with
    // NEITHER must not be dressed up as a link that goes nowhere.
    it('does not make the header tappable when there is nobody to open', async () => {
      renderWithProviders(<DmThreadScreen conversationId="c-1" title="Misty" />);
      await waitFor(() => expect(screen.getByTestId('dm-thread-empty')).toBeTruthy());

      push.mockClear();
      fireEvent.press(screen.getByTestId('dm-thread-header-identity'));
      expect(push).not.toHaveBeenCalled();
    });
  });

  it('renders the thread oldest-first with own messages on the right', async () => {
    (fetchMessages as jest.Mock).mockResolvedValue([
      buildMessage({ id: 'm-1', senderId: 'them', body: 'you coming?' }),
      buildMessage({
        id: 'm-2',
        senderId: 'me',
        body: 'on my way',
        createdAt: '2026-07-28T12:05:00.000Z',
      }),
    ]);

    renderWithProviders(<DmThreadScreen conversationId="c-1" />);

    await waitFor(() => {
      expect(screen.getByText('you coming?')).toBeTruthy();
    });
    expect(screen.getByText('on my way')).toBeTruthy();
    expect(alignSelfOf('dm-thread-row-m-1')).toBe('flex-start');
    expect(alignSelfOf('dm-thread-row-m-2')).toBe('flex-end');
  });

  it('marks the conversation read when the thread opens', async () => {
    renderWithProviders(<DmThreadScreen conversationId="c-77" />);

    await waitFor(() => {
      expect(markConversationRead).toHaveBeenCalledWith('c-77');
    });
  });

  // Sending used to scroll inside ONE `requestAnimationFrame`, which runs before
  // the list has measured the new row — so `scrollToEnd` used the old content
  // height and stopped short, leaving the message you just sent below the fold.
  // The scroll now waits for `onContentSizeChange`, the first moment the row is
  // measurable.
  it('scrolls to the newest message only once the list has measured it', async () => {
    const scrollToOffset = jest
      .spyOn(FlatList.prototype, 'scrollToOffset')
      .mockImplementation(() => {});
    (sendMessage as jest.Mock).mockResolvedValue(null);
    renderWithProviders(<DmThreadScreen conversationId="c-1" />);
    await waitFor(() => expect(fetchMessages).toHaveBeenCalled());

    scrollToOffset.mockClear();
    fireEvent.changeText(screen.getByTestId('dm-thread-input'), 'gm');
    fireEvent.press(screen.getByTestId('dm-thread-send'));

    // Nothing yet: the row is in state but the list has not measured it, which
    // is exactly the frame the old single-rAF scroll fired on and stopped short.
    expect(scrollToOffset).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent(screen.getByTestId('dm-thread-list'), 'contentSizeChange', 393, 2000);
    });

    /*
      Aimed at the MEASURED content height, not at `scrollToEnd`'s estimate.

      `scrollToEnd` derives its offset from what the list currently believes the
      content measures, and with variable-height rows that belief can be stale
      by exactly the row just added — so it stops a bubble short and the message
      you just sent stays under the composer. Over-scrolling is clamped by the
      scroll view, so aiming at the true height can only be right.

      Animated, because this is YOUR send — everything else jumps.
    */
    expect(scrollToOffset).toHaveBeenCalledWith({ animated: true, offset: 2000 });
    scrollToOffset.mockRestore();
  });

  it('appends optimistically, then reconciles the temp entry with the server row', async () => {
    let resolveSend: (value: DmMessage | null) => void = () => {};
    (sendMessage as jest.Mock).mockReturnValue(
      new Promise<DmMessage | null>((resolve) => {
        resolveSend = resolve;
      }),
    );

    renderWithProviders(<DmThreadScreen conversationId="c-1" />);

    await waitFor(() => expect(fetchMessages).toHaveBeenCalled());

    fireEvent.changeText(screen.getByTestId('dm-thread-input'), '  gm collectors  ');
    fireEvent.press(screen.getByTestId('dm-thread-send'));

    // Instantly on screen under a LOCAL id, and the composer is already empty —
    // before the request has resolved.
    expect(screen.getByText('gm collectors')).toBeTruthy();
    expect(screen.getByTestId('dm-thread-row-local-1')).toBeTruthy();
    expect(screen.getByTestId('dm-thread-input').props.value).toBe('');
    expect(sendMessage).toHaveBeenCalledWith('c-1', 'gm collectors');

    await act(async () => {
      resolveSend(
        buildMessage({
          id: 'server-1',
          senderId: 'me',
          body: 'gm collectors',
          createdAt: '2026-07-28T12:10:00.000Z',
        }),
      );
    });

    // The temp entry is REPLACED, not joined by a duplicate.
    await waitFor(() => expect(screen.getByTestId('dm-thread-row-server-1')).toBeTruthy());
    expect(screen.queryByTestId('dm-thread-row-local-1')).toBeNull();
    expect(screen.getAllByText('gm collectors')).toHaveLength(1);
    expect(alignSelfOf('dm-thread-row-server-1')).toBe('flex-end');
  });

  it('keeps the typed text on screen and marks it failed when the send returns null', async () => {
    // Null is a real, reachable outcome: the moderation prefilter marks the row
    // `removed` and it would not survive the next read.
    (sendMessage as jest.Mock).mockResolvedValue(null);

    renderWithProviders(<DmThreadScreen conversationId="c-1" />);

    await waitFor(() => expect(fetchMessages).toHaveBeenCalled());

    fireEvent.changeText(screen.getByTestId('dm-thread-input'), 'wanna trade?');
    fireEvent.press(screen.getByTestId('dm-thread-send'));

    await waitFor(() => expect(screen.getByTestId('dm-thread-failed-local-1')).toBeTruthy());
    // The words the user typed are never dropped.
    expect(screen.getByText('wanna trade?')).toBeTruthy();
    expect(screen.getByTestId('dm-thread-row-local-1')).toBeTruthy();
  });

  it('re-sends a failed message in place when it is tapped', async () => {
    (sendMessage as jest.Mock).mockResolvedValueOnce(null);

    renderWithProviders(<DmThreadScreen conversationId="c-1" />);

    await waitFor(() => expect(fetchMessages).toHaveBeenCalled());

    fireEvent.changeText(screen.getByTestId('dm-thread-input'), 'wanna trade?');
    fireEvent.press(screen.getByTestId('dm-thread-send'));
    await waitFor(() => expect(screen.getByTestId('dm-thread-failed-local-1')).toBeTruthy());

    (sendMessage as jest.Mock).mockResolvedValueOnce(
      buildMessage({ id: 'server-2', senderId: 'me', body: 'wanna trade?' }),
    );
    fireEvent.press(screen.getByLabelText('Retry sending'));

    await waitFor(() => expect(screen.getByTestId('dm-thread-row-server-2')).toBeTruthy());
    expect(screen.queryByTestId('dm-thread-row-local-1')).toBeNull();
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it('does nothing when send is pressed with an empty composer', async () => {
    renderWithProviders(<DmThreadScreen conversationId="c-1" />);

    await waitFor(() => expect(fetchMessages).toHaveBeenCalled());

    fireEvent.press(screen.getByTestId('dm-thread-send'));
    expect(sendMessage).not.toHaveBeenCalled();
  });

  // A block freezes a DM in BOTH directions (`conversation_has_block` wraps the
  // either-direction `is_blocked`), and `messages_insert` rejects every send.
  // Before this, the composer stayed fully live and the rejection surfaced only
  // as a red bubble with a permanent "tap to try again".
  describe('when the conversation is blocked', () => {
    it('replaces the composer with one direction-blind line, and keeps the thread readable', async () => {
      (fetchConversationBlocked as jest.Mock).mockResolvedValue(true);
      (fetchMessages as jest.Mock).mockResolvedValue([
        buildMessage({ id: 'm-1', senderId: 'them', body: 'say that again' }),
      ]);

      renderWithProviders(<DmThreadScreen conversationId="c-1" title="Someone" />);

      await waitFor(() => expect(screen.getByTestId('dm-thread-blocked')).toBeTruthy());
      expect(screen.getByText("You can't reply to this conversation.")).toBeTruthy();

      // Nothing left to type into or tap.
      expect(screen.queryByTestId('dm-thread-input')).toBeNull();
      expect(screen.queryByTestId('dm-thread-send')).toBeNull();

      // Reporting depends on the history staying on screen — the block freezes
      // the thread, it does not hide it.
      expect(screen.getByTestId('dm-thread-list')).toBeTruthy();
      expect(screen.getByText('say that again')).toBeTruthy();
    });

    it('never names who blocked whom', async () => {
      (fetchConversationBlocked as jest.Mock).mockResolvedValue(true);

      renderWithProviders(<DmThreadScreen conversationId="c-1" title="Ash" />);

      await waitFor(() => expect(screen.getByTestId('dm-thread-blocked')).toBeTruthy());
      // The service answer is direction-blind, so the copy has to be too: the
      // same words whether you blocked them or they blocked you. The HEADER
      // still names the person — that is the thread's title, and it is what lets
      // you find the conversation you meant to report.
      const notice = within(screen.getByTestId('dm-thread-blocked'));
      for (const leak of [/block/i, /Ash/, /they|them|their/i]) {
        expect(notice.queryByText(leak)).toBeNull();
      }
    });

    it('closes the composer and drops the retry when a send turns out to be blocked', async () => {
      // The other side can block while the thread is open, which is invisible
      // until something is attempted. The failed send triggers a re-ask.
      (fetchConversationBlocked as jest.Mock)
        .mockResolvedValueOnce(false)
        .mockResolvedValue(true);
      (sendMessage as jest.Mock).mockResolvedValue(null);

      renderWithProviders(<DmThreadScreen conversationId="c-1" />);
      await waitFor(() => expect(fetchMessages).toHaveBeenCalled());

      fireEvent.changeText(screen.getByTestId('dm-thread-input'), 'wanna trade?');
      fireEvent.press(screen.getByTestId('dm-thread-send'));

      await waitFor(() => expect(screen.getByTestId('dm-thread-blocked')).toBeTruthy());
      expect(fetchConversationBlocked).toHaveBeenCalledWith('c-1');

      // The words stay. The offer of a retry that can never succeed does not.
      expect(screen.getByText('wanna trade?')).toBeTruthy();
      expect(screen.getByText('Not sent')).toBeTruthy();
      expect(screen.queryByText('Not sent — tap to try again')).toBeNull();
      expect(screen.queryByLabelText('Retry sending')).toBeNull();

      // And the dead bubble cannot be tapped back into flight.
      fireEvent.press(screen.getByText('wanna trade?'));
      expect(sendMessage).toHaveBeenCalledTimes(1);
    });

    it('keeps the retry when an ordinary send failure is not a block', async () => {
      (fetchConversationBlocked as jest.Mock).mockResolvedValue(false);
      (sendMessage as jest.Mock).mockResolvedValue(null);

      renderWithProviders(<DmThreadScreen conversationId="c-1" />);
      await waitFor(() => expect(fetchMessages).toHaveBeenCalled());

      fireEvent.changeText(screen.getByTestId('dm-thread-input'), 'wanna trade?');
      fireEvent.press(screen.getByTestId('dm-thread-send'));

      await waitFor(() => expect(screen.getByTestId('dm-thread-failed-local-1')).toBeTruthy());
      expect(screen.queryByTestId('dm-thread-blocked')).toBeNull();
      expect(screen.getByTestId('dm-thread-input')).toBeTruthy();
      expect(screen.getByLabelText('Retry sending')).toBeTruthy();
    });

    // Null means "nobody answered" — a dropped request, or a schema predating
    // social_13, where the RLS gate does not exist either. Treating it as "not
    // blocked" would be a guess; treating it as blocked would lock a composer
    // that works.
    it('leaves the composer alone when the block state is unknown', async () => {
      (fetchConversationBlocked as jest.Mock).mockResolvedValue(null);
      (sendMessage as jest.Mock).mockResolvedValue(null);

      renderWithProviders(<DmThreadScreen conversationId="c-1" />);
      await waitFor(() => expect(fetchMessages).toHaveBeenCalled());

      expect(screen.queryByTestId('dm-thread-blocked')).toBeNull();

      fireEvent.changeText(screen.getByTestId('dm-thread-input'), 'gm');
      fireEvent.press(screen.getByTestId('dm-thread-send'));

      await waitFor(() => expect(screen.getByTestId('dm-thread-failed-local-1')).toBeTruthy());
      expect(screen.queryByTestId('dm-thread-blocked')).toBeNull();
      expect(screen.getByLabelText('Retry sending')).toBeTruthy();
    });

    it('does not send when a submit races the block being discovered', async () => {
      let resolveSend: (value: DmMessage | null) => void = () => {};
      (fetchConversationBlocked as jest.Mock)
        .mockResolvedValueOnce(false)
        .mockResolvedValue(true);
      (sendMessage as jest.Mock).mockReturnValue(
        new Promise<DmMessage | null>((resolve) => {
          resolveSend = resolve;
        }),
      );

      renderWithProviders(<DmThreadScreen conversationId="c-1" />);
      await waitFor(() => expect(fetchMessages).toHaveBeenCalled());

      const input = screen.getByTestId('dm-thread-input');
      fireEvent.changeText(input, 'first');
      // Keyboard "send" key, not the button — the path a disabled button misses.
      fireEvent(input, 'submitEditing');
      expect(sendMessage).toHaveBeenCalledTimes(1);

      // The first send fails, the re-ask says blocked, the composer closes.
      await act(async () => {
        resolveSend(null);
      });
      await waitFor(() => expect(screen.getByTestId('dm-thread-blocked')).toBeTruthy());

      // A submit that was already on its way finds a screen that refuses it.
      fireEvent(input, 'submitEditing');
      expect(sendMessage).toHaveBeenCalledTimes(1);
    });
  });

  /*
    A SHARED POST IS NOT A MESSAGE BUBBLE.

    The card draws its own neutral surface. Wrapping it in the sender tint put a
    solid purple slab around someone else's photo, and it read as a
    strangely-shaped message rather than as a post — the thing you pointed at,
    not the thing you said. So it looks identical on both sides of the thread.
  */
  /*
    ─────────────────────────────────────────────────────────────────────────
    NO FRAME MAY SHOW THE THREAD UN-PINNED
    ─────────────────────────────────────────────────────────────────────────
    This list is top-anchored and scrolled to the bottom afterwards, in
    `onLayout` / `onContentSizeChange` — both of which run after a frame has been
    drawn. Opening a thread therefore rendered the OLDEST messages and snapped to
    the newest, reported as "a weird flicker when opening my messages".

    Pinned as visibility rather than as scroll offset because the offset was
    never wrong; it was just applied a frame late, and a test on the offset would
    have passed throughout.
  */
  describe('opening a thread', () => {
    it('does not show the list until it has been pinned to the bottom', async () => {
      (fetchMessages as jest.Mock).mockResolvedValue([
        buildMessage({ id: 'm-1', body: 'oldest' }),
        buildMessage({ id: 'm-2', body: 'newest', createdAt: '2026-07-28T12:05:00.000Z' }),
      ]);

      renderWithProviders(<DmThreadScreen conversationId="c-1" />);
      await waitFor(() => expect(screen.getByTestId('dm-thread-row-m-1')).toBeTruthy());

      const opacityOf = () =>
        StyleSheet.flatten(screen.getByTestId('dm-thread-list').props.style)?.opacity;

      // The pin runs off layout/content-size, neither of which fires in this
      // environment on its own — so at this point the list is deliberately
      // invisible rather than showing the top of the thread.
      expect(opacityOf()).toBe(0);

      await act(async () => {
        fireEvent(screen.getByTestId('dm-thread-list'), 'contentSizeChange', 361, 900);
      });
      expect(opacityOf()).toBe(1);
    });

    /*
      THE THREAD DOES NOT WAIT FOR ITS SHARED CARDS. This is the assertion, not
      an omission.

      It did wait, so the conversation could appear as one piece — and that
      turned a thread which visibly loaded into one that sat blank for up to 1.5s
      and then snapped in. Worse, the wait was uneven: it counted only shared
      PROFILES, and a profile card reports ready instantly once its cache is
      warm, so on a second open the gate lifted while the shared POST card was
      still a placeholder that then grew ~155pt under the reader. Reported as
      "the messages flicker when I open them a second time".

      Waiting was the wrong tool. Each card now reserves its final height while
      it loads, so nothing changes size and there is nothing to hide.
    */
    it('reveals as soon as it pins, without any card reporting ready', async () => {
      (fetchMessages as jest.Mock).mockResolvedValue([
        buildMessage({ id: 'm-1', body: 'hello' }),
        buildMessage({
          id: 'm-2',
          body: '',
          sharedProfileUserId: 'owner-1',
          sharedProfileTab: 'wishlist',
          createdAt: '2026-07-28T12:05:00.000Z',
        }),
        buildMessage({
          id: 'm-3',
          body: '',
          sharedPostId: 'post-9',
          createdAt: '2026-07-28T12:06:00.000Z',
        }),
      ]);

      renderWithProviders(<DmThreadScreen conversationId="c-1" />);
      await waitFor(() => expect(screen.getByTestId('dm-thread-row-m-1')).toBeTruthy());

      await act(async () => {
        fireEvent(screen.getByTestId('dm-thread-list'), 'contentSizeChange', 361, 900);
      });

      // Visible with BOTH attachment kinds still unresolved — nobody called
      // `onReady`, and the thread no longer asks anyone to.
      expect(StyleSheet.flatten(screen.getByTestId('dm-thread-list').props.style)?.opacity).toBe(1);
      expect(mockSharedProfileReadyCallbacks).toHaveLength(0);
    });

    /*
      An empty thread has nothing to pin, so gating on the pin would hide its
      empty state forever — the failure mode this exception exists to stop.
    */
    it('shows an empty thread immediately, since there is nothing to pin', async () => {
      (fetchMessages as jest.Mock).mockResolvedValue([]);

      renderWithProviders(<DmThreadScreen conversationId="c-1" />);

      // One effect tick, not one frame: the reveal LATCHES in an effect so it can
      // never be recomputed back to hidden by a later batch of messages.
      await waitFor(() => {
        expect(StyleSheet.flatten(screen.getByTestId('dm-thread-list').props.style)?.opacity).toBe(
          1,
        );
      });
    });

    /*
      ───────────────────────────────────────────────────────────────────────
      AND ONCE SHOWN, IT IS NEVER TAKEN AWAY
      ───────────────────────────────────────────────────────────────────────
      Reported as "it appears for a sec, then flickers, then appears again". The
      gate was recomputed every render and `attachmentCount` derives from
      `messages`, so a second batch arriving pushed the count up while only the
      first card had reported — and the thread hid itself again mid-read.
    */
    it('stays visible when a later message adds another card', async () => {
      (fetchMessages as jest.Mock).mockResolvedValue([
        buildMessage({ id: 'm-1', body: 'hello' }),
        buildMessage({
          id: 'm-2',
          body: '',
          sharedProfileUserId: 'owner-1',
          sharedProfileTab: 'wishlist',
          createdAt: '2026-07-28T12:05:00.000Z',
        }),
      ]);

      renderWithProviders(<DmThreadScreen conversationId="c-1" />);
      await waitFor(() => expect(screen.getByTestId('dm-thread-row-m-1')).toBeTruthy());

      const opacityOf = () =>
        StyleSheet.flatten(screen.getByTestId('dm-thread-list').props.style)?.opacity;

      await act(async () => {
        fireEvent(screen.getByTestId('dm-thread-list'), 'contentSizeChange', 361, 900);
        mockSharedProfileReadyCallbacks.forEach((report) => report());
      });
      expect(opacityOf()).toBe(1);

      // A refresh delivers a SECOND card. The count rises past what has reported,
      // which used to re-close the gate.
      (fetchMessages as jest.Mock).mockResolvedValue([
        buildMessage({
          id: 'm-3',
          body: '',
          sharedProfileUserId: 'owner-2',
          sharedProfileTab: 'collection',
          createdAt: '2026-07-28T12:09:00.000Z',
        }),
      ]);
      await act(async () => {
        fireEvent(screen.getByTestId('dm-thread-list'), 'refresh');
      });

      expect(opacityOf()).toBe(1);
    });

    /*
      ───────────────────────────────────────────────────────────────────────
      THE WHOLE PAGE RENDERS IN THE FIRST PASS
      ───────────────────────────────────────────────────────────────────────
      Reported as "it loads the text messages first, and then all of a sudden
      the shared ones appear" — which was virtualization, not loading.

      The list is TOP-ANCHORED and corrected by a scroll. At RN's default
      `initialNumToRender` of 10, the first pass drew the ten OLDEST rows,
      `onContentSizeChange` measured a height counting only those, and the pin
      aimed at it. FlatList then rendered the rest in batches, each one growing
      the content height and firing another pin. The newest messages — where a
      shared card usually is — are in those later batches, and a card is ~390pt,
      so every batch shoved the thread under the reader.

      The two numbers have to stay equal, and nothing else forces that: raising
      the fetch limit without raising this would quietly bring the stutter back
      for anyone whose thread is longer than the initial window.
    */
    it('renders a full page of messages up front, so the pin lands once', () => {
      renderWithProviders(<DmThreadScreen conversationId="c-1" />);

      const list = screen.getByTestId('dm-thread-list');
      expect(list.props.initialNumToRender).toBe(DEFAULT_MESSAGE_LIMIT);
    });
  });

  describe('shared posts', () => {
    const PURPLE = '#A54BFA';

    function backgroundOf(testID: string): unknown {
      return StyleSheet.flatten(screen.getByTestId(testID).props.style)?.backgroundColor;
    }

    it('never paints the sender tint behind a shared post, on either side', async () => {
      (fetchMessages as jest.Mock).mockResolvedValue([
        buildMessage({ id: 'm-1', senderId: 'me', body: '', sharedPostId: 'post-9' }),
        buildMessage({
          id: 'm-2',
          senderId: 'them',
          body: '',
          sharedPostId: 'post-9',
          createdAt: '2026-07-28T12:05:00.000Z',
        }),
      ]);

      renderWithProviders(<DmThreadScreen conversationId="c-1" />);

      await waitFor(() => expect(screen.getByTestId('dm-thread-row-m-1')).toBeTruthy());

      // The row still picks its side — only the chrome is gone.
      expect(alignSelfOf('dm-thread-row-m-1')).toBe('flex-end');
      expect(alignSelfOf('dm-thread-row-m-2')).toBe('flex-start');

      // No chrome at all — not a purple slab, not a grey one. The card is the
      // only surface, and it is the same on both sides.
      expect(backgroundOf('dm-thread-bubble-m-1')).toBeUndefined();
      expect(backgroundOf('dm-thread-bubble-m-2')).toBeUndefined();
      expect(backgroundOf('dm-thread-bubble-m-1')).not.toBe(PURPLE);
    });

    /*
      THE SAME RULE, FOR THE OTHER ATTACHMENT.

      The chrome test above passed while the shared-PROFILE card shipped inside a
      thick purple frame, because the condition it pins read `item.sharedPostId`
      alone. One test per attachment type is not duplication — it is the only
      thing that catches the next attachment being added to a check that names a
      specific one.
    */
    it('never paints the sender tint behind a shared profile either', async () => {
      (fetchMessages as jest.Mock).mockResolvedValue([
        buildMessage({
          id: 'm-1',
          senderId: 'me',
          body: '',
          sharedProfileUserId: 'owner-1',
          sharedProfileTab: 'wishlist',
        }),
        buildMessage({
          id: 'm-2',
          senderId: 'them',
          body: '',
          sharedProfileUserId: 'owner-1',
          sharedProfileTab: 'collection',
          createdAt: '2026-07-28T12:05:00.000Z',
        }),
      ]);

      renderWithProviders(<DmThreadScreen conversationId="c-1" />);

      await waitFor(() => expect(screen.getByTestId('dm-thread-row-m-1')).toBeTruthy());

      expect(alignSelfOf('dm-thread-row-m-1')).toBe('flex-end');
      expect(alignSelfOf('dm-thread-row-m-2')).toBe('flex-start');

      expect(backgroundOf('dm-thread-bubble-m-1')).toBeUndefined();
      expect(backgroundOf('dm-thread-bubble-m-2')).toBeUndefined();
      expect(backgroundOf('dm-thread-bubble-m-1')).not.toBe(PURPLE);
    });

    // A plain message is untouched by any of this.
    it('still bubbles ordinary text in the sender tint', async () => {
      (fetchMessages as jest.Mock).mockResolvedValue([
        buildMessage({ id: 'm-1', senderId: 'me', body: 'on my way' }),
      ]);

      renderWithProviders(<DmThreadScreen conversationId="c-1" />);

      await waitFor(() => expect(screen.getByText('on my way')).toBeTruthy());
      expect(backgroundOf('dm-thread-bubble-m-1')).toBe(PURPLE);
    });
  });

  describe('realtime subscription', () => {
    /**
     * Stand-in for `RealtimeClient`, reproducing the one behaviour that caused a
     * production crash: `channel(topic)` returns an EXISTING channel when one
     * with the same topic is still registered, and `.on('postgres_changes')` on
     * an already-subscribed channel throws.
     *
     * `removeChannel` resolves asynchronously and — as in the real client —
     * deliberately does NOT deregister synchronously, which is exactly the
     * window the crash lived in.
     */
    function fakeRealtimeClient() {
      const channels = new Map<string, { subscribed: boolean }>();
      const topics: string[] = [];

      function channel(topic: string) {
        const realtimeTopic = `realtime:${topic}`;
        const existing = channels.get(realtimeTopic);
        const entry = existing ?? { subscribed: false };
        if (!existing) {
          channels.set(realtimeTopic, entry);
          topics.push(topic);
        }
        const handle = {
          on(...__args: unknown[]) {
            if (entry.subscribed) {
              throw new Error(
                `cannot add \`postgres_changes\` callbacks for ${realtimeTopic} after \`subscribe()\`.`,
              );
            }
            return handle;
          },
          subscribe() {
            entry.subscribed = true;
            return handle;
          },
        };
        return handle;
      }

      // Never removes synchronously — the real one is a promise over the socket.
      const removeChannel = jest.fn(async () => 'ok');
      return { channel, removeChannel, topics };
    }

    it('takes a fresh channel topic each time, so re-opening a thread cannot throw', async () => {
      const client = fakeRealtimeClient();
      jest.isolateModules(() => {});
      const supabaseModule = require('@/lib/supabase') as { supabase: unknown };
      const original = supabaseModule.supabase;
      (supabaseModule as any).supabase = client;

      try {
        const first = renderWithProviders(<DmThreadScreen conversationId="c-1" />);
        await waitFor(() => expect(fetchMessages).toHaveBeenCalled());
        // Unmount fires `removeChannel`, which does NOT deregister synchronously.
        first.unmount();

        // Re-entering the SAME conversation before that lands is the crash case:
        // with a fixed topic this second mount would be handed the already
        // subscribed channel and `.on(...)` would throw into the error boundary.
        expect(() => {
          renderWithProviders(<DmThreadScreen conversationId="c-1" />);
        }).not.toThrow();

        expect(client.removeChannel).toHaveBeenCalled();
        // Same conversation, distinct topics — that is what makes it safe.
        expect(client.topics).toHaveLength(2);
        expect(client.topics[0]).not.toBe(client.topics[1]);
        for (const topic of client.topics) {
          expect(topic.startsWith('dm:c-1:')).toBe(true);
        }
      } finally {
        (supabaseModule as any).supabase = original;
      }
    });
  });
});
