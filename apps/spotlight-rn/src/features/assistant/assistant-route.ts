import type { Href } from 'expo-router';

import {
  CARD_GAMES,
  type AssistantContextSource,
  type AssistantPageContext,
  type AssistantPageKind,
  type CardGame,
} from '@spotlight/api-client';

/** Contract cap on scanner context. */
export const ASSISTANT_MAX_CONTEXT_CARDS = 20;

/**
 * `/assistant?source=…&cardIds=a,b&game=…`. `game` is the opening screen's game
 * (Home's market picker, the scanner lane); the server scopes market-wide
 * rankings to it. Cast like `/login` in use-guest-gate: the typed-routes codegen
 * only learns new routes at bundle time.
 */
export function assistantHref(
  source: AssistantContextSource,
  cardIds: string[] = [],
  game?: CardGame | null,
  page?: AssistantPageContext | null,
): Href {
  const unique = Array.from(new Set(cardIds.filter(Boolean))).slice(0, ASSISTANT_MAX_CONTEXT_CARDS);
  const params: Record<string, string> = { source };
  if (unique.length > 0) {
    params.cardIds = unique.join(',');
  }
  if (game) {
    params.game = game;
  }
  if (page) {
    // The floating bubble's page context, as one JSON param (small: kind, a
    // short label, a few ids). Parsed defensively on the way in.
    params.page = JSON.stringify(page);
  }
  return { pathname: '/assistant', params } as unknown as Href;
}

function first(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? '';
}

export function parseAssistantRouteParams(params: {
  source?: string | string[];
  cardIds?: string | string[];
  threadId?: string | string[];
  game?: string | string[];
  page?: string | string[];
}): {
  source: AssistantContextSource;
  cardIds: string[];
  threadId: string | null;
  game: CardGame | null;
  page: AssistantPageContext | null;
} {
  const source = first(params.source) === 'scanner' ? 'scanner' : 'home';
  const cardIds = first(params.cardIds)
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
    .slice(0, ASSISTANT_MAX_CONTEXT_CARDS);
  const rawGame = first(params.game);
  const game = CARD_GAMES.find((candidate) => candidate === rawGame) ?? null;
  return { source, cardIds, threadId: first(params.threadId) || null, game, page: parsePageParam(first(params.page)) };
}

const PAGE_KINDS: readonly AssistantPageKind[] = [
  'home', 'collection', 'watchlist', 'search', 'card', 'set', 'scanner',
  'events', 'event', 'social', 'post', 'profile', 'news', 'insights', 'other',
];

function parsePageParam(raw: string): AssistantPageContext | null {
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<AssistantPageContext> | null;
    const kind = PAGE_KINDS.find((candidate) => candidate === parsed?.kind);
    if (!parsed || !kind) {
      return null;
    }
    const params: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed.params ?? {})) {
      if (typeof value === 'string' && value) {
        params[key] = value;
      }
    }
    return { kind, label: typeof parsed.label === 'string' && parsed.label ? parsed.label : null, params };
  } catch {
    return null;
  }
}
