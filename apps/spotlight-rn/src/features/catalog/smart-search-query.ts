/**
 * Which search path a typed query takes. `plain` (card names, "charizard 199")
 * stays on the normal catalog search with no AI call; `natural` asks the smart
 * search endpoint; `question` shows the Ask Ekalight row above normal results.
 */
export type SearchQueryKind = 'plain' | 'natural' | 'question';

const QUESTION_STARTS = new Set([
  'should', 'is', 'are', 'what', "what's", 'whats', 'how', 'which', 'why', 'when', 'can', 'do', 'does', 'will',
  'worth',
]);

// A price or ordering word means a filter even in two words ("priciest charizard").
const STRONG_CUES = [
  /\$\s?\d/,
  /\b(?:under|over|below|above)\s+\$?\d/,
  /\b(?:cheap|cheapest|cheaper|priciest|expensive)\b/,
];

const CUES = [
  ...STRONG_CUES,
  /\b(?:under|over|below|above)\b/,
  /\bmy\b/,
  /\bi\s+(?:don'?t\s+)?own\b/,
  /\bnot\s+own(?:ed)?\b/,
  /\bfrom\s+(?:19|20)\d\d\b/,
  /\b(?:japanese|english)\b/,
  /\balt(?:ernate)?[\s-]?arts?\b/,
  /\bfull[\s-]?arts?\b/,
  /\billustration\b/,
  /\bsealed\b/,
  /\bby\s+[a-z]/,
  /\bin\s+the\b/,
  /\bwith\b/,
  /\b(?:newest|latest)\b/,
];

export function classifySearchQuery(text: string): SearchQueryKind {
  const normalized = text.trim().toLowerCase().replace(/\s+/g, ' ');
  if (normalized.length < 2) {
    return 'plain';
  }
  const words = normalized.split(' ');
  if (normalized.endsWith('?') || (words.length >= 2 && QUESTION_STARTS.has(words[0]))) {
    return 'question';
  }
  if (words.length >= 2 && STRONG_CUES.some((cue) => cue.test(normalized))) {
    return 'natural';
  }
  if (words.length >= 3 && CUES.some((cue) => cue.test(normalized))) {
    return 'natural';
  }
  return 'plain';
}

/** Placeholder examples; each is one the smart search can answer. */
export const SMART_SEARCH_EXAMPLES = [
  'Eevee alt arts under $50',
  'Japanese Pikachu promos',
  'Pikachu in the rain',
  'priciest Charizard',
  "Umbreon cards I don't own",
] as const;

export function pickSmartSearchExample(random: () => number = Math.random): string {
  const index = Math.min(SMART_SEARCH_EXAMPLES.length - 1, Math.floor(random() * SMART_SEARCH_EXAMPLES.length));
  return SMART_SEARCH_EXAMPLES[index];
}

export function smartSearchPlaceholder(example: string): string {
  return `Search cards, or try "${example}"`;
}
