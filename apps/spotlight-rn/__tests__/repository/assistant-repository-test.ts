import {
  HttpSpotlightRepository,
  MockSpotlightRepository,
} from '../../../../packages/api-client/src/spotlight/repository';
import {
  AssistantRequestError,
  buildAssistantSendBody,
  isAssistantRequestError,
  parseAssistantAction,
  parseAssistantMessage,
  parseAssistantSuggestions,
} from '../../../../packages/api-client/src/spotlight/assistant-wire';
import { parseAssistantMarkdown } from '@/features/assistant/assistant-markdown';

function jsonResponse(status: number, body?: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
  } as Response;
}

function lastRequest(): [string, RequestInit | undefined] {
  const calls = (global.fetch as jest.Mock).mock.calls as [string, RequestInit | undefined][];
  return calls[calls.length - 1];
}

const wireUsage = { limit: 3, used_today: 1, remaining_today: 2, resets_at: '2026-11-18T00:00:00Z', is_guest: false };

const wireAssistantMessage = {
  id: 'msg_2',
  thread_id: 'thr_1',
  role: 'assistant',
  text: 'You own **Celebi**.',
  cards: [
    {
      card_id: 'xyp-111',
      name: 'Celebi',
      set: 'XY Black Star Promos',
      number: 'XY111',
      language: 'en',
      image_small_url: 'https://img/celebi.png',
      price_usd: 37.54,
      variant: null,
      grader: null,
      grade: null,
      quantity_owned: 1,
      app_url: 'spotlight://cards/xyp-111',
    },
    { name: 'no id — dropped' },
  ],
  actions: [
    {
      id: 'act_1',
      type: 'add_to_collection',
      summary: 'Add Celebi · NM · ×1',
      params: { card_id: 'xyp-111', quantity: 1, condition: 'NM', variant_name: null, grader: null, grade: null, collection_id: null },
      state: 'proposed',
    },
    { id: 'act_bad', type: 'delete_everything', params: {} },
  ],
  created_at: '2026-11-17T10:00:00Z',
  status: 'ok',
};

describe('assistant wire normalization', () => {
  it('normalizes a message: cards + actions camelCased, malformed rows dropped', () => {
    const message = parseAssistantMessage(wireAssistantMessage);
    expect(message).toMatchObject({ id: 'msg_2', threadId: 'thr_1', role: 'assistant', status: 'ok' });
    expect(message?.cards).toEqual([
      expect.objectContaining({ cardId: 'xyp-111', setName: 'XY Black Star Promos', priceUsd: 37.54, quantityOwned: 1, imageSmallUrl: 'https://img/celebi.png' }),
    ]);
    expect(message?.actions).toEqual([
      expect.objectContaining({ id: 'act_1', type: 'add_to_collection', params: expect.objectContaining({ cardId: 'xyp-111', condition: 'NM', quantity: 1 }) }),
    ]);
  });

  it('parses update_holding and watch_card params', () => {
    expect(parseAssistantAction({ id: 'a', type: 'update_holding', summary: 's', params: { holding_id: 'entry-2', quantity: 3, condition: 'lp' }, state: 'confirmed' }))
      .toEqual({ id: 'a', type: 'update_holding', summary: 's', state: 'confirmed', params: { holdingId: 'entry-2', quantity: 3, condition: 'LP' } });
    expect(parseAssistantAction({ id: 'b', type: 'watch_card', summary: 's', params: { card_id: 'c1', variant: null, target_price_usd: 12.5 } }))
      .toEqual({ id: 'b', type: 'watch_card', summary: 's', state: 'proposed', params: { cardId: 'c1', variant: null, targetPriceUsd: 12.5 } });
  });

  it('parses an executed add with its undo info', () => {
    const parsed = parseAssistantAction({
      id: 'act_x', type: 'add_to_collection', summary: 'Added', state: 'done',
      params: { card_id: 'c1', quantity: 2, condition: 'NM' },
      undo: { deck_entry_id: 'deckentry:1', quantity_added: 2, expires_at: '2026-11-21T00:00:00Z' },
    });
    expect(parsed).toMatchObject({
      state: 'done',
      undo: { deckEntryId: 'deckentry:1', quantityAdded: 2, expiresAt: '2026-11-21T00:00:00Z' },
    });
    expect(parseAssistantAction({ id: 'u', type: 'add_to_collection', summary: '', state: 'undone', params: { card_id: 'c1' } })?.state)
      .toBe('undone');
  });

  it('builds a snake_case send body and caps scanner context at 20 unique ids', () => {
    const ids = Array.from({ length: 25 }, (_, index) => `card-${index % 22}`);
    const body = buildAssistantSendBody({ threadId: null, clientMessageId: 'cid', text: 'hi', context: { source: 'scanner', cardIds: ids } });
    expect(body).toEqual({
      thread_id: null,
      client_message_id: 'cid',
      text: 'hi',
      capabilities: ['direct_add'],
      context: { source: 'scanner', card_ids: Array.from({ length: 20 }, (_, index) => `card-${index}`) },
    });
  });

  it('parses **bold**, headings, bullets and numbered lines; a stray # stays literal', () => {
    expect(parseAssistantMarkdown('Worth **$5**\n- one\n* two\n#not a heading\n## Top picks\n1. Celebi\n2) Oshawott')).toEqual([
      { kind: 'paragraph', spans: [{ text: 'Worth ', bold: false }, { text: '$5', bold: true }] },
      { kind: 'bullet', spans: [{ text: 'one', bold: false }] },
      { kind: 'bullet', spans: [{ text: 'two', bold: false }] },
      { kind: 'paragraph', spans: [{ text: '#not a heading', bold: false }] },
      { kind: 'heading', spans: [{ text: 'Top picks', bold: false }] },
      { kind: 'numbered', marker: '1.', spans: [{ text: 'Celebi', bold: false }] },
      { kind: 'numbered', marker: '2.', spans: [{ text: 'Oshawott', bold: false }] },
    ]);
  });

  it('a line that starts with **bold** is a paragraph, not a bullet', () => {
    expect(parseAssistantMarkdown('**Celebi** is $37.54')[0].kind).toBe('paragraph');
  });

  it('parses follow-up suggestions: strings only, trimmed, de-duplicated, capped at 3', () => {
    expect(parseAssistantSuggestions([' Is it worth grading? ', 7, null, '', 'Is it worth grading?', 'PSA 10 price?', 'Trend?', 'Fourth'])).toEqual([
      'Is it worth grading?',
      'PSA 10 price?',
      'Trend?',
    ]);
    expect(parseAssistantSuggestions(undefined)).toEqual([]);
    expect(parseAssistantSuggestions('not a list')).toEqual([]);
  });

  it('carries suggestions on assistant messages only, and tolerates an older server without them', () => {
    expect(parseAssistantMessage({ ...wireAssistantMessage, suggestions: ['Watch it', 3] })?.suggestions).toEqual(['Watch it']);
    expect(parseAssistantMessage(wireAssistantMessage)?.suggestions).toEqual([]);
    expect(parseAssistantMessage({ ...wireAssistantMessage, role: 'user', suggestions: ['x'] })?.suggestions).toEqual([]);
  });
});

