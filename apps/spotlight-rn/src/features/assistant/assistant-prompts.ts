import type { AssistantUsage } from '@spotlight/api-client';

// Owner-picked (2026-11-20): every entry point without specific cards gets exactly these.
export const ASSISTANT_MARKET_PROMPTS = [
  'Undervalued cards',
  'Cards with most recently new high sales',
  'What cards are likely to go up',
] as const;

/** Starter prompts for a new chat: card-specific when opened with cards, else the three market prompts. */
export function assistantStarterPrompts(trayCardCount: number): string[] {
  if (trayCardCount === 1) {
    return [
      "What's this card worth?",
      'Is this worth grading?',
      "What's this card worth in PSA 10?",
      'Has this card gone up lately?',
      'Watch this card and alert me if it drops',
      "What's my collection worth?",
    ];
  }
  if (trayCardCount > 1) {
    return [
      'Which of these is worth the most?',
      'Are any of these worth grading?',
      'What are these worth in PSA 10?',
      'Which of these should I keep or sell?',
      'Add these to my collection',
      "What's my collection worth?",
    ];
  }
  return [...ASSISTANT_MARKET_PROMPTS];
}

/** "Hi, Stephen" from the profile's display name; guests and nameless users get "Hi there". */
export function assistantGreeting(displayName: string | null | undefined, isGuest: boolean): string {
  const first = isGuest ? '' : (displayName ?? '').trim().split(/\s+/)[0] ?? '';
  return first ? `Hi, ${first}` : 'Hi there';
}

/** A line under the greeting when the chat carries cards, so the user knows they're attached. */
export function assistantCardContextLine(trayCardCount: number): string | null {
  if (trayCardCount <= 0) {
    return null;
  }
  return trayCardCount === 1 ? 'Ask about this card' : `Ask about these ${trayCardCount} cards`;
}

/** Only shown when running low: 1 or 2 left on a limited plan. 0 shows the limit block instead. */
export const ASSISTANT_LOW_REMAINING_THRESHOLD = 2;

export function assistantRemainingCaption(usage: AssistantUsage | null): string | null {
  const remaining = usage?.remainingToday;
  if (!usage || usage.limit == null || remaining == null || remaining <= 0 || remaining > ASSISTANT_LOW_REMAINING_THRESHOLD) {
    return null;
  }
  return `${remaining} ${remaining === 1 ? 'question' : 'questions'} left today`;
}
