/**
 * Subscription entitlements — the single gate every paywalled surface reads
 * (PDP recent-sales + lowest-listed blur paywalls). `useIsPremium()` is true when
 * EITHER the RevenueCat "premium" entitlement is active (real subscribers) OR the
 * interim local unlock flag is set.
 *
 * RevenueCat is the source of truth once configured (`purchases.ts` calls
 * `setRevenueCatPremium()` from its customerInfo listener). The local flag
 * (`grantPremiumUnlock()`) is an INTERIM free unlock kept working until the
 * RevenueCat products/keys are live — device-local (grants ACCESS, not private
 * data, so not owner-scoped). Remove the local path once subscriptions ship.
 */
import { useEffect } from 'react';
import { useSyncExternalStore } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEY = 'spotlight.entitlements.premiumUnlocked.v1';

// RevenueCat entitlement identifier (must match the one configured in the
// RevenueCat dashboard). Kept here so the paywall + purchase flow agree.
export const PREMIUM_ENTITLEMENT_ID = 'premium';

let rcPremium = false; // from RevenueCat customerInfo
let localUnlock = false; // interim device-local unlock
let hydrated = false;
const listeners = new Set<() => void>();

/*
  PAYWALL OFF — everyone sees every listing and every recent sale.

  Nothing about the product is ready to charge for, and holding comps behind a
  blur is the wrong first impression while we are still getting people to use
  the app at all. `isPremium` gates exactly two things — the PDP recent-sales
  and lowest-listed panels — so this one switch removes the whole thing on both
  platforms without touching anything else.

  The RevenueCat wiring underneath is deliberately LEFT INTACT rather than
  deleted: `rcPremium` / `localUnlock` still hydrate and still notify, so
  turning the paywall back on is flipping this constant back, not rebuilding
  the purchase flow. The `paywall_subscribe_tapped` events simply stop firing,
  because there is no longer an upsell to tap.
*/
const PAYWALL_ENABLED = false;

function isPremium(): boolean {
  if (!PAYWALL_ENABLED) {
    return true;
  }
  return rcPremium || localUnlock;
}

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
  return isPremium();
}

async function hydrateOnce(): Promise<void> {
  if (hydrated) {
    return;
  }
  hydrated = true;
  try {
    const stored = await AsyncStorage.getItem(STORAGE_KEY);
    if (stored === '1' && !localUnlock) {
      const wasPremium = isPremium();
      localUnlock = true;
      if (!wasPremium) {
        notify();
      }
    }
  } catch {
    // Best-effort: a read failure just leaves the user on the free tier.
  }
}

export function useIsPremium(): boolean {
  // Load the persisted local flag once on first mount of any consumer.
  useEffect(() => {
    void hydrateOnce();
  }, []);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** RevenueCat listener (in purchases.ts) pushes the live entitlement state here. */
export function setRevenueCatPremium(active: boolean): void {
  if (rcPremium === active) {
    return;
  }
  const wasPremium = isPremium();
  rcPremium = active;
  if (isPremium() !== wasPremium) {
    notify();
  }
}

/** Interim free unlock of every paywalled surface (until subscriptions land). */
export function grantPremiumUnlock(): void {
  if (localUnlock) {
    return;
  }
  const wasPremium = isPremium();
  localUnlock = true;
  if (!wasPremium) {
    notify();
  }
  void AsyncStorage.setItem(STORAGE_KEY, '1').catch(() => {
    // Persist is best-effort; the in-memory flag still unlocks this session.
  });
}

/** Clear the interim local unlock (testing the paywall; does not touch RevenueCat). */
export function resetPremiumUnlock(): void {
  if (!localUnlock) {
    return;
  }
  const wasPremium = isPremium();
  localUnlock = false;
  if (isPremium() !== wasPremium) {
    notify();
  }
  void AsyncStorage.removeItem(STORAGE_KEY).catch(() => {});
}
