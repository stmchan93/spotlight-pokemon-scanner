import { useMemo } from 'react';

import type {
  VendorPriceMode,
  VendorPurchaseLineInput,
  VendorSettings,
} from '@spotlight/api-client';

import {
  summarizeVendorOffers,
  vendorOfferForMarket,
  type VendorOffer,
  type VendorOfferTotals,
} from '@/features/vendor/vendor-pricing';

import { effectiveScanRowGrading, scanRowInventoryTarget } from './scan-row-grading';
import type { ScanPriceSheetSelection } from './screens/scan-price-sheet';
import {
  activeCandidateForCapture,
  resolveCaptureTrayPrice,
  supportedTrayCurrencyCode,
} from './screens/scanner-screen-helpers';
import type { RecentCapture } from './screens/scanner-screen-types';
import { useTraySelector, type TrayState, type TrayStore } from './tray-store';

// The vendor price tag on a tray row: the row's own displayed market price
// (the SAME `resolveCaptureTrayPrice` the row and TOTAL use) times the
// vendor's buy or sell %. Display + the Bought payload only — it never
// changes what ADD files or any card's worth. USD only: a non-USD row gets no
// offer, exactly like it stays out of the TOTAL.

export type CaptureVendorQuote = {
  marketUsd: number | null;
  offer: VendorOffer | null;
};

const noQuote: CaptureVendorQuote = { marketUsd: null, offer: null };

export function captureVendorQuote(
  capture: RecentCapture,
  selection: ScanPriceSheetSelection | null | undefined,
  settings: VendorSettings,
  mode: VendorPriceMode,
): CaptureVendorQuote {
  if (capture.binderPage?.empty || capture.isLoadingCandidates) {
    return noQuote;
  }
  const { amount, currencyCode } = resolveCaptureTrayPrice(capture, selection);
  if (currencyCode !== supportedTrayCurrencyCode || typeof amount !== 'number' || !Number.isFinite(amount)) {
    return noQuote;
  }
  const isSlab = effectiveScanRowGrading(capture, selection).grader != null;
  return { marketUsd: amount, offer: vendorOfferForMarket(amount, isSlab, settings, mode) };
}

export function selectTrayVendorTotals(
  state: TrayState,
  settings: VendorSettings,
  mode: VendorPriceMode,
): VendorOfferTotals {
  return summarizeVendorOffers(state.items.map(
    (capture) => captureVendorQuote(capture, state.priceSelections.get(capture.id), settings, mode),
  ));
}

function totalsEqual(a: VendorOfferTotals, b: VendorOfferTotals): boolean {
  return a.marketTotal === b.marketTotal && a.offerTotal === b.offerTotal && a.pricedCount === b.pricedCount;
}

const emptyTotals: VendorOfferTotals = { marketTotal: 0, offerTotal: 0, pricedCount: 0 };

/** The tray's offer total for `mode`; zeros while vendor pricing is off. */
export function useTrayVendorTotals(
  store: TrayStore,
  settings: VendorSettings,
  mode: VendorPriceMode | null,
): VendorOfferTotals {
  const selector = useMemo(
    () => (mode == null
      ? () => emptyTotals
      : (state: TrayState) => selectTrayVendorTotals(state, settings, mode)),
    [mode, settings],
  );
  return useTraySelector(store, selector, totalsEqual);
}

/**
 * The Bought payload line for a row, or null when it can't be bought (no
 * match, no USD price). Files the row the way ADD would (printing, condition
 * or grade), at the offer price.
 */
export function buildVendorPurchaseLine(
  capture: RecentCapture,
  selection: ScanPriceSheetSelection | null | undefined,
  settings: VendorSettings,
  rawVariantLabel: string | null,
): VendorPurchaseLineInput | null {
  const candidate = activeCandidateForCapture(capture);
  if (!candidate || capture.recentlyAdded) {
    return null;
  }
  const quote = captureVendorQuote(capture, selection, settings, 'buy');
  if (!quote.offer) {
    return null;
  }
  const target = scanRowInventoryTarget(capture, selection);
  const isGraded = target.mode === 'slabs';
  return {
    cardId: candidate.cardId,
    quantity: 1,
    marketUsd: quote.marketUsd,
    offerUsd: quote.offer.offerUsd,
    buyPercent: quote.offer.percent,
    tier: quote.offer.tier,
    variantName: isGraded ? target.slabContext?.variantName ?? null : rawVariantLabel,
    condition: isGraded ? null : target.conditionCode ?? 'near_mint',
    grader: isGraded ? target.slabContext?.grader ?? null : null,
    grade: isGraded ? target.slabContext?.grade ?? null : null,
    certNumber: isGraded ? target.slabContext?.certNumber ?? null : null,
  };
}

export function newVendorBatchId(): string {
  return `vb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
