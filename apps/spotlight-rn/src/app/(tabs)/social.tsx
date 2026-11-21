import { FocusedStatusBar } from '@/components/focused-status-bar';
import { GuestScannerRedirect } from '@/features/auth/components/guest-scanner-redirect';
import { FeedScreen } from '@/features/social/screens/feed-screen';
import { useAuth } from '@/providers/auth-provider';

/**
 * Social — the feed of posts and market trends, and the last tab in the bar.
 *
 * It briefly WAS the tabs root, under the name Home. The app now opens on your
 * collection instead, so the feed moved here and Collection took `(tabs)/index`
 * back. The screen itself is unchanged by either move.
 */
export default function SocialRoute() {
  // Social needs an account (feed reads are scoped to `auth.uid()` by RLS), so a
  // guest who taps it gets the login page, over the scanner they came from.
  const { isGuest } = useAuth();
  if (isGuest) {
    return <GuestScannerRedirect promptLogin />;
  }

  return (
    <>
      <FocusedStatusBar style="dark" />
      <FeedScreen />
    </>
  );
}
