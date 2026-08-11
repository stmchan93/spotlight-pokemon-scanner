import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { Avatar, Text, useSpotlightTheme } from '@spotlight/design-system';

import { PostImage } from '@/features/social/components/post-card';
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

/** Matches the media frame, so the card does not resize when the photo lands. */
const CARD_WIDTH = 240;

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
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHY IT IS A CARD AND NOT A MESSAGE BUBBLE
 * ───────────────────────────────────────────────────────────────────────────
 * It draws its OWN surface and the thread does not wrap it in bubble chrome —
 * see `dm-thread-screen`. A shared post is not a thing you said, it is a thing
 * you pointed at, and painting it in the sender's bubble tint (a solid purple
 * slab on your own messages) made it read as a strangely-shaped message. Same
 * neutral card on both sides of the thread, exactly like Instagram: sender
 * header, the photo, then the caption.
 */
export function SharedPostBubble({
  postId,
  apiBaseUrl,
  accessToken,
  viewerUserId,
  onOpen,
  testID = 'shared-post',
}: {
  postId: string;
  /** Backend base URL for the authenticated media proxy. No image when null. */
  apiBaseUrl?: string | null;
  accessToken?: string | null;
  /** Whose eyes these are — the author is served their own un-approved media. */
  viewerUserId?: string | null;
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
        style={[
          styles.card,
          styles.placeholder,
          { backgroundColor: theme.colors.gray0, borderColor: theme.colors.gray200 },
        ]}
        testID={`${testID}-loading`}
      />
    );
  }

  if (state.status === 'unavailable') {
    return (
      <View
        style={[
          styles.card,
          styles.unavailable,
          { backgroundColor: theme.colors.gray0, borderColor: theme.colors.gray200 },
        ]}
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
  const handle = post.author?.handle ?? null;
  const media = post.media[0] ?? null;
  const trimmedBase = apiBaseUrl ? apiBaseUrl.replace(/\/+$/, '') : '';
  // The proxy serves private bytes behind a bearer header, so with no base URL
  // or no token there is nothing to show — the card falls back to header +
  // caption rather than to a broken frame.
  const canShowImage = Boolean(trimmedBase) && Boolean(accessToken) && media !== null;

  return (
    <Pressable
      accessibilityLabel={`Open ${author}'s post`}
      accessibilityRole="button"
      onPress={() => onOpen(post.id)}
      style={[styles.card, { backgroundColor: theme.colors.gray0, borderColor: theme.colors.gray200 }]}
      testID={`${testID}-card`}
    >
      {/* Whose post this is — the first thing you need, and what the thread's
          own sender avatar cannot tell you when someone forwards a stranger. */}
      <View style={styles.header}>
        <Avatar
          initials={(author[0] ?? '?').toUpperCase()}
          size={24}
          uri={post.author?.avatarUrl ?? undefined}
        />
        <Text
          numberOfLines={1}
          style={[theme.typography.label, styles.headerName, { color: theme.colors.gray900 }]}
        >
          {handle ? `@${handle}` : author}
        </Text>
      </View>

      {canShowImage && media ? (
        <PostImage
          accessToken={accessToken as string}
          media={media}
          testID={`${testID}-image`}
          uri={`${trimmedBase}/api/v1/post-media/${media.id}`}
          viewerIsAuthor={viewerUserId != null && viewerUserId === post.authorId}
        />
      ) : null}

      {post.body ? (
        <Text
          numberOfLines={2}
          style={[theme.typography.bodySmall, styles.caption, { color: theme.colors.gray900 }]}
        >
          {post.body}
        </Text>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  caption: {
    paddingBottom: 10,
    paddingHorizontal: 10,
  },
  card: {
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    // Fixed rather than max: the photo arrives after the card is on screen, and
    // a card that grows to fit it would shove the whole thread as you read.
    overflow: 'hidden',
    width: CARD_WIDTH,
  },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
    padding: 10,
  },
  headerName: {
    flex: 1,
  },
  placeholder: {
    height: 220,
  },
  unavailable: {
    padding: 12,
  },
});
