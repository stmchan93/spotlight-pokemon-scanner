import type { AssistantPageContext, AssistantUsage } from '@spotlight/api-client';

// Owner-picked (2026-11-20): every entry point without specific cards gets exactly these.
export const ASSISTANT_MARKET_PROMPTS = [
  // Figma 6607:10700 / 6607:10716 / 6607:10710 (owner, 2026-11-21).
  "What's my collection worth?",
  'Which of my cards went up this week?',
  "What's trending in the market right now?",
] as const;

/**
 * Starter prompts for a new chat: card-specific when opened with cards, else the
 * three market prompts. The scanner always gets the three market prompts.
 */
export function assistantStarterPrompts(trayCardCount: number, source: 'home' | 'scanner' = 'home'): string[] {
  // The scanner opens with the same chips as everywhere else (owner, 2026-11-20); the tray still rides along as context.
  if (source === 'scanner') {
    return [...ASSISTANT_MARKET_PROMPTS];
  }
  if (trayCardCount === 1) {
    const card = 'this card';
    // Plan doc §5 decision 10: the marketed checks lead when cards are attached.
    return [
      `Should I grade ${card}?`,
      `Is ${card} a good deal?`,
      `Trade check ${card}`,
      `What's ${card} worth?`,
      `Has ${card} gone up lately?`,
      `Watch ${card} and alert me if it drops`,
    ];
  }
  if (trayCardCount > 1) {
    const cards = 'these cards';
    return [
      `Which of ${cards} should I grade?`,
      `Are ${cards} a good deal?`,
      `Trade check ${cards}`,
      `Which of ${cards} is worth the most?`,
      `What are ${cards} worth in PSA 10?`,
      `Add ${cards} to my collection`,
    ];
  }
  return [...ASSISTANT_MARKET_PROMPTS];
}

/**
 * Starter chips for a chat opened from the scan tray header's Ekalight chip:
 * about the scanned cards, including the tray actions the chat can propose
 * (add them, swap a row's printing). The owner calls them "scanned cards".
 */
export function assistantScanTrayPrompts(trayCardCount: number): string[] {
  if (trayCardCount === 1) {
    return [
      "What's my scanned card worth?",
      'Should I grade it?',
      'Add it to my collection',
      'Swap it for a different printing',
    ];
  }
  return [
    'What are my scanned cards worth?',
    'Which should I grade?',
    'Add these to my collection',
    'Swap a card for a different printing',
  ];
}

/**
 * Starter chips for a chat opened from the Chat pill: about the page the
 * user is on. Pages with thin context (Home, Social, an unknown page) keep the
 * owner's three market prompts, and so does the scanner (owner, 2026-11-20: the
 * scanner opens with the same chips as everywhere else; the tray rides along).
 */
export function assistantPagePrompts(page: AssistantPageContext | null | undefined): string[] {
  switch (page?.kind) {
    case 'card':
      return ['Is this a good buy?', 'Show its price history', 'Is it worth grading?'];
    case 'set':
      return ["What are this set's chase cards?", 'Which cards in this set are rising?', 'Is this set worth collecting?'];
    case 'search':
      return page.params.query
        ? ['Find cards like these', 'Which of these is the best value?', "What's trending in the market right now?"]
        : ['Find cards like these', "What's trending in the market right now?", 'Undervalued cards'];
    case 'collection':
    case 'insights':
      return ["What's my collection worth?", 'Biggest movers in my collection', 'Which of my cards should I grade?'];
    case 'watchlist':
      return ['Any of my watched cards near a low?', 'Which watched card moved the most?', 'Should I buy any of these now?'];
    case 'events':
    case 'event':
      return ['Which events are near me?', 'What should I bring to a card show?', 'How do I negotiate at a show?'];
    case 'profile':
      return ["What's trending in the market right now?", 'How do I start a trade?', "What's my collection worth?"];
    default:
      return [...ASSISTANT_MARKET_PROMPTS];
  }
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
