import type { Href } from 'expo-router';

import { CARD_GAMES, type AssistantContextSource, type CardGame } from '@spotlight/api-client';

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
): Href {
  const unique = Array.from(new Set(cardIds.filter(Boolean))).slice(0, ASSISTANT_MAX_CONTEXT_CARDS);
  const params: Record<string, string> = { source };
  if (unique.length > 0) {
    params.cardIds = unique.join(',');
  }
  if (game) {
    params.game = game;
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
}): { source: AssistantContextSource; cardIds: string[]; threadId: string | null; game: CardGame | null } {
  const source = first(params.source) === 'scanner' ? 'scanner' : 'home';
  const cardIds = first(params.cardIds)
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
    .slice(0, ASSISTANT_MAX_CONTEXT_CARDS);
  const rawGame = first(params.game);
  const game = CARD_GAMES.find((candidate) => candidate === rawGame) ?? null;
  return { source, cardIds, threadId: first(params.threadId) || null, game };
}
