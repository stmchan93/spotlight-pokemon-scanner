import type { ReactNode } from 'react';
import { Redirect, type Href } from 'expo-router';

import { useAuth } from '@/providers/auth-provider';

// Same cast as `use-guest-gate.ts`: typed routes lag the `(modal)/login` route.
const LOGIN_HREF = '/login' as Href;

/**
 * For write-only routes a guest can only reach by deep link (compose, edit
 * profile, DMs): a guest gets the login page in this route's place, so Back
 * from login returns to wherever the link was opened, not to the form.
 */
export function GuestRouteGuard({ children }: { children: ReactNode }) {
  const { isGuest } = useAuth();
  if (isGuest) {
    return <Redirect href={LOGIN_HREF} />;
  }
  return <>{children}</>;
}
