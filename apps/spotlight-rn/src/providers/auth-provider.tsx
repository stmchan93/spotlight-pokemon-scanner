import { createContext, type PropsWithChildren, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import * as Linking from 'expo-linking';
import type { Session } from '@supabase/supabase-js';

import type { AppUser, AuthState } from '@/features/auth/auth-models';
import {
  AuthCanceledError,
  bootstrapProfileIfNeeded,
  checkAppleSignInAvailability,
  checkEmailExists,
  getAccessToken,
  getCurrentSession,
  getConfigurationIssue,
  getIsConfigured,
  getNeedsProfile,
  isAnonymousSession,
  isAuthCanceledError,
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
  verifyRecoveryCode,
  verifySignupCode,
} from '@/features/auth/auth-service';
import { getResolvedDisplayName, type ProfileUpdate } from '@/features/auth/auth-models';
import { hasEverSignedIn, markHasSignedIn } from '@/features/auth/guest-first-launch';
import { capturePostHogEvent } from '@/lib/observability/posthog';
import { supabase } from '@/lib/supabase';

type EmailAuthActions = {
  checkEmail: (email: string) => Promise<boolean>;
  signUpEmail: (input: { email: string; password: string; fullName: string }) => Promise<{ needsCode: boolean }>;
  signInEmail: (input: { email: string; password: string }) => Promise<void>;
  verifyCode: (input: { email: string; code: string; fullName: string }) => Promise<void>;
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
  errorMessage: string | null;
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
function guestAppUser(session: Session): AppUser {
  return {
    id: session.user.id,
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

  const updateFromSession = useCallback(async (session: Session | null) => {
    setCurrentSession(session);

    if (session && recoveryInProgressRef.current) {
      return;
    }

    if (!session) {
      setCurrentUser(null);
      setProfileDraftName('');
      setState('signedOut');
      return;
    }

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
  }, []);

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
        // login → sign in anonymously so the user lands on the scanner. If the
        // device HAS signed in before, keep today's signed-out login flow. Any
        // failure (anon sign-ins disabled in the dashboard, network) falls back
        // to the login screen — guest mode degrades gracefully.
        if (!session && !(await hasEverSignedIn())) {
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
  }, [handleIncomingURL, updateFromSession]);

  const clearError = useCallback(() => setErrorMessage(null), []);

  const value = useMemo<AuthContextValue>(() => ({
    accessToken: getAccessToken(currentSession),
    appleSignInAvailable,
    configurationIssue: getConfigurationIssue(),
    currentSession,
    currentUser,
    errorMessage,
    isGuest: isAnonymousSession(currentSession),
    isBusy,
    isConfigured: getIsConfigured(),
    profileDraftName,
    setProfileDraftName,
    clearError,
    checkEmail: (email: string) => runWithBusy(() => checkEmailExists(email)),
    signUpEmail: ({ email, password, fullName }) => runWithBusy(async () => {
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
    verifyCode: ({ email, code, fullName }) => runWithBusy(async () => {
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
        const session = await signInWithApple();
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
        const session = await signInWithGoogle();
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
      await performAuthAction(async () => {
        await updateProfileService(currentUser.id, patch);
        const refreshedSession = currentSession ?? await getCurrentSession();
        if (refreshedSession) {
          await updateFromSession(refreshedSession);
        }
      });
    },
  }), [
    appleSignInAvailable,
    clearError,
    currentSession,
    currentUser,
    errorMessage,
    isBusy,
    performAuthAction,
    profileDraftName,
    runWithBusy,
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
