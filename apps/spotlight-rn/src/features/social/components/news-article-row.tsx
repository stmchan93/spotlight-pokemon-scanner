import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Modal, Pressable, StyleSheet, View } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { PlaySolid } from 'iconoir-react-native';

import type { NewsItem } from '@spotlight/api-client';
import { borderWidths, spacing, Text, useSpotlightTheme } from '@spotlight/design-system';

import { trackNewsItemOpened } from '@/features/meta-feed/meta-analytics';
import { openLinkOut } from '@/features/meta-feed/screens/components/open-link-out';
import { CommentsSheet } from '@/features/social/components/comments-sheet';
import { PostMetricsRow } from '@/features/social/components/post-metrics-row';
import { SharePostSheet } from '@/features/social/components/share-post-sheet';
import type { NewsThread } from '@/features/social/news-thread-service';
import { signalFeedNeedsRefresh } from '@/features/social/screens/new-post-screen';
import { likePost, repostPost, unlikePost, unrepostPost } from '@/features/social/social-service';
import { useAppServices } from '@/providers/app-providers';

/** Figma 6322:7602 draws the lead image at 361 x 191. */
const LEAD_IMAGE_ASPECT_RATIO = 361 / 191;
const THUMBNAIL_SIZE = 80;
const PLAY_BADGE_SIZE = 32;
const PLAY_ICON_SIZE = 16;
const TITLE_MAX_LINES = 5;

type NewsArticleRowProps = {
  item: NewsItem;
  /** The first story on the page: a large image above the reactions. */
  lead?: boolean;
  /** Absent until someone first reacts to this article. */
  thread?: NewsThread | null;
  liked?: boolean;
  reposted?: boolean;
  testID?: string;
};

function PlayBadge({ testID }: { testID: string }) {
  const theme = useSpotlightTheme();
  return (
    <View pointerEvents="none" style={styles.playBadgeSlot} testID={testID}>
      <View style={[styles.playBadge, { backgroundColor: theme.colors.gray0 }]}>
        <PlaySolid color={theme.colors.gray900} height={PLAY_ICON_SIZE} width={PLAY_ICON_SIZE} />
      </View>
    </View>
  );
}

/**
 * One story on the News tab (Figma 6322:7596). Reactions are real: the first one
 * asks the backend for the article's hidden post, and everything after that is
 * the ordinary post machinery.
 */
