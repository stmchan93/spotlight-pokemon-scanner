import { useRouter } from 'expo-router';

import { SignedOutFlow } from '@/features/auth/components/signed-out-flow';
import { useAuth } from '@/providers/auth-provider';

/**
 * Login-on-demand modal for guest mode. A guest taps any gated action →
 * `router.push('/login')` presents this over the scanner. The back affordance
 * dismisses to the guest experience (`router.back()`). On a successful real
 * login the session switch flips `AuthenticatedAppProviders`' key → the app
 * remounts at the tabs root (Collection), tearing this modal down.
 *
 * SIGN-UP from here is a CONVERSION, not a new account: when the current
 * session is an anonymous guest, the auth provider routes signUpEmail/verifyCode
 * /Apple/Google through the identity-preserving helpers so the user keeps the
 * uuid — and the scans — they already own. Nothing to do at this call site; see
 * `auth-provider.tsx`.
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
