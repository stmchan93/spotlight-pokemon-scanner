import { createContext, type PropsWithChildren, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import * as Linking from 'expo-linking';
import type { Session } from '@supabase/supabase-js';

import type { AppUser, AuthState } from '@/features/auth/auth-models';
import {
  AuthCanceledError,
  bootstrapProfileIfNeeded,
  checkAppleSignInAvailability,
  checkEmailExists,
  convertAnonymousUserToEmailAccount,
  getAccessToken,
  getCurrentSession,
  getConfigurationIssue,
  getIsConfigured,
  getNeedsProfile,
  isAnonymousSession,
  isAuthCanceledError,
  linkAppleIdentityToCurrentUser,
  linkOAuthIdentityToCurrentUser,
  resendSignupCode,
  resolveAppUserFromSession,
  restoreSessionFromUrl,
  sendPasswordReset,
  signInAnonymously,
  signInWithApple,
  signInWithEmailPassword,
  signInWithGoogle,
  signOut,
  signUpWithEmail,
  updatePassword as updatePasswordService,
  updateProfile as updateProfileService,
  upsertProfile,
  verifyAnonymousEmailConversion,
  verifyRecoveryCode,
  verifySignupCode,
} from '@/features/auth/auth-service';
import {
  PENDING_GUEST_USER_ID,
  getResolvedDisplayName,
  type ProfileUpdate,
} from '@/features/auth/auth-models';
import { hasEverSignedIn, markHasSignedIn } from '@/features/auth/guest-first-launch';
import { capturePostHogEvent } from '@/lib/observability/posthog';
import { resolveRuntimeBoolean } from '@/lib/runtime-config';
import { supabase } from '@/lib/supabase';

type EmailAuthActions = {
  checkEmail: (email: string) => Promise<boolean>;
  signUpEmail: (input: { email: string; password: string; fullName: string }) => Promise<{ needsCode: boolean }>;
  signInEmail: (input: { email: string; password: string }) => Promise<void>;
  /**
   * Finish an email signup. `password` is required only on the GUEST path:
   * converting an anonymous user sets the password after the emailed code
   * proves the address (a plain signup already carried it), so the stepper
   * passes the same draft password it used on the signup step.
   */
  verifyCode: (input: { email: string; code: string; fullName: string; password?: string }) => Promise<void>;
  resendCode: (email: string) => Promise<void>;
  sendReset: (email: string) => Promise<void>;
  verifyResetCode: (input: { email: string; code: string }) => Promise<void>;
  updatePassword: (newPassword: string, currentPassword?: string) => Promise<void>;
  /** Clear the shared auth error (e.g. when moving between auth steps) so one
   * screen's failure doesn't follow the user onto the next. */
  clearError: () => void;
};

type AuthContextValue = EmailAuthActions & {
  accessToken: string | null;
  appleSignInAvailable: boolean;
  configurationIssue: string | null;
  currentSession: Session | null;
  currentUser: AppUser | null;
  /**
   * Mint the guest's Supabase session if it hasn't been minted yet, and resolve
   * once the app is holding a usable access token. No-op (returns the existing
   * session) for anyone who already has one.
   *
   * Call this — and await it — immediately before the FIRST action that needs a
   * server identity (dispatching a scan, any authed backend write). Do not call
   * it on app open, on navigation, or on browsing: each anonymous user Supabase
   * mints is a billable Monthly Active User.
   *
   * Resolves to null when the mint fails (anonymous sign-ins disabled, offline);
   * the caller should surface its own "couldn't reach the server" state rather
   * than throwing the user out of guest mode.
   */
  ensureGuestSession: () => Promise<Session | null>;
  errorMessage: string | null;
  /**
   * Live read of the current access token. Unlike `accessToken` (a render
   * snapshot) this is updated SYNCHRONOUSLY the moment a session lands, so a
   * request dispatched by a closure created before the guest mint still goes
   * out authenticated. The repository calls it per request.
   */
  getAccessToken: () => string | null;
  /**
   * Move the signed-in user's OWN `followingCount` by `delta`, locally.
   *
   * Following someone writes a `follows` row and a `SECURITY DEFINER` trigger
   * updates BOTH profiles' counters — verified correct in the database. But the
   * viewer's own count is rendered from `currentUser`, which is loaded at
   * sign-in and never re-read, so the number they were just looking at did not
   * move while the person they followed visibly gained a follower.
   *
   * A local delta rather than a refetch, deliberately: the outcome of your own
   * tap is already known, and a round trip to be told what you just did is both
   * slower and able to fail. The server remains the source of truth — the next
   * profile load overwrites this — so a lost race self-corrects rather than
   * compounding.
   *
   * Clamped at 0. Callers MUST revert on a failed write (pass the negated delta).
   */
  applyFollowingDelta: (delta: number) => void;
  /** True while the active session is a guest (Supabase anonymous user). */
  isGuest: boolean;
  isBusy: boolean;
  isConfigured: boolean;
  profileDraftName: string;
  setProfileDraftName: (value: string) => void;
  signInWithApple: () => Promise<void>;
  signInWithGoogle: () => Promise<void>;
  signOut: () => Promise<void>;
  state: AuthState;
  submitProfile: () => Promise<void>;
  /** Persist Edit Profile fields, then refresh the current user. */
  updateProfile: (patch: ProfileUpdate) => Promise<void>;
};

export type { EmailAuthActions };

const testUser: AppUser = {
  adminEnabled: false,
  avatarURL: null,
  displayName: 'UI Test User',
  email: 'ui-tests@spotlight.local',
  id: '00000000-0000-0000-0000-000000000001',
  labelerEnabled: true,
  providers: ['ui-tests'],
};

const shouldBypassAuthForTests = process.env.NODE_ENV === 'test';

/**
 * Defer minting the guest's Supabase anonymous user until the first action that
 * actually needs a server identity, instead of minting it on first launch.
 *
 * WHY: Supabase bills per Monthly Active User and an anonymous user counts as
 * one. Minting on app open bills every install that merely opens the app; worse,
 * a guest whose refresh token lapses comes back as a NEW anonymous user (the
 * has-signed-in flag never flips for a guest), i.e. another MAU and another
 * orphaned `owner_user_id` on the backend.
 *
 * ON (default since 2026-08-06): first launch enters guest mode with NO Supabase
 * user; the app is fully usable for browsing, and `ensureGuestSession()` mints on
 * demand — today only from the scanner's `handleCapture`, the first action that
 * genuinely needs a server identity.
 *
 * OFF (emergency rollback only, `EXPO_PUBLIC_SPOTLIGHT_DEFER_GUEST_SESSION=0`
 * or the `spotlightDeferGuestSession` Expo extra): restores the eager mint at
 * launch, which bills a MAU for every app open of a fresh install. Ship this
 * only to unblock a guest-mode outage. See
 * docs/guest-mode-first-launch-plan-2026-07-02.md.
 */
const shouldDeferGuestSessionMint = resolveRuntimeBoolean(
  ['EXPO_PUBLIC_SPOTLIGHT_DEFER_GUEST_SESSION'],
  ['spotlightDeferGuestSession'],
  true,
);

export { PENDING_GUEST_USER_ID };

/** Owner key used while nobody is signed in and guest mode is not running. */
const SIGNED_OUT_OWNER_KEY = 'signed-out';

/**
 * React key that keeps ONE provider tree across the whole guest experience.
 * Minting mid-scan changes the owner key (`pending-guest` → the anonymous uuid);
 * without this the tree would remount and throw the in-flight capture away.
 */
const GUEST_PROVIDER_KEY = 'guest';

/**
 * Owner key for PERSISTED account data (AsyncStorage caches, persisted
 * dashboard, active collection). Always the real Supabase uuid when there is a
 * session, so two accounts can never read each other's data.
 */
export function resolveSessionOwnerKey(
  sessionUserID: string | null | undefined,
  isGuest: boolean,
): string {
  if (sessionUserID) {
    return sessionUserID;
  }
  return isGuest ? PENDING_GUEST_USER_ID : SIGNED_OUT_OWNER_KEY;
}

/**
 * React key for the provider tree — deliberately COARSER than the owner key.
 *
 * The only transition it collapses is pending-guest → the anonymous user that
 * guest just minted, which happens mid-capture and must not remount the app. A
 * pending guest has never held a token, so it owns no data that could survive
 * into the minted session; and isolation does not depend on this key anyway —
 * `AppProviders` scopes every cache (in memory and on disk) by the owner key it
 * is PASSED, which stays the exact uuid. Every account boundary that matters
 * (guest → real account, account A → account B, sign-out) still changes this
 * key and still remounts.
 */
export function resolveProviderRemountKey(sessionOwnerKey: string, isGuest: boolean): string {
  return isGuest ? GUEST_PROVIDER_KEY : sessionOwnerKey;
}

const AuthContext = createContext<AuthContextValue | null>(null);

// An expired/invalid refresh token (or a missing session) just means the user
// needs to sign in again — that's normal, not an error. Surfacing Supabase's
// raw "refresh token expired" / "Auth session missing" text as a red banner on
// the sign-in screen is alarming and pointless, so we swallow it.
function isExpectedSessionEndError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const text = `${error.name} ${error.message}`.toLowerCase();
  return (
    text.includes('refresh token')
    || text.includes('refresh_token')
    || text.includes('session missing')
    || text.includes('session_not_found')
    || text.includes('session expired')
  );
}

