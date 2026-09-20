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

/** "26% off" for the chip, or null when the backend scored no discount. */
export function buildDiscountLabel(alert: DealAlert): string | null {
  if (alert.discountPct == null || !Number.isFinite(alert.discountPct) || alert.discountPct <= 0) {
    return null;
  }
  return `${Math.round(alert.discountPct)}% off`;
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

  const title = [card?.name, card?.cardNumber, card?.setName]
    .map((part) => (part ?? '').trim())
    .filter((part) => part.length > 0)
    .join(' · ');
  const subject = title.length > 0 ? title : 'A card on my watchlist';

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
