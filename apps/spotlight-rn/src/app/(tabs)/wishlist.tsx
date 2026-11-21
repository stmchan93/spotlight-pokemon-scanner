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
  const { isGuest } = useAuth();
  // Guests can't reach this tab (the tab bar sends them to sign-in); this only
  // catches a deep link, without bouncing them around the pager.
  if (isGuest) {
    return <GuestScannerRedirect />;
  }
  return (
    <>
      <FocusedStatusBar style="dark" />
      <WishlistScreen />
    </>
  );
}
