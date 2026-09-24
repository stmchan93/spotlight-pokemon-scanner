import { CARD_GAMES, type CardGame, type MetaLaneFilter, type NewsKind } from '@spotlight/api-client';

export function firstParam(value?: string | string[]): string {
  if (Array.isArray(value)) {
    return value.find((candidate) => candidate.trim().length > 0) ?? '';
  }
  return value ?? '';
}

// Deep links are untrusted input: anything unrecognised falls back to the default.
export function parseGameParam(value?: string | string[]): CardGame | undefined {
  const raw = firstParam(value);
  return (CARD_GAMES as readonly string[]).includes(raw) ? (raw as CardGame) : undefined;
}

export function parseLaneParam(value?: string | string[]): MetaLaneFilter | undefined {
  const raw = firstParam(value);
  return raw === 'all' || raw === 'raw' || raw === 'graded' ? raw : undefined;
}

export function parseWindowParam(value?: string | string[]): number | undefined {
  const raw = Number(firstParam(value));
  return raw === 7 || raw === 30 || raw === 90 ? raw : undefined;
}

export function parseNewsKindParam(value?: string | string[]): NewsKind | undefined {
  const raw = firstParam(value);
  return raw === 'news' || raw === 'market' || raw === 'video' || raw === 'community' ? raw : undefined;
}
