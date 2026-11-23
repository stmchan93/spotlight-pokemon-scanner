import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';

import {
  buildAssistantSendBody,
  mockAssistantUsage,
  type AssistantMessage,
  type AssistantPageContext,
  type AssistantSendPayload,
  type AssistantSendResult,
} from '@spotlight/api-client';

import { ASSISTANT_MARKET_PROMPTS, assistantPagePrompts } from '@/features/assistant/assistant-prompts';
import { assistantHref, parseAssistantRouteParams } from '@/features/assistant/assistant-route';
import {
  ASSISTANT_BUBBLE_SIZE,
  assistantBubbleHiddenOnRoute,
  assistantBubbleZone,
  bubbleRoutePath,
  clampToZone,
  snapSide,
} from '@/features/assistant/page-context/assistant-bubble-zones';
import {
  assistantPageKey,
  resolveAssistantOpenContext,
  resolveAssistantRoutePage,
} from '@/features/assistant/page-context/assistant-page-context';
import {
  readThreadPageKey,
  rememberThreadPageKey,
  resetAssistantPagePersistence,
} from '@/features/assistant/page-context/assistant-page-persistence';
import { AssistantScreen } from '@/features/assistant/screens/assistant-screen';
import { registerScanTrayAssistantBridge } from '@/features/scanner/scan-tray-assistant-bridge';

import { createTestSpotlightRepository, renderWithProviders } from '../../test-utils';

jest.mock('@react-native-async-storage/async-storage', () => {
  const store = new Map<string, string>();
  return {
    __esModule: true,
    default: {
      getItem: jest.fn(async (key: string) => store.get(key) ?? null),
      setItem: jest.fn(async (key: string, value: string) => {
        store.set(key, value);
      }),
      removeItem: jest.fn(async (key: string) => {
        store.delete(key);
      }),
      clear: () => store.clear(),
    },
  };
});

jest.mock('@/features/auth/use-guest-gate', () => ({
  useGuestGate: () => ({
    ensureGuestSession: jest.fn(async () => ({ access_token: 'guest' })),
    gate: (fn: () => void) => fn,
    isGuest: false,
    openLogin: jest.fn(),
  }),
}));

// The test-bypass AuthProvider's user.
const TEST_OWNER = '00000000-0000-0000-0000-000000000001';

const CARD_PAGE: AssistantPageContext = {
  kind: 'card',
  label: 'Charizard ex · 151',
  params: { card_id: 'sv3pt5-199' },
};

function reply(threadId = 'thr_new'): AssistantSendResult {
  const base = { threadId, createdAt: '2026-11-22T10:00:00Z', status: 'ok' as const };
  const message: AssistantMessage = { ...base, id: 'a1', role: 'assistant', text: 'ok', cards: [], actions: [] };
  return {
    threadId,
    userMessage: { ...base, id: 'u1', role: 'user', text: 'q', cards: [], actions: [] },
    message,
    usage: mockAssistantUsage(1),
  };
}

