/**
 * RevenueCat wiring for the premium subscription.
 *
 * react-native-purchases is a NATIVE module, so (like palette.ts / expo-sharing)
 * it's lazy-required and every call is guarded — OTA'd JS on a binary WITHOUT the
 * native module (or before the RevenueCat keys/products are live) must not crash.
 * In that state the CTA falls back to the interim free unlock so the paywall is
 * still testable.
 *
 * Setup needed to go live (outside code): create the subscription product(s) in
 * App Store Connect + Google Play, configure the "premium" entitlement + offering
 * in the RevenueCat dashboard, and set the public SDK keys via env:
 *   EXPO_PUBLIC_REVENUECAT_IOS_KEY / EXPO_PUBLIC_REVENUECAT_ANDROID_KEY
 */
import { Platform } from 'react-native';

import {
  PREMIUM_ENTITLEMENT_ID,
  grantPremiumUnlock,
  setRevenueCatPremium,
} from '@/features/monetization/entitlements';

type CustomerInfoLike = { entitlements?: { active?: Record<string, unknown> } };
type PackageLike = unknown;
type PurchasesModule = {
  configure: (options: { apiKey: string }) => void;
  getOfferings: () => Promise<{ current?: { availablePackages?: PackageLike[] } | null } | null>;
  getCustomerInfo: () => Promise<CustomerInfoLike>;
  purchasePackage: (pkg: PackageLike) => Promise<{ customerInfo: CustomerInfoLike }>;
  addCustomerInfoUpdateListener: (listener: (info: CustomerInfoLike) => void) => void;
};

export type PremiumUnlockResult = 'purchased' | 'interim' | 'cancelled' | 'error';

let configured = false;

function loadPurchasesModule(): PurchasesModule | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('react-native-purchases') as
      | PurchasesModule
      | { default?: PurchasesModule };
    const candidate =
      typeof (mod as PurchasesModule).configure === 'function'
        ? (mod as PurchasesModule)
        : (mod as { default?: PurchasesModule }).default;
    return candidate && typeof candidate.configure === 'function' ? candidate : null;
  } catch {
    return null;
  }
}

function platformApiKey(): string | null {
  const key =
    Platform.OS === 'ios'
      ? process.env.EXPO_PUBLIC_REVENUECAT_IOS_KEY
      : Platform.OS === 'android'
        ? process.env.EXPO_PUBLIC_REVENUECAT_ANDROID_KEY
        : undefined;
  const trimmed = (key ?? '').trim();
  return trimmed || null;
}

function hasPremiumEntitlement(info: CustomerInfoLike | null | undefined): boolean {
  return Boolean(info?.entitlements?.active?.[PREMIUM_ENTITLEMENT_ID]);
}

function ensureConfigured(purchases: PurchasesModule, apiKey: string): void {
  if (configured) {
    return;
  }
  purchases.configure({ apiKey });
  configured = true;
}

/** True once the native module + a platform API key are both present. */
export function isPurchasesConfigured(): boolean {
  return loadPurchasesModule() != null && platformApiKey() != null;
}

/**
 * Configure RevenueCat at app startup and mirror the live "premium" entitlement
 * into the entitlements store. No-op (safe) when the native module or keys are
 * absent — the interim unlock path covers the CTA until then.
 */
export function configurePurchases(): void {
  const purchases = loadPurchasesModule();
  const apiKey = platformApiKey();
  if (!purchases || !apiKey) {
    return;
  }
  try {
    ensureConfigured(purchases, apiKey);
    purchases.addCustomerInfoUpdateListener((info) => {
      setRevenueCatPremium(hasPremiumEntitlement(info));
    });
    void purchases
      .getCustomerInfo()
      .then((info) => setRevenueCatPremium(hasPremiumEntitlement(info)))
      .catch(() => {
        // Network/config hiccup — leave the user on their current tier.
      });
  } catch {
    // Native module missing on this binary (OTA before a native build) → no-op.
  }
}

/**
 * Drive the "Unlock" CTA: purchase the premium package via RevenueCat when it's
 * live, otherwise fall back to the interim free unlock so the paywall stays
 * testable. Returns what happened so callers can toast appropriately.
 */
export async function requestPremiumUnlock(): Promise<PremiumUnlockResult> {
  const purchases = loadPurchasesModule();
  const apiKey = platformApiKey();
  if (!purchases || !apiKey) {
    grantPremiumUnlock();
    return 'interim';
  }
  try {
    ensureConfigured(purchases, apiKey);
    const offerings = await purchases.getOfferings();
    const pkg = offerings?.current?.availablePackages?.[0];
    if (!pkg) {
      // Keys present but no products configured yet — keep it testable.
      grantPremiumUnlock();
      return 'interim';
    }
    const { customerInfo } = await purchases.purchasePackage(pkg);
    const active = hasPremiumEntitlement(customerInfo);
    setRevenueCatPremium(active);
    return active ? 'purchased' : 'error';
  } catch (error) {
    if ((error as { userCancelled?: boolean } | null)?.userCancelled) {
      return 'cancelled';
    }
    return 'error';
  }
}
