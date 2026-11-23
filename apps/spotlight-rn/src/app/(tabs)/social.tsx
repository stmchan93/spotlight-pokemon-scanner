import { FocusedStatusBar } from '@/components/focused-status-bar';
import { GuestScannerRedirect } from '@/features/auth/components/guest-scanner-redirect';
import { FeedScreen } from '@/features/social/screens/feed-screen';
import { useAuth } from '@/providers/auth-provider';

/**
 * Social — FOR YOU (posts + news by date) and YOUR POSTS, the last tab in the bar.
 *
 * It briefly WAS the tabs root, under the name Home. The app now opens on your
 * collection instead, so the feed moved here and Collection took `(tabs)/index`
 * back. The screen itself is unchanged by either move.
 */
export default function SocialRoute() {
  // Guests get a sign-in page in place (no redirect: it fought the swipe pager). The
  // feed reads are scoped to `auth.uid()` by RLS, so a guest would get an empty
  // list rather than a first-launch surface worth seeing.
  const { isGuest } = useAuth();
  if (isGuest) {
    return <GuestScannerRedirect />;
  }

  return (
    <>
      <FocusedStatusBar style="dark" />
      <FeedScreen />
    </>
  );
}
