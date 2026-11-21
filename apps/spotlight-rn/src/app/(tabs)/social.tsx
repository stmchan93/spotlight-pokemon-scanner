import { FocusedStatusBar } from '@/components/focused-status-bar';
import { GuestTabSignIn } from '@/features/auth/components/guest-tab-sign-in';
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
  // Guests get a sign-in page in place (no redirect: it fought the swipe pager). The
  // feed reads are scoped to `auth.uid()` by RLS, so a guest would get an empty
  // list rather than a first-launch surface worth seeing.
  const { isGuest } = useAuth();
  if (isGuest) {
    return <GuestTabSignIn message="Follow collectors, share your pulls, and see what the market is doing." title="Sign in to join the community" />;
  }

  return (
    <>
      <FocusedStatusBar style="dark" />
      <FeedScreen />
    </>
  );
}
