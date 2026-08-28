import type { ReactNode } from 'react';

import { useAccessGate } from '@/features/auth/access-gate-provider';
import { useAuth } from '@/providers/auth-provider';

import { HandleClaimScreen } from './handle-claim-screen';

/**
 * The blocking @handle claim gate for existing users (`handle: null`). Renders
 * the claim screen INSTEAD of the app — no navigation, no dismiss, the same
 * modality as AuthGate's needsProfile case — and only when ALL of:
 *
 *  - the backend flag says claiming is required (fail-open false, so an
 *    unreachable backend never traps anyone here);
 *  - a real signed-in user (guests are exempt until they convert — the access
 *    provider also skips the status fetch for them, leaving `status` null);
 *  - the handle is KNOWN to be absent. `handleKnown` guards the false nulls: a
 *    profile-fetch timeout or a degraded select that dropped the handle column
 *    must never trap a user who already owns one.
 */
export function HandleClaimGate({ children }: { children: ReactNode }) {
  const { status } = useAccessGate();
  const auth = useAuth();

  const mustClaim =
    status?.handleClaimRequired === true
    && !auth.isGuest
    && auth.currentUser != null
    && auth.currentUser.handleKnown === true
    && auth.currentUser.handle == null;

  if (!mustClaim) {
    return <>{children}</>;
  }

  return (
    <HandleClaimScreen
      errorMessage={auth.errorMessage}
      isBusy={auth.isBusy}
      onSubmit={(handle) => {
        void auth.submitHandle(handle);
      }}
      user={auth.currentUser}
    />
  );
}
