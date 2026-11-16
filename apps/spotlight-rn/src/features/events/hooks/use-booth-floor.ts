import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useFocusEffect } from 'expo-router';

import { groupBoothPosts } from '@/features/events/booth-format';
import {
  fetchBoothClaims,
  fetchBoothPosts,
  fetchHotBooths,
  suggestMyBooth,
  type BoothClaim,
  type BoothPost,
} from '@/features/events/booth-service';
import { EVENT_PRESENCE_INTERVAL_MS } from '@/features/events/hooks/use-event-presence';
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
  /**
   * The signed-in user already holds a booth at this show. One booth per person
   * (user, 2026-11-16): every claim prompt hides once this is true.
   */
  hasMyBooth: boolean;
  /** Vendors whose Treasure email is the signed-in user's ("This is you"). */
  suggestedVendorIds: readonly string[];
  /** Vendors with recent card opens from several people, hottest first (no counts). */
  hotVendorIds: ReadonlySet<string>;
  refreshClaims: () => void;
};

const NO_CLAIMS: ReadonlyMap<string, BoothClaim> = new Map();
const NO_IDS: readonly string[] = [];

/**
 * Claims and booth posts for one show, loaded once per screen rather than per
 * card. Missing tables resolve to empty values, which renders today's map.
 */
export function useBoothFloor(eventId: string, vendorIds: readonly string[] | null): BoothFloor {
  const { currentUser } = useAuth();
  const myUserId = currentUser?.id ?? null;
  const [claims, setClaims] = useState<ReadonlyMap<string, BoothClaim> | null>(null);
  const [posts, setPosts] = useState<readonly BoothPost[]>([]);
  const [suggested, setSuggested] = useState<readonly string[]>(NO_IDS);
  const [hot, setHot] = useState<readonly string[]>(NO_IDS);
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

  // Who "this is you" points at depends on the signed-in email, so it follows sign-in.
  useEffect(() => {
    if (!eventId || !myUserId) {
      setSuggested(NO_IDS);
      return;
    }
    void suggestMyBooth(eventId).then((next) => {
      if (alive.current) {
        setSuggested(next);
      }
    });
  }, [eventId, myUserId]);

  // Heat on the presence cadence, while the show page is focused.
  useFocusEffect(
    useCallback(() => {
      if (!eventId) {
        return undefined;
      }
      let active = true;
      const tick = () =>
        void fetchHotBooths(eventId).then((next) => {
          if (active && alive.current) {
            setHot((current) => (current.join('|') === next.join('|') ? current : next));
          }
        });
      tick();
      const timer = setInterval(tick, EVENT_PRESENCE_INTERVAL_MS);
      return () => {
        active = false;
        clearInterval(timer);
      };
    }, [eventId]),
  );

  const { byVendor, freshVendorIds } = useMemo(() => groupBoothPosts(posts), [posts]);
  const hotVendorIds = useMemo(() => new Set(hot), [hot]);

  return useMemo(
    () => ({
      enabled: claims != null,
      claims: claims ?? NO_CLAIMS,
      posts,
      postsByVendor: byVendor,
      freshVendorIds,
      myUserId,
      hasMyBooth:
        myUserId != null && [...(claims ?? NO_CLAIMS).values()].some((claim) => claim.userId === myUserId),
      suggestedVendorIds: suggested,
      hotVendorIds,
      refreshClaims: loadClaims,
    }),
    [byVendor, claims, freshVendorIds, hotVendorIds, loadClaims, myUserId, posts, suggested],
  );
}
