import { useLocalSearchParams, useNavigation } from 'expo-router';
import { useEffect } from 'react';

import { FocusedStatusBar } from '@/components/focused-status-bar';
import { FeedScreen, GuestSocialScreen, parseSocialTab } from '@/features/social/screens/feed-screen';
import { useAuth } from '@/providers/auth-provider';

/**
 * Social — FOR YOU (posts + news by date), YOUR POSTS and EVENTS (the upcoming
 * shows list, formerly its own tab). `/social?tab=events|forYou|yourPosts`
 * opens on that page; `/events` redirects here.
 */
export default function SocialRoute() {
  const { isGuest } = useAuth();
  const params = useLocalSearchParams<{ tab?: string }>();
  const requestedTab = parseSocialTab(params.tab);
  const navigation = useNavigation();

  // Consume the param once the page has switched, so the same link again still switches.
  useEffect(() => {
    if (params.tab !== undefined) {
      navigation.setParams({ tab: undefined } as never);
    }
  }, [navigation, params.tab]);

  return (
    <>
      <FocusedStatusBar style="dark" />
      {/* Guests get EVENTS only; the feed reads are scoped to `auth.uid()` by RLS. */}
      {isGuest ? <GuestSocialScreen /> : <FeedScreen requestedTab={requestedTab} />}
    </>
  );
}
