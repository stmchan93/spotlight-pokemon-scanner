import type {
  CardCatalogSource,
  CardFavoriteEntry,
  CardGame,
  CatalogSearchResult,
  InventoryCardEntry,
  ProductKind,
} from '@spotlight/api-client';

import {
  printingImagesForCandidate,
  printingImagesForEntries,
  type PrintingImage,
} from '@/features/cards/printing-image';

export type CardDetailPreview = {
  cardId: string;
  cardNumber: string;
  /** Which TCG this card is from; undefined means Pokémon. */
  game?: CardGame;
  /** `'tcgplayer'` hides graded lanes before the detail lands; undefined = Scrydex. */
  catalogSource?: CardCatalogSource;
  currencyCode?: string | null;
  entryId?: string | null;
  id: string;
  imageUrl: string;
  largeImageUrl?: string | null;
  marketPrice?: number | null;
  name: string;
  ownedEntry?: InventoryCardEntry | null;
  /**
   * Images for specific printings, e.g. the art version a scan matched. The
   * card page header shows one while that printing is selected.
   */
  printingImages?: PrintingImage[];
  /** `'sealed'` paints the sealed layout before the detail request lands. */
  productKind?: ProductKind;
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

// The preview is what the PDP paints from BEFORE the detail request lands, so
// it must carry the game too — otherwise the grading lanes render as Pokémon's
// for a beat and then swap, which reads as a flicker of wrong controls.
export function cardDetailPreviewFromCatalogResult(result: CatalogSearchResult): CardDetailPreview {
  const printingImages = printingImagesForCandidate(result);
  return {
    cardId: result.cardId,
    cardNumber: result.cardNumber,
    currencyCode: result.currencyCode ?? 'USD',
    game: result.game,
    catalogSource: result.catalogSource,
    id: result.id,
    imageUrl: result.imageUrl,
    marketPrice: result.marketPrice ?? null,
    name: result.name,
    // Only set when the scan matched an art version, so other previews keep their shape.
    ...(printingImages ? { printingImages } : {}),
    productKind: result.productKind,
    setName: result.setName,
  };
}

export function cardDetailPreviewFromInventoryEntry(entry: InventoryCardEntry): CardDetailPreview {
  // An alt-art copy opens on its own art while its printing is selected.
  const printingImages = printingImagesForEntries([
    { printingLabel: entry.variantName, printingImageUrl: entry.printingImageUrl },
  ]);
  return {
    cardId: entry.cardId,
    cardNumber: entry.cardNumber,
    currencyCode: entry.currencyCode,
    entryId: entry.id,
    game: entry.game,
    catalogSource: entry.catalogSource,
    id: entry.id,
    imageUrl: entry.imageUrl,
    largeImageUrl: entry.largeImageUrl ?? null,
    marketPrice: entry.hasMarketPrice ? entry.marketPrice : null,
    name: entry.name,
    ownedEntry: entry,
    ...(printingImages ? { printingImages } : {}),
    setName: entry.setName,
  };
}

/**
 * Preview for a copy someone ELSE owns (a public profile's Collection). Paints
 * the same art/name/price, but carries no `ownedEntry` / `entryId`: the card
 * page treats a preview's owned entry as the viewer's own copy, so passing
 * theirs would open the page as an UPDATE of their row.
 */
export function cardDetailPreviewFromForeignInventoryEntry(entry: InventoryCardEntry): CardDetailPreview {
  return {
    ...cardDetailPreviewFromInventoryEntry(entry),
    entryId: null,
    id: `foreign:${entry.id}`,
    ownedEntry: null,
  };
}

export function saveCardDetailPreviewFromForeignInventoryEntry(entry: InventoryCardEntry) {
  return saveCardDetailPreview(cardDetailPreviewFromForeignInventoryEntry(entry));
}

export function saveCardDetailPreviewFromCatalogResult(result: CatalogSearchResult) {
  return saveCardDetailPreview(cardDetailPreviewFromCatalogResult(result));
}

export function saveCardDetailPreviewFromInventoryEntry(entry: InventoryCardEntry) {
  return saveCardDetailPreview(cardDetailPreviewFromInventoryEntry(entry));
}

export function cardDetailPreviewFromFavorite(entry: CardFavoriteEntry): CardDetailPreview {
  const printingImages = printingImagesForEntries([
    { printingLabel: entry.watchVariant ?? entry.variantName, printingImageUrl: entry.printingImageUrl },
  ]);
  return {
    cardId: entry.cardId,
    cardNumber: entry.cardNumber,
    currencyCode: entry.currencyCode,
    game: entry.game,
    catalogSource: entry.catalogSource,
    id: `favorite:${entry.cardId}`,
    imageUrl: entry.imageUrl,
    largeImageUrl: entry.largeImageUrl ?? null,
    marketPrice: entry.marketPrice ?? null,
    name: entry.name,
    ...(printingImages ? { printingImages } : {}),
    setName: entry.setName,
  };
}

export function saveCardDetailPreviewFromFavorite(entry: CardFavoriteEntry) {
  return saveCardDetailPreview(cardDetailPreviewFromFavorite(entry));
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
