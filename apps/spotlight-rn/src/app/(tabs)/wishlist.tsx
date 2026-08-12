import { Redirect } from 'expo-router';
import { StatusBar } from 'expo-status-bar';

import { NativeTabsPageBridge } from '@/components/native-tabs-page-bridge';
import { WishlistScreen } from '@/features/wishlist/screens/wishlist-screen';
import { useAuth } from '@/providers/auth-provider';

/**
 * Wishlist, promoted from a PUSHED stack screen to a tab. `(stack)/wishlist`
 * was removed in the same change — leaving both would have given `/wishlist`
 * two routes.
 *
 * Bridged as 'portfolio': `activePage` only distinguishes "the scanner is live"
 * from "it isn't", and here it isn't. Passing 'scanner' would mount the camera
 * from the Wishlist tab.
 */
export default function WishlistRoute() {
  const { isGuest } = useAuth();

  // Redirect for guests, the same as Home and You — NOT the screen's own
  // "bounce to login" effect. NativeTabs mounts tab screens eagerly, so on a
  // first launch that effect ran before the user had touched this tab and threw
  // the login modal over the scanner: a fresh install looked like it opened on
  // a login wall. Redirecting at the ROUTE keeps the screen from mounting at
  // all, which is why the sibling tabs never had the problem.
  if (isGuest) {
    return <Redirect href={'/scan' as never} />;
  }

  return (
    <NativeTabsPageBridge page="portfolio">
      <StatusBar style="dark" />
      <WishlistScreen />
    </NativeTabsPageBridge>
  );
}
