import { fireEvent, screen, waitFor } from '@testing-library/react-native';

import {
  mockAssistantCards,
  mockAssistantUsage,
  parseAssistantMessage,
  type AssistantMessage,
  type AssistantPrintingChoice,
  type AssistantSendPayload,
  type AssistantSendResult,
} from '@spotlight/api-client';

import { assistantPrintingChoiceMessage } from '@/features/assistant/assistant-printing-choice';
import { AssistantMessageBubble } from '@/features/assistant/components/assistant-message-bubble';
import { AssistantScreen } from '@/features/assistant/screens/assistant-screen';

import { createTestSpotlightRepository, renderWithProviders } from '../../test-utils';

jest.mock('@/features/auth/use-guest-gate', () => ({
  useGuestGate: () => ({
    ensureGuestSession: jest.fn(async () => ({ access_token: 'guest' })),
    gate: (fn: () => void) => fn,
    isGuest: false,
    openLogin: jest.fn(),
  }),
}));

const { celebi, oshawott } = mockAssistantCards;

const addChoice: AssistantPrintingChoice = {
  kind: 'pick_printing',
  intent: 'add',
  quantity: 1,
  condition: 'NM',
  grader: null,
  grade: null,
  quantityStated: false,
  conditionStated: false,
};

function choiceReply(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    id: 'c1',
    threadId: 'thr_1',
    role: 'assistant',
    text: 'I found two printings. Tap a card below to pick the right one.',
    cards: [celebi, oshawott],
    actions: [],
    createdAt: '2026-11-21T10:00:00Z',
    status: 'ok',
    choice: addChoice,
    ...overrides,
  };
}

