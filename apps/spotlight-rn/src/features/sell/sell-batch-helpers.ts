import type {
  InventoryCardEntry,
  PortfolioSaleRequestPayload,
} from '@spotlight/api-client';

import {
  parseSellPrice,
} from '@/features/sell/sell-order-helpers';

export const bulkSellMissingPriceErrorMessage = 'Enter a sell price for every selected card.';
export const bulkSellEmptySelectionErrorMessage = 'Choose at least one card to sell.';

export type BulkSellLineState = {
  entryId: string;
  quantity: number;
  soldPriceText: string;
  revealsBoughtPrice: boolean;
};

export type BulkSellLineMetrics = {
  quantity: number;
  soldPrice: number | null;
  draftTotal: number;
  marketTotal: number;
  projectedTotal: number;
  isActive: boolean;
};

export type BulkSellSelectionSummary = {
  activeEntries: InventoryCardEntry[];
  totalSelectedQuantity: number;
  draftGrossTotal: number;
  estimatedMarketTotal: number;
  projectedGrossTotal: number;
  currencyCode: string;
  hasAnySoldPrice: boolean;
  hasMissingActiveSoldPrice: boolean;
};

export type BulkSellSubmitState = 'processing' | 'success';

export type BulkSellStatusCopy = {
  title: string;
  headline: string;
  detail: string;
};

export function buildInitialBulkSellLines(entries: InventoryCardEntry[]) {
  return Object.fromEntries(entries.map((entry) => [
    entry.id,
    {
      entryId: entry.id,
      quantity: entry.quantity,
      soldPriceText: '',
      revealsBoughtPrice: false,
    } satisfies BulkSellLineState,
  ])) as Record<string, BulkSellLineState>;
}

export function parseBulkSellPrice(text: string) {
  return parseSellPrice(text);
}

export function getBulkSellLineMetrics(
  entry: InventoryCardEntry,
  line: BulkSellLineState | undefined,
): BulkSellLineMetrics {
  const quantity = Math.min(Math.max(0, line?.quantity ?? 0), entry.quantity);
  const soldPrice = parseBulkSellPrice(line?.soldPriceText ?? '');
  const baseMarketPrice = entry.hasMarketPrice ? entry.marketPrice : 0;

  return {
    quantity,
    soldPrice,
    draftTotal: quantity * (soldPrice ?? 0),
    marketTotal: quantity * baseMarketPrice,
    projectedTotal: quantity * (soldPrice ?? baseMarketPrice),
    isActive: quantity > 0,
  };
}

export function activeBulkSellEntries(
  entries: InventoryCardEntry[],
  lines: Record<string, BulkSellLineState>,
) {
  return entries.filter((entry) => getBulkSellLineMetrics(entry, lines[entry.id]).isActive);
}

export function summarizeBulkSellSelection(
  entries: InventoryCardEntry[],
  lines: Record<string, BulkSellLineState>,
): BulkSellSelectionSummary {
  const currencyCode = entries[0]?.currencyCode ?? 'USD';

  return entries.reduce<BulkSellSelectionSummary>((summary, entry) => {
    const metrics = getBulkSellLineMetrics(entry, lines[entry.id]);

    if (!metrics.isActive) {
      return summary;
    }

    summary.activeEntries.push(entry);
    summary.totalSelectedQuantity += metrics.quantity;
    summary.draftGrossTotal += metrics.draftTotal;
    summary.estimatedMarketTotal += metrics.marketTotal;
    summary.projectedGrossTotal += metrics.projectedTotal;
    summary.hasAnySoldPrice = summary.hasAnySoldPrice || metrics.soldPrice !== null;
    summary.hasMissingActiveSoldPrice = summary.hasMissingActiveSoldPrice || metrics.soldPrice === null;

    return summary;
  }, {
    activeEntries: [],
    totalSelectedQuantity: 0,
    draftGrossTotal: 0,
    estimatedMarketTotal: 0,
    projectedGrossTotal: 0,
    currencyCode,
    hasAnySoldPrice: false,
    hasMissingActiveSoldPrice: false,
  });
}

export function validateBulkSellSubmission(
  entries: InventoryCardEntry[],
  lines: Record<string, BulkSellLineState>,
) {
  const summary = summarizeBulkSellSelection(entries, lines);
  if (summary.activeEntries.length === 0) {
    return bulkSellEmptySelectionErrorMessage;
  }

  if (summary.hasMissingActiveSoldPrice) {
    return bulkSellMissingPriceErrorMessage;
  }

  return null;
}

export function buildBulkSellPayloads(
  entries: InventoryCardEntry[],
  lines: Record<string, BulkSellLineState>,
) {
  return activeBulkSellEntries(entries, lines).flatMap<PortfolioSaleRequestPayload>((entry) => {
    const metrics = getBulkSellLineMetrics(entry, lines[entry.id]);
    if (metrics.soldPrice === null) {
      return [];
    }

    return [{
      deckEntryID: entry.id,
      cardID: entry.cardId,
      slabContext: entry.slabContext ?? null,
      quantity: metrics.quantity,
      unitPrice: metrics.soldPrice,
      currencyCode: entry.currencyCode,
      paymentMethod: null,
      soldAt: new Date().toISOString(),
      showSessionID: null,
      note: null,
      sourceScanID: null,
    }];
  });
}

export function buildBulkSellStatusCopy(
  submitState: BulkSellSubmitState,
  summary: Pick<BulkSellSelectionSummary, 'currencyCode' | 'draftGrossTotal' | 'totalSelectedQuantity'>,
): BulkSellStatusCopy {
  const quantityLabel =
    summary.totalSelectedQuantity === 1
      ? '1 card'
      : `${summary.totalSelectedQuantity} cards`;
  const totalLabel = formatStatusCurrency(summary.draftGrossTotal, summary.currencyCode);

  if (submitState === 'success') {
    return {
      title: 'Congrats!',
      headline: 'Batch sale confirmed',
      detail: `${quantityLabel} sold for ${totalLabel}.`,
    };
  }

  return {
    title: 'Processing sale',
    headline: `Selling ${totalLabel}`,
    detail: `Locking in ${quantityLabel}.`,
  };
}

function formatStatusCurrency(value: number, currencyCode: string) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currencyCode,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}
