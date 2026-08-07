import { NativeTabsPageBridge } from '@/components/native-tabs-page-bridge';
import { WishlistScreen } from '@/features/wishlist/screens/wishlist-screen';

/**
 * Wishlist as a native tab. It is a PUSHED stack screen in the live app
 * (`(stack)/wishlist/index.tsx`); here it is a peer tab, which is the whole
 * point of the two-tab shape — the bar needs a second destination now that Scan
 * has left it.
 *
 * Bridged as 'portfolio' because `activePage` only distinguishes "the scanner is
 * live" from "it isn't", and on this screen it isn't. Passing 'scanner' here
 * would tell `scanner-screen` to mount the camera from the Wishlist tab.
 */
export default function NativeTabsWishlist() {
  return (
    <NativeTabsPageBridge page="portfolio">
      <WishlistScreen />
    </NativeTabsPageBridge>
  );
}
