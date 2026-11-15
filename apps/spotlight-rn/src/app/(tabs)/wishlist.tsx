import { FocusedStatusBar } from '@/components/focused-status-bar';
import { WishlistScreen } from '@/features/wishlist/screens/wishlist-screen';

/**
 * Wishlist, promoted from a PUSHED stack screen to a tab. `(stack)/wishlist`
 * was removed in the same change — leaving both would have given `/wishlist`
 * two routes.
 */
export default function WishlistRoute() {
  return (
    <>
      <FocusedStatusBar style="dark" />
      <WishlistScreen />
    </>
  );
}
