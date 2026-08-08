import type { UserProfile } from '@/features/auth/auth-models';
import { isMissingColumnError } from '@/lib/postgrest-errors';
import { supabase } from '@/lib/supabase';

/**
 * Supabase reads for OTHER people's profiles (Phase 2a public profiles).
 *
 * `auth-service.ts` owns the signed-in user's own row in `user_profiles`; this
 * module is the read-only cross-user lane and reads a DIFFERENT relation:
 * `public.public_profiles`.
 *
 * Why a view and not `user_profiles`: RLS filters rows, not columns, so a
 * public-read policy on `user_profiles` would publish moderation state
 * (`status`, `is_shadowbanned`) and the capability flags (`admin_enabled`,
 * `labeler_enabled`) to anyone holding the anon key that ships in the app
 * bundle — including guests, who sign in anonymously and still get the
 * `authenticated` role. `public_profiles` exposes only the presentational
 * columns and is filtered to `status = 'active' and not is_shadowbanned`.
 *
 * A suspended or shadowbanned user therefore returns no row, which lands on the
 * ordinary not-found state. That is intended: the viewer is never told why.
 *
 * These functions NEVER throw — a missing handle, a hidden row, or an
 * unconfigured Supabase client all resolve to `null`.
 */

/** The relation these reads target. Never `user_profiles`. */
const PUBLIC_PROFILES_VIEW = 'public_profiles';

/** Exactly the columns `public.public_profiles` exposes (minus `created_at`). */
type PublicProfileRow = {
  user_id: string;
  display_name: string | null;
  avatar_url: string | null;
  handle: string | null;
  bio: string | null;
  location: string | null;
  social_link: string | null;
  cover_url?: string | null;
  is_verified: boolean | null;
  reputation: number | null;
  follower_count: number | null;
  following_count: number | null;
  post_count: number | null;
};

// Only columns that exist on the view. Selecting `admin_enabled`,
// `labeler_enabled`, `status`, or `is_shadowbanned` here would error — they are
// deliberately absent.
const publicProfileSelect =
  'user_id, display_name, avatar_url, handle, bio, location, social_link, is_verified, reputation, follower_count, following_count, post_count';
// `cover_url` is the newest column on the view and is not present on every
// environment yet. PostgREST fails the whole select on one unknown column, so
// single-profile reads try this first and fall back to `publicProfileSelect` —
// a not-yet-migrated view costs the banner, not the profile. List reads
// (followers/following/search) never render a cover and stay on the base select.
const publicProfileSelectWithCover = `${publicProfileSelect}, cover_url`;

function mapPublicProfile(row: PublicProfileRow): UserProfile {
  return {
    userID: row.user_id,
    displayName: row.display_name,
    avatarURL: row.avatar_url,
    // Capability flags aren't on the public view at all; a visitor always sees
    // false, never the target's real capabilities.
    labelerEnabled: false,
    adminEnabled: false,
    handle: row.handle ?? null,
    bio: row.bio ?? null,
    location: row.location ?? null,
    socialLink: row.social_link ?? null,
    coverURL: row.cover_url ?? null,
    isVerified: row.is_verified === true,
    reputation: row.reputation ?? 0,
    followerCount: row.follower_count ?? 0,
    followingCount: row.following_count ?? 0,
    postCount: row.post_count ?? 0,
  };
}

/**
 * Read one row from the public profile view by an equality filter. Returns null
 * for every failure mode, including "no such row" and "row filtered out by
 * moderation state" — the caller cannot distinguish them, by design.
 */
