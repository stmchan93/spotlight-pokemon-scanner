// Wire parser for GET /api/v1/watchlist/suggestions (backend/watchlist_suggestions.py).
// Tolerant like similar-cards-wire: a row without a cardId is dropped, a
// missing field becomes null, so an older/newer server never breaks the screen.
import { CARD_GAMES, type CardGame, type WatchlistSuggestion } from './types';

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

function asGame(value: unknown): CardGame | undefined {
  return typeof value === 'string' && (CARD_GAMES as readonly string[]).includes(value)
    ? (value as CardGame)
    : undefined;
}

export function parseWatchlistSuggestion(value: unknown): WatchlistSuggestion | null {
  const raw = asRecord(value);
  const cardId = raw ? asString(raw.cardId) : null;
  if (!raw || !cardId) {
    return null;
  }
  return {
    cardId,
    name: asString(raw.name) ?? '',
    cardNumber: asString(raw.number) ?? '',
    setName: asString(raw.setName) ?? '',
    imageUrl: asString(raw.imageUrl),
    game: asGame(raw.game),
    language: asString(raw.language),
    marketPrice: asNumber(raw.priceNow),
    currencyCode: asString(raw.currencyCode) ?? 'USD',
    lastScannedAt: asString(raw.lastScannedAt),
  };
}

export function parseWatchlistSuggestionsPayload(value: unknown): WatchlistSuggestion[] {
  const items = asRecord(value)?.items;
  return Array.isArray(items)
    ? items
      .map(parseWatchlistSuggestion)
      .filter((item): item is WatchlistSuggestion => item != null)
    : [];
}
