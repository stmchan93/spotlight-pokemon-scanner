/**
 * Your profile as shareable text — what the share glyph in the profile top bar
 * (Figma 3670:47454) hands to the OS share sheet.
 *
 * TEXT ONLY, AND DELIBERATELY SO. There is nowhere to link TO yet. The app
 * registers exactly one scheme, `spotlight://`, and `app.json` declares no
 * `associatedDomains` (iOS) and no `intentFilters` (Android) — so there is no
 * https URL that opens a profile, and a `spotlight://u/handle` line is dead text
 * for every recipient without the build installed, usually not even tappable in
 * the chat app they read it in. A URL that 404s or does nothing is worse than no
 * URL, the same call this app already makes for the wishlist share.
 *
 * WHEN UNIVERSAL LINKS EXIST, THIS IS THE ONE PLACE TO CHANGE. Add the
 * `associatedDomains`/`intentFilters` entries and a public profile route, then
 * append the URL here and pass it to `Share.share` as `{ message, url }` — the
 * shape card detail already uses. Nothing else needs to move: the bar button
 * calls this function and hands the result straight to the sheet.
 */

/** The product name that appears in the message. */
const APP_NAME = 'Ekalight';

export type ProfileShareIdentity = {
  displayName?: string | null;
  /** Stored WITHOUT the `@`; a stored value that carries one is tolerated. */
  handle?: string | null;
};

/**
 * "Check out <name>'s collection".
 *
 * Was "Check out <name> (@<handle>) on Ekalight" — the app name and the
 * parenthesised handle were noise next to the link that follows, and neither
 * said what the recipient would be opening. The message now names the
 * DESTINATION, because it is always sent alongside a deep link to exactly that.
 *
 * Every part is optional, because a signed-in user is not guaranteed either:
 * handles are claimed separately from sign-up, and the display name falls back
 * to a placeholder before the profile has loaded. Returns null when there is no
 * identity at all — the caller stays silent rather than sharing "Check out 's
 * collection", the same contract `buildWishlistShareMessage` uses for an empty
 * list.
 */
export function buildProfileShareMessage({
  displayName,
  handle,
  destination = 'collection',
}: ProfileShareIdentity & {
  /** Which page the accompanying deep link opens. */
  destination?: 'collection' | 'wishlist';
}): string | null {
  const name = (displayName ?? '').trim();
  // Tolerate a stored leading `@` so the message never reads "@@handle".
  const rawHandle = (handle ?? '').trim().replace(/^@+/, '');
  // Prefer the human name; the handle is the fallback identity, not an addendum.
  const who = name || (rawHandle ? `@${rawHandle}` : '');

  if (!who) {
    return null;
  }
  return `Check out ${who}'s ${destination}`;
}