async function fetchPublicProfileBy(
  column: 'handle' | 'user_id',
  value: string,
): Promise<UserProfile | null> {
  if (!supabase || !value) {
    return null;
  }

  try {
    // Widest first, then the cover-less select. Anything other than a missing
    // column would fail the same way on the narrower select, so only that walks
    // down a rung.
    for (const select of [publicProfileSelectWithCover, publicProfileSelect]) {
      const { data, error } = await supabase
        .from(PUBLIC_PROFILES_VIEW)
        .select(select)
        .eq(column, value)
        .maybeSingle();

      if (!error && data) {
        // Double cast: a select whose column list is a runtime variable gives
        // postgrest-js no literal to infer the row shape from, so it widens to
        // its error-string union. `PublicProfileRow` is the real shape.
        return mapPublicProfile(data as unknown as PublicProfileRow);
      }
      if (!isMissingColumnError(error)) {
        return null;
      }
    }

    return null;
  } catch {
    return null;
  }
}

/** Strip a leading `@` and surrounding whitespace from a routed handle. */
export function normalizeProfileHandle(value: string | null | undefined): string {
  return (value ?? '').trim().replace(/^@+/, '');
}

/**
 * Public profile by @handle. `handle` is `citext`, so the match is already
 * case-insensitive in Postgres — no client-side lowercasing needed. Returns null
 * when nobody owns the handle (or the owner isn't publicly visible).
 */
export async function fetchProfileByHandle(handle: string): Promise<UserProfile | null> {
  const normalized = normalizeProfileHandle(handle);
  if (!normalized) {
    return null;
  }
  return fetchPublicProfileBy('handle', normalized);
}

/**
 * Public profile by Supabase user id — the fallback lane for users who have not
 * claimed a handle, so every profile stays reachable.
 */
export async function fetchProfileById(userID: string): Promise<UserProfile | null> {
  const normalized = (userID ?? '').trim();
  if (!normalized) {
    return null;
  }
  return fetchPublicProfileBy('user_id', normalized);
}

// ---------------------------------------------------------------------------
// Follow graph (Phase 2b)
// ---------------------------------------------------------------------------
// All follow reads/writes go straight to the `follows` table under its RLS
// policies (public select; insert/delete only your own rows; can't follow someone
// who blocked you). The DB triggers keep follower_count / following_count on
// user_profiles correct — the client never touches those counters.

/**
 * The signed-in user's id, or null when unauthenticated / Supabase absent.
 * Prefers the locally persisted session over `auth.getUser()`, which costs an
 * auth-server round trip on every call (RLS still validates the JWT server-side).
 */
async function currentUserId(): Promise<string | null> {
  if (!supabase) {
    return null;
  }
  try {
    if (typeof supabase.auth.getSession === 'function') {
      const { data } = await supabase.auth.getSession();
      const sessionUserId = data?.session?.user?.id ?? null;
      if (sessionUserId) {
        return sessionUserId;
      }
    }
    const { data } = await supabase.auth.getUser();
    return data.user?.id ?? null;
  } catch {
    return null;
  }
}

/** Does the signed-in user follow `targetUserId`? False on any failure. */
export async function isFollowing(targetUserId: string): Promise<boolean> {
  const me = await currentUserId();
  if (!supabase || !me || !targetUserId || me === targetUserId) {
    return false;
  }
  try {
    const { data, error } = await supabase
      .from('follows')
      .select('followee_id')
      .eq('follower_id', me)
      .eq('followee_id', targetUserId)
      .maybeSingle();
    return !error && Boolean(data);
  } catch {
    return false;
  }
}

/**
 * Follow `targetUserId`. Idempotent (the row's PK is (follower,followee), so a
 * repeat insert is ignored). Returns true when the follow is in place afterward.
 * Throws nothing — the caller rolls back its optimistic count on a false return.
 */
export async function followUser(targetUserId: string): Promise<boolean> {
  const me = await currentUserId();
  if (!supabase || !me || !targetUserId || me === targetUserId) {
    return false;
  }
  try {
    const { error } = await supabase
      .from('follows')
      .upsert(
        { follower_id: me, followee_id: targetUserId },
        { onConflict: 'follower_id,followee_id', ignoreDuplicates: true },
      );
    return !error;
  } catch {
    return false;
  }
}

