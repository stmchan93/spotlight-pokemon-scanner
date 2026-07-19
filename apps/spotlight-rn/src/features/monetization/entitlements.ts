/**
 * Subscription entitlements — STUB.
 *
 * Single gate every paywalled surface reads (first consumer: the PDP
 * recent-sales panel's blur paywall). When real subscriptions land
 * (RevenueCat/StoreKit), replace the body with the entitlement lookup and
 * every paywall updates at once. Keep the hook signature stable.
 */
export function useIsPremium(): boolean {
  // TODO(monetization): wire to the subscription provider. Until then,
  // everyone is on the free tier.
  return false;
}
