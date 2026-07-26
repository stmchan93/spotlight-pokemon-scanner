import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { ChatBubbleEmpty, CheckCircle, Heart, HeartSolid, MediaImage } from 'iconoir-react-native';

import { Avatar, Text, useSpotlightTheme } from '@spotlight/design-system';

import { CommentsSheet } from '@/features/social/components/comments-sheet';
import {
  type FeedPost,
  type FeedPostMedia,
  fetchLikedPostIds,
  likePost,
  unlikePost,
} from '@/features/social/social-service';

type PostCardProps = {
  post: FeedPost;
  /** Backend base URL for the authenticated post-media proxy. Images hide when null. */
  apiBaseUrl?: string | null;
  /** Supabase access token for the proxy's `Authorization` bearer. Images hide when null. */
  accessToken?: string | null;
  /** Tap the card chip → open the anchored card's PDP. */
  onPressCard?: (cardId: string) => void;
  /**
   * Optional seed for the viewer's liked state. When omitted (the default), the
   * card self-resolves it on mount via `fetchLikedPostIds`, so feeds need no new
   * props. Pass it when the caller already batch-fetched liked ids.
   */
  initialLiked?: boolean;
  testID?: string;
};

const AVATAR_SIZE = 40;

/** Two initials for the author avatar fallback. Mirrors `getProfileInitials`. */
function authorInitials(displayName: string | null, handle: string | null): string {
  const source = (displayName ?? handle ?? '').trim();
  const words = source.split(/\s+/).filter(Boolean).slice(0, 2);
  const letters = words.map((word) => word[0]?.toUpperCase() ?? '').filter(Boolean);
  return letters.length > 0 ? letters.join('') : 'C';
}

