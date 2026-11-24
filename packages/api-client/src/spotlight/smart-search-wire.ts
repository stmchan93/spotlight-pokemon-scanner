// Wire helpers for natural-language search (POST /api/v1/assistant/search).
// Tolerant like assistant-wire: anything malformed reads as intent "plain", so
// the app falls back to its normal search.
import type {
  SmartSearchChip,
  SmartSearchIntent,
  SmartSearchInterpretation,
  SmartSearchOwned,
  SmartSearchRequest,
  SmartSearchSort,
} from './types';

const INTENTS: readonly SmartSearchIntent[] = ['search', 'question', 'plain'];
const OWNED: readonly SmartSearchOwned[] = ['any', 'owned', 'not_owned'];
const SORTS: readonly SmartSearchSort[] = ['relevance', 'price_asc', 'price_desc', 'newest'];

export type SmartSearchWire = {
  intent: SmartSearchIntent;
  interpretation: SmartSearchInterpretation | null;
  chips: SmartSearchChip[];
  /** Raw card rows, the same shape /api/v1/cards/search returns. */
  rawResults: unknown[];
  nextCursor: string | null;
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export function parseSmartSearchInterpretation(value: unknown): SmartSearchInterpretation | null {
  const raw = record(value);
  const filter = raw ? record(raw.filter) : null;
  if (!raw || !filter) {
    return null;
  }
  return {
    filter,
    owned: OWNED.includes(raw.owned as SmartSearchOwned) ? (raw.owned as SmartSearchOwned) : 'any',
    sort: SORTS.includes(raw.sort as SmartSearchSort) ? (raw.sort as SmartSearchSort) : 'relevance',
  };
}

export function parseSmartSearchResponse(body: unknown): SmartSearchWire {
  const raw = record(body);
  const intent = raw && INTENTS.includes(raw.intent as SmartSearchIntent) ? (raw.intent as SmartSearchIntent) : 'plain';
  const interpretation = raw ? parseSmartSearchInterpretation(raw.interpretation) : null;
  // A "search" without the interpretation it ran can't page or drop chips: treat it as plain.
  if (intent === 'search' && !interpretation) {
    return { chips: [], intent: 'plain', interpretation: null, nextCursor: null, rawResults: [] };
  }
  const chips = (Array.isArray(raw?.chips) ? raw.chips : []).flatMap((item): SmartSearchChip[] => {
    const chip = record(item);
    const id = typeof chip?.id === 'string' ? chip.id : null;
    const label = typeof chip?.label === 'string' ? chip.label : null;
    const field = typeof chip?.field === 'string' ? chip.field : null;
    return id && label && field ? [{ field, id, label }] : [];
  });
  return {
    chips,
    intent,
    interpretation,
    nextCursor: typeof raw?.nextCursor === 'string' && raw.nextCursor ? raw.nextCursor : null,
    rawResults: Array.isArray(raw?.results) ? raw.results : [],
  };
}

export function buildSmartSearchBody(request: SmartSearchRequest): Record<string, unknown> {
  return {
    game: request.game,
    ...(request.limit != null ? { limit: request.limit } : {}),
    ...(request.cursor ? { cursor: request.cursor } : {}),
    ...(request.interpretation ? { interpretation: request.interpretation } : { query: request.query }),
  };
}

/** The interpretation with one chip's field dropped; the server re-runs it without the model. */
export function removeSmartSearchChip(
  interpretation: SmartSearchInterpretation,
  chip: SmartSearchChip,
): SmartSearchInterpretation {
  if (chip.field === 'owned') {
    return { ...interpretation, owned: 'any' };
  }
  if (chip.field === 'sort') {
    return { ...interpretation, sort: 'relevance' };
  }
  const filter = { ...interpretation.filter };
  delete filter[chip.field];
  return { ...interpretation, filter };
}
