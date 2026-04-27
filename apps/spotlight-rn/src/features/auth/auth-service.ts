import * as Linking from 'expo-linking';
import type { Session, User } from '@supabase/supabase-js';
import { sha256 } from 'js-sha256';

import {
  type AppUser,
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
  display_name: string | null;
  user_id: string;
};

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
    avatarURL: row.avatar_url,
    displayName: row.display_name,
    userID: row.user_id,
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
      .select('user_id, display_name, avatar_url')
      .eq('user_id', userID)
      .single();

    if (error || !data) {
      return null;
    }

    return mapUserProfile(data as UserProfileRow);
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
    avatarURL,
    displayName: normalizedDisplayName,
    userID,
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
      .select('user_id, display_name, avatar_url')
      .single();

    if (data) {
      return mapUserProfile(data as UserProfileRow);
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
    avatarURL,
    displayName,
    email: authUser.email ?? null,
    id: authUser.id,
    providers: dedupeProviders(authUser),
  };
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

export async function signOut() {
  if (!supabase) {
    return;
  }

  await supabase.auth.signOut();
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
