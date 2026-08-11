import type { CardFavoriteEntry } from '@spotlight/api-client';

/**
 * How many cards go in the message before it collapses to a count.
 *
 * A hunt list is pasted into a group chat or a dealer's DM, and past a couple
 * of dozen lines it stops being readable and starts being spam — the reader
 * scrolls past it, which is the opposite of the point. The remainder is still
 * announced, so nobody is misled about the size of the list.
 */
export const WISHLIST_SHARE_MAX_LINES = 25;

/** One card, as a line someone can actually scan: name, number, set. */
function formatEntryLine(entry: CardFavoriteEntry): string {
  return [entry.name, entry.cardNumber, entry.setName]
    .map((part) => (part ?? '').trim())
    .filter((part) => part.length > 0)
    .join(' · ');
}

/**
 * The wishlist as shareable text — "here is what I am hunting", pasted into a
 * chat.
 *
 * This is the MACRO version of the per-card share on card detail: that one
 * shares a single card with a marketplace link, this one shares the list. There
 * is deliberately no link here, because there is nothing to link TO — the
 * wishlist is private and the public profile has no Wishlist tab. Inventing a
 * URL that 404s for the recipient would be worse than plain text.
 *
 * Returns null for an empty list: sharing "here is my wishlist" followed by
 * nothing is a worse outcome than the button appearing to do nothing, and the
 * caller can stay silent instead.
 */
export function buildWishlistShareMessage(
  entries: readonly CardFavoriteEntry[],
  identity?: { displayName?: string | null; handle?: string | null },
): string | null {
  // Still gated on having something to show: "Check out X's wishlist" pointing
  // at an empty page is the same bad outcome the card list guarded against.
  const hasSomethingToShow = entries.some((entry) => formatEntryLine(entry).length > 0);
  if (!hasSomethingToShow) {
    return null;
  }

  const name = (identity?.displayName ?? '').trim();
  const rawHandle = (identity?.handle ?? '').trim().replace(/^@+/, '');
  const who = name || (rawHandle ? `@${rawHandle}` : '');

  // Nameless but non-empty: still worth sending, just without the possessive.
  return who ? `Check out ${who}'s wishlist` : 'Check out this wishlist';
}