describe('route → page context', () => {
  it.each([
    ['/', 'collection', {}],
    ['/wishlist', 'watchlist', {}],
    ['/scan', 'scanner', {}],
    ['/events', 'events', {}],
    ['/events/hawaii-2026-10', 'event', { event_id: 'hawaii-2026-10' }],
    ['/social', 'social', {}],
    ['/u/ash', 'profile', { handle: 'ash' }],
    ['/cards/sv3pt5-199', 'card', { card_id: 'sv3pt5-199' }],
    ['/set-spotlight/sv3pt5', 'set', { set_id: 'sv3pt5' }],
    ['/search/people', 'search', { tab: 'people' }],
    ['/catalog/game/onepiece', 'search', { game: 'onepiece' }],
    ['/somewhere/new', 'other', {}],
  ])('%s → %s', (pathname, kind, params) => {
    const page = resolveAssistantRoutePage(pathname);
    expect(page.kind).toBe(kind);
    expect(page.params).toEqual(params);
  });

  it('a set page carries its set id, game and name from the route', () => {
    const page = resolveAssistantRoutePage('/catalog/expansion/sv3pt5', { game: 'pokemon', name: '151' });
    expect(page).toEqual({ kind: 'set', label: '151', params: { set_id: 'sv3pt5', game: 'pokemon' } });
  });

  it('catalog search carries the q param', () => {
    expect(resolveAssistantRoutePage('/catalog/search', { q: 'pikachu' })).toEqual({
      kind: 'search', label: 'Search: pikachu', params: { query: 'pikachu', tab: 'cards' },
    });
  });

  it('screen extras enrich the route; the scanner tray rides as card ids with source scanner', () => {
    const scanner = resolveAssistantOpenContext('/scan', {}, { cardIds: ['a', 'b', 'a'], game: 'onepiece' });
    expect(scanner).toMatchObject({ source: 'scanner', cardIds: ['a', 'b'], game: 'onepiece' });
    expect(scanner.page).toEqual({ kind: 'scanner', label: 'Scanner', params: { game: 'onepiece' } });

    const card = resolveAssistantOpenContext('/cards/x', {}, {
      label: 'Charizard ex · 151', params: { card_id: 'y', grader: 'PSA', grade: '10', condition: null },
    });
    expect(card.source).toBe('home');
    expect(card.cardIds).toEqual([]);
    expect(card.page).toEqual({ kind: 'card', label: 'Charizard ex · 151', params: { card_id: 'y', grader: 'PSA', grade: '10' } });
  });

  it('a search with no query names its game', () => {
    expect(resolveAssistantOpenContext('/catalog/game/lorcana').page.label).toBe('Disney Lorcana search');
  });

  it('page keys ignore labels and transient params', () => {
    expect(assistantPageKey(CARD_PAGE)).toBe('card:card_id=sv3pt5-199');
    expect(assistantPageKey({ ...CARD_PAGE, label: 'other', params: { ...CARD_PAGE.params, grade: '9' } }))
      .toBe('card:card_id=sv3pt5-199');
    expect(assistantPageKey({ kind: 'search', label: null, params: { query: 'a' } })).toBe('search');
    expect(assistantPageKey(null)).toBe('none');
  });
});

describe('bubble zones', () => {
  const metrics = { windowHeight: 874, insetTop: 62, insetBottom: 34, tabBarHeight: 96 };

  it('hides on the chat, auth, forms and capture routes', () => {
    for (const path of ['/assistant', '/login', '/account/ai', '/new-post', '/messages/abc', '/labeling/session', '/cards/x/scan-review']) {
      expect(assistantBubbleHiddenOnRoute(path)).toBe(true);
    }
    for (const path of ['/', '/wishlist', '/scan', '/cards/x', '/catalog/search']) {
      expect(assistantBubbleHiddenOnRoute(path)).toBe(false);
    }
  });

  it('tabs sit above the tab bar; pushed pages keep clear of a bottom action bar', () => {
    const tab = assistantBubbleZone('/wishlist', metrics);
    expect(tab?.maxY).toBe(874 - 96 - ASSISTANT_BUBBLE_SIZE - 12);
    const stack = assistantBubbleZone('/cards/x', metrics);
    expect(stack!.maxY).toBeLessThan(tab!.maxY);
    expect(clampToZone(10_000, stack!)).toBe(stack!.maxY);
    expect(clampToZone(-5, stack!)).toBe(stack!.minY);
  });

  it('the scanner allows only the band between the frame and the tray, else nothing', () => {
    expect(assistantBubbleZone('/scan', metrics)).toBeNull();
    expect(assistantBubbleZone('/scan', { ...metrics, scanner: { frameBottom: 582, trayTop: 681, trayExpanded: false } }))
      .toEqual({ minY: 594, maxY: 617 });
    // A tray with cards (no room) or an open tray: hidden.
    expect(assistantBubbleZone('/scan', { ...metrics, scanner: { frameBottom: 582, trayTop: 610, trayExpanded: false } }))
      .toBeNull();
    expect(assistantBubbleZone('/scan', { ...metrics, scanner: { frameBottom: 582, trayTop: 681, trayExpanded: true } }))
      .toBeNull();
    expect(bubbleRoutePath('/dev/scanner')).toBe('/scan');
  });

  it('snaps to the nearer edge, flings included', () => {
    expect(snapSide(10, 0, 400)).toBe('left');
    expect(snapSide(300, 0, 400)).toBe('right');
    expect(snapSide(150, 1500, 400)).toBe('right');
  });
});

