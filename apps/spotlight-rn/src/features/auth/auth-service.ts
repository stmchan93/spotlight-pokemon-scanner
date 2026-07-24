import * as Linking from 'expo-linking';
import type { Session, User } from '@supabase/supabase-js';
import { sha256 } from 'js-sha256';

import {
  type AppUser,
  type ProfileUpdate,
  type UserProfile,
  normalizeDisplayName,
  requiresProfileCompletion,
} from './auth-models';
import {
  supabase,
  supabaseAuthConfig,
} from '@/lib/supabase';

type AppleAuthModule = typeof import('expo-apple-authentication');
type WebBrowserModule = typeof import('expo-web-browser');

let appleAuthenticationModule: AppleAuthModule | null = null;
let webBrowserModule: WebBrowserModule | null = null;

try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  appleAuthenticationModule = require('expo-apple-authentication') as AppleAuthModule;
} catch {
  appleAuthenticationModule = null;
}

try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  webBrowserModule = require('expo-web-browser') as WebBrowserModule;
} catch {
  webBrowserModule = null;
}

type UserProfileRow = {
  avatar_url: string | null;
  admin_enabled?: boolean | null;
  display_name: string | null;
  labeler_enabled?: boolean | null;
  user_id: string;
  handle?: string | null;
  bio?: string | null;
  location?: string | null;
  social_link?: string | null;
  is_verified?: boolean | null;
  reputation?: number | null;
  follower_count?: number | null;
  following_count?: number | null;
  post_count?: number | null;
};

const profileSelectBase = 'user_id, display_name, avatar_url';
const profileSelectWithCapabilities = `${profileSelectBase}, labeler_enabled, admin_enabled`;
// Full social profile row. Falls back to the narrower selects when the social
// columns aren't present yet (older env / migration not applied), so a missing
// column never nulls out the whole profile.
const profileSelectFull =
  `${profileSelectWithCapabilities}, handle, bio, location, social_link, is_verified, reputation, follower_count, following_count, post_count`;

export class AuthCanceledError extends Error {
  constructor(message = 'Authentication was canceled.') {
    super(message);
    this.name = 'AuthCanceledError';
  }
}

function fallbackDisplayName(user: User) {
  const metadata = user.user_metadata ?? {};
  const metadataKeys = [
    'display_name',
    'full_name',
    'name',
    'preferred_username',
    'user_name',
    'given_name',
  ];

  for (const key of metadataKeys) {
    const value = metadata[key];
    if (typeof value === 'string' && normalizeDisplayName(value)) {
      return normalizeDisplayName(value);
    }
  }

  const emailPrefix = user.email?.split('@')[0]?.trim();
  return emailPrefix ? emailPrefix : null;
}

