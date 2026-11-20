import { fireEvent, screen, waitFor } from '@testing-library/react-native';

import {
  mockAssistantCards,
  mockAssistantUsage,
  type AssistantFeedback,
  type AssistantFeedbackInput,
  type AssistantMessage,
  type AssistantSendResult,
} from '@spotlight/api-client';

import { AssistantScreen } from '@/features/assistant/screens/assistant-screen';

import {
  HttpSpotlightRepository,
  MockSpotlightRepository,
} from '../../../../../packages/api-client/src/spotlight/repository';
import {
  buildAssistantFeedbackBody,
  parseAssistantFeedback,
  parseAssistantMessage,
} from '../../../../../packages/api-client/src/spotlight/assistant-wire';
import { createTestSpotlightRepository, renderWithProviders } from '../../test-utils';

jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(async () => true) }));

jest.mock('@/features/auth/use-guest-gate', () => ({
  useGuestGate: () => ({
    ensureGuestSession: jest.fn(async () => ({ access_token: 'token' })),
    gate: (fn: () => void) => fn,
    isGuest: false,
    openLogin: jest.fn(),
  }),
}));

const mockCapture = jest.fn();
jest.mock('@/lib/observability/posthog', () => ({
  ...jest.requireActual('@/lib/observability/posthog'),
  capturePostHogEvent: (...args: unknown[]) => mockCapture(...args),
}));

const FEEDBACK = 'assistant-message-a1-feedback';

function assistantMessage(feedback: AssistantFeedback | null = null): AssistantMessage {
  return {
    id: 'a1',
    threadId: 'thr_1',
    role: 'assistant',
    text: 'Celebi is worth $37.54.',
    cards: [mockAssistantCards.celebi],
    actions: [],
    createdAt: '2026-11-17T10:00:00Z',
    status: 'ok',
    feedback,
  };
}

function reply(): AssistantSendResult {
  return {
    threadId: 'thr_1',
    userMessage: { ...assistantMessage(), id: 'u1', role: 'user', text: 'q', cards: [], feedback: null },
    message: assistantMessage(),
    usage: mockAssistantUsage(1),
  };
}

function stored(input: AssistantFeedbackInput): AssistantFeedback | null {
  return parseAssistantFeedback({ ...buildAssistantFeedbackBody(input), updated_at: '2026-11-19T00:00:00Z' });
}

function renderScreen(overrides: Parameters<typeof createTestSpotlightRepository>[0]) {
  const repository = createTestSpotlightRepository({
    listAssistantThreads: async () => ({ threads: [], nextCursor: null }),
    sendAssistantMessage: async () => reply(),
    ...overrides,
  });
  renderWithProviders(<AssistantScreen onBack={jest.fn()} onOpenCard={jest.fn()} source="home" />, {
    spotlightRepository: repository,
  });
}

async function askOnce() {
  fireEvent.changeText(screen.getByTestId('assistant-input'), 'What is Celebi worth?');
  fireEvent.press(screen.getByTestId('assistant-send'));
  await screen.findByTestId(`${FEEDBACK}-up`);
}

function isSelected(testID: string) {
  return screen.getByTestId(testID).props.accessibilityState?.selected === true;
}

beforeEach(() => {
  mockCapture.mockClear();
});

