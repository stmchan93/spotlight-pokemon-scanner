import { act, fireEvent, screen, waitFor, within } from '@testing-library/react-native';
import * as Clipboard from 'expo-clipboard';
import { Alert, StyleSheet, type AlertButton } from 'react-native';

import {
  AssistantRequestError,
  mockAssistantCards,
  mockAssistantUsage,
  type AssistantMessage,
  type AssistantProposedAction,
  type AssistantSendPayload,
  type AssistantSendResult,
} from '@spotlight/api-client';

import {
  ASSISTANT_MARKET_PROMPTS,
  assistantGreeting,
  assistantRemainingCaption,
} from '@/features/assistant/assistant-prompts';
import { AssistantScreen } from '@/features/assistant/screens/assistant-screen';

import { createTestSpotlightRepository, renderWithProviders } from '../../test-utils';

jest.mock('expo-clipboard', () => ({
  setStringAsync: jest.fn(async () => true),
}));

const mockOpenLogin = jest.fn();
let mockIsGuest = false;
jest.mock('@/features/auth/use-guest-gate', () => ({
  useGuestGate: () => ({
    ensureGuestSession: jest.fn(async () => ({ access_token: 'guest' })),
    gate: (fn: () => void) => fn,
    isGuest: mockIsGuest,
    openLogin: mockOpenLogin,
  }),
}));

const mockCapture = jest.fn();
jest.mock('@/lib/observability/posthog', () => ({
  ...jest.requireActual('@/lib/observability/posthog'),
  capturePostHogEvent: (...args: unknown[]) => mockCapture(...args),
}));

function reply(action: AssistantProposedAction | null, overrides: Partial<AssistantMessage> = {}): AssistantSendResult {
  const base = { threadId: 'thr_1', createdAt: '2026-11-17T10:00:00Z', status: 'ok' as const };
  return {
    threadId: 'thr_1',
    userMessage: { ...base, id: 'u1', role: 'user', text: 'q', cards: [], actions: [] },
    message: {
      ...base,
      id: 'a1',
      role: 'assistant',
      text: 'Here is **Celebi**.',
      cards: [mockAssistantCards.celebi],
      actions: action ? [action] : [],
      ...overrides,
    },
    usage: mockAssistantUsage(1),
  };
}

async function ask(text = 'question') {
  fireEvent.changeText(screen.getByTestId('assistant-input'), text);
  fireEvent.press(screen.getByTestId('assistant-send'));
}

function renderScreen(repoOverrides: Parameters<typeof createTestSpotlightRepository>[0], props: Partial<React.ComponentProps<typeof AssistantScreen>> = {}) {
  // No saved chats unless a test seeds them: otherwise the screen resumes the latest one.
  const repository = createTestSpotlightRepository({
    listAssistantThreads: async () => ({ threads: [], nextCursor: null }),
    ...repoOverrides,
  });
  const onOpenCard = jest.fn();
  renderWithProviders(
    <AssistantScreen onBack={jest.fn()} onOpenCard={onOpenCard} source="home" {...props} />,
    { spotlightRepository: repository },
  );
  return { repository, onOpenCard };
}

/** Auto-answers the next confirm dialog with its destructive button. */
function confirmNextAlert() {
  return jest.spyOn(Alert, 'alert').mockImplementationOnce((_title, _message, buttons?: AlertButton[]) => {
    buttons?.find((button) => button.style === 'destructive')?.onPress?.();
  });
}

function sendButtonColor() {
  return StyleSheet.flatten(screen.getByTestId('assistant-send').props.style).backgroundColor;
}

beforeEach(() => {
  mockIsGuest = false;
  mockOpenLogin.mockClear();
  mockCapture.mockClear();
});

