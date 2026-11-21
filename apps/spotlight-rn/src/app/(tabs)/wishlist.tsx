import { FocusedStatusBar } from '@/components/focused-status-bar';
import { GuestTabSignIn } from '@/features/auth/components/guest-tab-sign-in';
import { WishlistScreen } from '@/features/wishlist/screens/wishlist-screen';
import { useAuth } from '@/providers/auth-provider';

/**
 * Wishlist, promoted from a PUSHED stack screen to a tab. `(stack)/wishlist`
 * was removed in the same change — leaving both would have given `/wishlist`
 * two routes.
 */
export default function WishlistRoute() {
  const { isGuest } = useAuth();
  // Guests can't reach this tab (the tab bar sends them to sign-in); this only
  // catches a deep link, without bouncing them around the pager.
  if (isGuest) {
    return <GuestTabSignIn message="Watch cards and get an alert when they hit your price." title="Sign in to use your Watchlist" />;
  }
  return (
    <>
      <FocusedStatusBar style="dark" />
      <WishlistScreen />
    </>
  );
}
