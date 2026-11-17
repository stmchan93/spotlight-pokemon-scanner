import { fireEvent, screen, waitFor } from '@testing-library/react-native';

import {
  AssistantRequestError,
  mockAssistantCards,
  mockAssistantUsage,
  type AssistantMessage,
  type AssistantProposedAction,
  type AssistantSendPayload,
  type AssistantSendResult,
} from '@spotlight/api-client';

import { AssistantScreen } from '@/features/assistant/screens/assistant-screen';

import { createTestSpotlightRepository, renderWithProviders } from '../../test-utils';

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
  const repository = createTestSpotlightRepository(repoOverrides);
  const onOpenCard = jest.fn();
  renderWithProviders(
    <AssistantScreen onBack={jest.fn()} onOpenCard={onOpenCard} source="home" {...props} />,
    { spotlightRepository: repository },
  );
  return { repository, onOpenCard };
}

beforeEach(() => {
  mockIsGuest = false;
  mockOpenLogin.mockClear();
  mockCapture.mockClear();
});

describe('AssistantScreen', () => {
  it('shows the usage pill, sends a question, and renders text + tappable card tiles', async () => {
    const { onOpenCard } = renderScreen({});
    expect(await screen.findByText('3 LEFT TODAY')).toBeTruthy();
    expect(mockCapture).toHaveBeenCalledWith('assistant_opened', { source: 'home' });

    await ask("What's my collection worth?");
    expect(await screen.findByTestId('assistant-card-xyp-111')).toBeTruthy();
    expect(screen.getByText('2 LEFT TODAY')).toBeTruthy();
    expect(screen.getByText('$37.54')).toBeTruthy();
    expect(mockCapture).toHaveBeenCalledWith('assistant_question_sent', { source: 'home' });

    fireEvent.press(screen.getByTestId('assistant-card-xyp-111'));
    expect(onOpenCard).toHaveBeenCalledWith('xyp-111');
  });

  it('hides the pill when the limit is null (unlimited)', async () => {
    const getAssistantUsage = jest.fn(async () => mockAssistantUsage(5, null));
    renderScreen({ getAssistantUsage });
    await waitFor(() => expect(getAssistantUsage).toHaveBeenCalled());
    expect(screen.queryByTestId('assistant-usage-pill')).not.toBeOnTheScreen();
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

  it('opens saved chats, resumes one, and deletes one', async () => {
    renderScreen({});
    fireEvent.press(screen.getByTestId('assistant-open-history'));
    fireEvent.press(await screen.findByTestId('assistant-thread-thr_mock_seed'));
    expect(await screen.findByText('What am I missing from Celestial Storm?')).toBeTruthy();

    fireEvent.press(screen.getByTestId('assistant-open-history'));
    fireEvent.press(await screen.findByTestId('assistant-thread-thr_mock_seed-delete'));
    expect(await screen.findByTestId('assistant-threads-empty')).toBeTruthy();
  });
});
