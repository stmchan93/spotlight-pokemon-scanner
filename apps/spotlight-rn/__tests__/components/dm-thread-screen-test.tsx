import { StyleSheet } from 'react-native';
import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { useRouter } from 'expo-router';

import {
  type DmMessage,
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
  fetchMessages: jest.fn(),
  markConversationRead: jest.fn(),
  sendMessage: jest.fn(),
}));

// The thread decides which side a bubble sits on from the signed-in user's id.
// `requireActual` keeps the real `AuthProvider` defined for the test harness.
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
    jest.clearAllMocks();
    (useRouter as jest.Mock).mockReturnValue({ back, push });
    (fetchMessages as jest.Mock).mockResolvedValue([]);
    (markConversationRead as jest.Mock).mockResolvedValue(true);
    (sendMessage as jest.Mock).mockResolvedValue(null);
  });

  it('shows an empty state for a thread with no messages', async () => {
    renderWithProviders(<DmThreadScreen conversationId="c-1" title="Ash" />);

    await waitFor(() => {
      expect(screen.getByTestId('dm-thread-empty')).toBeTruthy();
    });
    expect(screen.getByText('Ash')).toBeTruthy();
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
});
