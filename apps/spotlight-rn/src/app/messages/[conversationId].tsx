import { useLocalSearchParams } from 'expo-router';

import { DmThreadScreen } from '@/features/social/screens/dm-thread-screen';

/**
 * One DM thread at `/messages/<conversationId>`.
 *
 * This directory deliberately has NO `_layout.tsx`: without one the route joins
 * the ROOT stack alongside `/messages` instead of mounting a nested navigator.
 * See `src/app/messages.tsx` for why that distinction is load-bearing.
 *
 * `?name=` is the other participant's already-resolved display name, handed over
 * by the inbox row. The data layer has no fetch-one-conversation read, so without
 * it the header would either be blank or cost a full inbox query.
 */
function firstParam(value?: string | string[]): string {
  if (Array.isArray(value)) {
    return value.find((candidate) => candidate.trim().length > 0) ?? '';
  }
  return value ?? '';
}

export default function DmThreadRoute() {
  const params = useLocalSearchParams<{
    conversationId?: string | string[];
    name?: string | string[];
    handle?: string | string[];
    avatar?: string | string[];
    userId?: string | string[];
  }>();

  const conversationId = firstParam(params.conversationId).trim();
  const name = firstParam(params.name).trim();
  const handle = firstParam(params.handle).trim();
  const avatarUrl = firstParam(params.avatar).trim();
  const userId = firstParam(params.userId).trim();

  if (!conversationId) {
    return null;
  }

  return (
    // Keyed so navigating between two threads remounts rather than leaking the
    // previous thread's messages into the new one's state.
    <DmThreadScreen
      conversationId={conversationId}
      key={conversationId}
      // Handed over by the inbox for the same reason `name` is: the data layer
      // has no fetch-one-conversation read, and the inbox already holds all of
      // this. Anything missing simply degrades — no avatar, or a header that
      // does not navigate — rather than blocking the thread from opening.
      otherUser={{
        avatarUrl: avatarUrl || null,
        displayName: name || null,
        handle: handle || null,
        userId: userId || null,
      }}
      title={name || undefined}
    />
  );
}
