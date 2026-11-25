import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { ChatBubbleEmpty, Repeat, ShareIos, ThumbsUp } from 'iconoir-react-native';

import { spacing, Text, useSpotlightTheme } from '@spotlight/design-system';

const ICON_SIZE = 20;
// Figma 4299:94944: the repeat glyph is 24pt wide (the other three are 20) and
// all four run a heavier ~1.7pt stroke — iconoir's default 1.5 rendered at 20pt
// showed ~1.25 and read thin.
const ICON_STROKE = 2;
const REPOST_ICON_SIZE = 24;
// The comment icon and its count are two separate targets 4px apart, so their
// hit slops are trimmed on the facing edges instead of overlapping.
const COMMENT_ICON_HIT_SLOP = { top: 8, bottom: 8, left: 8, right: 2 } as const;
const COMMENT_COUNT_HIT_SLOP = { top: 8, bottom: 8, left: 2, right: 8 } as const;

export type PostMetricsRowProps = {
  liked: boolean;
  likeCount: number;
  commentCount: number;
  reposted: boolean;
  repostCount: number;
  onToggleLike: () => void;
  onOpenComments: () => void;
  onToggleRepost: () => void;
  onShare: () => void;
  /** White glyphs for the full-screen viewer's black backdrop. */
  onDark?: boolean;
  style?: StyleProp<ViewStyle>;
  /** Prefix for every control's testID. */
  testID: string;
};

/**
 * The like + comment + repost + share row under a post or news article.
 * Presentational: the caller owns the counts and the writes.
 */
export function PostMetricsRow({
  liked,
  likeCount,
  commentCount,
  reposted,
  repostCount,
  onToggleLike,
  onOpenComments,
  onToggleRepost,
  onShare,
  onDark = false,
  style,
  testID,
}: PostMetricsRowProps) {
  const theme = useSpotlightTheme();
  const primaryColor = onDark ? theme.colors.gray0 : theme.colors.gray900;
  // Liked = solid purple thumb (stroke + fill) with a matching count.
  const likeColor = liked ? theme.colors.purple500 : primaryColor;
  // Reposted tints stroke + count, but does NOT fill: the repeat glyph is an
  // open path (two arrows), so filling it floods the space between them.
  const repostColor = reposted ? theme.colors.purple500 : primaryColor;

  return (
    <View style={[styles.row, style]} testID={`${testID}-metrics`}>
      <View style={styles.left}>
        <Pressable
          accessibilityLabel={liked ? 'Unlike post' : 'Like post'}
          accessibilityRole="button"
          accessibilityState={{ selected: liked }}
          hitSlop={8}
          onPress={onToggleLike}
          style={styles.item}
          testID={`${testID}-like-button`}
        >
          <ThumbsUp
            color={likeColor}
            // The glyph's outline is a closed path, so filling it with the same
            // color reads as a single solid shape.
            fill={liked ? theme.colors.purple500 : 'none'}
            height={ICON_SIZE}
            strokeWidth={ICON_STROKE}
            testID={`${testID}-like-icon`}
            width={ICON_SIZE}
          />
          <Text
            style={[theme.typography.labelStrong, { color: likeColor }]}
            testID={`${testID}-like-count`}
          >
            {likeCount}
          </Text>
        </Pressable>
        <View style={styles.item}>
          <Pressable
            accessibilityLabel="Add a comment"
            accessibilityRole="button"
            hitSlop={COMMENT_ICON_HIT_SLOP}
            onPress={onOpenComments}
            testID={`${testID}-comment-button`}
          >
            <ChatBubbleEmpty color={primaryColor} height={ICON_SIZE} strokeWidth={ICON_STROKE} width={ICON_SIZE} />
          </Pressable>
          <Pressable
            accessibilityLabel="View comments"
            accessibilityRole="button"
            hitSlop={COMMENT_COUNT_HIT_SLOP}
            onPress={onOpenComments}
            testID={`${testID}-comment-count-button`}
          >
            <Text
              style={[theme.typography.labelStrong, { color: primaryColor }]}
              testID={`${testID}-comment-count`}
            >
              {commentCount}
            </Text>
          </Pressable>
        </View>
        {/*
          An endorsement, not a second copy (`post_reposts`, social_23): the count
          ticks up and the post joins your Activity, but nothing is republished,
          so no copy can outlive the original.
        */}
        <Pressable
          accessibilityLabel={reposted ? 'Undo repost' : 'Repost'}
          accessibilityRole="button"
          accessibilityState={{ selected: reposted }}
          hitSlop={8}
          onPress={onToggleRepost}
          style={styles.item}
          testID={`${testID}-repost-button`}
        >
          <Repeat
            color={repostColor}
            height={REPOST_ICON_SIZE}
            strokeWidth={ICON_STROKE}
            testID={`${testID}-repost-icon`}
            width={REPOST_ICON_SIZE}
          />
          <Text
            style={[theme.typography.labelStrong, { color: repostColor }]}
            testID={`${testID}-repost-count`}
          >
            {repostCount}
          </Text>
        </Pressable>
      </View>
      {/* Private delivery in DMs. It carries an id, so moderation still applies. */}
      <Pressable
        accessibilityLabel="Share post"
        accessibilityRole="button"
        hitSlop={8}
        onPress={onShare}
        style={styles.item}
        testID={`${testID}-share-button`}
      >
        <ShareIos color={primaryColor} height={ICON_SIZE} strokeWidth={ICON_STROKE} width={ICON_SIZE} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  item: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.xxxs,
  },
  left: {
    alignItems: 'center',
    flexDirection: 'row',
    // Figma 4299:94902 — 20 between reaction groups, 4 inside one.
    gap: spacing.md,
  },
  row: {
    // Figma 3505:14440 baselines the row on its bottom edge, so the share glyph
    // lines up with the reaction glyphs rather than floating above them.
    alignItems: 'flex-end',
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.sm,
  },
});
