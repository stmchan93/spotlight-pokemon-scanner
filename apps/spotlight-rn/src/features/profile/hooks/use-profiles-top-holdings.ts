import { useEffect, useRef, useState } from 'react';

import type { InventoryCardEntry } from '@spotlight/api-client';

import { useAppServices } from '@/providers/app-providers';

/** The backend's per-request cap on collectors. */
export const TOP_HOLDINGS_BATCH_SIZE = 20;
/** Cards on one person's rail. */
export const TOP_HOLDINGS_PER_PERSON = 6;

export type TopHoldingsState =
  | { status: 'loading' }
  | { status: 'ready'; entries: InventoryCardEntry[] }
  /** The read failed or the backend could not reach this collector: no rail. */
  | { status: 'unavailable' };

/**
 * Each listed collector's most valuable public holdings, read in batches of
 * {@link TOP_HOLDINGS_BATCH_SIZE} through `getProfilesTopHoldings` — one request
 * for a whole page of people, never one per row. Results are kept for the life
 * of the screen, so retyping a query does not refetch people already shown.
 */
export function useProfilesTopHoldings(userIds: readonly string[]): Record<string, TopHoldingsState> {
  const { spotlightRepository } = useAppServices();
  const [byUser, setByUser] = useState<Record<string, TopHoldingsState>>({});
  const requestedRef = useRef(new Set<string>());
  const key = userIds.join(',');

  useEffect(() => {
    const missing = key
      .split(',')
      .filter((id) => id.length > 0 && !requestedRef.current.has(id));
    if (missing.length === 0) {
      return;
    }
    missing.forEach((id) => requestedRef.current.add(id));
    setByUser((current) => {
      const next = { ...current };
      missing.forEach((id) => {
        next[id] = { status: 'loading' };
      });
      return next;
    });
    for (let index = 0; index < missing.length; index += TOP_HOLDINGS_BATCH_SIZE) {
      const batch = missing.slice(index, index + TOP_HOLDINGS_BATCH_SIZE);
      void spotlightRepository
        .getProfilesTopHoldings(batch, { limit: TOP_HOLDINGS_PER_PERSON })
        .then((profiles) => {
          const answered = new Map(profiles.map((profile) => [profile.userId.toLowerCase(), profile]));
          setByUser((current) => {
            const next = { ...current };
            batch.forEach((id) => {
              const profile = answered.get(id.toLowerCase());
              next[id] = profile?.available
                ? { entries: profile.entries, status: 'ready' }
                : { status: 'unavailable' };
            });
            return next;
          });
        })
        .catch(() => {
          // Forget the failure so the next visit to these people can retry.
          batch.forEach((id) => requestedRef.current.delete(id));
          setByUser((current) => {
            const next = { ...current };
            batch.forEach((id) => {
              next[id] = { status: 'unavailable' };
            });
            return next;
          });
        });
    }
  }, [key, spotlightRepository]);

  return byUser;
}
