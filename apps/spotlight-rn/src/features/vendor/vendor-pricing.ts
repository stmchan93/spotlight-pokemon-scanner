import {
  DEFAULT_VENDOR_SETTINGS,
  type VendorPriceMode,
  type VendorSettings,
  type VendorTierKey,
} from '@spotlight/api-client';

// Vendor buy/sell math. Must match backend/vendor_offers.py `offer_for_market`:
// whole cents, half-up, tiers by market price (bulk under `bulkMaxUsd`, then
// under $50, then $50+; slabs their own tier).

export const MID_TIER_BREAK_USD = 50;
export const SELL_PERCENT_MIN = 85;
export const SELL_PERCENT_MAX = 120;

export type VendorOfferTier = VendorTierKey | 'flat' | 'sell';

export type VendorOffer = {
  offerUsd: number;
  percent: number;
  tier: VendorOfferTier;
};

export function vendorTierFor(
  marketUsd: number,
  isSlab: boolean,
  settings: VendorSettings,
): VendorTierKey | 'flat' {
  if (!settings.tiersEnabled) {
    return 'flat';
  }
  if (isSlab) {
    return 'slab';
  }
  if (marketUsd < settings.bulkMaxUsd) {
    return 'bulk';
  }
  return marketUsd < MID_TIER_BREAK_USD ? 'under50' : 'over50';
}

/** The vendor's price for one card at `marketUsd`; null when there is no market price. */
export function vendorOfferForMarket(
  marketUsd: number | null | undefined,
  isSlab: boolean,
  settings: VendorSettings,
  mode: VendorPriceMode,
): VendorOffer | null {
  if (typeof marketUsd !== 'number' || !Number.isFinite(marketUsd) || marketUsd < 0) {
    return null;
  }
  let tier: VendorOfferTier;
  let percent: number;
  if (mode === 'sell') {
    tier = 'sell';
    percent = settings.sellPercent;
  } else {
    tier = vendorTierFor(marketUsd, isSlab, settings);
    percent = tier === 'flat' ? settings.buyPercent : settings.tiers[tier];
  }
  // toFixed(6) strips float noise (287.93 * 70 = 20155.099999…) before rounding.
  const cents = Math.floor(Number((marketUsd * percent).toFixed(6)) + 0.5);
  return { offerUsd: cents / 100, percent, tier };
}

export type VendorOfferTotals = {
  marketTotal: number;
  offerTotal: number;
  /** Rows with a USD market price (the only ones that count). */
  pricedCount: number;
};

export function summarizeVendorOffers(
  rows: readonly { marketUsd: number | null; offer: VendorOffer | null }[],
): VendorOfferTotals {
  let marketTotal = 0;
  let offerTotal = 0;
  let pricedCount = 0;
  rows.forEach(({ marketUsd, offer }) => {
    if (offer == null || marketUsd == null) {
      return;
    }
    marketTotal += marketUsd;
    offerTotal += offer.offerUsd;
    pricedCount += 1;
  });
  return {
    marketTotal: Math.round(marketTotal * 100) / 100,
    offerTotal: Math.round(offerTotal * 100) / 100,
    pricedCount,
  };
}

/** Short label for a mode's pricing, e.g. "BUY 40–70%" or "SELL 100%". */
export function vendorModeSummary(settings: VendorSettings, mode: VendorPriceMode): string {
  if (mode === 'sell') {
    return `SELL ${settings.sellPercent}%`;
  }
  if (!settings.tiersEnabled) {
    return `BUY ${settings.buyPercent}%`;
  }
  const values = Object.values(settings.tiers);
  const low = Math.min(...values);
  const high = Math.max(...values);
  return low === high ? `BUY ${low}%` : `BUY ${low}–${high}%`;
}

export const VENDOR_TIER_LABELS: Record<VendorTierKey, string> = {
  bulk: 'Bulk',
  under50: 'Under $50',
  over50: '$50+',
  slab: 'Slabs',
};

export function cloneVendorSettings(settings: VendorSettings = DEFAULT_VENDOR_SETTINGS): VendorSettings {
  return { ...settings, tiers: { ...settings.tiers } };
}

const usdFormatter = new Intl.NumberFormat('en-US', { currency: 'USD', style: 'currency' });

/** USD only — this feature never shows another currency. */
export function formatUsd(amount: number): string {
  return usdFormatter.format(amount);
}

/** "+$12.40" / "−$3.00". */
export function formatSignedUsd(amount: number): string {
  if (amount === 0) {
    return formatUsd(0);
  }
  return `${amount > 0 ? '+' : '−'}${formatUsd(Math.abs(amount))}`;
}
