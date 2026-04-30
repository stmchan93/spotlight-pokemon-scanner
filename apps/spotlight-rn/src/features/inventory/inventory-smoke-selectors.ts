import type { InventoryCardEntry } from '@spotlight/api-client';

function normalizeSmokePart(value: string | null | undefined, fallback: string) {
  const normalized = (value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return normalized || fallback;
}

export function makeInventorySmokeKey(entry: InventoryCardEntry) {
  if (entry.kind === 'graded') {
    return [
      'graded',
      normalizeSmokePart(entry.cardId, 'unknown-card'),
      normalizeSmokePart(entry.slabContext?.grader, 'unknown-grader'),
      normalizeSmokePart(entry.slabContext?.grade, 'unknown-grade'),
      normalizeSmokePart(entry.slabContext?.certNumber, 'no-cert'),
    ].join('-');
  }

  return ['raw', normalizeSmokePart(entry.cardId, 'unknown-card')].join('-');
}

export function makeInventorySmokeTestID(entry: InventoryCardEntry) {
  return `inventory-entry-smoke-${makeInventorySmokeKey(entry)}`;
}

export function makeBulkSellSmokeTestID(prefix: string, entry: InventoryCardEntry) {
  return `${prefix}-smoke-${makeInventorySmokeKey(entry)}`;
}
