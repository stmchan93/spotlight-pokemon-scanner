import { useCallback } from 'react';
import { useRouter, type Href } from 'expo-router';

import { useAuth } from '@/providers/auth-provider';

// The `(modal)/login` route is brand new; expo-router's typed-routes codegen
// (.expo/types/router.d.ts) only regenerates at bundle time, so `/login` isn't
// in the Href union yet during a bare `tsc`. Cast until the next typegen (the
// OTA export) picks it up. The route exists and resolves at runtime.
const LOGIN_HREF = '/login' as Href;

/**
 * Guest gating for the first-launch scanner experience.
 *
 * In guest (Supabase anonymous) mode every gated action opens the login modal
 * instead of running; for real users it runs normally.
 *
 * Usage — wrap a handler at the call site (args are forwarded):
 *   const { gate } = useGuestGate();
 *   <Button onPress={gate(handleAdd)} />
 *   <Row onSelect={gate(handleRowMenuSelect)} />          // (action) => …
 *   <Button onPress={gate(() => handleRow(captureId))} /> // arg-bound
 *
 * Or check/route imperatively:
 *   const { isGuest, openLogin } = useGuestGate();
 *   if (isGuest) { openLogin(); return; }
 *
 * `ensureGuestSession` is re-exported here because the ALLOWED guest actions
 * live next to the gated ones: a guest has no Supabase user until the first
 * action that needs a server identity mints one. Await it before that call, and
 * never on app open or navigation — each anonymous user is a billable MAU.
 */
export function useGuestGate() {
  const { ensureGuestSession, isGuest } = useAuth();
  const router = useRouter();

  const openLogin = useCallback(() => {
    router.push(LOGIN_HREF);
  }, [router]);

  const gate = useCallback(
    <A extends unknown[]>(action: (...args: A) => void) =>
      (...args: A): void => {
        if (isGuest) {
          openLogin();
          return;
        }
        action(...args);
      },
    [isGuest, openLogin],
  );

  return { ensureGuestSession, isGuest, gate, openLogin };
}