describe('HttpSpotlightRepository — assistant', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  const repository = () => new HttpSpotlightRepository('http://example.test', { getAccessToken: () => 'tok' });

  it('POSTs a message with auth and normalizes the reply', async () => {
    global.fetch = jest.fn().mockResolvedValue(jsonResponse(200, {
      thread_id: 'thr_1',
      user_message: { ...wireAssistantMessage, id: 'msg_1', role: 'user', cards: [], actions: [] },
      message: { ...wireAssistantMessage, suggestions: ['Is Celebi worth grading?'] },
      usage: wireUsage,
    })) as typeof fetch;

    const result = await repository().sendAssistantMessage({
      threadId: null,
      clientMessageId: 'client-1',
      text: "What's my collection worth?",
      context: { source: 'home' },
    });

    const [url, init] = lastRequest();
    expect(url).toBe('http://example.test/api/v1/assistant/messages');
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer tok');
    expect(JSON.parse(String(init?.body))).toEqual({
      thread_id: null,
      client_message_id: 'client-1',
      text: "What's my collection worth?",
      capabilities: ['direct_add'],
      context: { source: 'home' },
    });
    expect(result.threadId).toBe('thr_1');
    expect(result.message.suggestions).toEqual(['Is Celebi worth grading?']);
    expect(result.usage).toEqual({ limit: 3, usedToday: 1, remainingToday: 2, resetsAt: '2026-11-18T00:00:00Z', isGuest: false });
    expect(result.message.cards[0].cardId).toBe('xyp-111');
  });

  it('turns a 429 into a daily_limit error carrying usage', async () => {
    global.fetch = jest.fn().mockResolvedValue(jsonResponse(429, {
      error: 'daily_limit',
      usage: { ...wireUsage, used_today: 1, remaining_today: 0, limit: 1, is_guest: true },
    })) as typeof fetch;

    const error = await repository()
      .sendAssistantMessage({ threadId: 'thr_1', clientMessageId: 'c', text: 'hi' })
      .catch((caught: unknown) => caught);
    expect(isAssistantRequestError(error)).toBe(true);
    expect((error as AssistantRequestError).code).toBe('daily_limit');
    expect((error as AssistantRequestError).usage).toMatchObject({ remainingToday: 0, isGuest: true });
  });

  it.each([
    [503, { error: 'assistant_disabled' }, 'assistant_disabled'],
    [503, { error: 'assistant_busy' }, 'assistant_busy'],
    [502, { error: 'assistant_failed' }, 'assistant_failed'],
    [401, undefined, 'unauthenticated'],
  ])('maps %s %j to %s', async (status, body, code) => {
    global.fetch = jest.fn().mockResolvedValue(jsonResponse(status, body)) as typeof fetch;
    const error = await repository().getAssistantUsage().catch((caught: unknown) => caught);
    expect((error as AssistantRequestError).code).toBe(code);
  });

  it('reads threads, messages, deletes, and records action state at the contract paths', async () => {
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(jsonResponse(200, {
        threads: [{ id: 'thr_1', title: 'Q', updated_at: '2026-11-17T10:00:00Z', last_message_preview: 'A' }],
        next_cursor: 'c2',
      }))
      .mockResolvedValueOnce(jsonResponse(200, { messages: [wireAssistantMessage] }))
      .mockResolvedValueOnce(jsonResponse(200, { deleted: true }))
      .mockResolvedValueOnce(jsonResponse(200, { deleted: 4 }))
      .mockResolvedValueOnce(jsonResponse(200, { action: { ...wireAssistantMessage.actions[0], state: 'confirmed' } }));
    global.fetch = fetchMock as typeof fetch;
    const repo = repository();

    const page = await repo.listAssistantThreads({ limit: 20, cursor: 'c1' });
    expect(page).toEqual({
      threads: [{ id: 'thr_1', title: 'Q', updatedAt: '2026-11-17T10:00:00Z', lastMessagePreview: 'A' }],
      nextCursor: 'c2',
    });
    expect(lastRequest()[0]).toBe('http://example.test/api/v1/assistant/threads?limit=20&cursor=c1');

    const messages = await repo.getAssistantThreadMessages('thr_1');
    expect(messages).toHaveLength(1);
    expect(lastRequest()[0]).toBe('http://example.test/api/v1/assistant/threads/thr_1/messages?limit=50');

    await expect(repo.deleteAssistantThread('thr_1')).resolves.toBe(true);
    expect(lastRequest()[1]?.method).toBe('DELETE');
    await expect(repo.deleteAllAssistantThreads()).resolves.toBe(4);
    expect(lastRequest()[0]).toBe('http://example.test/api/v1/assistant/threads');

    const action = await repo.setAssistantActionState('act_1', 'confirmed');
    expect(action.state).toBe('confirmed');
    expect(lastRequest()[0]).toBe('http://example.test/api/v1/assistant/actions/act_1');
    expect(JSON.parse(String(lastRequest()[1]?.body))).toEqual({ state: 'confirmed' });
  });

  it('undoes an executed add at the contract path and maps refusals', async () => {
    const executed = { ...wireAssistantMessage.actions[0], state: 'undone' };
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(jsonResponse(200, { action: executed }))
      .mockResolvedValueOnce(jsonResponse(409, { error: 'undo_expired', detail: 'x' }));
    global.fetch = fetchMock as typeof fetch;
    const repo = repository();
    await expect(repo.undoAssistantAction('act_1')).resolves.toMatchObject({ state: 'undone' });
    expect(fetchMock.mock.calls[0][0]).toBe('http://example.test/api/v1/assistant/actions/act_1/undo');
    expect(fetchMock.mock.calls[0][1]?.method).toBe('POST');
    const error = await repo.undoAssistantAction('act_1').catch((caught: unknown) => caught);
    expect((error as AssistantRequestError).code).toBe('undo_expired');
  });
});