describe('page prompts, route and wire', () => {
  it('chips follow the page; thin pages keep the market three', () => {
    expect(assistantPagePrompts(CARD_PAGE)).toEqual(['Is this a good buy?', 'Show its price history', 'Is it worth grading?']);
    expect(assistantPagePrompts({ kind: 'watchlist', label: null, params: {} })[0]).toBe('Any of my watched cards near a low?');
    expect(assistantPagePrompts({ kind: 'events', label: null, params: {} })[0]).toBe('Which events are near me?');
    expect(assistantPagePrompts({ kind: 'search', label: null, params: {} })[0]).toBe('Find cards like these');
    expect(assistantPagePrompts({ kind: 'collection', label: null, params: {} })).toContain('Biggest movers in my collection');
    expect(assistantPagePrompts({ kind: 'social', label: null, params: {} })).toEqual([...ASSISTANT_MARKET_PROMPTS]);
    expect(assistantPagePrompts({ kind: 'scanner', label: null, params: {} })).toEqual([...ASSISTANT_MARKET_PROMPTS]);
  });

  it('the page round-trips through the route as JSON; junk is dropped', () => {
    const href = assistantHref('home', [], null, CARD_PAGE) as unknown as { params: Record<string, string> };
    expect(parseAssistantRouteParams(href.params).page).toEqual(CARD_PAGE);
    expect(parseAssistantRouteParams({ page: '{nope' }).page).toBeNull();
    expect(parseAssistantRouteParams({ page: JSON.stringify({ kind: 'hologram' }) }).page).toBeNull();
  });

  it('the wire body carries context.page, capped', () => {
    const body = buildAssistantSendBody({
      threadId: null,
      clientMessageId: 'cid',
      text: 'hi',
      context: { source: 'home', page: { kind: 'search', label: 'x'.repeat(200), params: { query: ' q ', empty: ' ' } } },
    });
    expect(body.context).toEqual({ source: 'home', page: { kind: 'search', label: 'x'.repeat(80), params: { query: 'q' } } });
  });
});