describe('assistant printing choice', () => {
  it('parses the wire choice; unknown kinds, user rows and older servers get none', () => {
    const parsed = parseAssistantMessage({
      id: 'm',
      role: 'assistant',
      text: 'x',
      choice: { kind: 'pick_printing', intent: 'add', quantity: 2, condition: 'lp', grader: null, grade: null,
        quantity_stated: true, condition_stated: true },
    });
    expect(parsed?.choice).toEqual({
      kind: 'pick_printing',
      intent: 'add',
      quantity: 2,
      condition: 'LP',
      grader: null,
      grade: null,
      quantityStated: true,
      conditionStated: true,
    });
    expect(parseAssistantMessage({ id: 'm', role: 'assistant', text: 'x', choice: { kind: 'add' } })?.choice).toBeNull();
    expect(parseAssistantMessage({ id: 'm', role: 'assistant', text: 'x' })?.choice).toBeNull();
    expect(
      parseAssistantMessage({ id: 'u', role: 'user', text: 'x', choice: { kind: 'pick_printing', intent: 'add' } })?.choice,
    ).toBeNull();
    // Missing defaults: add = ×1 NM, a slab has no condition.
    expect(
      parseAssistantMessage({ id: 'm', role: 'assistant', text: 'x', choice: { kind: 'pick_printing', intent: 'add', grader: 'PSA', grade: '10' } })
        ?.choice,
    ).toMatchObject({ quantity: 1, condition: null, grader: 'PSA', grade: '10' });
  });

  it('builds the follow-up from the tapped printing, repeating only stated details', () => {
    expect(assistantPrintingChoiceMessage(addChoice, celebi)).toBe(
      'Add Celebi (XY Black Star Promos XY111) to my collection',
    );
    expect(
      assistantPrintingChoiceMessage(
        { ...addChoice, quantity: 2, condition: 'LP', quantityStated: true, conditionStated: true },
        celebi,
      ),
    ).toBe('Add 2 Lightly Played Celebi (XY Black Star Promos XY111) to my collection');
    expect(
      assistantPrintingChoiceMessage({ ...addChoice, condition: null, grader: 'PSA', grade: '10', conditionStated: true }, celebi),
    ).toBe('Add PSA 10 Celebi (XY Black Star Promos XY111) to my collection');
    expect(
      assistantPrintingChoiceMessage(
        { ...addChoice, intent: 'update', quantity: 3, condition: null, quantityStated: true },
        oshawott,
      ),
    ).toBe("Update my Oshawott (McDonald's Collection 2021 21/25) to 3 copies");
  });

  it('choice tiles pick on tap, open the card on long-press, and show the hint', () => {
    const onPickCard = jest.fn();
    const onOpenCard = jest.fn();
    const message = choiceReply();
    renderWithProviders(
      <AssistantMessageBubble
        actionStates={{}}
        message={message}
        onConfirmAction={jest.fn()}
        onDismissAction={jest.fn()}
        onOpenCard={onOpenCard}
        onPickCard={onPickCard}
      />,
    );
    expect(screen.getByTestId('assistant-card-xyp-111-pick-hint')).toHaveTextContent('Tap to pick');
    fireEvent.press(screen.getByTestId('assistant-card-xyp-111'));
    expect(onPickCard).toHaveBeenCalledWith(celebi, message);
    expect(onOpenCard).not.toHaveBeenCalled();
    fireEvent(screen.getByTestId('assistant-card-xyp-111'), 'longPress');
    expect(onOpenCard).toHaveBeenCalledWith('xyp-111');
  });

  it('without onPickCard (an older reply) tiles open the card page as usual', () => {
    const onOpenCard = jest.fn();
    renderWithProviders(
      <AssistantMessageBubble
        actionStates={{}}
        message={choiceReply()}
        onConfirmAction={jest.fn()}
        onDismissAction={jest.fn()}
        onOpenCard={onOpenCard}
      />,
    );
    expect(screen.queryByTestId('assistant-card-xyp-111-pick-hint')).toBeNull();
    fireEvent.press(screen.getByTestId('assistant-card-xyp-111'));
    expect(onOpenCard).toHaveBeenCalledWith('xyp-111');
  });

  it('tapping a candidate on the latest reply sends the add for that card id', async () => {
    const base = { threadId: 'thr_1', createdAt: '2026-11-21T10:00:00Z', status: 'ok' as const };
    const first: AssistantSendResult = {
      threadId: 'thr_1',
      userMessage: { ...base, id: 'u1', role: 'user', text: 'Add Celebi', cards: [], actions: [] },
      message: choiceReply(),
      usage: mockAssistantUsage(1),
    };
    const second: AssistantSendResult = {
      ...first,
      userMessage: { ...first.userMessage, id: 'u2' },
      message: { ...choiceReply({ id: 'a2', choice: null, text: 'Ready to add.', cards: [celebi] }) },
    };
    const sendAssistantMessage = jest
      .fn(async (_payload: AssistantSendPayload) => first)
      .mockImplementationOnce(async () => first)
      .mockImplementationOnce(async () => second);
    const repository = createTestSpotlightRepository({
      listAssistantThreads: async () => ({ threads: [], nextCursor: null }),
      sendAssistantMessage,
    });
    const onOpenCard = jest.fn();
    renderWithProviders(<AssistantScreen onBack={jest.fn()} onOpenCard={onOpenCard} source="home" />, {
      spotlightRepository: repository,
    });
    fireEvent.changeText(screen.getByTestId('assistant-input'), 'Add Celebi to my collection');
    fireEvent.press(screen.getByTestId('assistant-send'));
    fireEvent.press(await screen.findByTestId('assistant-card-mcdonalds25-21'));
    await waitFor(() => expect(sendAssistantMessage).toHaveBeenCalledTimes(2));
    expect(sendAssistantMessage.mock.calls[1][0]).toMatchObject({
      threadId: 'thr_1',
      text: "Add Oshawott (McDonald's Collection 2021 21/25) to my collection",
      context: { source: 'home', cardIds: ['mcdonalds25-21'] },
    });
    expect(onOpenCard).not.toHaveBeenCalled();
  });
});