function fallbackAvatarURL(user: User) {
  const metadata = user.user_metadata ?? {};
  const metadataKeys = ['avatar_url', 'picture'];

  for (const key of metadataKeys) {
    const value = metadata[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }

  return null;
}

function formatAppleFullName(fullName: {
  familyName?: string | null;
  givenName?: string | null;
} | null) {
  if (!fullName) {
    return null;
  }

  return normalizeDisplayName(
    [fullName.givenName, fullName.familyName].filter(Boolean).join(' '),
  );
}

function dedupeProviders(user: User) {
  return [...new Set(
    (user.identities ?? [])
      .map((identity) => identity.provider)
      .filter((provider): provider is string => typeof provider === 'string' && provider.length > 0),
  )];
}

function mapUserProfile(row: UserProfileRow): UserProfile {
  return {
    adminEnabled: row.admin_enabled === true,
    avatarURL: row.avatar_url,
    displayName: row.display_name,
    labelerEnabled: row.labeler_enabled === true,
    userID: row.user_id,
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

function randomNonce(length = 32) {
  const cryptoObject = globalThis.crypto as Crypto | undefined;
  const bytes = new Uint8Array(length);

  if (cryptoObject?.getRandomValues) {
    cryptoObject.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }

  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function parseCallbackParams(url: string) {
  const parsedURL = new URL(url);
  const params = new URLSearchParams(parsedURL.search);
  const fragment = parsedURL.hash.startsWith('#') ? parsedURL.hash.slice(1) : parsedURL.hash;

  if (fragment) {
    const fragmentParams = new URLSearchParams(fragment);
    fragmentParams.forEach((value, key) => {
      if (!params.has(key)) {
        params.set(key, value);
      }
    });
  }

  return params;
}

async function syncUserMetadata(displayName: string, avatarURL: string | null) {
  if (!supabase) {
    return;
  }

  const data: Record<string, string> = {
    display_name: displayName,
  };

  if (avatarURL) {
    data.avatar_url = avatarURL;
  }

  await supabase.auth.updateUser({
    data,
  });
}

export function isAuthCanceledError(error: unknown) {
  return error instanceof AuthCanceledError;
}

export async function checkAppleSignInAvailability() {
  if (!appleAuthenticationModule) {
    return false;
  }

  try {
    return await appleAuthenticationModule.isAvailableAsync();
  } catch {
    return false;
  }
}

export async function fetchProfile(userID: string) {
  if (!supabase) {
    return null;
  }

  try {
    const { data, error } = await supabase
      .from('user_profiles')
      .select(profileSelectFull)
      .eq('user_id', userID)
      .single();

    if (!error && data) {
      return mapUserProfile(data as UserProfileRow);
    }

    const fallback = await supabase
      .from('user_profiles')
      .select(profileSelectBase)
      .eq('user_id', userID)
      .single();

    if (fallback.error || !fallback.data) {
      return null;
    }

    return mapUserProfile(fallback.data as UserProfileRow);
  } catch {
    return null;
  }
}

async function fetchProfileWithTimeout(userID: string, timeoutMs = 2000) {
  return Promise.race<UserProfile | null>([
    fetchProfile(userID),
    new Promise<null>((resolve) => {
      setTimeout(() => resolve(null), timeoutMs);
    }),
  ]);
}

export async function upsertProfile(
  userID: string,
  displayName: string,
  avatarURL: string | null,
) {
  const normalizedDisplayName = normalizeDisplayName(displayName) ?? displayName;
  const profile: UserProfile = {
    adminEnabled: false,
    avatarURL,
    displayName: normalizedDisplayName,
    labelerEnabled: false,
    userID,
    handle: null,
    bio: null,
    location: null,
    socialLink: null,
    isVerified: false,
    reputation: 0,
    followerCount: 0,
    followingCount: 0,
    postCount: 0,
  };

  if (!supabase) {
    return profile;
  }

  try {
    await syncUserMetadata(normalizedDisplayName, avatarURL);
    const { data } = await supabase
      .from('user_profiles')
      .upsert({
        avatar_url: avatarURL,
        display_name: normalizedDisplayName,
        user_id: userID,
      }, {
        onConflict: 'user_id',
      })
      .select(profileSelectBase)
      .single();

    if (data) {
      return await fetchProfile(userID) ?? mapUserProfile(data as UserProfileRow);
    }
  } catch (error) {
    console.warn('[AUTH] Failed to upsert user profile.', error);
  }

  return profile;
}

export async function resolveAppUserFromSession(session: Session): Promise<AppUser> {
  const authUser = session.user;
  const profile = await fetchProfileWithTimeout(authUser.id);
  const displayName = normalizeDisplayName(profile?.displayName) ?? fallbackDisplayName(authUser);
  const avatarURL = profile?.avatarURL ?? fallbackAvatarURL(authUser);

  return {
    adminEnabled: profile?.adminEnabled ?? false,
    avatarURL,
    displayName,
    email: authUser.email ?? null,
    id: authUser.id,
    labelerEnabled: profile?.labelerEnabled ?? false,
    providers: dedupeProviders(authUser),
    handle: profile?.handle ?? null,
    bio: profile?.bio ?? null,
    location: profile?.location ?? null,
    socialLink: profile?.socialLink ?? null,
    isVerified: profile?.isVerified ?? false,
    reputation: profile?.reputation ?? 0,
    followerCount: profile?.followerCount ?? 0,
    followingCount: profile?.followingCount ?? 0,
    postCount: profile?.postCount ?? 0,
  };
}

/** Postgres unique-violation, raised by `uq_user_profiles_handle`. */
const PG_UNIQUE_VIOLATION = '23505';

/**
 * Thrown when a profile write is rejected for a reason the user can fix, so the
 * screen can say which field is wrong instead of a generic failure.
 */
export type ProfileUpdateErrorCode = 'handle-taken' | 'save-failed';

export class ProfileUpdateError extends Error {
  readonly code: ProfileUpdateErrorCode;

  constructor(code: ProfileUpdateErrorCode, message: string) {
    super(message);
    this.name = 'ProfileUpdateError';
    this.code = code;
  }
}

/**
 * Is this @handle free? True when nothing owns it, or when the caller already
 * does. `handle` is `citext`, so the match is case-insensitive in the DB.
 *
 * Reads `public_profiles`, not `user_profiles`: the base table is self-read-only,
 * so querying it would report every other user's handle as free.
 *
 * Advisory only. `uq_user_profiles_handle` is the real enforcement, and the view
 * hides suspended/shadowbanned users — so a handle held by one of them reads as
 * available here and is rejected at save time. Never treat a `true` from this as
 * permission to skip handling a save-time conflict.
 */
export async function isHandleAvailable(handle: string, userID: string): Promise<boolean> {
  if (!supabase || !handle) {
    return false;
  }

  try {
    const { data, error } = await supabase
      .from('public_profiles')
      .select('user_id')
      .eq('handle', handle)
      .maybeSingle();
    if (error) {
      return false;
    }
    return !data || data.user_id === userID;
  } catch {
    return false;
  }
}

/**
 * Write the Edit Profile fields to `user_profiles` (only the keys provided).
 * Returns the refetched full profile so callers can update UI, or null off
 * Supabase / on failure.
 *
 * Throws `ProfileUpdateError` when the write is rejected for a user-fixable
 * reason (a taken handle) — those must not silently no-op.
 */
export async function updateProfile(
  userID: string,
  patch: ProfileUpdate,
): Promise<UserProfile | null> {
  if (!supabase) {
    return null;
  }

  const row: Record<string, string | null> = { user_id: userID };
  if (patch.displayName !== undefined) {
    row.display_name = normalizeDisplayName(patch.displayName) ?? patch.displayName;
  }
  if (patch.handle !== undefined) row.handle = patch.handle;
  if (patch.bio !== undefined) row.bio = patch.bio;
  if (patch.location !== undefined) row.location = patch.location;
  if (patch.socialLink !== undefined) row.social_link = patch.socialLink;
  if (patch.avatarURL !== undefined) row.avatar_url = patch.avatarURL;

  try {
    if (row.display_name || patch.avatarURL !== undefined) {
      await syncUserMetadata(
        String(row.display_name ?? ''),
        patch.avatarURL ?? null,
      );
    }
    const { error } = await supabase.from('user_profiles').upsert(row, { onConflict: 'user_id' });
    if (error) {
      // A racing claim (or a stale availability read) lands here — the unique
      // index is the only authority on who owns a handle.
      if (error.code === PG_UNIQUE_VIOLATION && row.handle) {
        throw new ProfileUpdateError('handle-taken', 'That handle is already taken.');
      }
      throw error;
    }
  } catch (error) {
    if (error instanceof ProfileUpdateError) {
      throw error;
    }
    // Real write failures used to be swallowed here (warn + return null), so the
    // Edit Profile screen closed as though the save landed. That silence is what
    // hid missing columns on an unmigrated database. Log for the console, then
    // rethrow so the caller can tell the user the save did not happen.
    console.warn('[AUTH] Failed to update user profile.', error);
    throw new ProfileUpdateError('save-failed', 'Could not save your profile.');
  }

  // The write landed. The refresh read is best-effort — if it blips, the caller
  // falls back to the session, and we must NOT report a save failure for a save
  // that succeeded.
  try {
    return await fetchProfile(userID);
  } catch {
    return null;
  }
}

export async function bootstrapProfileIfNeeded(
  user: User,
  preferredDisplayName: string | null,
  preferredAvatarURL: string | null = null,
) {
  const displayName = normalizeDisplayName(preferredDisplayName) ?? fallbackDisplayName(user);
  const avatarURL = preferredAvatarURL ?? fallbackAvatarURL(user);

  if (!displayName) {
    return null;
  }

  return upsertProfile(user.id, displayName, avatarURL);
}

export async function restoreSessionFromUrl(url: string) {
  if (!supabase) {
    return null;
  }

  const params = parseCallbackParams(url);
  const errorCode = params.get('error_code');
  const errorDescription = params.get('error_description');
  if (errorCode) {
    throw new Error(errorDescription ?? errorCode);
  }

  const accessToken = params.get('access_token');
  const refreshToken = params.get('refresh_token');
  const authCode = params.get('code');

  if (accessToken && refreshToken) {
    const { data, error } = await supabase.auth.setSession({
      access_token: accessToken,
      refresh_token: refreshToken,
    });

    if (error) {
      throw error;
    }

    return data.session;
  }

  if (!authCode) {
    return null;
  }

  const { data, error } = await supabase.auth.exchangeCodeForSession(authCode);
  if (error) {
    throw error;
  }

  return data.session;
}

export async function signInWithGoogle() {
  if (!supabase) {
    throw new Error(supabaseAuthConfig.configurationIssue ?? 'Supabase Auth is not configured.');
  }
  if (!webBrowserModule) {
    throw new Error('Google sign-in is unavailable in the current app build.');
  }

  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo: supabaseAuthConfig.redirectURL,
      skipBrowserRedirect: true,
    },
  });

  if (error) {
    throw error;
  }

  const authURL = data?.url ?? '';
  if (!authURL) {
    throw new Error('Google sign-in could not be started.');
  }

  const result = await webBrowserModule.openAuthSessionAsync(authURL, supabaseAuthConfig.redirectURL);

  if (result.type === 'cancel' || result.type === 'dismiss') {
    throw new AuthCanceledError();
  }

  if (result.type !== 'success') {
    if (result.type === 'opened') {
      await Linking.openURL(authURL);
      return null;
    }

    throw new Error('Google sign-in could not be completed.');
  }

  return restoreSessionFromUrl(result.url);
}

export async function signInWithApple() {
  if (!supabase) {
    throw new Error(supabaseAuthConfig.configurationIssue ?? 'Supabase Auth is not configured.');
  }
  if (!appleAuthenticationModule) {
    throw new Error('Apple sign-in is unavailable in the current app build.');
  }

  try {
    const nonce = randomNonce();
    const hashedNonce = sha256(nonce);
    const credential = await appleAuthenticationModule.signInAsync({
      nonce: hashedNonce,
      requestedScopes: [
        appleAuthenticationModule.AppleAuthenticationScope.FULL_NAME,
        appleAuthenticationModule.AppleAuthenticationScope.EMAIL,
      ],
    });

    if (!credential.identityToken) {
      throw new Error('Apple sign-in did not return a valid identity token.');
    }

    const { data, error } = await supabase.auth.signInWithIdToken({
      provider: 'apple',
      token: credential.identityToken,
      access_token: credential.authorizationCode ?? undefined,
      nonce,
    });

    if (error) {
      throw error;
    }

    if (!data.session) {
      throw new Error('Apple sign-in did not create a session.');
    }

    await bootstrapProfileIfNeeded(
      data.session.user,
      formatAppleFullName(credential.fullName),
      null,
    );

    return data.session;
  } catch (error) {
    if (
      typeof error === 'object'
      && error !== null
      && 'code' in error
      && (error as { code?: string }).code === 'ERR_REQUEST_CANCELED'
    ) {
      throw new AuthCanceledError();
    }

    throw error;
  }
}

export async function checkEmailExists(email: string): Promise<boolean> {
  if (!supabase) {
    throw new Error(supabaseAuthConfig.configurationIssue ?? 'Supabase Auth is not configured.');
  }

  const { data, error } = await supabase.rpc('email_exists', { p_email: email.trim() });
  if (error) {
    throw error;
  }

  return data === true;
}

export async function signUpWithEmail({
  email,
  password,
  fullName,
}: {
  email: string;
  password: string;
  fullName: string;
}): Promise<{ needsCode: boolean; session: Session | null }> {
  if (!supabase) {
    throw new Error(supabaseAuthConfig.configurationIssue ?? 'Supabase Auth is not configured.');
  }

  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: {
        display_name: normalizeDisplayName(fullName) ?? fullName,
      },
    },
  });

  if (error) {
    throw error;
  }

  return {
    needsCode: data.session == null,
    session: data.session,
  };
}

