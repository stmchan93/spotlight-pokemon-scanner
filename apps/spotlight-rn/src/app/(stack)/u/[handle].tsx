import { useLocalSearchParams, useRouter } from 'expo-router';

import { saveCardDetailPreviewFromInventoryEntry } from '@/features/cards/card-detail-preview-session';
import { PublicProfileScreen } from '@/features/profile/screens/public-profile-screen';

// A Supabase auth id. Handles are `[a-z0-9_]{3,20}` and can never look like
// this, so one route segment can serve both lanes unambiguously.
const USER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function firstParam(value?: string | string[]) {
  if (Array.isArray(value)) {
    return value.find((candidate) => candidate.trim().length > 0) ?? '';
  }

  return value ?? '';
}

/**
 * Public profile route: `/u/<handle>`, or `/u/<user-id>` for collectors who
 * haven't claimed a handle yet. An explicit `?userId=` always wins, so a caller
 * that already knows the id can skip the handle lookup entirely.
 */
export default function PublicProfileRoute() {
  const router = useRouter();
  const params = useLocalSearchParams<{
    handle?: string | string[];
    userId?: string | string[];
    tab?: string | string[];
  }>();

  const slug = firstParam(params.handle).trim().replace(/^@+/, '');
  const explicitUserId = firstParam(params.userId).trim();
  const slugIsUserId = USER_ID_PATTERN.test(slug);
  // `?tab=` comes from a shared deep link (`profile-link.ts`). Anything we don't
  // recognise is IGNORED rather than an error: an old link naming a tab that no
  // longer exists should still open the profile, just on its default page.
  const requestedTab = firstParam(params.tab).trim().toLowerCase();
  const initialTab = requestedTab === 'wishlist' ? 'wishlist' : undefined;

  const handle = slugIsUserId || !slug ? undefined : slug;
  const userId = explicitUserId || (slugIsUserId ? slug : undefined);

  if (!handle && !userId) {
    return null;
  }

  return (
    <PublicProfileScreen
      key={`${handle ?? ''}:${userId ?? ''}`}
      handle={handle}
      initialTab={initialTab}
      onBack={() => router.back()}
      onOpenEntry={(entry) => {
        // Someone else's copy: pass the card + a display preview, but never the
        // deck entry id — that identifies THEIR row and would read as an owned
        // entry on the PDP.
        router.push({
          pathname: '/cards/[cardId]',
          params: {
            cardId: entry.cardId,
            previewId: saveCardDetailPreviewFromInventoryEntry(entry),
          },
        });
      }}
      userId={userId}
    />
  );
}
