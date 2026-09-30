import type { DealAlert, DealBaselineSource } from '@spotlight/api-client';

import { formatCurrency } from '@/features/portfolio/components/portfolio-formatting';

/*
  Copy and parsing for the watchlist Deals band. The payload shapes and the four
  repository methods (`listDealAlerts`, `markDealAlertSeen`,
  `markDealAlertTapped`, `setCardFavoriteTarget`) live in the api-client; only
  the sentences live here.
*/

export function centsToCurrency(cents: number | null | undefined, currencyCode = 'USD'): string | null {
  if (cents == null || !Number.isFinite(cents)) {
    return null;
  }
  return formatCurrency(cents / 100, currencyCode);
}

/** "$95" for whole dollars, "$95.50" otherwise — for short, spoken-style copy. */
function compactCurrency(cents: number | null | undefined, currencyCode: string): string | null {
  if (cents == null || !Number.isFinite(cents)) {
    return null;
  }
  return new Intl.NumberFormat('en-US', {
    currency: currencyCode,
    maximumFractionDigits: 2,
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
    style: 'currency',
  }).format(cents / 100);
}

/**
 * False once the listing is dead: the server swept it as expired, or its end
 * time has passed since the feed loaded. A dead eBay link lands on "similar
 * items", so it is never shown or opened. An unknown end time counts as live.
 */
export function isDealAlertLive(alert: DealAlert, now: number = Date.now()): boolean {
  if (alert.expiredAt) {
    return false;
  }
  if (!alert.listingEndsAt) {
    return true;
  }
  const endsAt = Date.parse(alert.listingEndsAt);
  return Number.isNaN(endsAt) || endsAt > now;
}

/**
 * Which number the baseline is. Older alerts carry no source; one whose
 * baseline equals the market can still be called the market.
 */
function dealBaselineSource(alert: DealAlert): DealBaselineSource | null {
  if (alert.baselineSource) {
    return alert.baselineSource;
  }
  return alert.marketCents != null && alert.marketCents === alert.baselineCents ? 'market' : null;
}

/** "$12.00 under the $46.00 market" — the comparison, named honestly. */
function buildDealClaim(alert: DealAlert, currencyCode: string, voice: 'you' | 'I'): string | null {
  const baseline = centsToCurrency(alert.baselineCents, currencyCode);
  if (!baseline || alert.baselineCents <= 0) {
    return null;
  }
  const savingsCents = alert.savingsCents ?? alert.baselineCents - alert.totalCents;
  const savings = savingsCents > 0 ? centsToCurrency(savingsCents, currencyCode) : null;
  const under = savings ? `${savings} under` : 'under';
  switch (dealBaselineSource(alert)) {
    case 'market':
      return `${under} the ${baseline} market`;
    case 'sales':
      return `${under} recent sales (${baseline})`;
    case 'added':
      return `${savings ? `${savings} below` : 'below'} the ${baseline} ${voice} added it at`;
    default:
      return `${under} ${baseline}`;
  }
}

/**
 * What the listing costs, split the way eBay shows it: the item price, plus
 * shipping when it is known and non-zero. Alerts from before the split was
 * stored carry only the shipping-inclusive total — that is shown as-is, with
 * nothing said about shipping. The deal math always uses `totalCents`.
 */
export function resolveDealListPrice(alert: DealAlert): { priceCents: number; shippingCents: number | null } {
  const price = alert.priceCents;
  if (price != null && Number.isFinite(price) && price > 0) {
    const shipping = alert.shippingCents ?? (price <= alert.totalCents ? alert.totalCents - price : null);
    if (shipping != null && Number.isFinite(shipping) && shipping >= 0) {
      return { priceCents: price, shippingCents: shipping > 0 ? shipping : null };
    }
  }
  return { priceCents: alert.totalCents, shippingCents: null };
}

export type DealPriceLines = {
  /** "Watch Price: $46.00", or the new-low line; null when there is no yardstick. */
  watchLine: string | null;
  /** "$50.00" — the item price the row sets in bold. */
  listPrice: string;
  /** "+ $6.00 shipping", or null for free / unknown shipping. */
  shippingSuffix: string | null;
};

/**
 * The two price lines a deal row shows:
 *   Watch Price: $46.00
 *   List Price: **$50.00** + $6.00 shipping
 *
 * The watch price is the number the listing was judged against (the baseline:
 * min of market, recent sales, the added price). A new low makes no percent
 * claim, so its first line says "lowest we've seen" instead.
 */