/** Compact relative time: "now", "5m", "3h", "2d", "4w", else a short date. */
function formatRelativeTime(createdAt: string): string {
  const then = Date.parse(createdAt);
  if (Number.isNaN(then)) {
    return '';
  }
  const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (seconds < 45) {
    return 'now';
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  if (days < 7) {
    return `${days}d`;
  }
  const weeks = Math.floor(days / 7);
  if (weeks < 5) {
    return `${weeks}w`;
  }
  return new Date(then).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/**
 * A single authed post image, streamed from `${apiBaseUrl}/api/v1/post-media/<id>`
 * with a bearer header (the bytes are private until moderation approves them, so
 * they're never a plain public URL). Uses the media blurhash as the placeholder.
 */
function PostImage({
  media,
  uri,
  accessToken,
  testID,
}: {
  media: FeedPostMedia;
  uri: string;
  accessToken: string;
  testID?: string;
}) {
  const theme = useSpotlightTheme();
  const aspectRatio =
    media.width && media.height && media.height > 0 ? media.width / media.height : 4 / 3;

  return (
    <ExpoImage
      accessibilityIgnoresInvertColors
      cachePolicy="memory-disk"
      contentFit="cover"
      placeholder={media.blurhash ? { blurhash: media.blurhash } : undefined}
      source={{ uri, headers: { Authorization: `Bearer ${accessToken}` } }}
      style={[
        styles.image,
        { aspectRatio, borderRadius: theme.radii.md, backgroundColor: theme.colors.surfaceMuted },
      ]}
      testID={testID}
    />
  );
}

/**
 * Post card (Phase 3b): author row, body, optional card chip, image(s), plus an
 * interactive like button (optimistic heart + count) and a comment button that
 * opens the thread sheet. The only other tappable affordance is the card chip → PDP.
 */
export function PostCard({
  post,
  apiBaseUrl,
  accessToken,
  onPressCard,
  initialLiked,
  testID = 'post-card',
}: PostCardProps) {
  const theme = useSpotlightTheme();

  const author = post.author;
  const displayName = author?.displayName?.trim() || (author?.handle ? `@${author.handle}` : 'Collector');
  const relativeTime = useMemo(() => formatRelativeTime(post.createdAt), [post.createdAt]);

  const canShowImages = Boolean(apiBaseUrl) && Boolean(accessToken) && post.media.length > 0;
  const trimmedBase = apiBaseUrl ? apiBaseUrl.replace(/\/+$/, '') : '';

  // Interaction state. `liked` / `likeCount` are optimistic; they reconcile to the
  // post prop on the next feed read. `likePending` de-dupes a double-tap while the
  // write is in flight. `commentCount` folds in comments added from the sheet.
  const [liked, setLiked] = useState(initialLiked ?? false);
  const [likeCount, setLikeCount] = useState(post.likeCount);
  const [likePending, setLikePending] = useState(false);
  const [commentCount, setCommentCount] = useState(post.commentCount);
  const [commentsVisible, setCommentsVisible] = useState(false);

  // Keep the optimistic counters in sync when a fresh copy of the post arrives
  // (e.g. a feed refresh). The optimistic writes above win only until then.
  useEffect(() => {
    setLikeCount(post.likeCount);
  }, [post.likeCount]);
  useEffect(() => {
    setCommentCount(post.commentCount);
  }, [post.commentCount]);

  // Self-resolve the viewer's liked state on mount so callers need no new props.
  // Skipped when the caller already seeded it. A failed read just leaves it unliked.
  useEffect(() => {
    if (initialLiked !== undefined) {
      return;
    }
    let cancelled = false;
    void fetchLikedPostIds([post.id])
      .then((likedIds) => {
        if (!cancelled) {
          setLiked(likedIds.has(post.id));
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [initialLiked, post.id]);

  // Optimistically flip the heart AND the count, then reconcile: roll both back if
  // the write returns false. Guarded against a double-tap while in flight.
  const handleToggleLike = useCallback(() => {
    if (likePending) {
      return;
    }
    const wasLiked = liked;
    const nextLiked = !wasLiked;

    setLiked(nextLiked);
    setLikeCount((count) => Math.max(0, count + (nextLiked ? 1 : -1)));
    setLikePending(true);

    void (async () => {
      const ok = await (nextLiked ? likePost(post.id) : unlikePost(post.id));
      if (!ok) {
        setLiked(wasLiked);
        setLikeCount((count) => Math.max(0, count + (nextLiked ? -1 : 1)));
      }
      setLikePending(false);
    })();
  }, [liked, likePending, post.id]);

  return (
    <View
      style={[styles.card, { backgroundColor: theme.colors.canvasElevated, borderRadius: theme.radii.lg }]}
      testID={`${testID}-${post.id}`}
    >
      <View style={styles.authorRow}>
        <Avatar
          initials={authorInitials(author?.displayName ?? null, author?.handle ?? null)}
          size={AVATAR_SIZE}
          testID={`${testID}-avatar`}
          uri={author?.avatarUrl}
        />
        <View style={styles.authorText}>
          <View style={styles.nameRow}>
            <Text
              numberOfLines={1}
              style={[theme.typography.bodyStrong, { color: theme.colors.gray900 }]}
              testID={`${testID}-author-name`}
            >
              {displayName}
            </Text>
            {author?.isVerified ? (
              <CheckCircle
                color={theme.colors.purple500}
                height={14}
                testID={`${testID}-verified`}
                width={14}
              />
            ) : null}
          </View>
          <View style={styles.metaRow}>
            {author?.handle ? (
              <Text
                numberOfLines={1}
                style={[theme.typography.captionMedium, { color: theme.colors.gray500 }]}
              >
                @{author.handle}
              </Text>
            ) : null}
            {relativeTime ? (
              <Text style={[theme.typography.captionMedium, { color: theme.colors.gray500 }]}>
                {author?.handle ? ` · ${relativeTime}` : relativeTime}
              </Text>
            ) : null}
          </View>
        </View>
      </View>

      {post.body ? (
        <Text
          style={[theme.typography.body, { color: theme.colors.gray900 }]}
          testID={`${testID}-body`}
        >
          {post.body}
        </Text>
      ) : null}

      {post.cardId ? (
        <Pressable
          accessibilityRole="button"
          onPress={() => (post.cardId ? onPressCard?.(post.cardId) : undefined)}
          style={[styles.cardChip, { backgroundColor: theme.colors.surfaceMuted, borderRadius: theme.radii.pill }]}
          testID={`${testID}-card-chip`}
        >
          <MediaImage color={theme.colors.purple500} height={14} width={14} />
          <Text style={[theme.typography.captionMedium, { color: theme.colors.purple500 }]}>
            View card
          </Text>
        </Pressable>
      ) : null}

      {canShowImages ? (
        <View style={styles.mediaColumn}>
          {post.media.map((media) => (
            <PostImage
              accessToken={accessToken as string}
              key={media.id}
              media={media}
              testID={`${testID}-image-${media.id}`}
              uri={`${trimmedBase}/api/v1/post-media/${media.id}`}
            />
          ))}
        </View>
      ) : null}

      <View style={styles.countsRow}>
        <Pressable
          accessibilityLabel={liked ? 'Unlike post' : 'Like post'}
          accessibilityRole="button"
          accessibilityState={{ selected: liked }}
          hitSlop={8}
          onPress={handleToggleLike}
          style={styles.countItem}
          testID={`${testID}-like-button`}
        >
          {liked ? (
            <HeartSolid color={theme.colors.red500} height={16} width={16} />
          ) : (
            <Heart color={theme.colors.gray500} height={16} width={16} />
          )}
          <Text
            style={[theme.typography.captionMedium, { color: liked ? theme.colors.red500 : theme.colors.gray600 }]}
            testID={`${testID}-like-count`}
          >
            {likeCount}
          </Text>
        </Pressable>
        <Pressable
          accessibilityLabel="View comments"
          accessibilityRole="button"
          hitSlop={8}
          onPress={() => setCommentsVisible(true)}
          style={styles.countItem}
          testID={`${testID}-comment-button`}
        >
          <ChatBubbleEmpty color={theme.colors.gray500} height={16} width={16} />
          <Text
            style={[theme.typography.captionMedium, { color: theme.colors.gray600 }]}
            testID={`${testID}-comment-count`}
          >
            {commentCount}
          </Text>
        </Pressable>
      </View>

      <CommentsSheet
        onClose={() => setCommentsVisible(false)}
        onCommentAdded={() => setCommentCount((count) => count + 1)}
        postId={post.id}
        testID={`${testID}-comments`}
        visible={commentsVisible}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  authorRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 10,
  },
  authorText: {
    flex: 1,
    gap: 1,
  },
  card: {
    gap: 10,
    padding: 14,
  },
  cardChip: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    flexDirection: 'row',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  countItem: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 4,
  },
  countsRow: {
    flexDirection: 'row',
    gap: 20,
    marginTop: 2,
  },
  image: {
    width: '100%',
  },
  mediaColumn: {
    gap: 8,
  },
  metaRow: {
    alignItems: 'center',
    flexDirection: 'row',
  },
  nameRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 4,
  },
});