/** Unfollow `targetUserId`. Returns true when the row is gone afterward. */
export async function unfollowUser(targetUserId: string): Promise<boolean> {
  const me = await currentUserId();
  if (!supabase || !me || !targetUserId) {
    return false;
  }
  try {
    const { error } = await supabase
      .from('follows')
      .delete()
      .eq('follower_id', me)
      .eq('followee_id', targetUserId);
    return !error;
  } catch {
    return false;
  }
}

/**
 * Resolve a set of follow-edge rows into public profiles. Two steps rather than a
 * PostgREST embed: `follows` has FKs to `auth.users`, not to the `public_profiles`
 * view, so there is no auto-embeddable relationship. We read the id column from
 * `follows`, then hydrate through the same moderation-filtered view every other
 * profile read uses — so blocked/suspended users drop out of the list for free.
 */
async function fetchFollowList(
  filterColumn: 'follower_id' | 'followee_id',
  matchColumn: 'follower_id' | 'followee_id',
  userID: string,
  limit: number,
): Promise<UserProfile[]> {
  if (!supabase || !userID) {
    return [];
  }
  try {
    const { data: edges, error } = await supabase
      .from('follows')
      .select(matchColumn)
      .eq(filterColumn, userID)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error || !edges || edges.length === 0) {
      return [];
    }

    const ids = edges
      .map((row) => (row as Record<string, string>)[matchColumn])
      .filter((id): id is string => Boolean(id));
    if (ids.length === 0) {
      return [];
    }

    const { data: rows, error: profileError } = await supabase
      .from(PUBLIC_PROFILES_VIEW)
      .select(publicProfileSelect)
      .in('user_id', ids);
    if (profileError || !rows) {
      return [];
    }

    // Preserve the follow order (most-recent first); the `in` read comes back
    // unordered.
    const byId = new Map(rows.map((row) => [(row as PublicProfileRow).user_id, row as PublicProfileRow]));
    return ids
      .map((id) => byId.get(id))
      .filter((row): row is PublicProfileRow => Boolean(row))
      .map(mapPublicProfile);
  } catch {
    return [];
  }
}

/** Profiles that follow `userID` (their followers). */
export function fetchFollowers(userID: string, limit = 100): Promise<UserProfile[]> {
  return fetchFollowList('followee_id', 'follower_id', userID, limit);
}

/** Profiles that `userID` follows (their following). */
export function fetchFollowing(userID: string, limit = 100): Promise<UserProfile[]> {
  return fetchFollowList('follower_id', 'followee_id', userID, limit);
}

// ---------------------------------------------------------------------------
// People discovery (Phase 2c)
// ---------------------------------------------------------------------------

/**
 * Prefix-search public profiles by @handle or display name. Reads the
 * moderation-filtered view, so hidden users never surface. Returns [] for a blank
 * query or any failure. The query is sanitized to the handle/name character set
 * before it is interpolated into the PostgREST `or` filter, so it cannot break the
 * filter grammar.
 */
export async function searchUsers(query: string, limit = 20): Promise<UserProfile[]> {
  const cleaned = (query ?? '')
    .trim()
    .replace(/^@+/, '')
    // Keep only characters that appear in handles/names; this also neutralizes the
    // comma/paren/dot that PostgREST's or() grammar treats as syntax.
    .replace(/[^a-zA-Z0-9_ ]/g, '')
    .trim();
  if (!supabase || cleaned.length === 0) {
    return [];
  }

  try {
    const pattern = `${cleaned}%`;
    const { data, error } = await supabase
      .from(PUBLIC_PROFILES_VIEW)
      .select(publicProfileSelect)
      .or(`handle.ilike.${pattern},display_name.ilike.${pattern}`)
      .order('follower_count', { ascending: false })
      .limit(limit);
    if (error || !data) {
      return [];
    }
    return (data as PublicProfileRow[]).map(mapPublicProfile);
  } catch {
    return [];
  }
}
