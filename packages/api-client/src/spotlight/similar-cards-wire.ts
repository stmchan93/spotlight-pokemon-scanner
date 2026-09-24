// Wire parser for GET /api/v1/cards/{cardId}/similar (backend/similar_cards.py).
// Tolerant: a malformed row is dropped, a missing field becomes null, so an
// older/newer server never breaks the card page.
import type { SimilarCard, SimilarCards } from './types';

type Raw = Record<string, unknown>;

function asRecord(value: unknown): Raw | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Raw) : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function parseSimilarCard(value: unknown): SimilarCard | null {
  const raw = asRecord(value);
  const cardId = raw ? asString(raw.cardId) : null;
  if (!raw || !cardId) {
    return null;
  }
  return {
    cardId,
    name: asString(raw.name) ?? '',
    setName: asString(raw.setName),
    number: asString(raw.number),
    language: asString(raw.language),
    imageUrl: asString(raw.imageUrl),
    priceNow: asNumber(raw.priceNow),
    currencyCode: asString(raw.currencyCode) ?? 'USD',
  };
}

function parseRow(value: unknown): SimilarCard[] {
  return Array.isArray(value)
    ? value.map(parseSimilarCard).filter((card): card is SimilarCard => card != null)
    : [];
}

export function parseSimilarCardsPayload(value: unknown, cardId: string): SimilarCards {
  const raw = asRecord(value) ?? {};
  return {
    cardId: asString(raw.cardId) ?? cardId,
    baseName: asString(raw.baseName),
    goesWith: parseSimilarCard(raw.goesWith),
    sameName: parseRow(raw.sameName),
    sameLookCheaper: parseRow(raw.sameLookCheaper),
  };
}
