// Deterministic Ask Ekalight fixtures for MockSpotlightRepository and the dev
// screens. Card ids are ones mock-data's card details know (xyp-111,
// mcdonalds25-21, sm7-1), so tapping a tile opens a real mock PDP.
import type {
  AssistantCardRef,
  AssistantContext,
  AssistantMessage,
  AssistantPriceChart,
  AssistantProposedAction,
  AssistantSetRef,
  AssistantThreadSummary,
  AssistantUsage,
} from './types';

const cdn = 'https://images.pokemontcg.io';

export const MOCK_ASSISTANT_DAILY_LIMIT = 3;

export const mockAssistantCards: Record<'celebi' | 'oshawott' | 'treecko', AssistantCardRef> = {
  celebi: {
    cardId: 'xyp-111',
    name: 'Celebi',
    setName: 'XY Black Star Promos',
    number: 'XY111',
    language: 'en',
    imageSmallUrl: `${cdn}/xyp/XY111.png`,
    priceUsd: 37.54,
    variant: null,
    grader: null,
    grade: null,
    quantityOwned: 1,
    appUrl: 'spotlight://cards/xyp-111',
  },
  oshawott: {
    cardId: 'mcdonalds25-21',
    name: 'Oshawott',
    setName: "McDonald's Collection 2021",
    number: '21/25',
    language: 'en',
    imageSmallUrl: `${cdn}/mcdonalds25/21.png`,
    priceUsd: 0.56,
    variant: null,
    grader: null,
    grade: null,
    quantityOwned: 2,
    appUrl: 'spotlight://cards/mcdonalds25-21',
  },
  treecko: {
    cardId: 'sm7-1',
    name: 'Treecko',
    setName: 'Celestial Storm',
    number: '1/168',
    language: 'ja',
    imageSmallUrl: `${cdn}/sm7/1.png`,
    priceUsd: 0.31,
    variant: null,
    grader: null,
    grade: null,
    quantityOwned: null,
    appUrl: 'spotlight://cards/sm7-1',
  },
};

export function mockAssistantUsage(usedToday: number, limit: number | null = MOCK_ASSISTANT_DAILY_LIMIT): AssistantUsage {
  return {
    limit,
    usedToday,
    remainingToday: limit == null ? null : Math.max(0, limit - usedToday),
    resetsAt: '2026-11-18T00:00:00Z',
    isGuest: false,
  };
}

/** Celebi NM over ~3 months: $31 to $37.54 (deterministic, every 3rd day). */
export function mockAssistantPriceChart(endDate = '2026-11-17'): AssistantPriceChart {
  const end = new Date(`${endDate}T12:00:00Z`).getTime();
  const points = Array.from({ length: 30 }, (_, index) => {
    const daysAgo = (29 - index) * 3;
    const date = new Date(end - daysAgo * 86_400_000).toISOString().slice(0, 10);
    const usd = index === 29 ? 37.54 : Math.round((31 + index * 0.2 + Math.sin(index / 2) * 0.8) * 100) / 100;
    return { date, usd };
  });
  return {
    cardId: mockAssistantCards.celebi.cardId,
    name: 'Celebi',
    variant: null,
    condition: 'NM',
    grader: null,
    grade: null,
    range: '90d',
    points,
    source: 'tcgplayer',
  };
}

type MockReply = Pick<AssistantMessage, 'text' | 'cards' | 'actions' | 'suggestions' | 'charts' | 'sets'>;

