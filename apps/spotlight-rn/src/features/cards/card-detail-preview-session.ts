import type { CatalogSearchResult, InventoryCardEntry } from '@spotlight/api-client';

export type CardDetailPreview = {
  cardId: string;
  cardNumber: string;
  currencyCode?: string | null;
  entryId?: string | null;
  id: string;
  imageUrl: string;
  largeImageUrl?: string | null;
  marketPrice?: number | null;
  name: string;
  ownedEntry?: InventoryCardEntry | null;
  setName: string;
};

const maxStoredPreviews = 50;
let nextPreviewSequence = 0;
const previews = new Map<string, CardDetailPreview>();

type SaveCardDetailPreviewInput = Omit<CardDetailPreview, 'id'> & {
  id?: string;
};

function saveCardDetailPreview(input: SaveCardDetailPreviewInput) {
  nextPreviewSequence += 1;
  const id = input.id ?? [
    'card-preview',
    input.cardId,
    input.entryId ?? 'catalog',
    Date.now(),
    nextPreviewSequence,
  ].join(':');

  const preview: CardDetailPreview = {
    ...input,
    id,
  };

  previews.delete(id);
  previews.set(id, preview);

  while (previews.size > maxStoredPreviews) {
    const oldestKey = previews.keys().next().value;
    if (!oldestKey) {
      break;
    }
    previews.delete(oldestKey);
  }

  return id;
}

export function cardDetailPreviewFromCatalogResult(result: CatalogSearchResult): CardDetailPreview {
  return {
    cardId: result.cardId,
    cardNumber: result.cardNumber,
    currencyCode: result.currencyCode ?? 'USD',
    id: result.id,
    imageUrl: result.imageUrl,
    marketPrice: result.marketPrice ?? null,
    name: result.name,
    setName: result.setName,
  };
}

export function cardDetailPreviewFromInventoryEntry(entry: InventoryCardEntry): CardDetailPreview {
  return {
    cardId: entry.cardId,
    cardNumber: entry.cardNumber,
    currencyCode: entry.currencyCode,
    entryId: entry.id,
    id: entry.id,
    imageUrl: entry.imageUrl,
    marketPrice: entry.hasMarketPrice ? entry.marketPrice : null,
    name: entry.name,
    ownedEntry: entry,
    setName: entry.setName,
  };
}

export function saveCardDetailPreviewFromCatalogResult(result: CatalogSearchResult) {
  return saveCardDetailPreview(cardDetailPreviewFromCatalogResult(result));
}

export function saveCardDetailPreviewFromInventoryEntry(entry: InventoryCardEntry) {
  return saveCardDetailPreview(cardDetailPreviewFromInventoryEntry(entry));
}

export function getCardDetailPreview(id?: string | null) {
  if (!id) {
    return null;
  }

  return previews.get(id) ?? null;
}

export function clearCardDetailPreviewSessions() {
  previews.clear();
}