export function buildDealPriceLines(alert: DealAlert, currencyCode = 'USD'): DealPriceLines {
  const { priceCents, shippingCents } = resolveDealListPrice(alert);
  const listPrice = centsToCurrency(priceCents, currencyCode) ?? '';
  const shipping = shippingCents != null ? centsToCurrency(shippingCents, currencyCode) : null;
  const shippingSuffix = shipping ? `+ ${shipping} shipping` : null;
  if (alert.kind === 'new_low') {
    const usual = alert.lowestSeenCents != null
      ? compactCurrency(Math.floor(alert.lowestSeenCents / 100) * 100, currencyCode)
      : null;
    return { listPrice, shippingSuffix, watchLine: usual ? `Lowest we've seen · usually ${usual}+` : "Lowest we've seen" };
  }
  const watchCents = alert.baselineCents > 0 ? alert.baselineCents : alert.marketCents;
  const watch = watchCents != null && watchCents > 0 ? centsToCurrency(watchCents, currencyCode) : null;
  return { listPrice, shippingSuffix, watchLine: watch ? `Watch Price: ${watch}` : null };
}

/** The price lines as one sentence, for the row's accessibility label. */
export function buildDealHeadline(alert: DealAlert, currencyCode = 'USD'): string {
  const { listPrice, shippingSuffix, watchLine } = buildDealPriceLines(alert, currencyCode);
  const list = `List Price: ${listPrice}${shippingSuffix ? ` ${shippingSuffix}` : ''}`;
  return watchLine ? `${watchLine}. ${list}` : list;
}

/**
 * "26% off" for the chip, or null when there is no percent to claim: no score,
 * a `new_low` (never a percent), or a `none`-tier market too thin to judge.
 */
export function buildDiscountLabel(alert: DealAlert): string | null {
  if (alert.kind === 'new_low' || alert.tier === 'none') {
    return null;
  }
  if (alert.discountPct == null || !Number.isFinite(alert.discountPct) || alert.discountPct <= 0) {
    return null;
  }
  return `${Math.round(alert.discountPct)}% off`;
}

/** The muted liquidity chip ("Few sales"), only for the thin-but-judged tiers. */
export function buildTierLabel(alert: DealAlert): string | null {
  if (alert.tier !== 'fewer' && alert.tier !== 'rarely') {
    return null;
  }
  const label = (alert.tierLabel ?? '').trim();
  return label.length > 0 ? label : null;
}

/**
 * A caught deal as a message someone else can act on.
 *
 * The savings is the whole point — "the app told me this was $12 under" is the
 * sentence that travels — so it leads over the discount percent, and the
 * listing URL rides along because a deal nobody can open is a brag, not a tip.
 */
export function buildDealShareMessage(
  alert: DealAlert,
  card: { name: string; cardNumber?: string | null; setName?: string | null } | null,
  currencyCode = 'USD',
): string | null {
  const total = centsToCurrency(alert.totalCents, currencyCode);
  if (!total) {
    return null;
  }

  const title = [card?.name, card?.cardNumber, card?.setName, alert.variantKey]
    .map((part) => (part ?? '').trim())
    .filter((part) => part.length > 0)
    .join(' · ');
  const subject = title.length > 0 ? title : 'A card on my watchlist';

  if (alert.kind === 'new_low') {
    const usual = alert.lowestSeenCents != null
      ? compactCurrency(Math.floor(alert.lowestSeenCents / 100) * 100, currencyCode)
      : null;
    const lowLine = `${subject} just listed at ${total} — the lowest we've seen${usual ? ` (usually ${usual}+)` : ''}.`;
    return alert.url ? `${lowLine}\n\n${alert.url}` : lowLine;
  }

  // Too thin to judge: say the price, claim nothing.
  if (alert.tier === 'none') {
    const plain = `${subject} just listed at ${total}.`;
    return alert.url ? `${plain}\n\n${alert.url}` : plain;
  }

  const claim = buildDealClaim(alert, currencyCode, 'I');
  const headline = claim
    ? `${subject} just listed at ${total} — ${claim}.`
    : `${subject} just listed at ${total}.`;
  return alert.url ? `${headline}\n\n${alert.url}` : headline;
}

/**
 * Parse a typed target price into whole cents.
 *
 * Returns `null` for an empty field (the CLEAR intent) and `undefined` for
 * something that isn't a usable price, so the caller can tell "clear it" from
 * "don't submit that".
 */
export function parseTargetPriceCents(raw: string): number | null | undefined {
  const trimmed = raw.replace(/[$,\s]/g, '').trim();
  if (trimmed.length === 0) {
    return null;
  }
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.round(value * 100);
}
