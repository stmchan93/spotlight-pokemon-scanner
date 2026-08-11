import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { useRouter } from 'expo-router';

import {
  type DmConversation,
  fetchConversations,
  fetchMessages,
  findOrCreateDm,
} from '@/features/social/dm-service';
import { searchUsers } from '@/features/profile/profile-service';
import { DmInboxScreen } from '@/features/social/screens/dm-inbox-screen';

import { renderWithProviders } from '../test-utils';

jest.mock('expo-router', () => ({
  useRouter: jest.fn(),
  /*
    The inbox loads on FOCUS, not on mount, so that a thread you just read stops
    showing as unread when you come back. There is no navigator in these tests,
    so stand it in with a plain effect — the screen only needs the callback to
    run once per mount, which is what focus does here anyway.
  */
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  useFocusEffect: (callback: () => void) => require('react').useEffect(callback, [callback]),
}));

jest.mock('@/features/social/dm-service', () => ({
  fetchConversations: jest.fn(),
  fetchMessages: jest.fn(),
  findOrCreateDm: jest.fn(),
}));

jest.mock('@/features/profile/profile-service', () => ({
  searchUsers: jest.fn(),
}));

function buildPerson(overrides: Record<string, unknown> = {}) {
  return {
    userID: 'user-trogdor',
    displayName: 'trogdor85',
    avatarURL: null,
    labelerEnabled: false,
    adminEnabled: false,
    handle: null,
    ...overrides,
  } as never;
}

function buildConversation(
  overrides: Partial<DmConversation> & Pick<DmConversation, 'id'>,
): DmConversation {
  return {
    isGroup: false,
    otherUserId: `other-${overrides.id}`,
    otherUser: {
      displayName: 'Ash Ketchum',
      handle: 'ash',
      avatarUrl: null,
      isVerified: false,
    },
    lastMessageAt: '2026-07-28T12:00:00.000Z',
    lastMessagePreview: 'hello there',
    lastReadAt: null,
    unreadCount: 0,
    ...overrides,
  };
}

const back = jest.fn();
const push = jest.fn();