describe('AssistantScreen with a page', () => {
  beforeEach(() => {
    resetAssistantPagePersistence();
  });

  function renderScreen(repoOverrides: Parameters<typeof createTestSpotlightRepository>[0], page: AssistantPageContext | null = CARD_PAGE) {
    const repository = createTestSpotlightRepository({
      listAssistantThreads: async () => ({ threads: [], nextCursor: null }),
      ...repoOverrides,
    });
    renderWithProviders(
      <AssistantScreen onBack={jest.fn()} onOpenCard={jest.fn()} page={page} source="home" />,
      { spotlightRepository: repository },
    );
    return repository;
  }

  it('shows the Looking-at chip and page chips, and sends the page on every turn until dismissed', async () => {
    const sendAssistantMessage = jest.fn(async (_payload: AssistantSendPayload) => reply());
    renderScreen({ sendAssistantMessage });
    expect(await screen.findByTestId('assistant-page-chip')).toBeTruthy();
    expect(screen.getByLabelText('Looking at Charizard ex · 151')).toBeTruthy();
    expect(screen.getByText('Is this a good buy?')).toBeTruthy();

    fireEvent.press(screen.getByText('Is this a good buy?'));
    await waitFor(() => expect(sendAssistantMessage).toHaveBeenCalledTimes(1));
    expect(sendAssistantMessage.mock.calls[0][0].context).toEqual({ source: 'home', page: CARD_PAGE });

    fireEvent.changeText(screen.getByTestId('assistant-input'), 'and graded?');
    fireEvent.press(screen.getByTestId('assistant-send'));
    await waitFor(() => expect(sendAssistantMessage).toHaveBeenCalledTimes(2));
    expect(sendAssistantMessage.mock.calls[1][0]).toMatchObject({ threadId: 'thr_new', context: { page: CARD_PAGE } });

    fireEvent.press(screen.getByTestId('assistant-page-chip-dismiss'));
    expect(screen.queryByTestId('assistant-page-chip')).not.toBeOnTheScreen();
    fireEvent.changeText(screen.getByTestId('assistant-input'), 'anything else?');
    fireEvent.press(screen.getByTestId('assistant-send'));
    await waitFor(() => expect(sendAssistantMessage).toHaveBeenCalledTimes(3));
    expect(sendAssistantMessage.mock.calls[2][0].context?.page).toBeUndefined();
  });

  it('a chat started here is remembered as this page\'s', async () => {
    const sendAssistantMessage = jest.fn(async (_payload: AssistantSendPayload) => reply('thr_card'));
    renderScreen({ sendAssistantMessage });
    fireEvent.press(await screen.findByText('Is this a good buy?'));
    await waitFor(async () => expect(await readThreadPageKey(TEST_OWNER, 'thr_card')).toBe('card:card_id=sv3pt5-199'));
  });

  it('continues the latest chat only when it was started on the same page', async () => {
    const threads = [{ id: 'thr_latest', title: 'Good buy?', updatedAt: '2026-11-22T10:00:00Z', lastMessagePreview: '' }];
    await rememberThreadPageKey(TEST_OWNER, 'thr_latest', 'card:card_id=sv3pt5-199');

    const same = jest.fn(async (_threadId: string) => []);
    renderScreen({ listAssistantThreads: async () => ({ threads, nextCursor: null }), getAssistantThreadMessages: same });
    await waitFor(() => expect(same).toHaveBeenCalledWith('thr_latest'));
    screen.unmount();

    const other = jest.fn(async (_threadId: string) => []);
    renderScreen(
      { listAssistantThreads: async () => ({ threads, nextCursor: null }), getAssistantThreadMessages: other },
      { kind: 'watchlist', label: 'Your Watchlist', params: {} },
    );
    expect(await screen.findByTestId('assistant-intro')).toBeTruthy();
    await act(async () => undefined);
    expect(other).not.toHaveBeenCalled();
  });
});

