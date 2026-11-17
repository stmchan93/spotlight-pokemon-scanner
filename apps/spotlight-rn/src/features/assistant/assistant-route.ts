import type { Href } from 'expo-router';

import type { AssistantContextSource } from '@spotlight/api-client';

/** Contract cap on scanner context. */
export const ASSISTANT_MAX_CONTEXT_CARDS = 20;

/**
 * `/assistant?source=…&cardIds=a,b`. Cast like `/login` in use-guest-gate: the
 * typed-routes codegen only learns new routes at bundle time.
 */
export function assistantHref(source: AssistantContextSource, cardIds: string[] = []): Href {
  const unique = Array.from(new Set(cardIds.filter(Boolean))).slice(0, ASSISTANT_MAX_CONTEXT_CARDS);
  const params: Record<string, string> = { source };
  if (unique.length > 0) {
    params.cardIds = unique.join(',');
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
}): { source: AssistantContextSource; cardIds: string[]; threadId: string | null } {
  const source = first(params.source) === 'scanner' ? 'scanner' : 'home';
  const cardIds = first(params.cardIds)
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
    .slice(0, ASSISTANT_MAX_CONTEXT_CARDS);
  return { source, cardIds, threadId: first(params.threadId) || null };
}
