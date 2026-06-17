import type { ReactNode } from 'react';

import { AccessGateProvider, useAccessGate } from '@/features/auth/access-gate-provider';
import { AuthLoadingScreen } from '@/features/auth/components/auth-loading-screen';
import { BetweenShowsScreen } from '@/features/auth/screens/between-shows-screen';

/**
 * The ACCESS layer that sits AFTER sign-in. When the backend access gate is
 * closed and this user isn't allowed in, it renders the "between shows" holding
 * screen instead of the app. While the status is still loading it shows a brief
 * loader (it does not gate), and it fails open on errors (see the provider).
 */
function AccessGateContent({ children }: { children: ReactNode }) {
  const { state } = useAccessGate();

  if (state === 'loading') {
    return <AuthLoadingScreen />;
  }

  if (state === 'blocked') {
    return <BetweenShowsScreen />;
  }

  return <>{children}</>;
}

export function AccessGate({ children }: { children: ReactNode }) {
  return (
    <AccessGateProvider>
      <AccessGateContent>{children}</AccessGateContent>
    </AccessGateProvider>
  );
}
