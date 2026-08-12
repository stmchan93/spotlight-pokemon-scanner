import { StatusBar } from 'expo-status-bar';

import { NativeTabsPageBridge } from '@/components/native-tabs-page-bridge';
import { WishlistScreen } from '@/features/wishlist/screens/wishlist-screen';

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
  return (
    <NativeTabsPageBridge page="portfolio">
      <StatusBar style="dark" />
      <WishlistScreen />
    </NativeTabsPageBridge>
  );
}