describe('Assistant feedback controls', () => {
  it('toggles 👍 on and off, persisting each change and firing the tap event', async () => {
    const setAssistantFeedback = jest.fn(async (_id: string, input: AssistantFeedbackInput) => stored(input));
    renderScreen({ setAssistantFeedback });
    await askOnce();
    expect(screen.getByLabelText('Good answer')).toBeTruthy();
    expect(screen.getByLabelText('Bad answer')).toBeTruthy();

    fireEvent.press(screen.getByTestId(`${FEEDBACK}-up`));
    await waitFor(() => expect(setAssistantFeedback).toHaveBeenCalledWith('a1', { rating: 'up' }));
    expect(isSelected(`${FEEDBACK}-up`)).toBe(true);
    expect(screen.getByTestId(`${FEEDBACK}-thanks`)).toBeTruthy();
    expect(mockCapture).toHaveBeenCalledWith('assistant_feedback_tapped', { rating: 'up', reason: null });

    fireEvent.press(screen.getByTestId(`${FEEDBACK}-up`));
    await waitFor(() => expect(setAssistantFeedback).toHaveBeenLastCalledWith('a1', { rating: null }));
    expect(isSelected(`${FEEDBACK}-up`)).toBe(false);
    expect(mockCapture).toHaveBeenLastCalledWith('assistant_feedback_tapped', { rating: 'cleared', reason: null });
  });

  it('👎 opens the reason picker; a reason and a note are saved', async () => {
    const setAssistantFeedback = jest.fn(async (_id: string, input: AssistantFeedbackInput) => stored(input));
    renderScreen({ setAssistantFeedback });
    await askOnce();

    fireEvent.press(screen.getByTestId(`${FEEDBACK}-down`));
    expect(await screen.findByTestId(`${FEEDBACK}-picker`)).toBeTruthy();
    expect(setAssistantFeedback).toHaveBeenLastCalledWith('a1', { rating: 'down' });
    for (const label of ['Wrong info', 'Not helpful', 'Too long', 'Wrong cards', 'Other']) {
      expect(screen.getByText(label)).toBeTruthy();
    }

    fireEvent.press(screen.getByTestId(`${FEEDBACK}-reason-wrong_cards`));
    await waitFor(() =>
      expect(setAssistantFeedback).toHaveBeenLastCalledWith('a1', { rating: 'down', reason: 'wrong_cards', note: null }),
    );
    expect(isSelected(`${FEEDBACK}-reason-wrong_cards`)).toBe(true);
    expect(mockCapture).toHaveBeenLastCalledWith('assistant_feedback_tapped', { rating: 'down', reason: 'wrong_cards' });

    fireEvent.changeText(screen.getByTestId(`${FEEDBACK}-note`), '  Showed the wrong Celebi  ');
    fireEvent.press(screen.getByTestId(`${FEEDBACK}-done`));
    await waitFor(() =>
      expect(setAssistantFeedback).toHaveBeenLastCalledWith('a1', {
        rating: 'down',
        reason: 'wrong_cards',
        note: 'Showed the wrong Celebi',
      }),
    );
    expect(screen.queryByTestId(`${FEEDBACK}-picker`)).not.toBeOnTheScreen();
    expect(isSelected(`${FEEDBACK}-down`)).toBe(true);

    // Done with no note change doesn't re-save.
    const calls = setAssistantFeedback.mock.calls.length;
    fireEvent.press(screen.getByTestId(`${FEEDBACK}-down`));
    await waitFor(() => expect(setAssistantFeedback).toHaveBeenLastCalledWith('a1', { rating: null }));
    expect(setAssistantFeedback.mock.calls.length).toBe(calls + 1);
    expect(isSelected(`${FEEDBACK}-down`)).toBe(false);
  });

  it('restores saved feedback from the thread payload', async () => {
    const threads = [{ id: 'thr_1', title: 'Celebi?', updatedAt: '2026-11-17T10:00:00Z', lastMessagePreview: '' }];
    renderScreen({
      listAssistantThreads: async () => ({ threads, nextCursor: null }),
      getAssistantThreadMessages: async () => [
        assistantMessage({ rating: 'down', reason: 'wrong', note: null, updatedAt: '2026-11-18T00:00:00Z' }),
      ],
    });
    await screen.findByTestId(`${FEEDBACK}-down`);
    expect(isSelected(`${FEEDBACK}-down`)).toBe(true);
    expect(isSelected(`${FEEDBACK}-up`)).toBe(false);
    expect(screen.queryByTestId(`${FEEDBACK}-picker`)).not.toBeOnTheScreen();
  });

  it('reverts the optimistic state when the save fails', async () => {
    const setAssistantFeedback = jest.fn(async () => {
      throw new Error('offline');
    });
    renderScreen({ setAssistantFeedback });
    await askOnce();
    fireEvent.press(screen.getByTestId(`${FEEDBACK}-up`));
    await waitFor(() => expect(setAssistantFeedback).toHaveBeenCalled());
    await waitFor(() => expect(isSelected(`${FEEDBACK}-up`)).toBe(false));
  });

  it('user messages get no feedback controls', async () => {
    renderScreen({});
    await askOnce();
    expect(screen.queryByTestId('assistant-message-u1-feedback')).not.toBeOnTheScreen();
  });
});

