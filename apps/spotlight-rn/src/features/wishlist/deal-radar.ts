import type { DealAlert } from '@spotlight/api-client';

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
 * The one line a deal row says out loud: "$34.00 listed — you added it at
 * $46.00".
 *
 * The baseline is what makes it a DEAL rather than a price, so it leads the
 * comparison. Falls back to market, and then to the bare listing price — a
 * price with no claim attached is still true, and a row that renders nothing
 * would be worse.
 */
export function buildDealHeadline(alert: DealAlert, currencyCode = 'USD'): string {
  const total = centsToCurrency(alert.totalCents, currencyCode) ?? '';
  if (alert.kind === 'new_low') {
    return buildNewLowLabel(alert, currencyCode);
  }
  const baseline = centsToCurrency(alert.baselineCents, currencyCode);
  if (baseline) {
    return `${total} listed — you added it at ${baseline}`;
  }
  const market = centsToCurrency(alert.marketCents, currencyCode);
  if (market) {
    return `${total} listed — market is ${market}`;
  }
  return `${total} listed`;
}

/**
 * "Lowest we've seen · $95 (usually $129+)". A new low makes no percent claim —
 * it is the honest thing to say about a thin market with no reliable yardstick.
 */
export function buildNewLowLabel(alert: DealAlert, currencyCode = 'USD'): string {
  const total = compactCurrency(alert.totalCents, currencyCode) ?? '';
  // "usually $129+" is a floor, so whole dollars rounded down.
  const usual = alert.lowestSeenCents != null
    ? compactCurrency(Math.floor(alert.lowestSeenCents / 100) * 100, currencyCode)
    : null;
  return usual ? `Lowest we've seen · ${total} (usually ${usual}+)` : `Lowest we've seen · ${total}`;
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

  const savings = centsToCurrency(alert.savingsCents, currencyCode);
  const discount = buildDiscountLabel(alert);
  const claim = savings
    ? `${savings} under what I added it at`
    : discount
      ? `${discount} what I added it at`
      : 'under what I added it at';

  const headline = `${subject} just listed at ${total} — ${claim}.`;
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
