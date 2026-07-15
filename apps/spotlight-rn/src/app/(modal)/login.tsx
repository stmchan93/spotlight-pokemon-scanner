import { useRouter } from 'expo-router';

import { SignedOutFlow } from '@/features/auth/components/signed-out-flow';
import { useAuth } from '@/providers/auth-provider';

/**
 * Login-on-demand modal for guest mode. A guest taps any gated action →
 * `router.push('/login')` presents this over the scanner. The back affordance
 * dismisses to the guest experience (`router.back()`). On a successful real
 * login the session switch flips `AuthenticatedAppProviders`' key → the app
 * remounts at the tabs root (Collection), tearing this modal down.
 */
export default function LoginModalRoute() {
  const auth = useAuth();
  const router = useRouter();

  return (
    <SignedOutFlow
      appleSignInAvailable={auth.appleSignInAvailable}
      configurationIssue={auth.configurationIssue}
      emailAuth={auth}
      errorMessage={auth.errorMessage}
      isBusy={auth.isBusy}
      onAppleSignIn={() => {
        void auth.signInWithApple();
      }}
      onClose={() => router.back()}
      onGoogleSignIn={() => {
        void auth.signInWithGoogle();
      }}
    />
  );
}
