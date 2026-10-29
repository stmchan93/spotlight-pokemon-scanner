import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useFocusEffect } from 'expo-router';

import { groupBoothPosts } from '@/features/events/booth-format';
import { fetchBoothClaims, fetchBoothPosts, type BoothClaim, type BoothPost } from '@/features/events/booth-service';
import { useAuth } from '@/providers/auth-provider';

export type BoothFloor = {
  /** False until claims load (no client, or social_27 not applied): the card stays as it was, with no claim button. */
  enabled: boolean;
  claims: ReadonlyMap<string, BoothClaim>;
  /** Newest first. */
  posts: readonly BoothPost[];
  postsByVendor: ReadonlyMap<string, BoothPost[]>;
  /** Vendors with a booth post in the last 24h (the pin dot). */
  freshVendorIds: ReadonlySet<string>;
  myUserId: string | null;
  refreshClaims: () => void;
};

const NO_CLAIMS: ReadonlyMap<string, BoothClaim> = new Map();

/**
 * Claims and booth posts for one show, loaded once per screen rather than per
 * card. Missing tables resolve to empty values, which renders today's map.
 */
export function useBoothFloor(eventId: string, vendorIds: readonly string[] | null): BoothFloor {
  const { currentUser } = useAuth();
  const myUserId = currentUser?.id ?? null;
  const [claims, setClaims] = useState<ReadonlyMap<string, BoothClaim> | null>(null);
  const [posts, setPosts] = useState<readonly BoothPost[]>([]);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const vendorKey = vendorIds?.join('|') ?? '';
  const loadClaims = useCallback(() => {
    if (!vendorKey) {
      return;
    }
    void fetchBoothClaims(vendorKey.split('|')).then((next) => {
      if (alive.current) {
        setClaims(next);
      }
    });
  }, [vendorKey]);

  const loadPosts = useCallback(() => {
    if (!eventId) {
      return;
    }
    void fetchBoothPosts(eventId).then((next) => {
      if (alive.current) {
        setPosts(next);
      }
    });
  }, [eventId]);

  // Posts again on every focus, so one made in the composer shows on return.
  useFocusEffect(loadPosts);

  // Claims once the vendor list is known, and again when signing in changes who "me" is.
  useEffect(() => {
    loadClaims();
  }, [loadClaims, myUserId]);

  const { byVendor, freshVendorIds } = useMemo(() => groupBoothPosts(posts), [posts]);

  return useMemo(
    () => ({
      enabled: claims != null,
      claims: claims ?? NO_CLAIMS,
      posts,
      postsByVendor: byVendor,
      freshVendorIds,
      myUserId,
      refreshClaims: loadClaims,
    }),
    [byVendor, claims, freshVendorIds, loadClaims, myUserId, posts],
  );
}
