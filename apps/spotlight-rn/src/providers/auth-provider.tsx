import { createContext, type PropsWithChildren, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import * as Linking from 'expo-linking';
import type { Session } from '@supabase/supabase-js';

import type { AppUser, AuthState } from '@/features/auth/auth-models';
import {
  AuthCanceledError,
  bootstrapProfileIfNeeded,
  checkAppleSignInAvailability,
  getAccessToken,
  getCurrentSession,
  getConfigurationIssue,
  getIsConfigured,
  getNeedsProfile,
  isAuthCanceledError,
  resolveAppUserFromSession,
  restoreSessionFromUrl,
  signInWithApple,
  signInWithGoogle,
  signOut,
  upsertProfile,
} from '@/features/auth/auth-service';
import { getResolvedDisplayName } from '@/features/auth/auth-models';
import { supabase } from '@/lib/supabase';

type AuthContextValue = {
  accessToken: string | null;
  appleSignInAvailable: boolean;
  configurationIssue: string | null;
  currentSession: Session | null;
  currentUser: AppUser | null;
  errorMessage: string | null;
  isBusy: boolean;
  isConfigured: boolean;
  profileDraftName: string;
  setProfileDraftName: (value: string) => void;
  signInWithApple: () => Promise<void>;
  signInWithGoogle: () => Promise<void>;
  signOut: () => Promise<void>;
  state: AuthState;
  submitProfile: () => Promise<void>;
};

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

function errorMessageFromUnknown(error: unknown) {
  if (error instanceof AuthCanceledError || isAuthCanceledError(error)) {
    return null;
  }

  if (error instanceof Error && error.message) {
    return error.message;
  }

  return 'Authentication failed.';
}

export function AuthProvider({ children }: PropsWithChildren) {
  const [state, setState] = useState<AuthState>(shouldBypassAuthForTests ? 'signedIn' : 'loading');
  const [currentUser, setCurrentUser] = useState<AppUser | null>(shouldBypassAuthForTests ? testUser : null);
  const [currentSession, setCurrentSession] = useState<Session | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [profileDraftName, setProfileDraftName] = useState(shouldBypassAuthForTests ? getResolvedDisplayName(testUser) : '');
  const [appleSignInAvailable, setAppleSignInAvailable] = useState(false);

  const updateFromSession = useCallback(async (session: Session | null) => {
    setCurrentSession(session);

    if (!session) {
      setCurrentUser(null);
      setProfileDraftName('');
      setState('signedOut');
      return;
    }

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

  const performAuthAction = useCallback(async (operation: () => Promise<void>) => {
    if (isBusy) {
      return;
    }

    setIsBusy(true);
    setErrorMessage(null);

    try {
      await operation();
    } catch (error) {
      const nextMessage = errorMessageFromUnknown(error);
      if (nextMessage) {
        setErrorMessage(nextMessage);
      }
    } finally {
      setIsBusy(false);
    }
  }, [isBusy]);

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
        if (isMounted) {
          await updateFromSession(session);
        }
      } catch (error) {
        const nextMessage = errorMessageFromUnknown(error);
        if (isMounted && nextMessage) {
          setErrorMessage(nextMessage);
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

  const value = useMemo<AuthContextValue>(() => ({
    accessToken: getAccessToken(currentSession),
    appleSignInAvailable,
    configurationIssue: getConfigurationIssue(),
    currentSession,
    currentUser,
    errorMessage,
    isBusy,
    isConfigured: getIsConfigured(),
    profileDraftName,
    setProfileDraftName,
    signInWithApple: async () => {
      await performAuthAction(async () => {
        const session = await signInWithApple();
        if (session) {
          await updateFromSession(session);
        }
      });
    },
    signInWithGoogle: async () => {
      await performAuthAction(async () => {
        const session = await signInWithGoogle();
        if (session) {
          await bootstrapProfileIfNeeded(session.user, null, null);
          await updateFromSession(session);
        }
      });
    },
    signOut: async () => {
      await performAuthAction(async () => {
        await signOut();
        setCurrentSession(null);
        setCurrentUser(null);
        setProfileDraftName('');
        setState('signedOut');
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
          return;
        }

        setCurrentUser((previous) => previous ? { ...previous, displayName: trimmedName } : previous);
        setProfileDraftName(trimmedName);
        setState('signedIn');
      });
    },
  }), [
    appleSignInAvailable,
    currentSession,
    currentUser,
    errorMessage,
    isBusy,
    performAuthAction,
    profileDraftName,
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
