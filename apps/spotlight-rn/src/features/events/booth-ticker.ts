import type { SpotlightEventMapVendor } from '@spotlight/api-client';

import { BOOTH_POST_FRESH_MS, formatBoothAgeShort } from '@/features/events/booth-format';
import type { BoothClaim, BoothPost } from '@/features/events/booth-service';

/** Below this, "browsing now" reads as empty rather than busy. */
export const MIN_BROWSING_SHOWN = 3;
/** Enough for a minute of rotation at 4s a line. */
export const MAX_TICKER_ITEMS = 12;

export type BoothTickerItem = {
  key: string;
  text: string;
  /** The vendor a tap selects; null for items about the whole show. */
  vendorId: string | null;
};

type TickerInput = {
  vendors: readonly Pick<SpotlightEventMapVendor, 'id' | 'name'>[];
  posts: readonly BoothPost[];
  claims: ReadonlyMap<string, BoothClaim>;
  /** Hottest first. */
  hotVendorIds: Iterable<string>;
  browsingNow: number | null;
  now?: number;
};

/**
 * The live ticker's lines, built only from what the show page already loaded:
 * busy booths (happening now) first, then posts and booth setups from the last
 * day newest first, then the browsing count. One post line per vendor.
 */
export function buildBoothTickerItems({
  vendors,
  posts,
  claims,
  hotVendorIds,
  browsingNow,
  now = Date.now(),
}: TickerInput): BoothTickerItem[] {
  const names = new Map(vendors.map((vendor) => [vendor.id, vendor.name]));
  const recent = (at: string) => {
    const time = Date.parse(at);
    return !Number.isNaN(time) && now - time < BOOTH_POST_FRESH_MS ? time : null;
  };

  const hot: BoothTickerItem[] = [];
  for (const vendorId of hotVendorIds) {
    const name = names.get(vendorId);
    if (name) {
      hot.push({ key: `hot:${vendorId}`, text: `🔥 ${name} is busy right now`, vendorId });
    }
  }

  const timed: { at: number; item: BoothTickerItem }[] = [];
  const posted = new Set<string>();
  const newestFirst = [...posts].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  for (const post of newestFirst) {
    const name = names.get(post.boothVendorId);
    const at = recent(post.createdAt);
    if (!name || at == null || posted.has(post.boothVendorId)) {
      continue;
    }
    posted.add(post.boothVendorId);
    timed.push({
      at,
      item: {
        key: `post:${post.id}`,
        text: `📸 ${name} posted · ${formatBoothAgeShort(post.createdAt, now)}`,
        vendorId: post.boothVendorId,
      },
    });
  }
  for (const claim of claims.values()) {
    const name = names.get(claim.vendorId);
    const at = recent(claim.claimedAt);
    if (!name || at == null) {
      continue;
    }
    timed.push({
      at,
      item: {
        key: `claim:${claim.vendorId}`,
        text: `👋 ${name} set up their booth · ${formatBoothAgeShort(claim.claimedAt, now)}`,
        vendorId: claim.vendorId,
      },
    });
  }
  timed.sort((a, b) => b.at - a.at);

  const items = [...hot, ...timed.map((entry) => entry.item)];
  const browsing =
    browsingNow != null && browsingNow >= MIN_BROWSING_SHOWN
      ? [{ key: 'browsing', text: `👀 ${browsingNow} people browsing`, vendorId: null }]
      : [];
  return [...items.slice(0, MAX_TICKER_ITEMS - browsing.length), ...browsing];
}
