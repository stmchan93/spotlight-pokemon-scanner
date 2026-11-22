import { useCallback, useEffect, useState } from 'react';

import type { VendorSettings } from '@spotlight/api-client';

import { useAppServices } from '@/providers/app-providers';

import { cloneVendorSettings } from './vendor-pricing';

// The server row is the source of truth; this is an in-memory cache keyed by
// `sessionOwnerKey`, so the scanner and the settings screen agree and another
// account's rates can never apply after a sign-in switch. Not persisted.
const cache = new Map<string, VendorSettings>();
const listeners = new Set<() => void>();
// One stable object, so screens can use `settings` as a memo dependency.
const defaults = cloneVendorSettings();

function notify() {
  listeners.forEach((listener) => listener());
}

/** Test hook: drop every cached account. */
export function resetVendorSettingsCache() {
  cache.clear();
  notify();
}

export type UseVendorSettings = {
  /** Cached server value, else the defaults until the first read lands. */
  settings: VendorSettings;
  loaded: boolean;
  /** Partial write; resolves false (and keeps the old value) on failure. */
  save: (patch: Partial<VendorSettings>) => Promise<boolean>;
};

export function useVendorSettings(): UseVendorSettings {
  const { sessionOwnerKey, spotlightRepository } = useAppServices();
  const [, setVersion] = useState(0);

  useEffect(() => {
    const listener = () => setVersion((value) => value + 1);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  useEffect(() => {
    if (cache.has(sessionOwnerKey)) {
      return;
    }
    let cancelled = false;
    void spotlightRepository.getVendorSettings().then((next) => {
      if (!cancelled && next) {
        cache.set(sessionOwnerKey, next);
        notify();
      }
    }).catch(() => {
      // Defaults stand; the next mount retries.
    });
    return () => {
      cancelled = true;
    };
  }, [sessionOwnerKey, spotlightRepository]);

  const save = useCallback(async (patch: Partial<VendorSettings>) => {
    try {
      const next = await spotlightRepository.setVendorSettings(patch);
      if (!next) {
        return false;
      }
      cache.set(sessionOwnerKey, next);
      notify();
      return true;
    } catch {
      return false;
    }
  }, [sessionOwnerKey, spotlightRepository]);

  const cached = cache.get(sessionOwnerKey);
  return {
    settings: cached ?? defaults,
    loaded: cached != null,
    save,
  };
}