// Supabase returns ONE generic "invalid credentials" error for a non-existent
// email, a deleted account (we hard-delete the auth user on account deletion —
// see backend `_delete_supabase_auth_user`), AND a wrong password; it doesn't
// distinguish them (anti-enumeration).
function isInvalidCredentialsError(error: unknown): boolean {
  const candidate = error as { message?: unknown; code?: unknown } | null;
  const message = String(candidate?.message ?? '').toLowerCase();
  const code = String(candidate?.code ?? '').toLowerCase();
  return (
    code === 'invalid_credentials'
    || code === 'user_not_found'
    || message.includes('invalid login credentials')
    || message.includes('user not found')
  );
}

export async function signInWithEmailPassword({
  email,
  password,
}: {
  email: string;
  password: string;
}): Promise<Session> {
  if (!supabase) {
    throw new Error(supabaseAuthConfig.configurationIssue ?? 'Supabase Auth is not configured.');
  }

  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });

  if (error) {
    // Supabase can't tell "no such account" from "wrong password". When it
    // rejects the credentials, ask the `email_exists` RPC whether the account is
    // actually there — only claim it's missing when it truly is, so a mistyped
    // password on a real account still shows the generic credentials error. If
    // the existence check itself fails, assume the account exists (never falsely
    // tell a real user their account is gone).
    if (isInvalidCredentialsError(error)) {
      const accountExists = await checkEmailExists(email).catch(() => true);
      if (!accountExists) {
        throw new Error('This account does not exist.');
      }
    }
    throw error;
  }

  if (!data.session) {
    throw new Error('Sign-in did not create a session.');
  }

  return data.session;
}

