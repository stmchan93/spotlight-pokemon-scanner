import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import {
  ChatBubbleEmpty,
  CheckCircle,
  MediaImage,
  MoreHoriz,
  ShareIos,
  ThumbsUp,
} from 'iconoir-react-native';

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
/** Portrait image frame per Figma 2903-7128 (3:4). */
const IMAGE_ASPECT_RATIO = 3 / 4;
const METRIC_ICON_SIZE = 18;
// The comment icon and its count are two separate targets 4px apart, so their
// hit slops are trimmed on the facing edges instead of overlapping.
const COMMENT_ICON_HIT_SLOP = { top: 8, bottom: 8, left: 8, right: 2 } as const;
const COMMENT_COUNT_HIT_SLOP = { top: 8, bottom: 8, left: 2, right: 8 } as const;

/** Two initials for the author avatar fallback. Mirrors `getProfileInitials`. */
function authorInitials(displayName: string | null, handle: string | null): string {
  const source = (displayName ?? handle ?? '').trim();
  const words = source.split(/\s+/).filter(Boolean).slice(0, 2);
  const letters = words.map((word) => word[0]?.toUpperCase() ?? '').filter(Boolean);
  return letters.length > 0 ? letters.join('') : 'C';
}

/** Absolute post date, e.g. "Jul 16, 2026". Empty for an unparseable timestamp. */
function formatPostDate(createdAt: string): string {
  const then = Date.parse(createdAt);
  if (Number.isNaN(then)) {
    return '';
  }
  return new Date(then).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/**
 * A single authed post image, streamed from `${apiBaseUrl}/api/v1/post-media/<id>`
 * with a bearer header (the bytes are private until moderation approves them, so
 * they're never a plain public URL). Uses the media blurhash as the placeholder.
 * Rendered full-bleed at a fixed 3:4 portrait frame.
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

  return (
    <ExpoImage
      accessibilityIgnoresInvertColors
      cachePolicy="memory-disk"
      contentFit="cover"
      placeholder={media.blurhash ? { blurhash: media.blurhash } : undefined}
      source={{ uri, headers: { Authorization: `Bearer ${accessToken}` } }}
      style={[
        styles.image,
        { aspectRatio: IMAGE_ASPECT_RATIO, backgroundColor: theme.colors.surfaceMuted },
      ]}
      testID={testID}
    />
  );
}

/**
 * Post card (Figma 2903-7128, Activity feed): a full-bleed card — header row
 * (avatar + name/date + a ⋯ options button), body text, an optional card chip,
 * full-bleed 3:4 image(s), and a metrics row (thumbs-up like + comment on the
 * left, share on the right) closed by a hairline divider. Interactions are
 * preserved: the like keeps its optimistic toggle+rollback (now a thumbs-up that
 * tints to the accent color when liked) and the card chip opens the anchored
 * card's PDP. Both comment targets — the chat icon and the count — open the full
 * thread sheet; the icon additionally focuses its composer.
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
  const postDate = useMemo(() => formatPostDate(post.createdAt), [post.createdAt]);

  const canShowImages = Boolean(apiBaseUrl) && Boolean(accessToken) && post.media.length > 0;
  const trimmedBase = apiBaseUrl ? apiBaseUrl.replace(/\/+$/, '') : '';

  // Interaction state. `liked` / `likeCount` are optimistic; they reconcile to the
  // post prop on the next feed read. `likePending` de-dupes a double-tap while the
  // write is in flight. `commentCount` folds in comments added from the sheet.
  const [liked, setLiked] = useState(initialLiked ?? false);
  const [likeCount, setLikeCount] = useState(post.likeCount);
  const [likePending, setLikePending] = useState(false);
  const [commentCount, setCommentCount] = useState(post.commentCount);
  // Both the chat icon and the count open the SAME thread sheet — they sit a few
  // pixels apart, and having the icon pop a composer-only sheet made whether you
  // saw the existing comments feel random. The icon just also focuses the
  // composer so you can type straight away.
  const [commentsVisible, setCommentsVisible] = useState(false);
  const [focusComposerOnOpen, setFocusComposerOnOpen] = useState(false);

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

  // Optimistically flip the like AND the count, then reconcile: roll both back if
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

  // Liked = solid purple thumb (stroke + fill) with a matching count.
  const likeColor = liked ? theme.colors.purple500 : theme.colors.gray700;

  return (
    <View
      style={[styles.card, { backgroundColor: theme.colors.canvasElevated }]}
      testID={`${testID}-${post.id}`}
    >
      <View style={styles.headerRow}>
        <Avatar
          initials={authorInitials(author?.displayName ?? null, author?.handle ?? null)}
          size={AVATAR_SIZE}
          testID={`${testID}-avatar`}
          uri={author?.avatarUrl}
        />
        <View style={styles.headerText}>
          <View style={styles.nameRow}>
            <Text
              numberOfLines={1}
              style={[theme.typography.bodyMedium, { color: theme.colors.gray900 }]}
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
          {postDate ? (
            <Text
              style={[theme.typography.cardMeta, { color: theme.colors.gray600 }]}
              testID={`${testID}-date`}
            >
              {postDate}
            </Text>
          ) : null}
        </View>
        <Pressable
          accessibilityLabel="Post options"
          accessibilityRole="button"
          hitSlop={8}
          style={styles.moreButton}
          testID={`${testID}-more-button`}
        >
          <MoreHoriz color={theme.colors.gray700} height={20} width={20} />
        </Pressable>
      </View>

      {post.body ? (
        <Text
          style={[styles.bodyText, theme.typography.body, { color: theme.colors.gray800 }]}
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

      <View style={styles.metricsRow}>
        <View style={styles.metricsLeft}>
          <Pressable
            accessibilityLabel={liked ? 'Unlike post' : 'Like post'}
            accessibilityRole="button"
            accessibilityState={{ selected: liked }}
            hitSlop={8}
            onPress={handleToggleLike}
            style={styles.metricItem}
            testID={`${testID}-like-button`}
          >
            <ThumbsUp
              color={likeColor}
              // Solid purple thumb when liked, not just a purple outline. The
              // glyph's outline is a closed path, so filling it with the same
              // color reads as a single solid shape.
              fill={liked ? theme.colors.purple500 : 'none'}
              height={METRIC_ICON_SIZE}
              testID={`${testID}-like-icon`}
              width={METRIC_ICON_SIZE}
            />
            <Text
              style={[theme.typography.bodyMedium, { color: likeColor }]}
              testID={`${testID}-like-count`}
            >
              {likeCount}
            </Text>
          </Pressable>
          <View style={styles.metricItem}>
            <Pressable
              accessibilityLabel="Add a comment"
              accessibilityRole="button"
              hitSlop={COMMENT_ICON_HIT_SLOP}
              onPress={() => {
                setFocusComposerOnOpen(true);
                setCommentsVisible(true);
              }}
              testID={`${testID}-comment-button`}
            >
              <ChatBubbleEmpty color={theme.colors.gray700} height={METRIC_ICON_SIZE} width={METRIC_ICON_SIZE} />
            </Pressable>
            <Pressable
              accessibilityLabel="View comments"
              accessibilityRole="button"
              hitSlop={COMMENT_COUNT_HIT_SLOP}
              onPress={() => {
                setFocusComposerOnOpen(false);
                setCommentsVisible(true);
              }}
              testID={`${testID}-comment-count-button`}
            >
              <Text
                style={[theme.typography.bodyMedium, { color: theme.colors.gray700 }]}
                testID={`${testID}-comment-count`}
              >
                {commentCount}
              </Text>
            </Pressable>
          </View>
        </View>
        <Pressable
          accessibilityLabel="Share post"
          accessibilityRole="button"
          hitSlop={8}
          style={styles.metricItem}
          testID={`${testID}-share-button`}
        >
          <ShareIos color={theme.colors.gray700} height={METRIC_ICON_SIZE} width={METRIC_ICON_SIZE} />
        </Pressable>
      </View>

      <View style={[styles.divider, { backgroundColor: theme.colors.outlineSubtle }]} />

      <CommentsSheet
        autoFocusComposer={focusComposerOnOpen}
        onClose={() => setCommentsVisible(false)}
        onCommentAdded={() => setCommentCount((count) => count + 1)}
        onCommentCountResolved={setCommentCount}
        postId={post.id}
        testID={`${testID}-comments`}
        visible={commentsVisible}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  bodyText: {
    paddingHorizontal: 16,
  },
  card: {
    // Figma 2903-7128 stacks the whole card on an 8px rhythm (header→body 8,
    // body→image 8, image→metrics 8) and separates cards by 16 after the
    // hairline divider.
    gap: 8,
    paddingTop: 16,
  },
  cardChip: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    flexDirection: 'row',
    gap: 4,
    marginHorizontal: 16,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  divider: {
    height: 0.5,
    width: '100%',
  },
  headerRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 16,
  },
  headerText: {
    flex: 1,
    gap: 4,
  },
  image: {
    width: '100%',
  },
  mediaColumn: {
    gap: 8,
  },
  metricItem: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 4,
  },
  metricsLeft: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 16,
  },
  metricsRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingBottom: 8,
    paddingHorizontal: 16,
  },
  moreButton: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  nameRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 4,
  },
});
