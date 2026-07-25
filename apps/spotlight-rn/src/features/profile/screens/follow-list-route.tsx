import { useEffect, useState } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';

import type { UserProfile } from '@/features/auth/auth-models';
import {
  fetchProfileByHandle,
  fetchProfileById,
} from '@/features/profile/profile-service';
import { FollowListScreen } from '@/features/profile/screens/follow-list-screen';

// A Supabase auth id. Handles are `[a-z0-9_]{3,20}` and can never look like this,
// so one `/u/<segment>` serves both lanes unambiguously — mirrors `[handle].tsx`.
const USER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function firstParam(value?: string | string[]) {
  if (Array.isArray(value)) {
    return value.find((candidate) => candidate.trim().length > 0) ?? '';
  }
  return value ?? '';
}

/**
 * Shared body for the `/u/[handle]/followers` and `/u/[handle]/following` routes.
 * Resolves the routed handle (or user id) to a Supabase user id the same way the
 * public profile route does, then renders {@link FollowListScreen}. In-app
 * navigation always passes `?userId=`, so the fast path skips the handle lookup;
 * a bare deep link by handle falls back to resolving it.
 */
export function FollowListRoute({ mode }: { mode: 'followers' | 'following' }) {
  const router = useRouter();
  const params = useLocalSearchParams<{
    handle?: string | string[];
    userId?: string | string[];
    title?: string | string[];
  }>();

  const slug = firstParam(params.handle).trim().replace(/^@+/, '');
  const explicitUserId = firstParam(params.userId).trim();
  const slugIsUserId = USER_ID_PATTERN.test(slug);
  const title = firstParam(params.title).trim() || undefined;

  // The id we can resolve synchronously: an explicit `?userId=`, or a slug that
  // is itself a user id.
  const directUserId = explicitUserId || (slugIsUserId ? slug : '');
  const handle = slugIsUserId || !slug ? undefined : slug;

  const [resolvedUserId, setResolvedUserId] = useState<string | null>(
    directUserId || null,
  );

  // Only runs on a handle-only deep link (no id in hand). Resolve to a user id
  // through the same moderation-filtered reads as the profile screen.
  useEffect(() => {
    if (directUserId) {
      setResolvedUserId(directUserId);
      return;
    }
    if (!handle) {
      setResolvedUserId(null);
      return;
    }

    let cancelled = false;
    setResolvedUserId(null);
    void (async () => {
      const byHandle: UserProfile | null = await fetchProfileByHandle(handle);
      const resolved = byHandle ?? (slug ? await fetchProfileById(slug) : null);
      if (!cancelled) {
        setResolvedUserId(resolved?.userID ?? '');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [directUserId, handle, slug]);

  if (!resolvedUserId) {
    // No id yet: either still resolving the handle, or nothing to show. The
    // screen renders its own loading state from an empty id.
    return (
      <FollowListScreen mode={mode} onBack={() => router.back()} title={title} userID="" />
    );
  }

  return (
    <FollowListScreen
      mode={mode}
      onBack={() => router.back()}
      title={title}
      userID={resolvedUserId}
    />
  );
}
