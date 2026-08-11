import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { Text, useSpotlightTheme } from '@spotlight/design-system';

import { type FeedPost, fetchPostById } from '@/features/social/social-service';

type LoadState =
  | { status: 'loading' }
  | { status: 'resolved'; post: FeedPost }
  /**
   * Removed by moderation, soft-deleted by its author, hard-deleted, or hidden
   * by a block created since it was sent. All four look identical here ON
   * PURPOSE — telling them apart would leak why, and "who blocked whom" is
   * exactly what the block system refuses to disclose.
   */
  | { status: 'unavailable' };

/**
 * A post someone sent into a DM thread (social_22).
 *
 * ONLY THE ID IS STORED. The preview is fetched here, on every render of the
 * thread, so `posts_select` re-answers "may this reader see this?" each time —
 * which is how a post that has since been removed, deleted or blocked stops
 * resolving without this component, or the message row, knowing anything about
 * moderation.
 *
 * That is the whole reason the message carries a reference rather than a link
 * baked into its body: baked text would be a permanent copy of something that
 * was meant to disappear, sitting in a private thread nobody moderates.
 */
export function SharedPostBubble({
  postId,
  onOpen,
  testID = 'shared-post',
}: {
  postId: string;
  onOpen: (postId: string) => void;
  testID?: string;
}) {
  const theme = useSpotlightTheme();
  const [state, setState] = useState<LoadState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    void fetchPostById(postId).then((post) => {
      if (cancelled) {
        return;
      }
      setState(post ? { status: 'resolved', post } : { status: 'unavailable' });
    });
    return () => {
      cancelled = true;
    };
  }, [postId]);

  if (state.status === 'loading') {
    return (
      <View
        style={[styles.card, styles.placeholder, { borderColor: theme.colors.gray200 }]}
        testID={`${testID}-loading`}
      />
    );
  }

  if (state.status === 'unavailable') {
    return (
      <View
        style={[styles.card, { borderColor: theme.colors.gray200 }]}
        testID={`${testID}-unavailable`}
      >
        {/*
          Says so, rather than rendering an empty card. A blank bubble reads as
          a bug; this reads as what happened.
        */}
        <Text style={[theme.typography.label, { color: theme.colors.gray600 }]}>
          This post is no longer available
        </Text>
      </View>
    );
  }

  const { post } = state;
  const author = post.author?.displayName ?? 'Collector';
  /*
    NO IMAGE, deliberately. Post images stream from an AUTHENTICATED proxy
    (`${apiBaseUrl}/api/v1/post-media/<id>`) and need the base URL and auth
    headers threaded down — `post-card.tsx` has a dedicated component for it.
    A DM preview does not earn that: author plus an excerpt is enough to know
    what was sent, and tapping opens the real post.
  */

  return (
    <Pressable
      accessibilityLabel={`Open ${author}'s post`}
      accessibilityRole="button"
      onPress={() => onOpen(post.id)}
      style={[styles.card, { borderColor: theme.colors.gray200 }]}
      testID={`${testID}-card`}
    >
      <View style={styles.copy}>
        <Text numberOfLines={1} style={[theme.typography.label, { color: theme.colors.gray600 }]}>
          {author}
        </Text>
        {post.body ? (
          <Text numberOfLines={2} style={[theme.typography.bodySmall, { color: theme.colors.gray900 }]}>
            {post.body}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    // Bounded so a long post cannot stretch the thread's bubble geometry, which
    // the scroll-to-latest maths depends on.
    maxWidth: 260,
    overflow: 'hidden',
    padding: 8,
  },
  placeholder: {
    height: 64,
  },
  copy: {
    gap: 2,
  },
});