/** Canned answer keyed off the question's wording, so each action type is reachable from the composer. */
export function buildMockAssistantReply(
  text: string,
  context: AssistantContext | null | undefined,
  nextActionId: () => string,
): MockReply {
  const question = text.toLowerCase();
  const { celebi, oshawott, treecko } = mockAssistantCards;

  if (/\b(watch|alert)\b/.test(question)) {
    const action: AssistantProposedAction = {
      id: nextActionId(),
      type: 'watch_card',
      summary: 'Watch Celebi (XY Black Star Promos XY111) · alert under $30.00',
      params: { cardId: celebi.cardId, variant: null, targetPriceUsd: 30 },
      state: 'proposed',
    };
    return {
      text: "**Celebi** is $37.54 right now. Confirm and I'll add it to your Watchlist with an alert under **$30.00**.",
      cards: [celebi],
      actions: [action],
      suggestions: ['What else is on my Watchlist?', 'Show its price history'],
    };
  }

  if (/\b(history|trend|chart)\b/.test(question)) {
    return {
      text: '**Celebi** climbed about **21%** over the past 3 months, to $37.54.',
      cards: [celebi],
      actions: [],
      charts: [mockAssistantPriceChart()],
      suggestions: ["What's it worth in PSA 10?", 'Watch Celebi with an alert under $30'],
    };
  }

  if (/\b(quantity|change|update|have \d+)\b/.test(question)) {
    const action: AssistantProposedAction = {
      id: nextActionId(),
      type: 'update_holding',
      summary: 'Oshawott (McDonald\'s Collection 2021 21/25) · ×2 → ×3',
      params: { holdingId: 'entry-2', quantity: 3, condition: null },
      state: 'proposed',
    };
    return {
      text: 'You have **2× Oshawott** right now. Confirm to change it to 3.',
      cards: [oshawott],
      actions: [action],
      suggestions: ["What's my collection worth now?"],
    };
  }

  if (/\badd\b/.test(question)) {
    const action: AssistantProposedAction = {
      id: nextActionId(),
      type: 'add_to_collection',
      summary: 'Add Treecko (Celestial Storm 1/168) · NM · ×1',
      params: {
        cardId: treecko.cardId,
        quantity: 1,
        condition: 'NM',
        variantName: null,
        grader: null,
        grade: null,
        collectionId: null,
      },
      state: 'proposed',
    };
    return {
      text: "I found **Treecko** (Celestial Storm 1/168). Tap Confirm and I'll add one in Near Mint.",
      cards: [treecko],
      actions: [action],
      suggestions: ['What else am I missing from Celestial Storm?', 'Is Treecko worth grading?'],
    };
  }

  if (/\bsets?\b/.test(question)) {
    return {
      text: '**Plasma Storm** is up **66.9%** over the past 30 days, while **Ascended Heroes** fell **24%**.',
      cards: [],
      actions: [],
      sets: mockAssistantSets(),
      suggestions: ['What are the top cards in Plasma Storm?'],
    };
  }

  if (context?.source === 'scanner' && (context.cardIds?.length ?? 0) > 0) {
    return {
      text: 'Of the cards in your tray, **Celebi** is worth the most at $37.54.\n- Celebi: $37.54\n- Oshawott: $0.56',
      cards: [celebi, oshawott],
      actions: [],
      suggestions: ['Is Celebi worth grading?', 'Watch Celebi with an alert under $30', "What's it worth in PSA 10?"],
    };
  }

  return {
    text: "Your collection is worth about **$85.92** today.\n- Most valuable: **Celebi** at $37.54\n- You own 2× Oshawott at $0.56 each\n\nPrices are Ekalight's daily market data, not live.",
    cards: [celebi, oshawott],
    actions: [],
    suggestions: ['Which of my cards went up this week?', 'Is Celebi worth grading?', 'What am I missing from Celestial Storm?'],
  };
}

/** Set tiles for a set-trend answer (one rising, one falling). */
export function mockAssistantSets(): AssistantSetRef[] {
  return [
    {
      setId: 'bw8',
      name: 'Plasma Storm',
      game: 'pokemon',
      logoUrl: 'https://images.scrydex.com/pokemon/bw8-logo/logo',
      symbolUrl: null,
      changePct: 66.9,
      window: '30d',
      releaseYear: '2013',
    },
    {
      setId: 'me3',
      name: 'Ascended Heroes',
      game: 'pokemon',
      logoUrl: null,
      symbolUrl: null,
      changePct: -24,
      window: '30d',
      releaseYear: '2026',
    },
  ];
}

export const MOCK_ASSISTANT_SEED_THREAD_ID = 'thr_mock_seed';

/** One saved chat so the history list and a resumed thread have something to show. */
export function seedMockAssistantThread(): { summary: AssistantThreadSummary; messages: AssistantMessage[] } {
  const threadId = MOCK_ASSISTANT_SEED_THREAD_ID;
  const createdAt = '2026-11-16T21:04:00Z';
  return {
    summary: {
      id: threadId,
      title: 'What am I missing from Celestial Storm?',
      updatedAt: '2026-11-16T21:04:09Z',
      lastMessagePreview: "You're missing 142 of 168 cards from Celestial Storm. The priciest gap is Rayquaza GX.",
    },
    messages: [
      {
        id: 'msg_mock_seed_1',
        threadId,
        role: 'user',
        text: 'What am I missing from Celestial Storm?',
        cards: [],
        actions: [],
        createdAt,
        status: 'ok',
      },
      {
        id: 'msg_mock_seed_2',
        threadId,
        role: 'assistant',
        text: "You're missing **142 of 168** cards from Celestial Storm. The priciest gap is Rayquaza GX.",
        cards: [mockAssistantCards.treecko],
        actions: [],
        createdAt: '2026-11-16T21:04:09Z',
        status: 'ok',
      },
    ],
  };
}