export function NewsArticleRow({
  item,
  lead = false,
  thread = null,
  liked: seededLiked = false,
  reposted: seededReposted = false,
  testID = 'news-article',
}: NewsArticleRowProps) {
  const theme = useSpotlightTheme();
  const { spotlightRepository } = useAppServices();

  const [liked, setLiked] = useState(seededLiked);
  const [likeCount, setLikeCount] = useState(thread?.likeCount ?? 0);
  const [reposted, setReposted] = useState(seededReposted);
  const [repostCount, setRepostCount] = useState(thread?.repostCount ?? 0);
  const [commentCount, setCommentCount] = useState(thread?.commentCount ?? 0);
  const [postId, setPostId] = useState<string | null>(thread?.postId ?? null);
  const [commentsVisible, setCommentsVisible] = useState(false);
  // Retained after closing so the sheet keeps its content while it slides away.
  const [shareMounted, setShareMounted] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const likePending = useRef(false);
  const repostPending = useRef(false);

  // The page's batch read lands after the first render.
  useEffect(() => setLiked(seededLiked), [seededLiked]);
  useEffect(() => setReposted(seededReposted), [seededReposted]);
  useEffect(() => {
    if (!thread) {
      return;
    }
    setPostId(thread.postId);
    setLikeCount(thread.likeCount);
    setCommentCount(thread.commentCount);
    setRepostCount(thread.repostCount);
  }, [thread]);

  const ensureThread = useCallback(async (): Promise<string | null> => {
    if (postId) {
      return postId;
    }
    const resolved = await spotlightRepository.ensureNewsThread(item.id);
    if (resolved) {
      setPostId(resolved);
    }
    return resolved;
  }, [item.id, postId, spotlightRepository]);

  const alertUnavailable = useCallback(() => {
    Alert.alert("Couldn't do that", 'Please try again in a moment.');
  }, []);

  const handleToggleLike = useCallback(() => {
    if (likePending.current) {
      return;
    }
    likePending.current = true;
    const next = !liked;
    setLiked(next);
    setLikeCount((count) => Math.max(0, count + (next ? 1 : -1)));
    void (async () => {
      const id = await ensureThread();
      const ok = id ? await (next ? likePost(id) : unlikePost(id)) : false;
      if (!ok) {
        setLiked(!next);
        setLikeCount((count) => Math.max(0, count + (next ? -1 : 1)));
      }
      if (!id) {
        alertUnavailable();
      }
      likePending.current = false;
    })();
  }, [alertUnavailable, ensureThread, liked]);

  const handleToggleRepost = useCallback(() => {
    if (repostPending.current) {
      return;
    }
    repostPending.current = true;
    const next = !reposted;
    setReposted(next);
    setRepostCount((count) => Math.max(0, count + (next ? 1 : -1)));
    void (async () => {
      const id = await ensureThread();
      const ok = id ? await (next ? repostPost(id) : unrepostPost(id)) : false;
      if (ok) {
        // A repost changes what the Social feed and your Activity contain.
        signalFeedNeedsRefresh();
      } else {
        setReposted(!next);
        setRepostCount((count) => Math.max(0, count + (next ? -1 : 1)));
      }
      if (!id) {
        alertUnavailable();
      }
      repostPending.current = false;
    })();
  }, [alertUnavailable, ensureThread, reposted]);

  const handleOpenComments = useCallback(() => {
    void (async () => {
      if (await ensureThread()) {
        setCommentsVisible(true);
      } else {
        alertUnavailable();
      }
    })();
  }, [alertUnavailable, ensureThread]);

  const handleShare = useCallback(() => {
    void (async () => {
      if (await ensureThread()) {
        setShareMounted(true);
        setShareOpen(true);
      } else {
        alertUnavailable();
      }
    })();
  }, [alertUnavailable, ensureThread]);

  const openArticle = useCallback(() => {
    trackNewsItemOpened(item, 'news_page');
    void openLinkOut(item.url);
  }, [item]);

  const isVideo = item.kind === 'video';
  const source = (
    <Text
      numberOfLines={1}
      // Figma 6322:7600: Caption SemiBold 13 gray-400.
      style={[theme.typography.labelStrong, { color: theme.colors.gray400 }]}
      testID={`${testID}-source`}
    >
      {item.source}
    </Text>
  );

  return (
    <View style={{ backgroundColor: theme.colors.gray0 }} testID={testID}>
      <View style={[styles.card, lead ? styles.cardLead : styles.cardStandard]}>
        <Pressable
          accessibilityLabel={`Open ${item.title}`}
          accessibilityRole="link"
          onPress={openArticle}
          testID={`${testID}-open`}
        >
          {lead ? (
            <View style={styles.leadBody}>
              <View style={styles.textStack}>
                {source}
                <Text
                  numberOfLines={TITLE_MAX_LINES}
                  // Figma 6322:7601: Medium 16.
                  style={[theme.typography.headlineMedium, { color: theme.colors.gray900 }]}
                  testID={`${testID}-title`}
                >
                  {item.title}
                </Text>
              </View>
              {item.imageUrl ? (
                <View
                  style={[
                    styles.leadImageFrame,
                    { backgroundColor: theme.colors.surfaceMuted, borderRadius: theme.radii.sm },
                  ]}
                >
                  <ExpoImage
                    accessibilityIgnoresInvertColors
                    cachePolicy="memory-disk"
                    contentFit="cover"
                    source={{ uri: item.imageUrl }}
                    style={styles.fill}
                    testID={`${testID}-image`}
                  />
                  {isVideo ? <PlayBadge testID={`${testID}-play`} /> : null}
                </View>
              ) : null}
            </View>
          ) : (
            <View style={[styles.textStack, styles.standardBody]}>
              {source}
              {/* The thumbnail lines up with the title, not the source above it. */}
              <View style={styles.standardRow}>
                <Text
                  numberOfLines={TITLE_MAX_LINES}
                  // Figma 6322:7634: SemiBold 15, up to 5 lines.
                  style={[theme.typography.bodyStrong, styles.standardTitle, { color: theme.colors.gray900 }]}
                  testID={`${testID}-title`}
                >
                  {item.title}
                </Text>
                {item.imageUrl ? (
                  <View
                    style={[
                      styles.thumbnail,
                      { backgroundColor: theme.colors.surfaceMuted, borderRadius: theme.radii.sm },
                    ]}
                    testID={`${testID}-thumbnail`}
                  >
                    <ExpoImage
                      accessibilityIgnoresInvertColors
                      cachePolicy="memory-disk"
                      contentFit="cover"
                      source={{ uri: item.imageUrl }}
                      style={styles.fill}
                      testID={`${testID}-image`}
                    />
                    {isVideo ? <PlayBadge testID={`${testID}-play`} /> : null}
                  </View>
                ) : null}
              </View>
            </View>
          )}
        </Pressable>

        <PostMetricsRow
          commentCount={commentCount}
          likeCount={likeCount}
          liked={liked}
          onOpenComments={handleOpenComments}
          onShare={handleShare}
          onToggleLike={handleToggleLike}
          onToggleRepost={handleToggleRepost}
          repostCount={repostCount}
          reposted={reposted}
          testID={testID}
        />
      </View>

      <View style={[styles.band, { backgroundColor: theme.colors.gray50 }]} />

      {postId ? (
        <CommentsSheet
          onClose={() => setCommentsVisible(false)}
          onCommentAdded={() => setCommentCount((count) => count + 1)}
          onCommentCountResolved={setCommentCount}
          postId={postId}
          testID={`${testID}-comments`}
          visible={commentsVisible}
        />
      ) : null}

      {postId && shareMounted ? (
        <Modal
          animationType="none"
          onRequestClose={() => setShareOpen(false)}
          presentationStyle="overFullScreen"
          statusBarTranslucent
          transparent
          visible={shareOpen}
        >
          <View style={styles.fill}>
            <SharePostSheet
              onClose={() => setShareOpen(false)}
              payload={{ kind: 'post', postId }}
              testID={`${testID}-share-sheet`}
              visible={shareOpen}
            />
          </View>
        </Modal>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  band: {
    height: borderWidths.sectionBand,
    width: '100%',
  },
  card: {
    paddingVertical: spacing.xs,
  },
  // Figma 6322:7598 stacks the lead on 12; 6322:7629 leaves 24 above the reactions.
  cardLead: {
    gap: spacing.xs,
  },
  cardStandard: {
    gap: spacing.lg,
  },
  fill: {
    flex: 1,
  },
  leadBody: {
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
  },
  leadImageFrame: {
    aspectRatio: LEAD_IMAGE_ASPECT_RATIO,
    borderCurve: 'continuous',
    overflow: 'hidden',
    width: '100%',
  },
  playBadge: {
    alignItems: 'center',
    borderRadius: PLAY_BADGE_SIZE / 2,
    borderCurve: 'continuous',
    height: PLAY_BADGE_SIZE,
    justifyContent: 'center',
    opacity: 0.9,
    width: PLAY_BADGE_SIZE,
  },
  playBadgeSlot: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  standardBody: {
    paddingHorizontal: spacing.sm,
  },
  standardRow: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: spacing.lg,
  },
  standardTitle: {
    flex: 1,
  },
  textStack: {
    gap: spacing.xxxs,
  },
  // Figma 6322:7636: every thumbnail is the same 80pt square, radius 8.
  thumbnail: {
    borderCurve: 'continuous',
    flexShrink: 0,
    height: THUMBNAIL_SIZE,
    overflow: 'hidden',
    width: THUMBNAIL_SIZE,
  },
});
