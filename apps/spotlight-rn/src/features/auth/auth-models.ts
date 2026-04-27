export type AuthState = 'loading' | 'signedOut' | 'needsProfile' | 'signedIn';

export type UserProfile = {
  userID: string;
  displayName: string | null;
  avatarURL: string | null;
};

export type AppUser = {
  id: string;
  email: string | null;
  displayName: string | null;
  avatarURL: string | null;
  providers: string[];
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
