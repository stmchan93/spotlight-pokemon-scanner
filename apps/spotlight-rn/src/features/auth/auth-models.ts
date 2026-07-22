export type AuthState = 'loading' | 'signedOut' | 'needsProfile' | 'signedIn';

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
};

export function normalizeDisplayName(value: string | null | undefined) {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
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