export async function verifySignupCode({
  email,
  code,
  fullName,
}: {
  email: string;
  code: string;
  fullName?: string;
}): Promise<Session> {
  if (!supabase) {
    throw new Error(supabaseAuthConfig.configurationIssue ?? 'Supabase Auth is not configured.');
  }

  const { data, error } = await supabase.auth.verifyOtp({
    email,
    token: code.trim(),
    type: 'signup',
  });

  if (error) {
    throw error;
  }

  if (!data.session) {
    throw new Error('Verification did not create a session.');
  }

  await bootstrapProfileIfNeeded(data.session.user, fullName ?? null);

  return data.session;
}

export async function resendSignupCode(email: string): Promise<void> {
  if (!supabase) {
    throw new Error(supabaseAuthConfig.configurationIssue ?? 'Supabase Auth is not configured.');
  }

  const { error } = await supabase.auth.resend({
    type: 'signup',
    email,
  });

  if (error) {
    throw error;
  }
}

export async function sendPasswordReset(email: string): Promise<void> {
  if (!supabase) {
    throw new Error(supabaseAuthConfig.configurationIssue ?? 'Supabase Auth is not configured.');
  }

  const { error } = await supabase.auth.resetPasswordForEmail(email.trim());

  if (error) {
    throw error;
  }
}

