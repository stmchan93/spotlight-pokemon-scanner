/**
 * Deep links to a collector's public profile.
 *
 * IN-APP ONLY, AND DELIBERATELY SO. These are `spotlight://` scheme links: they
 * open the right screen for anyone who already has the build, and are inert for
 * anyone who doesn't. That is why they are handed to another Ekalight user
 * through a DM (where the recipient provably has the app) rather than dropped
 * into the OS share sheet — see `profile-share.ts` for why a dead URL in a chat
 * is worse than no URL at all.
 *
 * WHEN UNIVERSAL LINKS EXIST, THIS IS THE ONE PLACE TO CHANGE: swap the scheme
 * for the https origin once `associatedDomains`/`intentFilters` and a public web
 * route are in place. Every caller builds its link here.
 */

/** Tabs a link can open the public profile on. Mirrors `ProfileTab`. */
export type ProfileLinkTab = 'collection' | 'wishlist';

export type ProfileLinkIdentity = {
  /** Stored WITHOUT the `@`; a stored value that carries one is tolerated. */
  handle?: string | null;
  /** Supabase user id — the fallback lane for collectors with no handle. */
  userId?: string | null;
  /** Omitted for the profile's default (Collection) tab. */
  tab?: ProfileLinkTab;
};

export const PROFILE_LINK_SCHEME = 'spotlight://';

/**
 * `spotlight://u/<handle-or-userId>[?tab=wishlist]`.
 *
 * The slug mirrors the `/u/[handle]` route's own rule: a claimed handle when
 * there is one, else the raw user id (the route detects a uuid-shaped segment
 * and resolves it by id instead). Returns null when there is neither — a link
 * to `/u/` resolves to nobody, so the caller stays silent instead, the same
 * contract `buildProfileShareMessage` uses for a nameless profile.
 */
export function buildProfileDeepLink({
  handle,
  userId,
  tab,
}: ProfileLinkIdentity): string | null {
  const trimmedHandle = (handle ?? '').trim().replace(/^@+/, '');
  const trimmedUserId = (userId ?? '').trim();
  const slug = trimmedHandle || trimmedUserId;

  if (!slug) {
    return null;
  }

  const path = `${PROFILE_LINK_SCHEME}u/${encodeURIComponent(slug)}`;
  // Collection is the profile's default tab, so naming it would add a param
  // that changes nothing.
  return tab && tab !== 'collection' ? `${path}?tab=${tab}` : path;
}

/** Finds `spotlight://…` runs inside free text (e.g. a DM body). */
export const PROFILE_LINK_PATTERN = /spotlight:\/\/\S+/g;

/**
 * The in-app route path for a `spotlight://` link, or null if it isn't one we
 * are willing to follow.
 *
 * DELIBERATELY NARROW: only `u/<slug>` resolves. These links arrive inside
 * message bodies, which are attacker-controlled text — anyone can type
 * `spotlight://` and any path they like into a DM. Routing on the general shape
 * would hand a stranger a jump to any screen in the app, so this recognises the
 * one route the share feature actually emits and rejects everything else.
 */
export function profileLinkToRoutePath(url: string): string | null {
  const trimmed = (url ?? '').trim();
  if (!trimmed.toLowerCase().startsWith(PROFILE_LINK_SCHEME)) {
    return null;
  }

  const rest = trimmed.slice(PROFILE_LINK_SCHEME.length);
  const [rawPath, rawQuery] = rest.split('?', 2);
  const segments = rawPath.split('/').filter((segment) => segment.length > 0);
  // Exactly `u/<slug>` — no deeper paths, and no traversal segments.
  if (segments.length !== 2 || segments[0] !== 'u') {
    return null;
  }
  const slug = decodeURIComponent(segments[1]);
  if (!slug || slug === '.' || slug === '..') {
    return null;
  }

  const tab = new URLSearchParams(rawQuery ?? '').get('tab');
  const suffix = tab === 'wishlist' ? '?tab=wishlist' : '';
  return `/u/${encodeURIComponent(slug)}${suffix}`;
}
