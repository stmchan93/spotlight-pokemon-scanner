import type { InventoryCardEntry } from '@spotlight/api-client';

import { resolveConditionDisplayLabel } from '@/lib/condition-display';

export const sellOrderProcessingMinimumDurationMs = 1600;
export const sellOrderSuccessDisplayDurationMs = 1100;
export const sellOrderSwipeThreshold = 92;
export const sellOrderSwipeRailHeight = 48;
export const sellSwipeCollapsedHeight = sellOrderSwipeRailHeight;
export const sellSwipeArmThresholdRatio = 0.4;

export type SingleSellStatusCopy = {
  title: string;
  headline: string;
  detail: string;
};

export function sanitizeSellPriceText(value: string) {
  const trimmed = value.replace(/[^0-9.]/g, '');
  const [whole = '', ...fractionParts] = trimmed.split('.');
  const fraction = fractionParts.join('').slice(0, 2);

  if (trimmed.startsWith('.')) {
    return fraction.length > 0 ? `0.${fraction}` : '0.';
  }

  if (fractionParts.length === 0) {
    return whole;
  }

  return `${whole}.${fraction}`;
}

export function parseSellPrice(text: string) {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return null;
  }

  return parsed;
}

export function formatEditableSellPrice(value: number) {
  const fixed = value.toFixed(2);
  return fixed.replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');
}

export function formatSellPercentValue(value: number) {
  const rounded = Math.round(value * 100) / 100;
  if (Math.abs(Math.round(rounded) - rounded) < 0.005) {
    return `${Math.round(rounded)}%`;
  }

  return `${rounded.toFixed(2)}%`;
}

export function buildOfferToYourPricePercentText(
  offerPrice: number | null,
  yourPrice: number | null,
) {
  if (offerPrice == null || offerPrice <= 0 || yourPrice == null || yourPrice <= 0) {
    return null;
  }

  const truncatedPercent = Math.floor(((offerPrice / yourPrice) * 100) * 100) / 100;
  if (Math.abs(Math.round(truncatedPercent) - truncatedPercent) < 0.005) {
    return `${Math.round(truncatedPercent)}% YP`;
  }

  return `${truncatedPercent.toFixed(2)}% YP`;
}

export function getSellSwipeConfirmThreshold() {
  return sellOrderSwipeThreshold;
}

export function canStartSellSwipeGesture(dx: number, dy: number) {
  return dy < -6 && Math.abs(dy) > Math.abs(dx);
}

export function canStartSellSheetDismissGesture(dx: number, dy: number) {
  return dy > 8 && Math.abs(dy) > Math.abs(dx);
}

export function isSellSwipeReleaseArmed(nextOffset: number, closedSheetOffset: number) {
  return closedSheetOffset > 0
    && (1 - (nextOffset / closedSheetOffset)) >= sellSwipeArmThresholdRatio;
}

export function getResistedSellSwipeTranslation(translation: number) {
  if (translation < 0) {
    return translation * 0.88;
  }

  return translation * 0.35;
}

export function formatSellOrderBoughtPriceLabel(
  value: number | null | undefined,
  currencyText: string,
  revealsValue: boolean,
) {
  if (value == null) {
    return '--';
  }

  return revealsValue ? currencyText : '*****';
}

export function buildSingleSellStatusCopy({
  currencyCode,
  entryName,
  quantity,
  soldTotal,
  submitState,
}: {
  currencyCode: string;
  entryName: string;
  quantity: number;
  soldTotal: number;
  submitState: 'processing' | 'success';
}): SingleSellStatusCopy {
  const totalLabel = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currencyCode,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(soldTotal);

  if (submitState === 'success') {
    return {
      title: 'Congrats!',
      headline: 'Sale confirmed',
      detail: `${entryName} sold for ${totalLabel}.`,
    };
  }

  return {
    title: 'Processing sale',
    headline: `Selling ${totalLabel}`,
    detail: quantity === 1 ? 'Locking in the sale.' : `Locking in ${quantity} cards.`,
  };
}

export function collectionSummaryLine(entry: InventoryCardEntry) {
  if (entry.kind === 'graded') {
    const parts = [
      `${entry.slabContext?.grader ?? 'Graded'} ${entry.slabContext?.grade ?? ''}`.trim(),
      entry.slabContext?.variantName?.trim(),
    ].filter(Boolean);
    return parts.join(' • ');
  }

  const parts = [
    resolveConditionDisplayLabel({
      conditionCode: entry.conditionCode,
      conditionLabel: entry.conditionLabel,
      conditionShortLabel: entry.conditionShortLabel,
    }),
    entry.slabContext?.variantName?.trim(),
  ].filter(Boolean);
  return parts.join(' • ');
}
