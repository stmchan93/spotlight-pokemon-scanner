import type { UserProfile } from '@/features/auth/auth-models';
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
    const { data, error } = await supabase
      .from(PUBLIC_PROFILES_VIEW)
      .select(publicProfileSelect)
      .eq(column, value)
      .maybeSingle();

    if (error || !data) {
      return null;
    }

    return mapPublicProfile(data as PublicProfileRow);
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
