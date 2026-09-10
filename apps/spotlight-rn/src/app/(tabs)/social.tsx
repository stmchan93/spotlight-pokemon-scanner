import { StatusBar } from 'expo-status-bar';

import { NativeTabsPageBridge } from '@/components/native-tabs-page-bridge';
import { GuestScannerRedirect } from '@/features/auth/components/guest-scanner-redirect';
import { FeedScreen } from '@/features/social/screens/feed-screen';
import { useAuth } from '@/providers/auth-provider';

/**
 * Social — the feed of posts and market trends, and the last tab in the bar.
 *
 * It briefly WAS the tabs root, under the name Home. The app now opens on your
 * collection instead, so the feed moved here and Collection took `(tabs)/index`
 * back. The screen itself is unchanged by either move.
 *
 * Bridged as 'portfolio', not because this screen is the portfolio, but because
 * `activePage` only distinguishes "the scanner is live" from "it isn't", and
 * here it isn't. Passing 'scanner' would mount the camera from the Social tab.
 * Wishlist is bridged the same way for the same reason.
 */
export default function SocialRoute() {
  // Guests land on the scanner, which is the whole of the guest experience: the
  // feed reads are scoped to `auth.uid()` by RLS, so a guest would get an empty
  // list rather than a first-launch surface worth seeing.
  const { isGuest } = useAuth();
  if (isGuest) {
    return <GuestScannerRedirect />;
  }

  return (
    <NativeTabsPageBridge page="portfolio">
      <StatusBar style="dark" />
      <FeedScreen />
    </NativeTabsPageBridge>
  );
}
