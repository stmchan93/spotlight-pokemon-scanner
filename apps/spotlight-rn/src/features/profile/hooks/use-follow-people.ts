import { useEffect, useMemo, useState } from 'react';

import type { UserProfile } from '@/features/auth/auth-models';
import { fetchFollowers, fetchFollowing, rankSearchMatches } from '@/features/profile/profile-service';

/** Search's PEOPLE chips (Figma 6725:9757): ALL is the people search; the others are the viewer's own lists. */
export type PeopleRelation = 'all' | 'followers' | 'following';

export type FollowPeople = {
  /** The viewer's list, narrowed to the typed query. */
  profiles: UserProfile[];
  isLoading: boolean;
  trimmedQuery: string;
};

/** Case-insensitive match on name or @handle; spaces ignored for handles ("stephen chan" → @stephenchan). */
export function filterProfilesByQuery(profiles: UserProfile[], query: string): UserProfile[] {
  const needle = query.trim().replace(/^@+/, '').toLowerCase();
  if (needle.length === 0) {
    return profiles;
  }
  const handleNeedle = needle.replace(/ /g, '');
  return rankSearchMatches(
    profiles.filter(
      (profile) =>
        (profile.displayName ?? '').toLowerCase().includes(needle) ||
        (profile.handle ?? '').toLowerCase().includes(handleNeedle),
    ),
    needle,
  );
}

/**
 * The viewer's followers or following, read once per chip selection and
 * filtered on device by the query — the lists are capped at 100, so a server
 * search per keystroke would buy nothing. Idle (no read) for `all` or no viewer.
 */
export function useFollowPeople(
  relation: PeopleRelation,
  query: string,
  { viewerId, enabled = true }: { viewerId: string | null; enabled?: boolean },
): FollowPeople {
  const [list, setList] = useState<UserProfile[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const active = enabled && viewerId != null && relation !== 'all';

  useEffect(() => {
    if (!active || viewerId == null) {
      setIsLoading(false);
      return undefined;
    }
    let cancelled = false;
    setList([]);
    setIsLoading(true);
    const read = relation === 'followers' ? fetchFollowers : fetchFollowing;
    void read(viewerId)
      .catch(() => [] as UserProfile[])
      .then((profiles) => {
        if (!cancelled) {
          setList(profiles);
          setIsLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [active, relation, viewerId]);

  const trimmedQuery = query.trim();
  const profiles = useMemo(
    () => (active ? filterProfilesByQuery(list, trimmedQuery) : []),
    [active, list, trimmedQuery],
  );

  return { isLoading: active && isLoading, profiles, trimmedQuery };
}