export async function verifyRecoveryCode({
  email,
  code,
}: {
  email: string;
  code: string;
}): Promise<Session> {
  if (!supabase) {
    throw new Error(supabaseAuthConfig.configurationIssue ?? 'Supabase Auth is not configured.');
  }

  const { data, error } = await supabase.auth.verifyOtp({
    email,
    token: code.trim(),
    type: 'recovery',
  });

  if (error) {
    throw error;
  }

  if (!data.session) {
    throw new Error('Recovery verification did not create a session.');
  }

  return data.session;
}

export async function updatePassword(
  newPassword: string,
  options?: { currentPassword?: string },
): Promise<void> {
  if (!supabase) {
    throw new Error(supabaseAuthConfig.configurationIssue ?? 'Supabase Auth is not configured.');
  }

  // When a `currentPassword` is supplied (the in-app "Change password" flow for a
  // signed-in user), re-verify it before mutating the password. Supabase's
  // `updateUser({ password })` changes the password on the live session without
  // re-authenticating, so this is the only place the old password can be checked.
  // The recovery flow (signed-out reset) intentionally omits `currentPassword`
  // because the user has forgotten it and proved identity via the email code.
  const currentPassword = options?.currentPassword?.trim();
  if (currentPassword) {
    const { data: sessionData } = await supabase.auth.getSession();
    const email = sessionData.session?.user?.email?.trim();
    if (!email) {
      throw new Error('You must be signed in to change your password.');
    }

    const { error: verifyError } = await supabase.auth.signInWithPassword({
      email,
      password: currentPassword,
    });
    if (verifyError) {
      throw new Error('Your current password is incorrect.');
    }
  }

  const { error } = await supabase.auth.updateUser({
    password: newPassword,
  });

  if (error) {
    throw error;
  }
}