describe('MockSpotlightRepository — assistant', () => {
  it('is idempotent on client_message_id and enforces the daily limit', async () => {
    const repo = new MockSpotlightRepository();
    const first = await repo.sendAssistantMessage({ threadId: null, clientMessageId: 'same', text: 'add a card' });
    const replay = await repo.sendAssistantMessage({ threadId: null, clientMessageId: 'same', text: 'add a card' });
    expect(replay).toBe(first);
    expect(first.message.actions[0].type).toBe('add_to_collection');
    expect(first.usage.remainingToday).toBe(2);

    await repo.sendAssistantMessage({ threadId: first.threadId, clientMessageId: 'b', text: 'watch it' });
    await repo.sendAssistantMessage({ threadId: first.threadId, clientMessageId: 'c', text: 'hello' });
    const error = await repo
      .sendAssistantMessage({ threadId: first.threadId, clientMessageId: 'd', text: 'one more' })
      .catch((caught: unknown) => caught);
    expect((error as AssistantRequestError).code).toBe('daily_limit');

    const threads = await repo.listAssistantThreads();
    expect(threads.threads[0].id).toBe(first.threadId);
    const confirmed = await repo.setAssistantActionState(first.message.actions[0].id, 'confirmed');
    expect(confirmed.state).toBe('confirmed');
  });
});