describe('AssistantScreen opened from the scan tray', () => {
  const TRAY_PAGE: AssistantPageContext = { kind: 'scanner', label: 'Your scan tray', params: { view: 'scan_tray' } };
  const ROWS = [
    { rowRef: 'cap-1', cardId: 'sv3pt5-199', condition: 'NM' as const, grader: null, grade: null, quantity: 1, variant: 'Holofoil' },
    { rowRef: 'cap-2', cardId: 'xyp-111', condition: null, grader: 'PSA', grade: '10', quantity: 1, variant: null },
  ];
  let unregister: (() => void) | null = null;

  beforeEach(() => {
    resetAssistantPagePersistence();
  });
  afterEach(() => {
    unregister?.();
    unregister = null;
  });

  function swapReply(): AssistantSendResult {
    const result = reply('thr_tray');
    return {
      ...result,
      message: {
        ...result.message,
        text: 'Swapping it to the Obsidian Flames printing is ready to confirm.',
        actions: [{
          id: 'act_swap',
          type: 'swap_tray_card',
          summary: 'Swap Charizard ex (151 199/165) → Charizard ex (Obsidian Flames 223/197)',
          state: 'proposed',
          params: { row: 1, rowRef: 'cap-1', fromCardId: 'sv3pt5-199', toCardId: 'sv3-223', toCard: null },
        }],
      },
    };
  }

  it('shows the tray chips, sends the live tray rows every turn, and applies a confirmed swap to the tray', async () => {
    const tray = {
      rows: jest.fn(() => ROWS),
      addRows: jest.fn(async () => ({ status: 'done' as const })),
      swapCard: jest.fn(() => ({ status: 'done' as const })),
      removeRow: jest.fn(() => ({ status: 'done' as const })),
    };
    unregister = registerScanTrayAssistantBridge(tray);
    const sendAssistantMessage = jest.fn(async (_payload: AssistantSendPayload) => swapReply());
    const setAssistantActionState = jest.fn(async () => ({ ...swapReply().message.actions[0], state: 'confirmed' as const }));
    const repository = createTestSpotlightRepository({
      listAssistantThreads: async () => ({ threads: [], nextCursor: null }),
      sendAssistantMessage,
      setAssistantActionState,
    });
    renderWithProviders(
      <AssistantScreen
        cardIds={['sv3pt5-199', 'xyp-111']}
        onBack={jest.fn()}
        onOpenCard={jest.fn()}
        page={TRAY_PAGE}
        source="scanner"
      />,
      { spotlightRepository: repository },
    );

    for (const chip of ['What are my scanned cards worth?', 'Which should I grade?', 'Add these to my collection']) {
      expect(await screen.findByText(chip)).toBeTruthy();
    }
    fireEvent.press(screen.getByText('Swap a card for a different printing'));
    await waitFor(() => expect(sendAssistantMessage).toHaveBeenCalledTimes(1));
    expect(sendAssistantMessage.mock.calls[0][0].context).toEqual({
      source: 'scanner', cardIds: ['sv3pt5-199', 'xyp-111'], page: TRAY_PAGE, trayRows: ROWS,
    });

    fireEvent.press(await screen.findByTestId('assistant-action-act_swap-confirm'));
    await waitFor(() => expect(tray.swapCard).toHaveBeenCalledWith(expect.objectContaining({
      rowRef: 'cap-1', fromCardId: 'sv3pt5-199', toCardId: 'sv3-223',
    })));
    expect(await screen.findByText('Changed in your scan tray')).toBeTruthy();
    await waitFor(() => expect(setAssistantActionState).toHaveBeenCalledWith('act_swap', 'confirmed'));

    // Follow-ups still carry the (re-read) tray rows.
    fireEvent.changeText(screen.getByTestId('assistant-input'), 'now add them');
    fireEvent.press(screen.getByTestId('assistant-send'));
    await waitFor(() => expect(sendAssistantMessage).toHaveBeenCalledTimes(2));
    expect(sendAssistantMessage.mock.calls[1][0].context?.trayRows).toEqual(ROWS);
    expect(tray.rows).toHaveBeenCalledTimes(2);
  });

  it('an action whose tray is gone says so instead of pretending', async () => {
    const sendAssistantMessage = jest.fn(async (_payload: AssistantSendPayload) => swapReply());
    renderWithProviders(
      <AssistantScreen cardIds={['sv3pt5-199']} onBack={jest.fn()} onOpenCard={jest.fn()} page={TRAY_PAGE} source="scanner" />,
      {
        spotlightRepository: createTestSpotlightRepository({
          listAssistantThreads: async () => ({ threads: [], nextCursor: null }),
          sendAssistantMessage,
        }),
      },
    );
    expect(await screen.findByText('Swap it for a different printing')).toBeTruthy();
    fireEvent.press(screen.getByText('Swap it for a different printing'));
    fireEvent.press(await screen.findByTestId('assistant-action-act_swap-confirm'));
    expect(await screen.findByText("That card isn't in your scan tray anymore.")).toBeTruthy();
  });
});
