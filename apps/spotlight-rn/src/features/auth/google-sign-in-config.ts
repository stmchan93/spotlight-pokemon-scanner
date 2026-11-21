import { resolveRuntimeValue } from '@/lib/runtime-config';

export type GoogleSignInClientIds = {
  /** iOS OAuth client. Its reversed form is the URL scheme baked into the binary. */
  iosClientId: string | null;
  /** Web OAuth client: the id-token audience Supabase verifies. */
  webClientId: string | null;
};

/**
 * Native Google sign-in client ids, set per environment at build time
 * (GOOGLE_IOS_CLIENT_ID / GOOGLE_WEB_CLIENT_ID → app.config.js `extra`).
 * Missing ids mean the browser flow is used.
 */
export function getGoogleSignInClientIds(): GoogleSignInClientIds {
  return {
    iosClientId: resolveRuntimeValue([], ['googleIosClientId']) || null,
    webClientId: resolveRuntimeValue([], ['googleWebClientId']) || null,
  };
}

/** `123-abc.apps.googleusercontent.com` → `com.googleusercontent.apps.123-abc`. */
export function reversedGoogleClientId(clientId: string): string {
  return clientId.split('.').reverse().join('.');
}
