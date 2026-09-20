import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useEffect, useRef, useState } from 'react';

import { useAppServices } from '@/providers/app-providers';
import { usePushPermissionPrompt } from '@/features/notifications/use-push-registration';

/**
 * The ONE-TIME "turn on deal alerts" call to action the Deals band renders.
 *
 * It exists because the permission prompt has to be contextual: the dialog is a
 * one-shot resource on iOS, and the moment it is worth spending is the moment
 * someone is looking at a caught listing — not app launch, and not a settings
 * screen they may never open.
 *
 * ONE-TIME means one time. It shows only while the OS has never been asked
 * (`undetermined`), and the first answer of any kind — yes, no, or "Not now" —
 * retires it for good on this account. A CTA that keeps coming back is a nag,
 * and it cannot even work: once the user has answered the system dialog, tapping
 * it again does nothing visible. The Account screen's switch is the permanent
 * way back in.
 */

/** Owner-scoped: a dismissal is that account's preference, not the device's. */
export function dealAlertPushCtaStorageKey(sessionOwnerKey: string): string {
  return `@spotlight/notifications/deal-cta-dismissed/${sessionOwnerKey}`;
}

export type DealAlertPushCta = {
  /** Render the CTA row only while this is true. */
  isVisible: boolean;
  isBusy: boolean;
  /** "Turn on" — raises the system dialog, then retires the CTA either way. */
  enable: () => Promise<void>;
  /** "Not now" — retires the CTA without spending the prompt. */
  dismiss: () => void;
};

export function useDealAlertPushCta(): DealAlertPushCta {
  const { sessionOwnerKey } = useAppServices();
  const { enablePushNotifications, isBusy, permission } = usePushPermissionPrompt();
  // `null` = the stored flag has not been read yet, which renders as hidden.
  const [isDismissed, setIsDismissed] = useState<boolean | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setIsDismissed(null);
    void AsyncStorage.getItem(dealAlertPushCtaStorageKey(sessionOwnerKey))
      .then((stored) => {
        if (!cancelled) {
          setIsDismissed(stored === '1');
        }
      })
      .catch(() => {
        if (!cancelled) {
          // Unreadable storage shows the CTA rather than hiding it; the
          // permission check below still stops it appearing after an answer.
          setIsDismissed(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [sessionOwnerKey]);

  const retire = useCallback(() => {
    if (mountedRef.current) {
      setIsDismissed(true);
    }
    void AsyncStorage.setItem(dealAlertPushCtaStorageKey(sessionOwnerKey), '1').catch(() => {
      // In-memory dismissal still holds for this session.
    });
  }, [sessionOwnerKey]);

  const enable = useCallback(async () => {
    await enablePushNotifications();
    // Retired whatever the answer was — see the one-time note above.
    retire();
  }, [enablePushNotifications, retire]);

  return {
    dismiss: retire,
    enable,
    isBusy,
    // `undetermined` only: once the OS has an answer the CTA is both pointless
    // and unhelpful, and the Account switch takes over.
    isVisible: permission === 'undetermined' && isDismissed === false,
  };
}
