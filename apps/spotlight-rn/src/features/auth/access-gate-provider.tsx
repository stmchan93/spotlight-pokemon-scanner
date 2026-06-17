import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type PropsWithChildren,
} from 'react';
import { AppState, type AppStateStatus } from 'react-native';

import type { AccessStatus } from '@spotlight/api-client';

import { useAppServices } from '@/providers/app-providers';

type AccessGateState = 'loading' | 'allowed' | 'blocked';

type AccessGateContextValue = {
  state: AccessGateState;
  status: AccessStatus | null;
  /** Re-fetch access status (e.g. after redeeming an invite code). */
  refresh: () => Promise<AccessStatus | null>;
};

const AccessGateContext = createContext<AccessGateContextValue | null>(null);

/**
 * Fetches the backend access-gate status after sign-in and decides whether the
 * signed-in user may enter the app.
 *
 * Policy:
 * - While the status is still loading, do NOT gate (callers show a brief loader).
 * - FAIL OPEN: if the status call errors, treat the user as allowed so a network
 *   blip can never lock people out. (The repository's getAccessStatus already
 *   returns `allowed: true` on transport failure; this provider mirrors that by
 *   defaulting to allowed if the call throws.)
 * - Re-check whenever the app returns to the foreground.
 */
export function AccessGateProvider({ children }: PropsWithChildren) {
  const { spotlightRepository } = useAppServices();
  const [state, setState] = useState<AccessGateState>('loading');
  const [status, setStatus] = useState<AccessStatus | null>(null);
  const isMountedRef = useRef(true);

  const refresh = useCallback(async (): Promise<AccessStatus | null> => {
    try {
      const nextStatus = await spotlightRepository.getAccessStatus();
      if (!isMountedRef.current) {
        return nextStatus;
      }
      setStatus(nextStatus);
      setState(nextStatus.allowed ? 'allowed' : 'blocked');
      return nextStatus;
    } catch {
      // FAIL OPEN on an unexpected throw — never lock the user out on a blip.
      if (isMountedRef.current) {
        setStatus(null);
        setState('allowed');
      }
      return null;
    }
  }, [spotlightRepository]);

  useEffect(() => {
    isMountedRef.current = true;
    void refresh();

    const subscription = AppState.addEventListener('change', (nextAppState: AppStateStatus) => {
      if (nextAppState === 'active') {
        void refresh();
      }
    });

    return () => {
      isMountedRef.current = false;
      subscription.remove();
    };
  }, [refresh]);

  return (
    <AccessGateContext.Provider value={{ state, status, refresh }}>
      {children}
    </AccessGateContext.Provider>
  );
}

export function useAccessGate(): AccessGateContextValue {
  const context = useContext(AccessGateContext);
  if (!context) {
    throw new Error('useAccessGate must be used within AccessGateProvider.');
  }
  return context;
}