// gotrue-js throws `AuthRetryableFetchError` when the HTTP request itself dies
// (offline, DNS blip, VPN hiccup) — and that error often carries an EMPTY
// message. Before this check it fell through to the opaque "Authentication
// failed." fallback, which reads like wrong credentials and made a signup on a
// flaky connection look like an account problem.
function isTransportError(error: Error): boolean {
  const name = error.name.toLowerCase();
  const message = error.message.toLowerCase();
  return (
    name.includes('retryable')
    || message === 'failed to fetch'
    || message.includes('network request failed')
    || message.includes('network error')
  );
}

function errorMessageFromUnknown(error: unknown) {
  if (error instanceof AuthCanceledError || isAuthCanceledError(error)) {
    return null;
  }

  if (isExpectedSessionEndError(error)) {
    return null;
  }

  if (error instanceof Error) {
    if (isTransportError(error)) {
      return "Couldn't reach the server. Check your connection and try again.";
    }
    if (error.message) {
      return error.message;
    }
  }

  return 'Something went wrong. Please try again.';
}

function authReasonClassFromUnknown(error: unknown) {
  if (error instanceof AuthCanceledError || isAuthCanceledError(error)) {
    return null;
  }

  if (error instanceof Error) {
    return error.name || error.constructor.name || 'Error';
  }

  if (typeof error === 'object' && error && 'constructor' in error) {
    const constructorName = (error as { constructor?: { name?: unknown } }).constructor?.name;
    if (typeof constructorName === 'string' && constructorName.length > 0) {
      return constructorName;
    }
  }

  return 'UnknownError';
}

