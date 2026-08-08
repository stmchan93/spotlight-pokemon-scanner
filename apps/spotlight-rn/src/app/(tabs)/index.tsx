import { Redirect } from 'expo-router';
import { StatusBar } from 'expo-status-bar';

import { NativeTabsPageBridge } from '@/components/native-tabs-page-bridge';
import { FeedScreen } from '@/features/social/screens/feed-screen';
import { useAuth } from '@/providers/auth-provider';

/**
 * Home — the social feed, and the landing tab after login.
 *
 * Collection used to be this route; it moved to `(tabs)/you` unchanged. The feed
 * itself was already built (71d58fd) but was only reachable at `/feed`, a pushed
 * stack route that nothing in the app linked to. Promoting it to the tabs root
 * is the whole change here — the screen is untouched.
 *
 * Bridged as 'portfolio', not because this screen is the portfolio, but because
 * `activePage` only distinguishes "the scanner is live" from "it isn't", and
 * here it isn't. Passing 'scanner' would mount the camera from the Home tab.
 * Wishlist is bridged the same way for the same reason.
 */
export default function HomeRoute() {
  // Guests land on the scanner, which is the whole of the guest experience: the
  // feed reads are scoped to `auth.uid()` by RLS, so a guest would get an empty
  // list rather than a first-launch surface worth seeing. This redirect used to
  // live on the Collection screen that occupied this route.
  const { isGuest } = useAuth();
  if (isGuest) {
    return <Redirect href={'/scan' as never} />;
  }

  return (
    <NativeTabsPageBridge page="portfolio">
      <StatusBar style="dark" />
      <FeedScreen />
    </NativeTabsPageBridge>
  );
}
