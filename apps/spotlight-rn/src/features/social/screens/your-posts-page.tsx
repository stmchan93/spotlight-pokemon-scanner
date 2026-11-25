import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from 'react';
import { RefreshControl, StyleSheet, View, type FlatList } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { StateCard, useSpotlightTheme } from '@spotlight/design-system';

import {
  AnimatedFlatList,
  type CollapsiblePageProps,
  type CollapsibleScrollTarget,
} from '@/components/page-tab-pager';
import { getResolvedDisplayName } from '@/features/auth/auth-models';
import { PostCard } from '@/features/social/components/post-card';
import { RepostAttribution } from '@/features/social/components/repost-attribution';
import { getFeedRefreshVersion } from '@/features/social/screens/new-post-screen';
import {
  type AuthorActivityItem,
  type FeedPost,
  type FeedPostAuthor,
  fetchAuthorActivity,
} from '@/features/social/social-service';
import { usePostDeletion } from '@/features/social/use-post-deletion';
import { resolveRepositoryBaseUrl } from '@/providers/app-providers';
import { useAuth } from '@/providers/auth-provider';

type Status = 'loading' | 'ready' | 'error';

type YourPostsPageProps = {
  page: CollapsiblePageProps;
  scrollRef?: RefObject<CollapsibleScrollTarget | null>;
  testID?: string;
};

/**
 * POST on Social (Figma 6769:6887 tab rail): what the viewer wrote AND
 * what they reposted, newest activity first — the list the Collection profile's
 * old Activity tab held. `fetchAuthorActivity` does the merge; it is one read
 * with no cursor, so this page does not page.
 */
export function YourPostsPage({ page, scrollRef, testID = 'your-posts' }: YourPostsPageProps) {
  const theme = useSpotlightTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { accessToken, currentUser } = useAuth();
  const apiBaseUrl = resolveRepositoryBaseUrl();
  const viewerId = currentUser?.id ?? null;

  const [items, setItems] = useState<AuthorActivityItem[]>([]);
  const [status, setStatus] = useState<Status>('loading');
  const [refreshing, setRefreshing] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const seenRefreshVersionRef = useRef(getFeedRefreshVersion());

  // Rows the viewer WROTE skip the profile hydration read; reposted rows are by
  // someone else and keep their own author (see `fetchAuthorActivity`).
  const knownAuthor = useMemo<FeedPostAuthor | null>(
    () =>
      currentUser
        ? {
            displayName: getResolvedDisplayName(currentUser),
            handle: currentUser.handle ?? null,
            avatarUrl: currentUser.avatarURL ?? null,
            isVerified: currentUser.isVerified === true,
          }
        : null,
    [currentUser],
  );
  const knownAuthorRef = useRef(knownAuthor);
  knownAuthorRef.current = knownAuthor;

  useEffect(() => {
    if (!viewerId) {
      setItems([]);
      setStatus('ready');
      return undefined;
    }
    let cancelled = false;
    void (async () => {
      try {
        const loaded = await fetchAuthorActivity(viewerId, { knownAuthor: knownAuthorRef.current });
        if (!cancelled) {
          setItems(loaded);
          setStatus('ready');
        }
      } catch {
        if (!cancelled) {
          setStatus('error');
        }
      } finally {
        if (!cancelled) {
          setRefreshing(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [viewerId, reloadToken]);

  // Composing or reposting bumps the shared counter; pick it up on return.
  useFocusEffect(
    useCallback(() => {
      if (seenRefreshVersionRef.current !== getFeedRefreshVersion()) {
        seenRefreshVersionRef.current = getFeedRefreshVersion();
        setReloadToken((token) => token + 1);
      }
    }, []),
  );

  const handleRefresh = useCallback(() => {
    setRefreshing(true);
    setReloadToken((token) => token + 1);
  }, []);

  // `usePostDeletion` speaks `FeedPost[]`; keep each row's `repostedAt` across
  // a failed delete's restore. A post the map doesn't know is one the hook just
  // restored, which can only be one the viewer wrote.
  const setPosts = useCallback<Dispatch<SetStateAction<FeedPost[]>>>((action) => {
    setItems((current) => {
      const posts = current.map((item) => item.post);
      const next = typeof action === 'function' ? action(posts) : action;
      const byId = new Map(current.map((item) => [item.post.id, item]));
      return next.map((post) => byId.get(post.id) ?? { post, repostedAt: null });
    });
  }, []);
  const { requestDelete, confirmSheet } = usePostDeletion(setPosts, {
    testID: `${testID}-delete-confirm`,
  });

  const handleOpenCard = useCallback(
    (cardId: string) => {
      router.push({ pathname: '/cards/[cardId]', params: { cardId } });
    },
    [router],
  );

  const empty =
    status === 'loading' ? (
      <StateCard
        centered
        loading
        message="Fetching your posts."
        style={styles.stateCard}
        testID={`${testID}-loading`}
        title="Loading posts"
        variant="field"
      />
    ) : status === 'error' ? (
      <StateCard
        message="Please try again in a moment."
        style={styles.stateCard}
        testID={`${testID}-error`}
        title="Could not load your posts"
        variant="field"
      />
    ) : (
      <StateCard
        message="Posts you write and repost will show up here."
        style={styles.stateCard}
        testID={`${testID}-empty`}
        title="No posts yet"
        variant="field"
      />
    );

  return (
    <>
      <AnimatedFlatList
        ListEmptyComponent={empty}
        contentContainerStyle={[
          page.contentContainerStyle,
          { paddingBottom: insets.bottom + theme.spacing.xl },
        ]}
        contentInsetAdjustmentBehavior="automatic"
        data={items}
        keyExtractor={(item: AuthorActivityItem) =>
          `${item.repostedAt ? 'repost' : 'post'}:${item.post.id}`
        }
        keyboardShouldPersistTaps="handled"
        onScroll={page.onScroll}
        ref={scrollRef as unknown as RefObject<FlatList<AuthorActivityItem>>}
        refreshControl={
          <RefreshControl
            onRefresh={handleRefresh}
            progressViewOffset={page.progressViewOffset}
            refreshing={refreshing}
            testID={`${testID}-refresh`}
            tintColor={theme.colors.gray400}
          />
        }
        renderItem={({ item }: { item: AuthorActivityItem }) => (
          <View>
            {/* A reposted card carries the ORIGINAL author; this says it was you who passed it on. */}
            {item.repostedAt ? <RepostAttribution testID={`${testID}-repost-attribution`} /> : null}
            <PostCard
              accessToken={accessToken}
              apiBaseUrl={apiBaseUrl}
              onPressCard={handleOpenCard}
              // Only your OWN post is deletable; un-reposting is the repost glyph's job.
              onRequestDelete={item.repostedAt ? undefined : requestDelete}
              post={item.post}
              testID={`${testID}-post`}
            />
          </View>
        )}
        scrollEventThrottle={page.scrollEventThrottle}
        scrollToOverflowEnabled={page.scrollToOverflowEnabled}
        testID={testID}
      />
      {confirmSheet}
    </>
  );
}

const styles = StyleSheet.create({
  // Figma 6642:5421: 16 under the tab rail, on the 16 page gutter.
  stateCard: {
    marginHorizontal: 16,
    marginTop: 16,
  },
});
