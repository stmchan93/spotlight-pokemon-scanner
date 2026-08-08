export type AuthState = 'loading' | 'signedOut' | 'needsProfile' | 'signedIn';

/**
 * Placeholder id for a guest who has NOT been given a Supabase user yet (guest
 * mode defers the mint to the first scan — every anonymous user is a billable
 * MAU). It is the same string on every device, so it must never be used as an
 * identity: analytics keyed on it would merge every pending guest into one
 * person. Lives here, not in the auth provider, so `@/lib/observability/posthog`
 * can guard against it without an import cycle.
 */
export const PENDING_GUEST_USER_ID = 'pending-guest';

export type UserProfile = {
  userID: string;
  displayName: string | null;
  avatarURL: string | null;
  labelerEnabled: boolean;
  adminEnabled: boolean;
  // Social profile fields (Supabase `user_profiles`, social migrations).
  // Optional so existing fixtures/callers don't all need updating; the auth
  // service populates them, consumers read with sensible defaults.
  handle?: string | null;
  bio?: string | null;
  location?: string | null;
  socialLink?: string | null;
  /** Wide banner behind the profile header (`user_profiles.cover_url`). */
  coverURL?: string | null;
  isVerified?: boolean;
  reputation?: number;
  followerCount?: number;
  followingCount?: number;
  postCount?: number;
};

export type AppUser = {
  id: string;
  email: string | null;
  displayName: string | null;
  avatarURL: string | null;
  providers: string[];
  labelerEnabled: boolean;
  adminEnabled: boolean;
  handle?: string | null;
  bio?: string | null;
  location?: string | null;
  socialLink?: string | null;
  coverURL?: string | null;
  isVerified?: boolean;
  reputation?: number;
  followerCount?: number;
  followingCount?: number;
  postCount?: number;
};

/** Fields the Edit Profile screen can write. */
export type ProfileUpdate = {
  displayName?: string | null;
  handle?: string | null;
  bio?: string | null;
  location?: string | null;
  socialLink?: string | null;
  avatarURL?: string | null;
  /**
   * Only send this key when the user actually picked a new cover. `updateProfile`
   * writes every key that is present, and `cover_url` is the newest column — an
   * unconditional `coverURL` on every save would fail the whole write on a
   * database that has not run the cover migration yet.
   */
  coverURL?: string | null;
};

export function normalizeDisplayName(value: string | null | undefined) {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export const HANDLE_MIN_LENGTH = 3;
export const HANDLE_MAX_LENGTH = 20;

/**
 * Fold what the user typed into a storable @handle: drop a leading `@`,
 * lowercase, keep only `[a-z0-9_]`, and cap the length. Safe to run on every
 * keystroke — it never rejects, it only narrows, so the field can't fight the
 * user mid-word.
 */
export function sanitizeHandleInput(value: string): string {
  return value
    .trim()
    .replace(/^@+/, '')
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '')
    .slice(0, HANDLE_MAX_LENGTH);
}

export type HandleValidity = 'empty' | 'too-short' | 'too-long' | 'bad-start' | 'ok';

/**
 * Validate an already-sanitized handle. `empty` is a legitimate state, not an
 * error: handles are optional, and profiles stay reachable by user id.
 */
export function validateHandle(value: string | null | undefined): HandleValidity {
  const handle = sanitizeHandleInput(value ?? '');
  if (handle.length === 0) {
    return 'empty';
  }
  if (handle.length < HANDLE_MIN_LENGTH) {
    return 'too-short';
  }
  if (handle.length > HANDLE_MAX_LENGTH) {
    return 'too-long';
  }
  // Leading underscores read as reserved/system names — require a letter or digit.
  if (!/^[a-z0-9]/.test(handle)) {
    return 'bad-start';
  }
  return 'ok';
}

/** User-facing explanation for a non-`ok` validity, or null when nothing is wrong. */
export function describeHandleValidity(validity: HandleValidity): string | null {
  switch (validity) {
    case 'too-short':
      return `At least ${HANDLE_MIN_LENGTH} characters.`;
    case 'too-long':
      return `At most ${HANDLE_MAX_LENGTH} characters.`;
    case 'bad-start':
      return 'Start with a letter or number.';
    default:
      return null;
  }
}

export function requiresProfileCompletion(user: AppUser) {
  return normalizeDisplayName(user.displayName) === null;
}

export function getResolvedDisplayName(user: AppUser) {
  const displayName = normalizeDisplayName(user.displayName);
  if (displayName) {
    return displayName;
  }

  const emailPrefix = user.email?.split('@')[0]?.trim();
  if (emailPrefix) {
    return emailPrefix;
  }

  return 'Collector';
}

export function getUserInitials(user: AppUser) {
  const words = getResolvedDisplayName(user)
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2);
  const letters = words.map((word) => word[0]?.toUpperCase() ?? '').filter(Boolean);

  if (letters.length === 0) {
    return 'C';
  }

  return letters.join('');
}