function captureAuthSignInSucceeded(provider: 'apple' | 'google' | 'email') {
  capturePostHogEvent('auth_sign_in_succeeded', {
    provider,
  });
}

function captureAuthSignInFailed(provider: 'apple' | 'google' | 'email', error: unknown) {
  const reasonClass = authReasonClassFromUnknown(error);
  if (!reasonClass) {
    return;
  }

  capturePostHogEvent('auth_sign_in_failed', {
    provider,
    reason_class: reasonClass,
  });
}

function captureProfileCompleted() {
  capturePostHogEvent('profile_completed');
}

// Synthetic AppUser for a guest (anonymous) session — no profile fetch, no
// display-name requirement (a guest has no name source and would otherwise be
// trapped on the profile-completion screen).
function guestAppUser(session: Session | null): AppUser {
  return {
    id: session?.user.id ?? PENDING_GUEST_USER_ID,
    email: null,
    displayName: 'Guest',
    avatarURL: null,
    providers: [],
    labelerEnabled: false,
    adminEnabled: false,
  };
}

export function AuthProvider({ children }: PropsWithChildren) {
  const [state, setState] = useState<AuthState>(shouldBypassAuthForTests ? 'signedIn' : 'loading');
  const [currentUser, setCurrentUser] = useState<AppUser | null>(shouldBypassAuthForTests ? testUser : null);
  const [currentSession, setCurrentSession] = useState<Session | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [profileDraftName, setProfileDraftName] = useState(shouldBypassAuthForTests ? getResolvedDisplayName(testUser) : '');
  const [appleSignInAvailable, setAppleSignInAvailable] = useState(false);
  // While a password reset is mid-flight the recovery `verifyOtp` hands us a
  // live session before the user has set a new password; hold them in the
  // signed-out reset flow until `updatePassword` finishes rather than letting
  // the auth listener flip the app to signedIn.
  const recoveryInProgressRef = useRef(false);
  // A guest we are deliberately NOT paying for yet: guest mode is live in the UI
  // but no Supabase anonymous user has been minted. Ref-mirrored because
  // `updateFromSession` is a stable callback that must see the current value.
  const [isPendingGuest, setIsPendingGuest] = useState(false);
  const isPendingGuestRef = useRef(false);
  const guestMintRef = useRef<Promise<Session | null> | null>(null);
  // Live access token. `accessToken` on the context is a render snapshot, and a
  // React render is too late for the guest mint: the scan that TRIGGERED the
  // mint is already running inside a closure built before it. This ref is
  // written synchronously as soon as a session lands, and the repository reads
  // it per request, so that in-flight scan goes out authenticated.
  const accessTokenRef = useRef<string | null>(null);

  const setPendingGuest = useCallback((pending: boolean) => {
    isPendingGuestRef.current = pending;
    setIsPendingGuest(pending);
  }, []);

  const getCurrentAccessToken = useCallback(() => accessTokenRef.current, []);

  const updateFromSession = useCallback(async (session: Session | null) => {
    accessTokenRef.current = getAccessToken(session);
    setCurrentSession(session);

    if (session && recoveryInProgressRef.current) {
      return;
    }

    if (!session) {
      // A pending guest legitimately has no session — a null here (e.g. the
      // INITIAL_SESSION event) must not kick them out to the login screen.
      if (isPendingGuestRef.current) {
        return;
      }
      setCurrentUser(null);
      setProfileDraftName('');
      setState('signedOut');
      return;
    }

    setPendingGuest(false);

    // Guest (anonymous) session: land straight in the app as a synthetic
    // "Guest" — state 'signedIn' so AuthGate renders the app, but skip the
    // profile-completion gate.
    if (isAnonymousSession(session)) {
      setCurrentUser(guestAppUser(session));
      setProfileDraftName('');
      setState('signedIn');
      return;
    }

    // A real (non-anonymous) account signed in — remember it so this device
    // never silently returns to first-launch guest mode.
    void markHasSignedIn();

    const resolvedUser = await resolveAppUserFromSession(session);
    setCurrentUser(resolvedUser);
    setProfileDraftName((current) => current || resolvedUser.displayName || '');
    setState(getNeedsProfile(resolvedUser) ? 'needsProfile' : 'signedIn');
  }, [setPendingGuest]);

  // Enter guest mode WITHOUT minting a Supabase anonymous user. The app renders
  // exactly as it does for a minted guest (`isGuest` is true, the profile gate
  // is skipped); the user only becomes a billable MAU once
  // `ensureGuestSession()` runs.
  const enterPendingGuest = useCallback(() => {
    setPendingGuest(true);
    setCurrentUser(guestAppUser(null));
    setProfileDraftName('');
    setState('signedIn');
  }, [setPendingGuest]);

  // See `applyFollowingDelta` on AuthContextValue for why this is a local delta
  // and not a refetch. Guarded against going negative: a double-tap that fired
  // two unfollows must not leave the count below zero and then re-render as a
  // negative number when a real read lands.
  const applyFollowingDelta = useCallback((delta: number) => {
    setCurrentUser((previous) => {
      if (!previous) {
        return previous;
      }
      const next = Math.max(0, (previous.followingCount ?? 0) + delta);
      return next === previous.followingCount ? previous : { ...previous, followingCount: next };
    });
  }, []);

  const ensureGuestSession = useCallback(async (): Promise<Session | null> => {
    if (currentSession) {
      return currentSession;
    }
    if (!isPendingGuestRef.current) {
      return null;
    }

    // Single-flight: a burst of gated actions (or a double-tapped shutter) must
    // produce ONE anonymous user, not one per call.
    if (!guestMintRef.current) {
      guestMintRef.current = (async () => {
        try {
          const session = await signInAnonymously();
          await updateFromSession(session);
          return session;
        } catch (error) {
          // Let the next action retry (anon sign-ins off, offline). Staying in
          // guest mode is right: the user did nothing wrong and bouncing them to
          // the login screen mid-action would lose their place.
          guestMintRef.current = null;
          console.warn('[AUTH] Could not create the guest session.', error);
          return null;
        }
      })();
    }

    return guestMintRef.current;
  }, [currentSession, updateFromSession]);

  const handleIncomingURL = useCallback(async (url: string) => {
    try {
      const restoredSession = await restoreSessionFromUrl(url);
      if (restoredSession) {
        await updateFromSession(restoredSession);
      }
    } catch (error) {
      const nextMessage = errorMessageFromUnknown(error);
      if (nextMessage) {
        setErrorMessage(nextMessage);
      }
    }
  }, [updateFromSession]);

  const performAuthAction = useCallback(async (
    operation: () => Promise<void>,
    options?: {
      onError?: (error: unknown) => void;
      onSuccess?: () => void;
    },
  ) => {
    if (isBusy) {
      return;
    }

    setIsBusy(true);
    setErrorMessage(null);

    try {
      await operation();
      options?.onSuccess?.();
    } catch (error) {
      options?.onError?.(error);
      const nextMessage = errorMessageFromUnknown(error);
      if (nextMessage) {
        setErrorMessage(nextMessage);
      }
    } finally {
      setIsBusy(false);
    }
  }, [isBusy]);

  // Like performAuthAction but returns the operation's result and rethrows on
  // failure (after surfacing the message) so the email stepper can branch on
  // success/failure of each step.
  const runWithBusy = useCallback(async <T,>(operation: () => Promise<T>): Promise<T> => {
    setIsBusy(true);
    setErrorMessage(null);
    try {
      return await operation();
    } catch (error) {
      const nextMessage = errorMessageFromUnknown(error);
      if (nextMessage) {
        setErrorMessage(nextMessage);
      }
      throw error;
    } finally {
      setIsBusy(false);
    }
  }, []);

  useEffect(() => {
    if (shouldBypassAuthForTests) {
      return;
    }

    let isMounted = true;

    void checkAppleSignInAvailability().then((available) => {
      if (isMounted) {
        setAppleSignInAvailable(available);
      }
    });

    void (async () => {
      try {
        const initialURL = await Linking.getInitialURL();
        if (initialURL) {
          await handleIncomingURL(initialURL);
        }

        const session = await getCurrentSession();
        if (!isMounted) {
          return;
        }

        // First-launch guest: no session AND this device has never had a real
        // login → land the user on the scanner as a guest. If the device HAS
        // signed in before, keep today's signed-out login flow.
        if (!session && !(await hasEverSignedIn())) {
          // Deferred mint (preferred): enter guest mode with no Supabase user at
          // all. Opening the app costs nothing; `ensureGuestSession()` mints on
          // the first action that needs a server identity.
          if (shouldDeferGuestSessionMint) {
            if (isMounted) {
              enterPendingGuest();
            }
            return;
          }

          // Eager mint (legacy): every app open of a fresh install becomes a
          // billable MAU. Any failure (anon sign-ins disabled in the dashboard,
          // network) falls back to the login screen — guest mode degrades
          // gracefully.
          try {
            const guestSession = await signInAnonymously();
            if (isMounted) {
              await updateFromSession(guestSession);
            }
          } catch {
            if (isMounted) {
              await updateFromSession(null);
            }
          }
          return;
        }

        await updateFromSession(session);
      } catch (error) {
        const nextMessage = errorMessageFromUnknown(error);
        if (isMounted) {
          if (nextMessage) {
            setErrorMessage(nextMessage);
          }
          setState((currentState) => (currentState === 'loading' ? 'signedOut' : currentState));
        }
      }
    })();

    const linkSubscription = Linking.addEventListener('url', ({ url }) => {
      void handleIncomingURL(url);
    });

    const authSubscription = supabase?.auth.onAuthStateChange((event, session) => {
      if (
        event === 'INITIAL_SESSION'
        || event === 'SIGNED_IN'
        || event === 'SIGNED_OUT'
        || event === 'TOKEN_REFRESHED'
        || event === 'USER_UPDATED'
      ) {
        setTimeout(() => {
          void updateFromSession(session);
        }, 0);
      }
    });

    return () => {
      isMounted = false;
      linkSubscription.remove();
      authSubscription?.data.subscription.unsubscribe();
    };
  }, [enterPendingGuest, handleIncomingURL, updateFromSession]);

  const clearError = useCallback(() => setErrorMessage(null), []);

  const value = useMemo<AuthContextValue>(() => ({
    accessToken: getAccessToken(currentSession),
    appleSignInAvailable,
    configurationIssue: getConfigurationIssue(),
    currentSession,
    currentUser,
    ensureGuestSession,
    errorMessage,
    applyFollowingDelta,
    getAccessToken: getCurrentAccessToken,
    // A guest is a guest whether or not we have paid for their identity yet, so
    // every existing gate keeps working across the deferred mint.
    isGuest: isPendingGuest || isAnonymousSession(currentSession),
    isBusy,
    isConfigured: getIsConfigured(),
    profileDraftName,
    setProfileDraftName,
    clearError,
    checkEmail: (email: string) => runWithBusy(() => checkEmailExists(email)),
    signUpEmail: ({ email, password, fullName }) => runWithBusy(async () => {
      // A guest who signs up must KEEP the uuid they already own: the backend's
      // `owner_user_id` IS this uuid, so `signUp()` here would strand every scan
      // they just made under a user nobody can sign in as (and bill a second
      // MAU). Attach the address to the existing anonymous user instead; the
      // password is set in `verifyCode` once the code proves the address.
      //
      // A PENDING guest has no Supabase user at all, so there is nothing to
      // preserve — they take the normal signup path and never cost an
      // anonymous MAU.
      if (isAnonymousSession(currentSession)) {
        return convertAnonymousUserToEmailAccount({ email, fullName });
      }

      const result = await signUpWithEmail({ email, password, fullName });
      if (result.session) {
        // No email confirmation required — persist the captured name and sign in.
        await bootstrapProfileIfNeeded(result.session.user, fullName, null);
        await updateFromSession(result.session);
        captureAuthSignInSucceeded('email');
      }
      return { needsCode: result.needsCode };
    }),
    signInEmail: ({ email, password }) => runWithBusy(async () => {
      const session = await signInWithEmailPassword({ email, password });
      await updateFromSession(session);
      captureAuthSignInSucceeded('email');
    }),
    verifyCode: ({ email, code, fullName, password }) => runWithBusy(async () => {
      // Guest half of the identity-preserving conversion started in
      // `signUpEmail`: verify the `email_change` code on the SAME user, then set
      // the password. The uuid — and everything the guest scanned — survives.
      if (isAnonymousSession(currentSession)) {
        if (!password) {
          throw new Error('Re-enter your password to finish creating your account.');
        }
        const session = await verifyAnonymousEmailConversion({ email, code, fullName, password });
        await updateFromSession(session);
        captureAuthSignInSucceeded('email');
        return;
      }

      const session = await verifySignupCode({ email, code, fullName });
      await updateFromSession(session);
      captureAuthSignInSucceeded('email');
    }),
    resendCode: (email: string) => runWithBusy(() => resendSignupCode(email)),
    sendReset: (email: string) => runWithBusy(() => sendPasswordReset(email)),
    verifyResetCode: ({ email, code }) => runWithBusy(async () => {
      recoveryInProgressRef.current = true;
      await verifyRecoveryCode({ email, code });
    }),
    updatePassword: (newPassword: string, currentPassword?: string) => runWithBusy(async () => {
      await updatePasswordService(newPassword, { currentPassword });
      recoveryInProgressRef.current = false;
      const session = await getCurrentSession();
      if (session) {
        await updateFromSession(session);
      }
    }),
    signInWithApple: async () => {
      await performAuthAction(async () => {
        // Guest: LINK Apple to the anonymous user (native sheet, OIDC overload)
        // so the uuid survives. Signing in would mint a second user and orphan
        // the guest's scans.
        const session = isAnonymousSession(currentSession)
          ? await linkAppleIdentityToCurrentUser()
          : await signInWithApple();
        if (session) {
          await updateFromSession(session);
          captureAuthSignInSucceeded('apple');
        }
      }, {
        onError: (error) => {
          captureAuthSignInFailed('apple', error);
        },
      });
    },
    signInWithGoogle: async () => {
      await performAuthAction(async () => {
        // Guest: LINK Google to the anonymous user (browser redirect) so the
        // uuid survives. A null session means the system browser took over and
        // the session arrives on the deep link instead.
        const session = isAnonymousSession(currentSession)
          ? await linkOAuthIdentityToCurrentUser('google')
          : await signInWithGoogle();
        if (session) {
          await bootstrapProfileIfNeeded(session.user, null, null);
          await updateFromSession(session);
          captureAuthSignInSucceeded('google');
        }
      }, {
        onError: (error) => {
          captureAuthSignInFailed('google', error);
        },
      });
    },
    signOut: async () => {
      await performAuthAction(async () => {
        await signOut();
        setPendingGuest(false);
        guestMintRef.current = null;
        accessTokenRef.current = null;
        setCurrentSession(null);
        setCurrentUser(null);
        setProfileDraftName('');
        setState('signedOut');
        capturePostHogEvent('auth_sign_out');
      });
    },
    state,
    submitProfile: async () => {
      if (!currentUser) {
        return;
      }

      const trimmedName = profileDraftName.trim();
      if (trimmedName.length === 0) {
        setErrorMessage('Enter a display name to continue.');
        return;
      }

      await performAuthAction(async () => {
        await upsertProfile(currentUser.id, trimmedName, currentUser.avatarURL);
        const refreshedSession = currentSession ?? await getCurrentSession();
        if (refreshedSession) {
          await updateFromSession(refreshedSession);
          captureProfileCompleted();
          return;
        }

        setCurrentUser((previous) => previous ? { ...previous, displayName: trimmedName } : previous);
        setProfileDraftName(trimmedName);
        setState('signedIn');
        captureProfileCompleted();
      });
    },
    updateProfile: async (patch: ProfileUpdate) => {
      if (!currentUser) {
        return;
      }
      // runWithBusy, not performAuthAction: a rejected write (e.g. a handle
      // claimed out from under us) has to reach the caller, or Edit Profile
      // dismisses itself as though the save landed.
      await runWithBusy(async () => {
        await updateProfileService(currentUser.id, patch);
        const refreshedSession = currentSession ?? await getCurrentSession();
        if (refreshedSession) {
          await updateFromSession(refreshedSession);
        }
      });
    },
  }), [
    appleSignInAvailable,
    applyFollowingDelta,
    clearError,
    currentSession,
    currentUser,
    ensureGuestSession,
    errorMessage,
    getCurrentAccessToken,
    isBusy,
    isPendingGuest,
    performAuthAction,
    profileDraftName,
    runWithBusy,
    setPendingGuest,
    state,
    updateFromSession,
  ]);

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);

  if (!context) {
    throw new Error('useAuth must be used within AuthProvider.');
  }

  return context;
}
