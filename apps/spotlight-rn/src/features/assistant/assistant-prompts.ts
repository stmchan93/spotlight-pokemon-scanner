import type { AssistantContextSource } from '@spotlight/api-client';

export const ASSISTANT_STARTER_PROMPT_LIMIT = 6;

export type AssistantIntroCopy = { title: string; body: string };

/** Starter prompts for a new chat, tailored to where it was opened from and what's in the tray. */
export function assistantStarterPrompts(source: AssistantContextSource, trayCardCount: number): string[] {
  let prompts: string[];
  if (trayCardCount === 1) {
    prompts = [
      "What's this card worth?",
      'Is this worth grading?',
      "What's this card worth in PSA 10?",
      'Has this card gone up lately?',
      'Watch this card and alert me if it drops',
      "What's my collection worth?",
    ];
  } else if (trayCardCount > 1) {
    prompts = [
      'Which of these is worth the most?',
      'Are any of these worth grading?',
      'What are these worth in PSA 10?',
      'Which of these should I keep or sell?',
      'Add these to my collection',
      "What's my collection worth?",
    ];
  } else if (source === 'scanner') {
    prompts = [
      "What's trending in the market right now?",
      'Help me prep for a card show',
      'What cards are near their price lows?',
      "What's my collection worth?",
    ];
  } else {
    prompts = [
      "What's my collection worth?",
      'Which of my cards went up this week?',
      "What's trending in the market right now?",
      'Which of my cards should I sell?',
      'Is anything I own worth grading?',
      'Help me prep for a card show',
    ];
  }
  return prompts.slice(0, ASSISTANT_STARTER_PROMPT_LIMIT);
}

export function assistantIntroCopy(trayCardCount: number): AssistantIntroCopy {
  if (trayCardCount > 0) {
    const cards = trayCardCount === 1 ? 'this card' : `these ${trayCardCount} cards`;
    return {
      title: `Ask about ${cards}`,
      body: 'Prices in raw and graded, whether grading pays off, recent trends, and what to keep or sell.',
    };
  }
  return {
    title: 'Your card market, answered',
    body: 'Prices, your collection, market trends, what to buy or sell, whether grading is worth it, and show prep. All in USD from Ekalight market data.',
  };
}
