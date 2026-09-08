import { useCallback, useEffect, useSyncExternalStore } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * "Macro lens lock" — scan from the ultra-wide lens only.
 *
 * The scanner normally opens the ultra-wide + wide + telephoto virtual device so
 * iOS Auto-Macro can hand a close-held card to the ultra-wide (the main lens on
 * Pro phones can't focus inside ~20cm). That hand-off is what users see as the
 * preview "snapping" or refocusing right as they bring a card in (confirmed at
 * ~15cm on iPhone 14 Pro Max, 2026-09-07). Locking to the ultra-wide removes the
 * switch entirely — the ultra-wide focuses down to ~2cm — at the cost of scanning
 * off a softer sensor, digitally zoomed to the normal field of view.
 *
 * Only worth it where the ultra-wide has autofocus (Pro models). Non-Pro
 * ultra-wides are fixed-focus, so the lock would blur every scan there; the
 * resolver below falls back to the multi-lens device in that case.
 */

export const SCANNER_MACRO_LENS_LOCK_STORAGE_KEY = '@spotlight/scanner/macro-lens-lock';

type LensCapableDevice = {
  /** vision-camera v5: true when the device can lock focus, i.e. has autofocus. */
  supportsFocusLocking?: boolean;
  supportsFocusMetering?: boolean;
};

export function resolveScannerCameraDevice<TDevice extends LensCapableDevice>({
  lockMacroLens,
  multiLensDevice,
  ultraWideDevice,
}: {
  lockMacroLens: boolean;
  multiLensDevice: TDevice | null | undefined;
  ultraWideDevice: TDevice | null | undefined;
}): TDevice | null {
  if (lockMacroLens && ultraWideDevice && ultraWideCanFocus(ultraWideDevice)) {
    return ultraWideDevice;
  }
  return multiLensDevice ?? null;
}

function ultraWideCanFocus(device: LensCapableDevice): boolean {
  return device.supportsFocusLocking === true || device.supportsFocusMetering === true;
}

// Module-level store so the Account-screen toggle and the scanner (different
// pager pages, both mounted) see the same value without a provider.
let macroLensLock = false;
let hydrated = false;
let hydrating: Promise<void> | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function hydrate(): Promise<void> {
  if (hydrated) {
    return Promise.resolve();
  }
  if (!hydrating) {
    hydrating = AsyncStorage.getItem(SCANNER_MACRO_LENS_LOCK_STORAGE_KEY)
      .then((stored) => {
        macroLensLock = stored === '1';
      })
      .catch(() => {
        // keep the default; the toggle still works in-memory
      })
      .finally(() => {
        hydrated = true;
        hydrating = null;
        emit();
      });
  }
  return hydrating;
}

export function setScannerMacroLensLock(next: boolean): void {
  macroLensLock = next;
  emit();
  void AsyncStorage.setItem(SCANNER_MACRO_LENS_LOCK_STORAGE_KEY, next ? '1' : '0').catch(() => {
    // ignore persistence failure — in-memory state still reflects the choice
  });
}

/** Test-only: reset the module store between cases. */
export function resetScannerMacroLensLockForTests(): void {
  macroLensLock = false;
  hydrated = false;
  hydrating = null;
}

export function useScannerMacroLensLock(): [boolean, (next: boolean) => void, boolean] {
  const enabled = useSyncExternalStore(subscribe, () => macroLensLock, () => false);
  const isHydrated = useSyncExternalStore(subscribe, () => hydrated, () => false);
  useEffect(() => {
    void hydrate();
  }, []);
  const setEnabled = useCallback((next: boolean) => {
    setScannerMacroLensLock(next);
  }, []);
  return [enabled, setEnabled, isHydrated];
}
