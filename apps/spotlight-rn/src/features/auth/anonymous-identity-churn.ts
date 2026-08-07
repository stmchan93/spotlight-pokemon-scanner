import AsyncStorage from '@react-native-async-storage/async-storage';

import { hasEverSignedIn } from './guest-first-launch';
import { getSecureStoreFallbackState } from '@/lib/supabase';

/**
 * Anonymous-identity churn metric — OBSERVATION ONLY.
 *
 * Supabase bills per Monthly Active User: "distinct users who log in or refresh
 * their token in the billing cycle", and an anonymous (guest) user counts like
 * any other. Minting one is therefore expected exactly ONCE per install.
 *
 * The expensive failure mode is IDENTITY CHURN: a device that loses its stored
 * session mints a BRAND NEW anonymous uuid on the next launch, which is
 *   (a) another billable MAU,
 *   (b) another orphaned `owner_user_id` in the backend's SQLite (the backend
 *       keys owned data by the Supabase uuid, so the old rows belong to a user
 *       nobody can ever sign in as), and
 *   (c) another phantom person in PostHog.
 *
 * We had no visibility into how often that happens. This module records the last
 * anonymous uuid the install minted plus a running count, and reports each mint
 * with a `mint_kind` that separates the benign cases from real churn.
 *
 * Two identities are deliberately NOT churn:
 *   - `after_sign_out` — the user signed out on purpose, so the previous
 *     identity was given up, not lost. `markAnonymousIdentityReleased()` is
 *     called from `signOut()` to record that.
 *   - `after_account_upgrade` — this device has had a real login
 *     (`hasEverSignedIn()`), so the anonymous identity was either promoted in
 *     place by the guest→account conversion (which preserves the uuid) or
 *     superseded by a real account. Note that `hasEverSignedIn()` fails toward
 *     TRUE, which is the safe direction here too: a storage read we cannot
 *     trust must never be reported as churn.
 *
 * Nothing here may change auth behaviour or throw into it, so every path
 * swallows its own failures and the PostHog module is pulled in lazily (a static
 * import would drag React into the auth service's import graph).
 */

/** The anonymous uuid this install minted most recently. */
const LAST_USER_ID_KEY = '@spotlight/auth/anonymous-identity/last-user-id';
/** How many distinct anonymous identities this install has minted. */
const MINT_COUNT_KEY = '@spotlight/auth/anonymous-identity/mint-count';
/**
 * Set when the recorded identity was deliberately given up (sign-out), so the
 * next mint is reported as `after_sign_out` rather than as a lost identity.
 */
const RELEASED_KEY = '@spotlight/auth/anonymous-identity/released';

export const ANONYMOUS_IDENTITY_MINTED_EVENT = 'auth_anonymous_identity_minted';

export type AnonymousMintKind =
  /** A real account has existed on this device; the guest uuid was promoted or superseded. */
  | 'after_account_upgrade'
  /** The previous guest identity was deliberately signed out. */
  | 'after_sign_out'
  /** The previous identity was LOST — the case this metric exists to count. */
  | 'churn'
  /** Expected: the first anonymous user this install has ever minted. */
  | 'first_ever';

async function readStoredValue(key: string): Promise<string | null> {
  try {
    const value = await AsyncStorage.getItem(key);
    return typeof value === 'string' && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

async function writeStoredValue(key: string, value: string): Promise<void> {
  try {
    await AsyncStorage.setItem(key, value);
  } catch {
    // Best effort. A lost write only means the NEXT mint under-reports.
  }
}

async function removeStoredValue(key: string): Promise<void> {
  try {
    await AsyncStorage.removeItem(key);
  } catch {
    // Best effort.
  }
}

function parseMintCount(raw: string | null): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

async function classifyMint(
  previousUserID: string | null,
  wasReleased: boolean,
): Promise<AnonymousMintKind> {
  if (!previousUserID) {
    return 'first_ever';
  }

  if (wasReleased) {
    return 'after_sign_out';
  }

  if (await hasEverSignedIn()) {
    return 'after_account_upgrade';
  }

  return 'churn';
}

/**
 * Correlating churn with keychain failure is the diagnosis we actually want: if
 * churning devices are the ones running on the AsyncStorage fallback tier, the
 * root cause is the keychain, not token expiry. Read defensively — the export
 * may be absent under a partially mocked `@/lib/supabase`, and a missing
 * diagnostic must never cost us the event.
 */
function readSecureStoreFallback(): {
  engaged: boolean | null;
  reason: string | null;
} {
  try {
    if (typeof getSecureStoreFallbackState !== 'function') {
      return { engaged: null, reason: null };
    }

    const state = getSecureStoreFallbackState();
    return {
      engaged: state.isUsingFallbackStorage,
      reason: state.reason,
    };
  } catch {
    return { engaged: null, reason: null };
  }
}

type AnonymousMintProperties = {
  is_churn: boolean;
  mint_count: number;
  mint_kind: AnonymousMintKind;
  previous_anonymous_user_id: string | null;
  secure_store_fallback_engaged: boolean | null;
  secure_store_fallback_reason: string | null;
};

function emitAnonymousIdentityMinted(properties: AnonymousMintProperties) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const observability = require('@/lib/observability/posthog') as typeof import('@/lib/observability/posthog');
    observability.capturePostHogEvent(ANONYMOUS_IDENTITY_MINTED_EVENT, properties);
  } catch {
    // Ignored on purpose: analytics must never break authentication.
  }
}

/**
 * Record that `userID` was just minted and report it to PostHog.
 *
 * Called from ONE place — `signInAnonymously()` in `auth-service`, the single
 * function that actually mints an anonymous user — so it cannot double-count.
 * Never throws.
 */
export async function recordAnonymousIdentityMint(userID: string): Promise<void> {
  try {
    if (!userID) {
      return;
    }

    const previousUserID = await readStoredValue(LAST_USER_ID_KEY);

    // Not a distinct identity, so nothing was minted and nothing was lost.
    // Supabase always issues a fresh uuid, so this is purely defensive.
    if (previousUserID === userID) {
      return;
    }

    const wasReleased = (await readStoredValue(RELEASED_KEY)) != null;
    const mintCount = parseMintCount(await readStoredValue(MINT_COUNT_KEY)) + 1;
    const mintKind = await classifyMint(previousUserID, wasReleased);

    await writeStoredValue(LAST_USER_ID_KEY, userID);
    await writeStoredValue(MINT_COUNT_KEY, String(mintCount));
    if (wasReleased) {
      await removeStoredValue(RELEASED_KEY);
    }

    const secureStoreFallback = readSecureStoreFallback();

    emitAnonymousIdentityMinted({
      is_churn: mintKind === 'churn',
      mint_count: mintCount,
      mint_kind: mintKind,
      previous_anonymous_user_id: previousUserID,
      secure_store_fallback_engaged: secureStoreFallback.engaged,
      secure_store_fallback_reason: secureStoreFallback.reason,
    });
  } catch {
    // Observation must never break the mint it is observing.
  }
}

/**
 * Mark the recorded anonymous identity as deliberately given up, so the next
 * mint is reported as `after_sign_out` instead of as a lost identity. Called
 * from `signOut()`. Never throws.
 */
export async function markAnonymousIdentityReleased(): Promise<void> {
  await writeStoredValue(RELEASED_KEY, 'true');
}
