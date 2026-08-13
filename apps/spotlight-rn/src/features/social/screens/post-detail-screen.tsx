import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

import { InlineLoader, StateCard, Text, useSpotlightTheme } from '@spotlight/design-system';

import { ChromeBackButton } from '@/components/chrome-back-button';
import { PostCard } from '@/features/social/components/post-card';
import { fetchPostById, type FeedPost } from '@/features/social/social-service';
import { usePostDeletion } from '@/features/social/use-post-deletion';
import { resolveRepositoryBaseUrl } from '@/providers/app-providers';
import { useAuth } from '@/providers/auth-provider';

type PostDetailScreenProps = {
  postId: string;
  /**
   * Open straight into the thread. Notifications about a comment or a comment
   * like set this, so tapping one lands on the conversation it is telling you
   * about rather than on the post with the thread still shut.
   */
  openComments?: boolean;
  /** Comment the thread should open on — see `CommentsSheet.focusCommentId`. */
  focusCommentId?: string | null;
  testID?: string;
};

type LoadStatus = 'loading' | 'ready' | 'missing';

/**
 * A single post, on its own screen.
 *
 * This exists because notifications had nowhere to go. Every like/comment row in
 * the list was inert — the code said so outright: "there is no per-post route …
 * those rows render non-interactive until a `/post/[postId]` screen exists". A
 * notification that cannot take you to the thing it is about is barely a
 * notification.
 *
 * It renders the SAME `PostCard` the feed does rather than a bespoke layout, so
 * likes, the comment sheet, the ⋯ menu and media all behave identically to
 * everywhere else and there is no second implementation to keep in step.
 */
export function PostDetailScreen({
  postId,
  openComments = false,
  focusCommentId = null,
  testID = 'post-detail',
}: PostDetailScreenProps) {
  const theme = useSpotlightTheme();
  const router = useRouter();
  const { accessToken } = useAuth();
  const apiBaseUrl = resolveRepositoryBaseUrl();

  const [post, setPost] = useState<FeedPost | null>(null);
  const [status, setStatus] = useState<LoadStatus>('loading');

  /*
    `usePostDeletion` owns confirm + optimistic removal + rollback, but it speaks
    in LISTS because every other caller holds one. Adapting a single post to that
    contract keeps one implementation of the delete flow rather than a second
    copy that would drift — this screen gets the same rollback and the same
    failure alert as the feed for free.
  */
  const setPostList = useCallback<Dispatch<SetStateAction<FeedPost[]>>>((value) => {
    setPost((current) => {
      const asList = current ? [current] : [];
      const next = typeof value === 'function' ? value(asList) : value;
      return next[0] ?? null;
    });
  }, []);

  const { requestDelete, confirmSheet } = usePostDeletion(setPostList, {
    testID: `${testID}-delete-confirm`,
  });

  // Deleting the post this screen exists to show leaves nothing behind, so go
  // back. Guarded on `ready` so it cannot fire during the initial load, and it
  // deliberately does NOT fire for a post that was never found — that case shows
  // the "isn't available" card instead, which is information the user needs.
  useEffect(() => {
    if (status === 'ready' && post === null) {
      router.back();
    }
  }, [post, router, status]);

  const load = useCallback(async () => {
    const row = await fetchPostById(postId);
    setPost(row);
    setStatus(row ? 'ready' : 'missing');
  }, [postId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <SafeAreaView
      edges={['top', 'left', 'right']}
      style={[styles.safeArea, { backgroundColor: theme.colors.gray0 }]}
      testID={testID}
    >
      <View style={styles.header}>
        <ChromeBackButton onPress={() => router.back()} testID={`${testID}-back`} />
        <Text style={[theme.typography.titleXsmall, styles.title]}>Post</Text>
        <View style={styles.headerSpacer} />
      </View>

      {status === 'loading' ? (
        <InlineLoader label="Loading post" testID={`${testID}-loading`} />
      ) : status === 'missing' || !post ? (
        <View style={styles.stateWrap}>
          {/*
            A notification outlives the thing it points at: the post can be
            deleted, hidden by moderation, or authored by someone who has since
            blocked you. Say so plainly instead of showing an empty screen.
          */}
          <StateCard
            message="It may have been deleted, or it is no longer visible to you."
            testID={`${testID}-missing`}
            title="This post isn't available"
            variant="field"
          />
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={styles.content}
          // `handled` so the comment sheet below this screen gets the FIRST tap
          // while its keyboard is up. Unset, a `ScrollView` claims that touch in
          // the capture phase to dismiss the keyboard, and send/⋯/like/reply all
          // need two taps. Tapping the background still dismisses.
          keyboardShouldPersistTaps="handled"
        >
          <PostCard
            accessToken={accessToken}
            apiBaseUrl={apiBaseUrl}
            autoOpenComments={openComments}
            focusCommentId={focusCommentId}
            onPressCard={(cardId) => router.push({ pathname: '/cards/[cardId]', params: { cardId } })}
            onRequestDelete={requestDelete}
            post={post}
            testID={`${testID}-post`}
          />
        </ScrollView>
      )}

      {confirmSheet}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingBottom: 32,
  },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  headerSpacer: {
    width: 36,
  },
  safeArea: {
    flex: 1,
  },
  stateWrap: {
    padding: 16,
  },
  title: {
    flex: 1,
    textAlign: 'center',
  },
});

export default PostDetailScreen;