export async function signOut() {
  if (!supabase) {
    return;
  }

  await supabase.auth.signOut();
}

/**
 * Anonymous ("guest") sign-in for the first-launch scanner. Returns a real
 * Supabase session whose `user.is_anonymous === true`; its JWT authenticates
 * the backend scan/match + card-detail endpoints exactly like a real account,
 * so no backend changes are needed. Requires "Allow anonymous sign-ins" to be
 * enabled in the Supabase dashboard — throws if the project has it off, so
 * callers must fall back to the normal login screen on error.
 */
export async function signInAnonymously(): Promise<Session> {
  if (!supabase) {
    throw new Error(supabaseAuthConfig.configurationIssue ?? 'Supabase Auth is not configured.');
  }

  const { data, error } = await supabase.auth.signInAnonymously();
  if (error) {
    throw error;
  }

  if (!data.session) {
    throw new Error('Anonymous sign-in did not create a session.');
  }

  return data.session;
}

/** True when the session is a guest (Supabase anonymous user). */
export function isAnonymousSession(session: Session | null): boolean {
  return session?.user.is_anonymous === true;
}

export async function getCurrentSession() {
  if (!supabase) {
    return null;
  }

  const { data, error } = await supabase.auth.getSession();
  if (error) {
    throw error;
  }

  return data.session;
}

export function getConfigurationIssue() {
  return supabaseAuthConfig.configurationIssue;
}

export function getIsConfigured() {
  return supabaseAuthConfig.isConfigured;
}

export function getAccessToken(session: Session | null) {
  return session?.access_token ?? null;
}

export function getNeedsProfile(user: AppUser | null) {
  return user ? requiresProfileCompletion(user) : false;
}
