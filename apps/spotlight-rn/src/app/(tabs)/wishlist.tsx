import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback } from 'react';

import { FocusedStatusBar } from '@/components/focused-status-bar';
import { GuestScannerRedirect } from '@/features/auth/components/guest-scanner-redirect';
import { WatchlistTabScreen } from '@/features/wishlist/screens/watchlist-tab-screen';
import { WATCHLIST_TAB_PARAM, parseWatchlistPageTabParam } from '@/lib/watchlist-tab';
import { useAuth } from '@/providers/auth-provider';

/**
 * WATCHLIST — the bottom tab (Figma 6775:16938) with two pages: WATCHLIST and
 * MARKET ANALYTICS. `/wishlist?tab=market` opens on MARKET ANALYTICS. The route
 * keeps its internal `wishlist` name so pushes already sent still land here.
 */
export default function WatchlistRoute() {
  const { isGuest } = useAuth();
  const router = useRouter();
  const requestedTab = parseWatchlistPageTabParam(useLocalSearchParams()[WATCHLIST_TAB_PARAM]);
  // Consume the param once the page has switched, so the same link again still switches.
  const clearRequestedTab = useCallback(() => {
    router.setParams({ [WATCHLIST_TAB_PARAM]: undefined } as never);
  }, [router]);

  // The watchlist is an account's; guests get the sign-in page in place, as on Home.
  if (isGuest) {
    return <GuestScannerRedirect />;
  }

  return (
    <>
      <FocusedStatusBar style="dark" />
      <WatchlistTabScreen onRequestedTabHandled={clearRequestedTab} requestedTab={requestedTab} />
    </>
  );
}
