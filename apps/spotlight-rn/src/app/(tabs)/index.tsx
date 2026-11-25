import { useCallback, useEffect } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { GuestScannerRedirect } from '@/features/auth/components/guest-scanner-redirect';
import {
  cardDetailPreviewFromInventoryEntry,
  saveCardDetailPreviewFromInventoryEntry,
} from '@/features/cards/card-detail-preview-session';
import {
  defaultLaneFromPreview,
  prefetchCardDetail,
} from '@/features/cards/card-detail-prefetch';
import { PortfolioScreen } from '@/features/portfolio/screens/portfolio-screen';
import { useAppServices } from '@/providers/app-providers';
import { useAuth } from '@/providers/auth-provider';
import { HOME_PROFILE_TAB_PARAM, parseHomeProfileTabParam } from '@/lib/home-profile-tab';
import { MARKET_ANALYTICS_HREF, WATCHLIST_HREF } from '@/lib/watchlist-tab';

/**
 * Home — your own collection, and the landing surface after login.
 *
 * This screen has been here twice. It was the tabs root originally, moved to
 * `(tabs)/you` when the feed was promoted to Home, and came back when the tabs
 * were reordered so the app opens on your cards again. The feed went the other
 * way and now lives at `(tabs)/social`, last in the bar. Only the routes moved
 * in either direction — `PortfolioScreen` and `FeedScreen` are untouched.
 *
 * `(tabs)/you` and `(tabs)/portfolio` are redirects here, so old links and the
 * "tapped my own name in the feed" navigation still land on the collection.
 *
 * NO `<StatusBar>` HERE. `PortfolioScreen` owns one, and it is scroll-aware:
 * white over the profile cover, dark once the white sheet is pinned under the
 * bar. A second, fixed `dark` at this level did not merely duplicate it — both
 * set the style process-wide, so the route's `dark` kept winning and the cover
 * never got its white time/battery at all.
 */
export default function HomeRoute() {
  const router = useRouter();
  const { spotlightRepository } = useAppServices();
  const { isGuest } = useAuth();
  // `/?tab=watchlist|masterset|market|collection` opens Home on that profile tab.
  const requestedProfileTab = parseHomeProfileTabParam(useLocalSearchParams()[HOME_PROFILE_TAB_PARAM]);
  const clearRequestedProfileTab = useCallback(() => {
    router.setParams({ [HOME_PROFILE_TAB_PARAM]: undefined } as never);
  }, [router]);
  // Watchlist and Market Analytics moved to the WATCHLIST bottom tab; old
  // `/?tab=watchlist|market` links (pushes, assistant replies) land there.
  useEffect(() => {
    if (requestedProfileTab === 'watchlist' || requestedProfileTab === 'market') {
      router.replace(requestedProfileTab === 'market' ? MARKET_ANALYTICS_HREF : WATCHLIST_HREF);
    }
  }, [requestedProfileTab, router]);
  // Signed in, the app opens on the Scanner; Home is only the route it starts on.

  // Collection is gated for guests, so there is nothing to show them here. Send
  // them a sign-in page in place (no redirect: it fought the swipe pager).
  if (isGuest) {
    return <GuestScannerRedirect />;
  }

  return (
    <PortfolioScreen
      onRequestedProfileTabHandled={clearRequestedProfileTab}
      requestedProfileTab={requestedProfileTab}
      onOpenInventoryEntry={(entry) => {
        const preview = cardDetailPreviewFromInventoryEntry(entry);
        prefetchCardDetail(
          spotlightRepository,
          entry.cardId,
          defaultLaneFromPreview(preview),
          preview.largeImageUrl ?? preview.imageUrl,
        );
        router.push({
          pathname: '/cards/[cardId]',
          params: {
            cardId: entry.cardId,
            entryId: entry.id,
            previewId: saveCardDetailPreviewFromInventoryEntry(entry),
          },
        });
      }}
    />
  );
}