describe('assistant feedback wire + repositories', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('parses feedback on assistant messages only and builds the body', () => {
    const wire = { rating: 'down', reason: 'too_long', note: 'shorter', updated_at: '2026-11-19T00:00:00Z' };
    expect(parseAssistantMessage({ id: 'm', role: 'assistant', feedback: wire })?.feedback).toEqual({
      rating: 'down',
      reason: 'too_long',
      note: 'shorter',
      updatedAt: '2026-11-19T00:00:00Z',
    });
    expect(parseAssistantMessage({ id: 'm', role: 'user', feedback: wire })?.feedback).toBeNull();
    expect(parseAssistantMessage({ id: 'm', role: 'assistant' })?.feedback).toBeNull();
    expect(parseAssistantFeedback({ rating: 'meh' })).toBeNull();
    expect(parseAssistantFeedback({ rating: 'up', reason: 'bogus' })?.reason).toBeNull();
    expect(buildAssistantFeedbackBody({ rating: null, reason: 'wrong', note: 'x' })).toEqual({ rating: null });
    expect(buildAssistantFeedbackBody({ rating: 'down', note: '  ' })).toEqual({ rating: 'down', reason: null, note: null });
    expect(buildAssistantFeedbackBody({ rating: 'down', note: 'x'.repeat(600) }).note).toHaveLength(500);
  });

  it('HTTP: POSTs to the contract path and returns the stored feedback', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        message_id: 'msg_1',
        feedback: { rating: 'down', reason: 'wrong', note: null, updated_at: '2026-11-19T00:00:00Z' },
      }),
    } as Response);
    global.fetch = fetchMock as typeof fetch;
    const repo = new HttpSpotlightRepository('http://example.test', { getAccessToken: () => 'tok' });
    const feedback = await repo.setAssistantFeedback('msg_1', { rating: 'down', reason: 'wrong' });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://example.test/api/v1/assistant/messages/msg_1/feedback');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ rating: 'down', reason: 'wrong', note: null });
    expect(feedback).toEqual({ rating: 'down', reason: 'wrong', note: null, updatedAt: '2026-11-19T00:00:00Z' });
  });

  it('mock: stores, restores in history, clears, and 404s unknown or user messages', async () => {
    const repo = new MockSpotlightRepository();
    const sent = await repo.sendAssistantMessage({ threadId: null, clientMessageId: 'c1', text: 'hello' });
    expect(sent.message.feedback).toBeNull();
    const saved = await repo.setAssistantFeedback(sent.message.id, { rating: 'down', reason: 'not_helpful', note: 'meh' });
    expect(saved).toMatchObject({ rating: 'down', reason: 'not_helpful', note: 'meh' });
    let history = await repo.getAssistantThreadMessages(sent.threadId);
    expect(history.find((message) => message.id === sent.message.id)?.feedback?.rating).toBe('down');

    await expect(repo.setAssistantFeedback(sent.message.id, { rating: null })).resolves.toBeNull();
    history = await repo.getAssistantThreadMessages(sent.threadId);
    expect(history.find((message) => message.id === sent.message.id)?.feedback).toBeNull();

    await expect(repo.setAssistantFeedback('msg_nope', { rating: 'up' })).rejects.toMatchObject({ code: 'not_found' });
    await expect(repo.setAssistantFeedback(sent.userMessage.id, { rating: 'up' })).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});