describe('AssistantScreen', () => {
  it('sends a question, renders text + tappable card tiles, and shows the low-remaining caption only at 2 or fewer', async () => {
    const getAssistantUsage = jest.fn(async () => mockAssistantUsage(0));
    const { onOpenCard } = renderScreen({ getAssistantUsage });
    await waitFor(() => expect(getAssistantUsage).toHaveBeenCalled());
    // 3 left: no caption.
    expect(screen.queryByTestId('assistant-remaining')).not.toBeOnTheScreen();
    expect(mockCapture).toHaveBeenCalledWith('assistant_opened', { source: 'home' });

    await ask("What's my collection worth?");
    expect(await screen.findByTestId('assistant-card-xyp-111')).toBeTruthy();
    expect(screen.getByTestId('assistant-remaining')).toHaveTextContent('2 questions left today');
    // The tile keeps its name and USD price under the art.
    expect(within(screen.getByTestId('assistant-card-xyp-111')).getByText('Celebi')).toBeTruthy();
    expect(screen.getByText('$37.54')).toBeTruthy();
    expect(mockCapture).toHaveBeenCalledWith('assistant_question_sent', { source: 'home' });

    fireEvent.press(screen.getByTestId('assistant-card-xyp-111'));
    expect(onOpenCard).toHaveBeenCalledWith('xyp-111');
  });

  it('never shows the remaining caption when unlimited', async () => {
    const getAssistantUsage = jest.fn(async () => mockAssistantUsage(5, null));
    renderScreen({ getAssistantUsage });
    await waitFor(() => expect(getAssistantUsage).toHaveBeenCalled());
    expect(screen.queryByTestId('assistant-remaining')).not.toBeOnTheScreen();
  });

  it('remaining caption copy: only 1 or 2 left on a limited plan', () => {
    expect(assistantRemainingCaption(mockAssistantUsage(0))).toBeNull();
    expect(assistantRemainingCaption(mockAssistantUsage(1))).toBe('2 questions left today');
    expect(assistantRemainingCaption(mockAssistantUsage(2))).toBe('1 question left today');
    expect(assistantRemainingCaption(mockAssistantUsage(3))).toBeNull();
    expect(assistantRemainingCaption(mockAssistantUsage(9, null))).toBeNull();
    expect(assistantRemainingCaption(null)).toBeNull();
  });

  it('header: close left, history + NEW CHAT right, no title and no usage badge', async () => {
    const onBack = jest.fn();
    renderScreen({}, { onBack });
    await screen.findByTestId('assistant-intro');
    expect(screen.getByLabelText('Close')).toBeTruthy();
    expect(screen.getByLabelText('Chat history')).toBeTruthy();
    expect(screen.getByText('NEW CHAT')).toBeTruthy();
    expect(screen.queryByText('Ask Ekalight')).not.toBeOnTheScreen();
    expect(screen.queryByText(/left today/i)).not.toBeOnTheScreen();
    fireEvent.press(screen.getByTestId('assistant-back'));
    expect(onBack).toHaveBeenCalled();
  });

  it('as a sheet: no status-bar inset, and no JS pull-down fighting the native sheet', async () => {
    renderScreen({}, { presentation: 'sheet' });
    await screen.findByTestId('assistant-intro');
    expect(screen.getByTestId('assistant-root').props.edges).toMatchObject({ top: 'off', left: 'additive', right: 'additive' });
    // The sheet's own pan (grabber + toolbar band) and the X close it.
    expect(screen.queryByTestId('assistant-pull-down')).toBeNull();
    // Android: lets the BottomSheetBehavior sheet take a drag at the list's top.
    expect(screen.getByTestId('assistant-messages').props.nestedScrollEnabled).toBe(true);
  });

  it('as a page (dev screens): keeps the top safe-area edge', async () => {
    renderScreen({});
    await screen.findByTestId('assistant-intro');
    expect(screen.getByTestId('assistant-root').props.edges).toMatchObject({ top: 'additive' });
  });

  it('a scroll drops the keyboard outright (never interactive, which split the composer from it)', async () => {
    renderScreen({});
    await screen.findByTestId('assistant-intro');
    expect(screen.getByTestId('assistant-messages').props.keyboardDismissMode).toBe('on-drag');
  });

  it('greets the signed-in user by first name with the purple mark', async () => {
    renderScreen({});
    expect(await screen.findByTestId('assistant-greeting')).toHaveTextContent('Hi, UI');
    expect(screen.getByTestId('assistant-intro-mark')).toBeTruthy();
    // Recent chats are not listed on a new chat any more.
    expect(screen.queryByText('RECENT CHATS')).not.toBeOnTheScreen();
  });

  it('a guest is greeted "Hi there"', async () => {
    mockIsGuest = true;
    renderScreen({});
    expect(await screen.findByTestId('assistant-greeting')).toHaveTextContent('Hi there');
  });

  it('greeting falls back to "Hi there" without a usable name', () => {
    expect(assistantGreeting('Stephen Chan', false)).toBe('Hi, Stephen');
    expect(assistantGreeting('  Ash  ', false)).toBe('Hi, Ash');
    expect(assistantGreeting(null, false)).toBe('Hi there');
    expect(assistantGreeting('   ', false)).toBe('Hi there');
    expect(assistantGreeting('Guest', true)).toBe('Hi there');
  });

  it('sends scanner tray ids as context on the first question only', async () => {
    const sendAssistantMessage = jest.fn(async (_payload: AssistantSendPayload) => reply(null));
    renderScreen({ sendAssistantMessage }, { source: 'scanner', cardIds: ['xyp-111', 'mcdonalds25-21'] });
    await ask('Which of these is worth the most?');
    await screen.findByTestId('assistant-card-xyp-111');
    await ask('and the cheapest?');
    await waitFor(() => expect(sendAssistantMessage).toHaveBeenCalledTimes(2));
    expect(sendAssistantMessage.mock.calls[0][0]).toMatchObject({
      threadId: null,
      context: { source: 'scanner', cardIds: ['xyp-111', 'mcdonalds25-21'] },
    });
    expect(sendAssistantMessage.mock.calls[1][0]).toMatchObject({ threadId: 'thr_1', context: { source: 'scanner' } });
    expect(sendAssistantMessage.mock.calls[1][0].context?.cardIds).toBeUndefined();
  });

  it('sends the opening screen game as context.game on every question', async () => {
    const sendAssistantMessage = jest.fn(async (_payload: AssistantSendPayload) => reply(null));
    renderScreen({ sendAssistantMessage }, { source: 'scanner', cardIds: ['xyp-111'], game: 'onepiece' });
    await ask('Which cards are rising the most?');
    await screen.findByTestId('assistant-card-xyp-111');
    await ask('and dropping?');
    await waitFor(() => expect(sendAssistantMessage).toHaveBeenCalledTimes(2));
    expect(sendAssistantMessage.mock.calls[0][0].context).toEqual({
      source: 'scanner', cardIds: ['xyp-111'], game: 'onepiece',
    });
    expect(sendAssistantMessage.mock.calls[1][0].context).toEqual({ source: 'scanner', game: 'onepiece' });
  });

  it('omits context.game when the screen has none', async () => {
    const sendAssistantMessage = jest.fn(async (_payload: AssistantSendPayload) => reply(null));
    renderScreen({ sendAssistantMessage });
    await ask('Which cards are rising the most?');
    await waitFor(() => expect(sendAssistantMessage).toHaveBeenCalledTimes(1));
    expect(sendAssistantMessage.mock.calls[0][0].context).toEqual({ source: 'home' });
  });

  it('reopening resumes the latest saved chat; NEW CHAT starts a blank one', async () => {
    const threads = [
      { id: 'thr_latest', title: 'Most expensive card?', updatedAt: '2026-11-17T17:36:00Z', lastMessagePreview: 'Charizard' },
      { id: 'thr_older', title: 'Worth grading?', updatedAt: '2026-11-17T17:30:00Z', lastMessagePreview: 'Maybe' },
    ];
    const getAssistantThreadMessages = jest.fn(async (_threadId: string) => []);
    renderScreen({ listAssistantThreads: async () => ({ threads, nextCursor: null }), getAssistantThreadMessages });
    await waitFor(() => expect(getAssistantThreadMessages).toHaveBeenCalledWith('thr_latest'));
    expect(screen.getByLabelText('New chat')).toBeTruthy();
    fireEvent.press(screen.getByTestId('assistant-new-chat'));
    expect(await screen.findByTestId('assistant-intro')).toBeTruthy();
    expect(screen.queryByTestId('assistant-recent-thr_older')).not.toBeOnTheScreen();
  });

  it('an initial prompt (search\'s Ask row) is sent once in a fresh chat', async () => {
    const sendAssistantMessage = jest.fn(async (_payload: AssistantSendPayload) => reply(null));
    const getAssistantThreadMessages = jest.fn(async (_threadId: string) => []);
    const threads = [{ id: 'thr_latest', title: 'Old', updatedAt: '2026-11-17T17:36:00Z', lastMessagePreview: '' }];
    renderScreen(
      { listAssistantThreads: async () => ({ threads, nextCursor: null }), getAssistantThreadMessages, sendAssistantMessage },
      { initialPrompt: 'should I grade my umbreon?' },
    );
    await waitFor(() => expect(sendAssistantMessage).toHaveBeenCalledTimes(1));
    expect(sendAssistantMessage.mock.calls[0][0].text).toBe('should I grade my umbreon?');
    expect(sendAssistantMessage.mock.calls[0][0].threadId ?? null).toBeNull();
    await act(async () => undefined);
    expect(sendAssistantMessage).toHaveBeenCalledTimes(1);
    expect(getAssistantThreadMessages).not.toHaveBeenCalled();
  });

  it('a scanner open with tray cards starts a fresh chat', async () => {
    const getAssistantThreadMessages = jest.fn(async (_threadId: string) => []);
    const threads = [{ id: 'thr_latest', title: 'Old', updatedAt: '2026-11-17T17:36:00Z', lastMessagePreview: '' }];
    renderScreen(
      { listAssistantThreads: async () => ({ threads, nextCursor: null }), getAssistantThreadMessages },
      { source: 'scanner', cardIds: ['xyp-111'] },
    );
    expect(await screen.findByTestId('assistant-intro')).toBeTruthy();
    await act(async () => undefined);
    expect(getAssistantThreadMessages).not.toHaveBeenCalled();
  });

  it('retries a failed send with the SAME client_message_id', async () => {
    const sendAssistantMessage = jest.fn<Promise<AssistantSendResult>, [AssistantSendPayload]>()
      .mockRejectedValueOnce(new AssistantRequestError('boom', 'assistant_failed', 502))
      .mockResolvedValueOnce(reply(null));
    renderScreen({ sendAssistantMessage });
    await ask('hello');
    expect(await screen.findByTestId('assistant-send-failed')).toBeTruthy();
    fireEvent.press(screen.getByTestId('assistant-retry'));
    await screen.findByTestId('assistant-card-xyp-111');
    const [first, second] = sendAssistantMessage.mock.calls.map(([payload]) => payload.clientMessageId);
    expect(second).toBe(first);
  });

  it('confirm add_to_collection creates a deck entry with selectionSource "assistant" and records the state', async () => {
    const action: AssistantProposedAction = {
      id: 'act_add',
      type: 'add_to_collection',
      summary: 'Add Celebi · NM · ×2',
      state: 'proposed',
      params: { cardId: 'xyp-111', quantity: 2, condition: 'LP', variantName: null, grader: null, grade: null, collectionId: null },
    };
    const createInventoryEntry = jest.fn(async () => ({ deckEntryID: 'new-entry', cardID: 'xyp-111', addedAt: '2026-11-17T10:00:00Z' }));
    const setAssistantActionState = jest.fn(async () => ({ ...action, state: 'confirmed' as const }));
    renderScreen({ sendAssistantMessage: jest.fn(async () => reply(action)), createInventoryEntry, setAssistantActionState });

    await ask('add celebi');
    fireEvent.press(await screen.findByTestId('assistant-action-act_add-confirm'));

    await screen.findByTestId('assistant-action-act_add-done');
    expect(createInventoryEntry).toHaveBeenCalledWith(expect.objectContaining({
      cardID: 'xyp-111',
      quantity: 2,
      condition: 'lightly_played',
      slabContext: null,
      selectionSource: 'assistant',
      sourceScanID: null,
    }));
    expect(setAssistantActionState).toHaveBeenCalledWith('act_add', 'confirmed');
    expect(mockCapture).toHaveBeenCalledWith('assistant_action_confirmed', { type: 'add_to_collection' });
  });

  it('confirm watch_card watches, then sets the target in cents', async () => {
    const action: AssistantProposedAction = {
      id: 'act_watch',
      type: 'watch_card',
      summary: 'Watch Celebi · alert under $30.01',
      state: 'proposed',
      params: { cardId: 'xyp-111', variant: null, targetPriceUsd: 30.005 },
    };
    const calls: string[] = [];
    const setCardFavorite = jest.fn(async (cardId: string) => {
      calls.push('favorite');
      return { cardId, isFavorite: true, watchVariant: null };
    });
    const setCardFavoriteTarget = jest.fn(async (cardId: string, cents: number | null) => {
      calls.push('target');
      return { status: 'ok' as const, target: { cardId, targetPriceCents: cents, targetSetAt: null, targetTriggeredAt: null } };
    });
    renderScreen({
      sendAssistantMessage: jest.fn(async () => reply(action)),
      setCardFavorite,
      setCardFavoriteTarget: setCardFavoriteTarget as never,
    });

    await ask('watch celebi');
    fireEvent.press(await screen.findByTestId('assistant-action-act_watch-confirm'));
    await screen.findByTestId('assistant-action-act_watch-done');
    expect(setCardFavorite).toHaveBeenCalledWith('xyp-111', true, { variant: null });
    expect(setCardFavoriteTarget).toHaveBeenCalledWith('xyp-111', 3001, { variant: null });
    expect(calls).toEqual(['favorite', 'target']);
  });

  it('confirm update_holding changes quantity on the deck entry; dismiss records dismissed', async () => {
    const update: AssistantProposedAction = {
      id: 'act_qty',
      type: 'update_holding',
      summary: 'Oshawott ×2 → ×3',
      state: 'proposed',
      params: { holdingId: 'entry-2', quantity: 3, condition: null },
    };
    const other: AssistantProposedAction = { ...update, id: 'act_other' };
    const setPortfolioEntryQuantity = jest.fn(async () => ({ deckEntryID: 'entry-2', cardID: 'mcdonalds25-21', quantity: 3, deleted: false }));
    const setAssistantActionState = jest.fn(async (id: string, state: 'confirmed' | 'dismissed') => ({ ...update, id, state }));
    const sendAssistantMessage = jest.fn(async () => {
      const result = reply(update);
      return { ...result, message: { ...result.message, actions: [update, other] } };
    });
    renderScreen({ sendAssistantMessage, setPortfolioEntryQuantity, setAssistantActionState });

    await ask('I have 3 oshawott');
    fireEvent.press(await screen.findByTestId('assistant-action-act_qty-confirm'));
    await screen.findByTestId('assistant-action-act_qty-done');
    expect(setPortfolioEntryQuantity).toHaveBeenCalledWith({ deckEntryID: 'entry-2', quantity: 3 });

    fireEvent.press(screen.getByTestId('assistant-action-act_other-dismiss'));
    await screen.findByTestId('assistant-action-act_other-dismissed');
    expect(setAssistantActionState).toHaveBeenCalledWith('act_other', 'dismissed');
    expect(mockCapture).toHaveBeenCalledWith('assistant_action_dismissed', { type: 'update_holding' });
  });

  it('shows the limit-reached state instead of the composer', async () => {
    renderScreen({ getAssistantUsage: jest.fn(async () => mockAssistantUsage(3)) });
    expect(await screen.findByTestId('assistant-limit')).toBeTruthy();
    expect(screen.queryByTestId('assistant-input')).not.toBeOnTheScreen();
    expect(mockCapture).toHaveBeenCalledWith('assistant_limit_hit', { is_guest: false });
  });

  it('a guest who hits the limit gets the sign-in prompt', async () => {
    mockIsGuest = true;
    const sendAssistantMessage = jest.fn(async () => {
      throw new AssistantRequestError('daily_limit', 'daily_limit', 429, { ...mockAssistantUsage(1, 1), isGuest: true });
    });
    renderScreen({ sendAssistantMessage });
    await ask('one more?');
    fireEvent.press(await screen.findByTestId('assistant-sign-in'));
    expect(mockOpenLogin).toHaveBeenCalled();
    expect(mockCapture).toHaveBeenCalledWith('assistant_limit_hit', { is_guest: true });
  });

  it('a guest tapping Confirm is sent to sign in instead of writing', async () => {
    mockIsGuest = true;
    const action: AssistantProposedAction = {
      id: 'act_g',
      type: 'add_to_collection',
      summary: 'Add Celebi',
      state: 'proposed',
      params: { cardId: 'xyp-111', quantity: 1, condition: 'NM', variantName: null, grader: null, grade: null, collectionId: null },
    };
    const createInventoryEntry = jest.fn();
    renderScreen({ sendAssistantMessage: jest.fn(async () => reply(action)), createInventoryEntry });
    await ask('add it');
    fireEvent.press(await screen.findByTestId('assistant-action-act_g-confirm'));
    expect(mockOpenLogin).toHaveBeenCalled();
    expect(createInventoryEntry).not.toHaveBeenCalled();
  });

  it('HISTORY: back, title, CLEAR ALL, rows with date/question/trash, and no composer', async () => {
    // The base mock's seeded chat (opened on mount as the latest one).
    renderScreen({ listAssistantThreads: undefined });
    fireEvent.press(screen.getByTestId('assistant-open-history'));
    expect(await screen.findByTestId('assistant-thread-thr_mock_seed')).toBeTruthy();
    expect(screen.getByText('HISTORY')).toBeTruthy();
    expect(screen.getByText('CLEAR ALL')).toBeTruthy();
    expect(screen.getByLabelText('Back to chat')).toBeTruthy();
    expect(screen.queryByTestId('assistant-input')).not.toBeOnTheScreen();
    expect(screen.queryByTestId('assistant-composer')).not.toBeOnTheScreen();

    fireEvent.press(screen.getByTestId('assistant-back'));
    expect(await screen.findByTestId('assistant-input')).toBeTruthy();
  });

  it('opens a saved chat from HISTORY, and deletes one only after confirming', async () => {
    renderScreen({ listAssistantThreads: undefined });
    fireEvent.press(screen.getByTestId('assistant-open-history'));
    fireEvent.press(await screen.findByTestId('assistant-thread-thr_mock_seed'));
    expect(await screen.findByText('What am I missing from Celestial Storm?')).toBeTruthy();

    fireEvent.press(screen.getByTestId('assistant-open-history'));
    // Cancelled: the row stays.
    const cancel = jest.spyOn(Alert, 'alert').mockImplementationOnce(() => undefined);
    fireEvent.press(await screen.findByTestId('assistant-thread-thr_mock_seed-delete'));
    expect(cancel).toHaveBeenCalledWith('Delete this chat?', expect.any(String), expect.any(Array));
    expect(screen.getByTestId('assistant-thread-thr_mock_seed')).toBeTruthy();

    confirmNextAlert();
    fireEvent.press(screen.getByTestId('assistant-thread-thr_mock_seed-delete'));
    expect(await screen.findByTestId('assistant-threads-empty')).toBeTruthy();
  });

  it('CLEAR ALL asks first, then empties the history', async () => {
    const deleteAllAssistantThreads = jest.fn(async () => 1);
    renderScreen({ listAssistantThreads: undefined, deleteAllAssistantThreads });
    fireEvent.press(screen.getByTestId('assistant-open-history'));
    await screen.findByTestId('assistant-thread-thr_mock_seed');
    confirmNextAlert();
    fireEvent.press(screen.getByTestId('assistant-threads-clear-all'));
    await waitFor(() => expect(deleteAllAssistantThreads).toHaveBeenCalledTimes(1));
    expect(await screen.findByTestId('assistant-threads-empty')).toBeTruthy();
  });

  it.each(['home', 'scanner'] as const)('a %s chat without cards offers exactly the 3 market prompts, full width, one per row', async (source) => {
    const sendAssistantMessage = jest.fn(async (_payload: AssistantSendPayload) => reply(null));
    renderScreen({ sendAssistantMessage }, { source });
    const chips = await screen.findByTestId('assistant-suggestions');
    expect(StyleSheet.flatten(chips.props.style)).toMatchObject({ alignItems: 'stretch' });
    expect(StyleSheet.flatten(chips.props.style).flexDirection).not.toBe('row');
    expect(ASSISTANT_MARKET_PROMPTS).toEqual([
      "What's my collection worth?",
      'Which of my cards went up this week?',
      "What's trending in the market right now?",
    ]);
    ASSISTANT_MARKET_PROMPTS.forEach((prompt, index) => {
      expect(screen.getByTestId(`assistant-suggestion-${index}`)).toHaveTextContent(prompt);
    });
    expect(screen.queryByTestId('assistant-suggestion-3')).not.toBeOnTheScreen();
    fireEvent.press(screen.getByTestId('assistant-suggestion-1'));
    await waitFor(() => expect(sendAssistantMessage).toHaveBeenCalledTimes(1));
    expect(sendAssistantMessage.mock.calls[0][0].text).toBe('Which of my cards went up this week?');
  });

  it('hides the starter prompts once the user starts typing, keeping the greeting', async () => {
    renderScreen({});
    await screen.findByTestId('assistant-suggestions');
    fireEvent.changeText(screen.getByTestId('assistant-input'), 'What is');
    expect(screen.queryByTestId('assistant-suggestions')).not.toBeOnTheScreen();
    expect(screen.getByTestId('assistant-greeting')).toBeTruthy();
    fireEvent.changeText(screen.getByTestId('assistant-input'), '');
    expect(await screen.findByTestId('assistant-suggestions')).toBeTruthy();
  });

  it('the scanner gets the same starter prompts as everywhere else, with the tray attached', async () => {
    renderScreen({}, { source: 'scanner', cardIds: ['xyp-111'] });
    expect(await screen.findByText('Ask about this card')).toBeTruthy();
    expect(screen.getByText("What's trending in the market right now?")).toBeTruthy();
    expect(screen.queryByText('Is this card worth grading?')).not.toBeOnTheScreen();
  });

  it('shows follow-up chips under the LATEST reply only, and tapping one sends it', async () => {
    const sendAssistantMessage = jest.fn<Promise<AssistantSendResult>, [AssistantSendPayload]>()
      .mockResolvedValueOnce(reply(null, { suggestions: ['Is Celebi worth grading?', 'Watch Celebi'] }))
      .mockImplementationOnce(async () => {
        const next = reply(null, { id: 'a2', suggestions: ['What else is trending?'] });
        return { ...next, userMessage: { ...next.userMessage, id: 'u2' } };
      });
    renderScreen({ sendAssistantMessage });
    await ask('first');
    expect(await screen.findByTestId('assistant-followups')).toBeTruthy();
    expect(screen.getByText('Is Celebi worth grading?')).toBeTruthy();

    fireEvent.press(screen.getByTestId('assistant-followup-0'));
    await waitFor(() => expect(sendAssistantMessage).toHaveBeenCalledTimes(2));
    expect(sendAssistantMessage.mock.calls[1][0].text).toBe('Is Celebi worth grading?');
    expect(await screen.findByText('What else is trending?')).toBeTruthy();
    // The earlier reply's chips are gone: only the newest reply offers follow-ups.
    expect(screen.queryByText('Watch Celebi')).not.toBeOnTheScreen();
    expect(screen.getAllByTestId('assistant-followups')).toHaveLength(1);
  });

  it('renders no follow-up chips when the server sends none (older backend)', async () => {
    renderScreen({ sendAssistantMessage: jest.fn(async () => reply(null)) });
    await ask('q');
    await screen.findByTestId('assistant-card-xyp-111');
    expect(screen.queryByTestId('assistant-followups')).not.toBeOnTheScreen();
  });

  describe('direct add (server-executed)', () => {
    const executed: AssistantProposedAction = {
      id: 'act_direct',
      type: 'add_to_collection',
      summary: 'Added Celebi (XY Promos 111) · NM · ×2',
      state: 'done',
      params: { cardId: 'xyp-111', quantity: 2, condition: 'NM', variantName: null, grader: null, grade: null, collectionId: null },
      undo: { deckEntryId: 'entry-new', quantityAdded: 2, expiresAt: '2999-01-01T00:00:00Z' },
    };

    it('renders "Added ✓" with Undo and no Confirm, and never writes from the app', async () => {
      const createInventoryEntry = jest.fn();
      const sendAssistantMessage = jest.fn(async (_payload: AssistantSendPayload) => reply(executed));
      renderScreen({ sendAssistantMessage, createInventoryEntry });
      await ask('Add two near mint Celebi XY Promos 111');

      expect(await screen.findByTestId('assistant-action-act_direct-done')).toBeTruthy();
      expect(screen.getByText('Added Celebi (XY Promos 111) · NM · ×2')).toBeTruthy();
      expect(screen.getByTestId('assistant-action-act_direct-undo')).toBeTruthy();
      expect(screen.queryByTestId('assistant-action-act_direct-confirm')).not.toBeOnTheScreen();
      expect(createInventoryEntry).not.toHaveBeenCalled();
      expect(mockCapture).toHaveBeenCalledWith('assistant_action_confirmed', { type: 'add_to_collection', direct: true });
    });

    it('Undo calls the undo endpoint once and shows the undone state', async () => {
      const undoAssistantAction = jest.fn(async () => ({ ...executed, state: 'undone' as const }));
      renderScreen({ sendAssistantMessage: jest.fn(async () => reply(executed)), undoAssistantAction });
      await ask('Add two near mint Celebi XY Promos 111');

      fireEvent.press(await screen.findByTestId('assistant-action-act_direct-undo'));
      expect(await screen.findByTestId('assistant-action-act_direct-undone')).toBeTruthy();
      expect(undoAssistantAction).toHaveBeenCalledTimes(1);
      expect(undoAssistantAction).toHaveBeenCalledWith('act_direct');
      expect(screen.queryByTestId('assistant-action-act_direct-undo')).not.toBeOnTheScreen();
      expect(mockCapture).toHaveBeenCalledWith('assistant_action_undone', { type: 'add_to_collection' });
    });

    it('a refused undo keeps the add and explains why', async () => {
      const undoAssistantAction = jest.fn(async () => {
        throw new AssistantRequestError('undo_expired', 'undo_expired', 409);
      });
      renderScreen({ sendAssistantMessage: jest.fn(async () => reply(executed)), undoAssistantAction });
      await ask('Add two near mint Celebi XY Promos 111');

      fireEvent.press(await screen.findByTestId('assistant-action-act_direct-undo'));
      expect(await screen.findByText('Undo is only available for 24 hours.')).toBeTruthy();
      expect(screen.getByTestId('assistant-action-act_direct-done')).toBeTruthy();
    });

    it('hides Undo once the window has passed', async () => {
      const expired = { ...executed, undo: { ...executed.undo!, expiresAt: '2020-01-01T00:00:00Z' } };
      renderScreen({ sendAssistantMessage: jest.fn(async () => reply(expired)) });
      await ask('Add two near mint Celebi XY Promos 111');
      expect(await screen.findByTestId('assistant-action-act_direct-done')).toBeTruthy();
      expect(screen.queryByTestId('assistant-action-act_direct-undo')).not.toBeOnTheScreen();
    });
  });

  it('shows the thinking row and a busy send button while waiting', async () => {
    let resolveSend: (value: AssistantSendResult) => void = () => undefined;
    const sendAssistantMessage = jest.fn(() => new Promise<AssistantSendResult>((resolve) => {
      resolveSend = resolve;
    }));
    renderScreen({ sendAssistantMessage });
    await ask('slow one');
    expect(await screen.findByTestId('assistant-sending')).toBeTruthy();
    expect(screen.getByTestId('assistant-send-spinner')).toBeTruthy();
    expect(screen.getByTestId('assistant-pending-question')).toBeTruthy();
    await act(async () => {
      resolveSend(reply(null));
    });
    expect(await screen.findByTestId('assistant-card-xyp-111')).toBeTruthy();
    expect(screen.queryByTestId('assistant-sending')).not.toBeOnTheScreen();
  });

  it('the send button is gray and disabled until there is text, then black', async () => {
    const sendAssistantMessage = jest.fn(async () => reply(null));
    renderScreen({ sendAssistantMessage });
    await screen.findByTestId('assistant-intro');
    expect(screen.getByPlaceholderText('Chat with Ekalight')).toBeTruthy();
    expect(sendButtonColor()).toBe('#E8E8E8');
    expect(screen.getByTestId('assistant-send')).toBeDisabled();
    fireEvent.press(screen.getByTestId('assistant-send'));
    fireEvent.changeText(screen.getByTestId('assistant-input'), '   ');
    fireEvent.press(screen.getByTestId('assistant-send'));
    expect(sendAssistantMessage).not.toHaveBeenCalled();

    fireEvent.changeText(screen.getByTestId('assistant-input'), 'Is Celebi worth grading?');
    expect(sendButtonColor()).toBe('#1A1A1A');
    expect(screen.getByTestId('assistant-send')).toBeEnabled();
    // One line of text stays a single row; it only stacks once the text wraps.
    expect(StyleSheet.flatten(screen.getByTestId('assistant-composer').props.style).flexDirection).toBe('row');
  });

  it('long-pressing a reply copies its text without markdown markers', async () => {
    renderScreen({ sendAssistantMessage: jest.fn(async () => reply(null)) });
    await ask('q');
    fireEvent(await screen.findByTestId('assistant-message-a1-press'), 'longPress');
    await waitFor(() => expect(Clipboard.setStringAsync).toHaveBeenCalledWith('Here is Celebi.'));
    expect(await screen.findByText('Copied')).toBeTruthy();
  });
});
