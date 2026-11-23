import { Redirect } from 'expo-router';

import { HOME_WATCHLIST_HREF } from '@/lib/home-profile-tab';

/**
 * Watchlist is no longer a bottom tab: it is a tab of the Home profile (Figma
 * 6642:5964), and Search took its slot in the bar. This route stays so old
 * `/wishlist` links, pushes the backend already sent, and deep links still land
 * on the watchlist — Home, with the WATCHLIST profile tab selected. Like `/you`
 * and `/portfolio`, it is not a pager page.
 */
export default function WishlistRedirect() {
  return <Redirect href={HOME_WATCHLIST_HREF as never} />;
}