describe('DmInboxScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (useRouter as jest.Mock).mockReturnValue({ back, push });
    // `fetchMessages` is mocked but intentionally left unstubbed: this screen
    // must never call it, and the tests below assert exactly that.
  });

  it('shows an empty state when there are no conversations', async () => {
    (fetchConversations as jest.Mock).mockResolvedValue([]);

    renderWithProviders(<DmInboxScreen />);

    await waitFor(() => {
      expect(screen.getByTestId('dm-inbox-empty')).toBeTruthy();
    });
    expect(screen.getByText('No messages yet')).toBeTruthy();
  });

  it('renders a row per conversation, newest first, with the denormalized preview', async () => {
    (fetchConversations as jest.Mock).mockResolvedValue([
      buildConversation({
        id: 'c-1',
        lastMessagePreview: 'see you at the show',
        otherUser: { displayName: 'Ash Ketchum', handle: 'ash', avatarUrl: null, isVerified: false },
      }),
      buildConversation({
        id: 'c-2',
        lastMessageAt: '2026-07-27T12:00:00.000Z',
        lastMessagePreview: 'nice pull',
        otherUser: { displayName: 'Misty', handle: 'misty', avatarUrl: null, isVerified: false },
      }),
    ]);

    renderWithProviders(<DmInboxScreen />);

    await waitFor(() => {
      expect(screen.getByText('Ash Ketchum')).toBeTruthy();
    });
    expect(screen.getByText('Misty')).toBeTruthy();

    expect(screen.getByTestId('dm-inbox-preview-c-1').props.children).toBe('see you at the show');
    expect(screen.getByTestId('dm-inbox-preview-c-2').props.children).toBe('nice pull');
  });

  it('issues NO per-row request: the preview rides along on the conversation', async () => {
    (fetchConversations as jest.Mock).mockResolvedValue([
      buildConversation({ id: 'c-1' }),
      buildConversation({ id: 'c-2' }),
      buildConversation({ id: 'c-3' }),
    ]);

    renderWithProviders(<DmInboxScreen />);

    await waitFor(() => {
      expect(screen.getByTestId('dm-inbox-row-c-3')).toBeTruthy();
    });

    // `last_message_preview` is denormalized onto `conversations` by the trigger
    // that stamps `last_message_at` (social_13). This screen used to fan out one
    // `fetchMessages(id, 1)` per row to draw one line of text each; three rows
    // meant three extra requests, fifty meant fifty. It must now make none.
    expect(fetchConversations).toHaveBeenCalledTimes(1);
    expect(fetchMessages).not.toHaveBeenCalled();
  });

  it('omits the preview line entirely when there is none, so the row stays centred', async () => {
    (fetchConversations as jest.Mock).mockResolvedValue([
      buildConversation({ id: 'c-1', lastMessageAt: null, lastMessagePreview: null }),
    ]);

    renderWithProviders(<DmInboxScreen />);

    await waitFor(() => {
      expect(screen.getByTestId('dm-inbox-row-c-1')).toBeTruthy();
    });

    // No element at all — not a blank one. An empty Text still occupies a full
    // line, which pushed the name above the avatar's centre and left dead space
    // beneath it on every never-messaged thread. Omitting it lets the row centre
    // the way the single-line search rows do. Still emphatically not a repair
    // read and not an invented placeholder.
    expect(screen.queryByTestId('dm-inbox-preview-c-1')).toBeNull();
    expect(fetchMessages).not.toHaveBeenCalled();
  });

  it('falls back to the handle, then to a generic name, when identity is missing', async () => {
    (fetchConversations as jest.Mock).mockResolvedValue([
      buildConversation({
        id: 'c-1',
        otherUser: { displayName: null, handle: 'brock', avatarUrl: null, isVerified: false },
      }),
      // A hidden/blocked/suspended participant hydrates to null — the row still
      // has to be findable and openable.
      buildConversation({ id: 'c-2', otherUser: null, otherUserId: null }),
    ]);

    renderWithProviders(<DmInboxScreen />);

    await waitFor(() => {
      expect(screen.getByText('brock')).toBeTruthy();
    });
    expect(screen.getByText('Someone')).toBeTruthy();
  });

  it('badges a thread with unread messages', async () => {
    (fetchConversations as jest.Mock).mockResolvedValue([
      buildConversation({ id: 'c-1', unreadCount: 3 }),
      buildConversation({ id: 'c-2', unreadCount: 0 }),
    ]);

    renderWithProviders(<DmInboxScreen />);

    await waitFor(() => {
      expect(screen.getByTestId('dm-inbox-unread-c-1')).toBeTruthy();
    });
    expect(screen.getByText('3')).toBeTruthy();
    expect(screen.queryByTestId('dm-inbox-unread-c-2')).toBeNull();
  });

  it('pushes the thread with the tapped conversation id', async () => {
    (fetchConversations as jest.Mock).mockResolvedValue([
      buildConversation({
        id: 'c-42',
        otherUser: { displayName: 'Ash Ketchum', handle: 'ash', avatarUrl: null, isVerified: false },
      }),
    ]);

    renderWithProviders(<DmInboxScreen />);

    await waitFor(() => {
      expect(screen.getByTestId('dm-inbox-row-c-42')).toBeTruthy();
    });

    fireEvent.press(screen.getByTestId('dm-inbox-row-c-42'));

    // The resolved IDENTITY rides along — name, @handle, photo and user id — so
    // the thread header can show who you are talking to, and link to them,
    // without a fetch-one-conversation read the data layer does not have.
    expect(push).toHaveBeenCalledWith({
      pathname: '/messages/[conversationId]',
      params: {
        conversationId: 'c-42',
        name: 'Ash Ketchum',
        avatar: '',
        handle: 'ash',
        userId: 'other-c-42',
      },
    });
  });

  describe('searching for someone to message', () => {
    it('replaces the thread list with people results while searching', async () => {
      (fetchConversations as jest.Mock).mockResolvedValue([buildConversation({ id: 'c-1' })]);
      (searchUsers as jest.Mock).mockResolvedValue([buildPerson()]);
      renderWithProviders(<DmInboxScreen />);
      await screen.findByTestId('dm-inbox-row-c-1');

      fireEvent.changeText(screen.getByTestId('dm-inbox-search'), 'trog');

      // People REPLACE threads rather than stacking above them: two lists of
      // avatars would make it ambiguous which tap continues a conversation and
      // which starts one.
      await waitFor(() => expect(screen.getByTestId('dm-inbox-person-user-trogdor')).toBeTruthy());
      expect(screen.queryByTestId('dm-inbox-row-c-1')).toBeNull();
    });

    it('truncates a long name to one line so the row stays centred on the avatar', async () => {
      // A wrapping name is what breaks vertical alignment here: the copy column
      // grows past the 40pt avatar and the name's first line ends up above the
      // avatar's middle, so the row reads as top-aligned. Truncation is the fix,
      // which makes numberOfLines load-bearing rather than cosmetic.
      (fetchConversations as jest.Mock).mockResolvedValue([]);
      (searchUsers as jest.Mock).mockResolvedValue([
        buildPerson({ displayName: 'a collector with a truly enormous display name', handle: 'x' }),
      ]);
      renderWithProviders(<DmInboxScreen />);

      fireEvent.changeText(screen.getByTestId('dm-inbox-search'), 'trog');

      await screen.findByTestId('dm-inbox-person-user-trogdor');
      const name = screen.getByText('a collector with a truly enormous display name');
      expect(name.props.numberOfLines).toBe(1);
      expect(screen.getByText('@x').props.numberOfLines).toBe(1);
    });

    it('opens a thread with the tapped person', async () => {
      (fetchConversations as jest.Mock).mockResolvedValue([]);
      (searchUsers as jest.Mock).mockResolvedValue([buildPerson()]);
      (findOrCreateDm as jest.Mock).mockResolvedValue('conv-99');
      renderWithProviders(<DmInboxScreen />);

      fireEvent.changeText(screen.getByTestId('dm-inbox-search'), 'trog');
      const row = await screen.findByTestId('dm-inbox-person-user-trogdor');
      fireEvent.press(row);

      await waitFor(() => expect(findOrCreateDm).toHaveBeenCalledWith('user-trogdor'));
      await waitFor(() =>
        expect(push).toHaveBeenCalledWith({
          pathname: '/messages/[conversationId]',
          params: {
            conversationId: 'conv-99',
            name: 'trogdor85',
            avatar: '',
            handle: '',
            userId: 'user-trogdor',
          },
        }),
      );
    });

    it('does NOT navigate when the conversation cannot be created', async () => {
      (fetchConversations as jest.Mock).mockResolvedValue([]);
      (searchUsers as jest.Mock).mockResolvedValue([buildPerson()]);
      // findOrCreateDm returns null on failure — navigating anyway would push
      // /messages/null and render a thread that cannot exist.
      (findOrCreateDm as jest.Mock).mockResolvedValue(null);
      renderWithProviders(<DmInboxScreen />);

      fireEvent.changeText(screen.getByTestId('dm-inbox-search'), 'trog');
      fireEvent.press(await screen.findByTestId('dm-inbox-person-user-trogdor'));

      await waitFor(() => expect(findOrCreateDm).toHaveBeenCalled());
      expect(push).not.toHaveBeenCalled();
    });

    it('shows a no-one-found state rather than an empty screen', async () => {
      (fetchConversations as jest.Mock).mockResolvedValue([]);
      (searchUsers as jest.Mock).mockResolvedValue([]);
      renderWithProviders(<DmInboxScreen />);

      fireEvent.changeText(screen.getByTestId('dm-inbox-search'), 'nobody');

      await waitFor(() => expect(screen.getByTestId('dm-inbox-search-empty')).toBeTruthy());
    });
  });
  /*
    Two things a friend hit on the real inbox: the unread badge sat at the
    BOTTOM of the row instead of level with the name, and a thread stayed
    badged after it had been read.
  */
  describe('the unread badge', () => {
    it('does not reserve a timestamp line when there is no timestamp', async () => {
      /*
        The meta column stacks time above badge. `formatRelativeTime` returns ''
        for a null timestamp, and an empty Text STILL occupies a full line — so
        the badge was pushed down off the name's centre line. A never-messaged
        thread is exactly the case that has no timestamp.
      */
      (fetchConversations as jest.Mock).mockResolvedValue([
        buildConversation({ id: 'c-1', lastMessageAt: null, unreadCount: 2 }),
      ]);

      renderWithProviders(<DmInboxScreen />);

      const badge = await screen.findByTestId('dm-inbox-unread-c-1');
      expect(badge).toBeTruthy();
      // Nothing but the badge in the meta column, so it centres on the row.
      expect(screen.queryByText('')).toBeNull();
    });

    it('clears the moment you open the thread, without waiting for a refetch', async () => {
      /*
        Opening a thread marks it read on the SERVER. The screen used to hold
        whatever counts it fetched on mount, so the badge sat there through the
        navigation and was still there on the way back — read as "it never
        cleared". The focus refetch is the source of truth; this is what makes
        it feel immediate.
      */
      (fetchConversations as jest.Mock).mockResolvedValue([
        buildConversation({ id: 'c-1', unreadCount: 4 }),
      ]);

      renderWithProviders(<DmInboxScreen />);

      expect(await screen.findByTestId('dm-inbox-unread-c-1')).toBeTruthy();

      fireEvent.press(screen.getByTestId('dm-inbox-row-c-1'));

      await waitFor(() => {
        expect(screen.queryByTestId('dm-inbox-unread-c-1')).not.toBeOnTheScreen();
      });
      // It still opened the thread — clearing the badge is not instead of that.
      expect(push).toHaveBeenCalled();
    });
  });
});
