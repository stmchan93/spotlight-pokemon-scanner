import type { AssistantUsage } from '@spotlight/api-client';

// Owner-picked (2026-11-20): every entry point without specific cards gets exactly these.
export const ASSISTANT_MARKET_PROMPTS = [
  // One market question, two everyday-collector ones (owner, 2026-11-20).
  'What are some undervalued cards?',
  "What's my collection worth?",
  'Which of my cards should I get graded?',
] as const;

/**
 * Starter prompts for a new chat: card-specific when opened with cards, else the
 * three market prompts. From the scanner the cards are named as SCANNED cards —
 * a bare "these" read as "what's 'these'?" (owner, 2026-11-20).
 */
export function assistantStarterPrompts(trayCardCount: number, source: 'home' | 'scanner' = 'home'): string[] {
  const scanned = source === 'scanner';
  if (trayCardCount === 1) {
    const card = scanned ? 'this scanned card' : 'this card';
    return [
      `What's ${card} worth?`,
      `Is ${card} worth grading?`,
      `What's ${card} worth in PSA 10?`,
      `Has ${card} gone up lately?`,
      `Watch ${card} and alert me if it drops`,
      "What's my collection worth?",
    ];
  }
  if (trayCardCount > 1) {
    const cards = scanned ? 'my scanned cards' : 'these cards';
    return [
      `Which of ${cards} is worth the most?`,
      `Are any of ${cards} worth grading?`,
      `What are ${cards} worth in PSA 10?`,
      `Which of ${cards} should I keep or sell?`,
      `Add ${cards} to my collection`,
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
