import { FocusedStatusBar } from '@/components/focused-status-bar';
import { GuestScannerRedirect } from '@/features/auth/components/guest-scanner-redirect';
import { WishlistScreen } from '@/features/wishlist/screens/wishlist-screen';
import { useAuth } from '@/providers/auth-provider';

/**
 * Wishlist, promoted from a PUSHED stack screen to a tab. `(stack)/wishlist`
 * was removed in the same change — leaving both would have given `/wishlist`
 * two routes.
 */
export default function WishlistRoute() {
  // The Watchlist needs an account: a guest gets the login page over the
  // scanner, once per visit (same as Social).
  const { isGuest } = useAuth();
  if (isGuest) {
    return <GuestScannerRedirect promptLogin />;
  }
  return (
    <>
      <FocusedStatusBar style="dark" />
      <WishlistScreen />
    </>
  );
}
