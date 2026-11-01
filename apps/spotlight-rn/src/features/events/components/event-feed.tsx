import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { Plus } from 'iconoir-react-native';

import { Button, StateCard, layout, spacing, useSpotlightTheme } from '@spotlight/design-system';

import { useActiveShow } from '@/features/events/hooks/use-active-show';
import { useEventFeed } from '@/features/events/hooks/use-event-feed';
import { PostCard } from '@/features/social/components/post-card';
import { getFeedRefreshVersion } from '@/features/social/screens/new-post-screen';
import { usePostDeletion } from '@/features/social/use-post-deletion';
import { AnalyticsEvent } from '@/lib/observability/analytics-events';
import { capturePostHogEvent } from '@/lib/observability/posthog';
import { resolveRepositoryBaseUrl } from '@/providers/app-providers';
import { useAuth } from '@/providers/auth-provider';

export type EventFeedHandle = {
  /** The host scroll view reached its end; fetch the next page. */
  loadMore: () => void;
};

type EventFeedProps = {
  eventId: string;
  testID?: string;
};

/**
 * A show's feed on its page: booth and attendee posts tagged to it, newest
 * first. Rendered inside the page's ScrollView (not a list of its own), so the
 * page drives paging through the handle.
 */
export const EventFeed = forwardRef<EventFeedHandle, EventFeedProps>(function EventFeed(
  { eventId, testID = 'event-feed' },
  ref,
) {
  const theme = useSpotlightTheme();
  const router = useRouter();
  const { accessToken, currentUser } = useAuth();
  const apiBaseUrl = resolveRepositoryBaseUrl();
  const feed = useEventFeed(eventId);
  const { loadMore, reload, setPosts } = feed;
  const canPost = useActiveShow({ eventId, enabled: currentUser != null }) != null;
  const { requestDelete, confirmSheet } = usePostDeletion(setPosts, { testID: `${testID}-delete-confirm` });

  useImperativeHandle(ref, () => ({ loadMore }), [loadMore]);

  useEffect(() => {
    capturePostHogEvent(AnalyticsEvent.eventFeedViewed, { event_id: eventId, source: 'event_page' });
  }, [eventId]);

  // Back from the composer with a new post: show it.
  const seenRefreshVersionRef = useRef(getFeedRefreshVersion());
  useFocusEffect(
    useCallback(() => {
      if (seenRefreshVersionRef.current !== getFeedRefreshVersion()) {
        seenRefreshVersionRef.current = getFeedRefreshVersion();
        reload();
      }
    }, [reload]),
  );

  const openComposer = useCallback(() => {
    router.push({ pathname: '/new-post', params: { eventId } } as never);
  }, [eventId, router]);
  const openCard = useCallback(
    (cardId: string) => router.push({ pathname: '/cards/[cardId]', params: { cardId } } as never),
    [router],
  );
  const dropAuthor = useCallback(
    (userId: string) => setPosts((current) => current.filter((post) => post.authorId !== userId)),
    [setPosts],
  );

  return (
    <View style={styles.root} testID={testID}>
      {canPost ? (
        <Button
          label="Post"
          leadingAccessory={<Plus color={theme.colors.gray0} height={16} strokeWidth={2} width={16} />}
          onPress={openComposer}
          shape="rounded"
          size="xs"
          style={styles.postButton}
          testID={`${testID}-compose`}
          variant="dark"
        />
      ) : null}
      {feed.status === 'loading' ? (
        <StateCard centered loading message="Fetching posts from the show." testID={`${testID}-loading`} title="Loading" variant="field" />
      ) : feed.status === 'error' ? (
        <StateCard
          actionLabel="Try again"
          message="The show's posts couldn't be loaded."
          onActionPress={reload}
          testID={`${testID}-error`}
          title="Couldn't load posts"
          variant="field"
        />
      ) : feed.posts.length === 0 ? (
        <StateCard
          message={canPost ? 'Be the first to post from the show.' : 'Posts from the show floor will appear here.'}
          testID={`${testID}-empty`}
          title="No posts yet"
          variant="field"
        />
      ) : (
        // Full-bleed like the main feed: cards carry their own gutters.
        <View style={styles.bleed}>
          {feed.posts.map((post) => (
            <PostCard
              accessToken={accessToken}
              apiBaseUrl={apiBaseUrl}
              eventBadgeMode="booth"
              key={post.id}
              onAuthorBlocked={dropAuthor}
              onPressCard={openCard}
              onRequestDelete={requestDelete}
              post={post}
              testID={`${testID}-post`}
            />
          ))}
        </View>
      )}
      {feed.isLoadingMore ? (
        <ActivityIndicator color={theme.colors.textSecondary} testID={`${testID}-loading-more`} />
      ) : null}
      {confirmSheet}
    </View>
  );
});

const styles = StyleSheet.create({
  root: {
    gap: spacing.sm,
  },
  postButton: {
    alignSelf: 'flex-start',
  },
  // The page body is inset by the gutter; post cards bring their own.
  bleed: {
    marginHorizontal: -layout.pageGutter,
  },
});
