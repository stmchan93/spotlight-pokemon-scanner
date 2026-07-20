/**
 * Subscription entitlements.
 *
 * Single gate every paywalled surface reads (PDP recent-sales + lowest-listed
 * blur paywalls). When real subscriptions land (RevenueCat/StoreKit), replace
 * the store below with the entitlement lookup — keep `useIsPremium()` /
 * `grantPremiumUnlock()` stable and every paywall updates at once.
 *
 * INTERIM (no payment provider yet): the "Unlock all listings" CTA calls
 * `grantPremiumUnlock()`, which flips a persisted local flag so the user is
 * treated as premium immediately (free while in beta). Device-local by design —
 * it grants ACCESS (not private data), so it's not owner-scoped; the real
 * provider will be. Reset with `resetPremiumUnlock()`.
 */
import { useEffect } from 'react';
import { useSyncExternalStore } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEY = 'spotlight.entitlements.premiumUnlocked.v1';

let premiumUnlocked = false;
let hydrated = false;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) {
    listener();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): boolean {
  return premiumUnlocked;
}

async function hydrateOnce(): Promise<void> {
  if (hydrated) {
    return;
  }
  hydrated = true;
  try {
    const stored = await AsyncStorage.getItem(STORAGE_KEY);
    if (stored === '1' && !premiumUnlocked) {
      premiumUnlocked = true;
      notify();
    }
  } catch {
    // Best-effort: a read failure just leaves the user on the free tier.
  }
}

export function useIsPremium(): boolean {
  // Load the persisted flag once on first mount of any consumer.
  useEffect(() => {
    void hydrateOnce();
  }, []);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Unlock every paywalled surface (interim free unlock until subscriptions land). */
export function grantPremiumUnlock(): void {
  if (premiumUnlocked) {
    return;
  }
  premiumUnlocked = true;
  notify();
  void AsyncStorage.setItem(STORAGE_KEY, '1').catch(() => {
    // Persist is best-effort; the in-memory flag still unlocks this session.
  });
}

/** Re-lock (for testing the paywall, or when the real entitlement takes over). */
export function resetPremiumUnlock(): void {
  if (!premiumUnlocked) {
    return;
  }
  premiumUnlocked = false;
  notify();
  void AsyncStorage.removeItem(STORAGE_KEY).catch(() => {});
}
