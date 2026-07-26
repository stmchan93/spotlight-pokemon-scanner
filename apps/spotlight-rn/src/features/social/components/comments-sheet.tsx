import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Dimensions,
  Easing,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ChatBubbleEmpty, SendDiagonal, ThumbsUp, Xmark } from 'iconoir-react-native';

import { Avatar, Text, TextField, useSpotlightTheme } from '@spotlight/design-system';

import {
  addComment,
  fetchComments,
  likeComment,
  type PostComment,
  unlikeComment,
} from '@/features/social/social-service';

type CommentsSheetProps = {
  visible: boolean;
  onClose: () => void;
  /** The post whose thread this sheet shows. */
  postId: string;
  /** Fired after a comment is optimistically appended, so the card can bump its count. */
  onCommentAdded?: (comment: PostComment) => void;
  testID?: string;
};

const SCREEN_HEIGHT = Dimensions.get('window').height;
// 24px avatar (Figma 2903-7590) — the reply column is indented by the avatar
// width + row gap so a reply's avatar sits under the parent's body text.
const AVATAR_SIZE = 24;
const ROW_GAP = 8;
const REPLY_INDENT = AVATAR_SIZE + ROW_GAP;

type LoadStatus = 'loading' | 'ready' | 'error';

/** Two initials for a comment author avatar fallback. Mirrors `authorInitials`. */
function commentInitials(displayName: string | null, handle: string | null): string {
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

/** Best display name for a comment author, falling back to handle then a generic label. */
function authorDisplayName(comment: PostComment): string {
  const author = comment.author;
  return author?.displayName?.trim() || (author?.handle ? `@${author.handle}` : 'Collector');
}

/**
 * One top-level comment plus its (flattened) replies. Replies-of-replies are
 * attributed to their TOP-LEVEL ancestor by walking the parent chain, so the
 * thread never indents past a single level. Each reply also carries the handle of
 * its DIRECT parent's author, rendered as an inline blue @mention.
 */
type CommentThread = {
  comment: PostComment;
  replies: { comment: PostComment; mentionHandle: string | null }[];
};

/**
 * Group threaded comments for display: top-level comments oldest-first, each with
 * its descendant replies (also oldest-first) attributed to its top-level ancestor.
 * A reply's `mentionHandle` is the handle of the comment it directly replies to.
 */
function buildCommentThreads(comments: PostComment[]): CommentThread[] {
  const byId = new Map<string, PostComment>();
  for (const comment of comments) {
    byId.set(comment.id, comment);
  }

  // Resolve each comment to the id of its top-level ancestor.
  const rootIdOf = (comment: PostComment): string => {
    let current = comment;
    const seen = new Set<string>();
    while (current.parentCommentId && byId.has(current.parentCommentId) && !seen.has(current.id)) {
      seen.add(current.id);
      current = byId.get(current.parentCommentId) as PostComment;
    }
    return current.id;
  };

  // The handle to @mention on a reply = the author of its DIRECT parent comment.
  const mentionHandleOf = (comment: PostComment): string | null => {
    const parent = comment.parentCommentId ? byId.get(comment.parentCommentId) : undefined;
    if (!parent) {
      return null;
    }
    return parent.author?.handle?.trim() || parent.author?.displayName?.trim() || null;
  };

  const topLevel = comments.filter(
    (comment) => !comment.parentCommentId || !byId.has(comment.parentCommentId),
  );
  const repliesByRoot = new Map<string, CommentThread['replies']>();
  for (const comment of comments) {
    if (comment.parentCommentId && byId.has(comment.parentCommentId)) {
      const root = rootIdOf(comment);
      const list = repliesByRoot.get(root) ?? [];
      list.push({ comment, mentionHandle: mentionHandleOf(comment) });
      repliesByRoot.set(root, list);
    }
  }

  // Comments arrive oldest-first from the service; preserve that ordering.
  return topLevel.map((comment) => ({
    comment,
    replies: repliesByRoot.get(comment.id) ?? [],
  }));
}

/**
 * Bottom-sheet comment thread (Phase 3b). Loads `fetchComments(postId)`, renders it
 * oldest-first with one level of reply nesting behind a per-comment "N replies"
 * toggle, and lets the viewer like a comment (optimistic) or add a comment / reply
 * (optimistically appended on success). Mirrors `CardActionsSheet`'s Modal +
 * slide-up + scrim + drag-handle so the sheets read as one system.
 *
 * NOTE: the Figma mock shows several custom sticker/emoji reactions per comment
 * (blepcat, derp-goku, …) with counts and an add-emoji button. Those are NOT
 * backed by the schema — the DB has only a single `comment_likes` (a thumbs-up),
 * so we render only the real like. Multi-emoji reactions would need a new
 * `comment_reactions` table (comment_id, user_id, emoji) plus service reads/writes;
 * deferred, so no fake/non-functional emoji buttons are shipped here.
 */
export function CommentsSheet({
  visible,
  onClose,
  postId,
  onCommentAdded,
  testID = 'comments-sheet',
}: CommentsSheetProps) {
  const theme = useSpotlightTheme();
  const insets = useSafeAreaInsets();

  const [isRendered, setIsRendered] = useState(visible);
  const translateY = useRef(new Animated.Value(SCREEN_HEIGHT)).current;

  const [comments, setComments] = useState<PostComment[]>([]);
  const [status, setStatus] = useState<LoadStatus>('loading');
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [replyTo, setReplyTo] = useState<PostComment | null>(null);
  // Which top-level comments have their replies revealed (tap "N replies" to toggle).
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  // Optimistic per-comment like state. Absent id = not liked; the count override map
  // holds the adjusted like_count so the row reflects the tap before any refetch.
  const [likedCommentIds, setLikedCommentIds] = useState<Set<string>>(new Set());
  const [likeCountOverrides, setLikeCountOverrides] = useState<Record<string, number>>({});
  const likePendingRef = useRef<Set<string>>(new Set());

  // Slide the sheet in on open, out on close (matches CardActionsSheet's timing).
  useEffect(() => {
    if (visible) {
      setIsRendered(true);
      const animation = Animated.spring(translateY, {
        toValue: 0,
        damping: 34,
        mass: 1,
        stiffness: 320,
        useNativeDriver: false,
      });
      animation.start();
      return () => animation.stop();
    }

    const animation = Animated.timing(translateY, {
      toValue: SCREEN_HEIGHT,
      duration: 200,
      easing: Easing.in(Easing.cubic),
      useNativeDriver: false,
    });
    animation.start(({ finished }) => {
      if (finished) {
        setIsRendered(false);
      }
    });
    return () => animation.stop();
  }, [translateY, visible]);

  // Load (or reload) the thread each time the sheet opens for a post. Reset the
  // draft/reply/expand/optimistic-like state so a reopen starts clean.
  useEffect(() => {
    if (!visible || !postId) {
      return;
    }
    let cancelled = false;
    setStatus('loading');
    setDraft('');
    setReplyTo(null);
    setExpandedIds(new Set());
    setLikedCommentIds(new Set());
    setLikeCountOverrides({});
    void (async () => {
      try {
        const loaded = await fetchComments(postId);
        if (cancelled) {
          return;
        }
        setComments(loaded);
        setStatus('ready');
      } catch {
        if (!cancelled) {
          setStatus('error');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [postId, visible]);

  const threads = useMemo(() => buildCommentThreads(comments), [comments]);

  const toggleReplies = useCallback((commentId: string) => {
    setExpandedIds((current) => {
      const next = new Set(current);
      if (next.has(commentId)) {
        next.delete(commentId);
      } else {
        next.add(commentId);
      }
      return next;
    });
  }, []);

  const handleToggleCommentLike = useCallback(
    (comment: PostComment) => {
      if (likePendingRef.current.has(comment.id)) {
        return;
      }
      likePendingRef.current.add(comment.id);

      const wasLiked = likedCommentIds.has(comment.id);
      const nextLiked = !wasLiked;
      const baseCount = likeCountOverrides[comment.id] ?? comment.likeCount;

      setLikedCommentIds((current) => {
        const next = new Set(current);
        if (nextLiked) {
          next.add(comment.id);
        } else {
          next.delete(comment.id);
        }
        return next;
      });
      setLikeCountOverrides((current) => ({
        ...current,
        [comment.id]: Math.max(0, baseCount + (nextLiked ? 1 : -1)),
      }));

      void (async () => {
        const ok = await (nextLiked ? likeComment(comment.id) : unlikeComment(comment.id));
        if (!ok) {
          // Roll both the thumbs-up and the count back to their pre-tap values.
          setLikedCommentIds((current) => {
            const next = new Set(current);
            if (nextLiked) {
              next.delete(comment.id);
            } else {
              next.add(comment.id);
            }
            return next;
          });
          setLikeCountOverrides((current) => ({ ...current, [comment.id]: baseCount }));
        }
        likePendingRef.current.delete(comment.id);
      })();
    },
    [likeCountOverrides, likedCommentIds],
  );

  const handleSend = useCallback(() => {
    const text = draft.trim();
    if (sending || text.length === 0 || !postId) {
      return;
    }
    const parent = replyTo;
    setSending(true);

    void (async () => {
      const newId = await addComment(postId, text, parent?.id ?? null);
      if (newId) {
        const optimistic: PostComment = {
          id: newId,
          postId,
          authorId: '',
          author: null,
          body: text,
          parentCommentId: parent?.id ?? null,
          likeCount: 0,
          createdAt: new Date().toISOString(),
        };
        setComments((current) => [...current, optimistic]);
        // Keep a freshly-added reply visible under its parent.
        if (parent) {
          setExpandedIds((current) => new Set(current).add(parent.id));
        }
        setDraft('');
        setReplyTo(null);
        onCommentAdded?.(optimistic);
      }
      setSending(false);
    })();
  }, [draft, onCommentAdded, postId, replyTo, sending]);

  // Renders one comment (top-level or reply): avatar + name/time + body (with an
  // optional inline blue @mention on replies) + the thumbs-up like and Reply action.
  const renderComment = useCallback(
    (comment: PostComment, options: { isReply: boolean; mentionHandle?: string | null }) => {
      const liked = likedCommentIds.has(comment.id);
      const likeCount = likeCountOverrides[comment.id] ?? comment.likeCount;
      const mention = options.mentionHandle?.trim();

      return (
        <View style={styles.commentRow} testID={`${testID}-comment-${comment.id}`}>
          <Avatar
            initials={commentInitials(comment.author?.displayName ?? null, comment.author?.handle ?? null)}
            size={AVATAR_SIZE}
            uri={comment.author?.avatarUrl}
          />
          <View style={styles.commentBody}>
            <View style={styles.commentMeta}>
              <Text
                numberOfLines={1}
                style={[theme.typography.bodyMedium, styles.commentName, { color: theme.colors.gray900 }]}
              >
                {authorDisplayName(comment)}
              </Text>
              <Text style={[theme.typography.captionMedium, { color: theme.colors.gray400 }]}>
                {formatRelativeTime(comment.createdAt)}
              </Text>
            </View>
            {comment.body ? (
              <Text style={[theme.typography.body, styles.commentText, { color: theme.colors.gray700 }]}>
                {options.isReply && mention ? (
                  <Text style={[theme.typography.body, { color: theme.colors.blue400 }]}>{`@${mention} `}</Text>
                ) : null}
                {comment.body}
              </Text>
            ) : null}
            <View style={styles.commentActions}>
              <Pressable
                accessibilityLabel={liked ? 'Unlike comment' : 'Like comment'}
                accessibilityRole="button"
                hitSlop={8}
                onPress={() => handleToggleCommentLike(comment)}
                style={styles.commentAction}
                testID={`${testID}-comment-${comment.id}-like`}
              >
                <ThumbsUp
                  color={liked ? theme.colors.purple500 : theme.colors.gray500}
                  fill={liked ? theme.colors.purple500 : 'none'}
                  height={16}
                  width={16}
                />
                {likeCount > 0 ? (
                  <Text style={[theme.typography.captionMedium, { color: theme.colors.gray600 }]}>
                    {likeCount}
                  </Text>
                ) : null}
              </Pressable>
              <Pressable
                accessibilityRole="button"
                hitSlop={8}
                onPress={() => setReplyTo(comment)}
                style={styles.commentAction}
                testID={`${testID}-comment-${comment.id}-reply`}
              >
                <Text style={[theme.typography.captionMedium, { color: theme.colors.gray600 }]}>
                  Reply
                </Text>
              </Pressable>
            </View>
          </View>
        </View>
      );
    },
    [handleToggleCommentLike, likeCountOverrides, likedCommentIds, testID, theme],
  );

  if (!isRendered) {
    return null;
  }

  const canSend = draft.trim().length > 0 && !sending;

  return (
    <Modal
      animationType="none"
      onRequestClose={onClose}
      presentationStyle="overFullScreen"
      statusBarTranslucent
      transparent
      visible={visible}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.root}
      >
        <Pressable
          accessibilityLabel="Close"
          accessibilityRole="button"
          onPress={onClose}
          style={styles.backdrop}
          testID={`${testID}-backdrop`}
        />
        <Animated.View
          style={[
            styles.sheet,
            {
              backgroundColor: theme.colors.gray0,
              paddingBottom: Math.max(insets.bottom, 12),
              transform: [{ translateY }],
            },
          ]}
          testID={testID}
        >
          <View style={styles.header}>
            <Pressable
              accessibilityLabel="Close"
              accessibilityRole="button"
              hitSlop={16}
              onPress={onClose}
              style={styles.handleHit}
              testID={`${testID}-handle`}
            >
              <View style={[styles.handleBar, { backgroundColor: theme.colors.gray200 }]} />
            </Pressable>
            <Text style={[theme.typography.bodyStrong, styles.title, { color: theme.colors.gray900 }]}>
              Comments
            </Text>
          </View>

          <ScrollView
            contentContainerStyle={styles.listContent}
            keyboardShouldPersistTaps="handled"
            style={styles.list}
            testID={`${testID}-list`}
          >
            {status === 'loading' ? (
              <View style={styles.centered} testID={`${testID}-loading`}>
                <ActivityIndicator color={theme.colors.textSecondary} />
              </View>
            ) : status === 'error' ? (
              <View style={styles.centered} testID={`${testID}-error`}>
                <Text style={[theme.typography.body, { color: theme.colors.gray600 }]}>
                  Could not load comments.
                </Text>
              </View>
            ) : threads.length === 0 ? (
              <View style={styles.centered} testID={`${testID}-empty`}>
                <ChatBubbleEmpty color={theme.colors.gray400} height={28} width={28} />
                <Text style={[theme.typography.body, { color: theme.colors.gray600 }]}>
                  Be the first to comment
                </Text>
              </View>
            ) : (
              threads.map(({ comment, replies }) => {
                const expanded = expandedIds.has(comment.id);
                return (
                  <View key={comment.id} style={styles.thread}>
                    {renderComment(comment, { isReply: false })}
                    {replies.length > 0 ? (
                      <Pressable
                        accessibilityRole="button"
                        hitSlop={8}
                        onPress={() => toggleReplies(comment.id)}
                        style={styles.repliesToggle}
                        testID={`${testID}-comment-${comment.id}-replies-toggle`}
                      >
                        <View style={[styles.repliesDash, { backgroundColor: theme.colors.gray400 }]} />
                        <Text style={[theme.typography.label, { color: theme.colors.gray600 }]}>
                          {expanded
                            ? 'Hide replies'
                            : `${replies.length} ${replies.length === 1 ? 'reply' : 'replies'}`}
                        </Text>
                      </Pressable>
                    ) : null}
                    {expanded
                      ? replies.map(({ comment: reply, mentionHandle }) => (
                          <View key={reply.id} style={styles.replyRow}>
                            {renderComment(reply, { isReply: true, mentionHandle })}
                          </View>
                        ))
                      : null}
                  </View>
                );
              })
            )}
          </ScrollView>

          {replyTo ? (
            <View
              style={[styles.replyBanner, { backgroundColor: theme.colors.gray50 }]}
              testID={`${testID}-reply-banner`}
            >
              <Text
                numberOfLines={1}
                style={[theme.typography.captionMedium, styles.replyBannerText, { color: theme.colors.gray600 }]}
              >
                {`Replying to ${authorDisplayName(replyTo)}`}
              </Text>
              <Pressable
                accessibilityLabel="Cancel reply"
                accessibilityRole="button"
                hitSlop={12}
                onPress={() => setReplyTo(null)}
                testID={`${testID}-reply-cancel`}
              >
                <Xmark color={theme.colors.gray600} height={16} width={16} />
              </Pressable>
            </View>
          ) : null}

          <View style={[styles.composer, { borderTopColor: theme.colors.outlineSubtle }]}>
            <View style={styles.composerField}>
              <TextField
                onChangeText={setDraft}
                onSubmitEditing={handleSend}
                placeholder={replyTo ? 'Add a reply…' : 'Add a comment…'}
                returnKeyType="send"
                testID={`${testID}-input`}
                value={draft}
              />
            </View>
            <Pressable
              accessibilityLabel="Send comment"
              accessibilityRole="button"
              disabled={!canSend}
              hitSlop={8}
              onPress={handleSend}
              style={[
                styles.sendButton,
                {
                  backgroundColor: canSend ? theme.colors.purple500 : theme.colors.gray200,
                  borderRadius: theme.radii.pill,
                },
              ]}
              testID={`${testID}-send`}
            >
              <SendDiagonal color={theme.colors.gray0} height={18} width={18} />
            </Pressable>
          </View>
        </Animated.View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0, 0, 0, 0.4)',
  },
  centered: {
    alignItems: 'center',
    gap: 8,
    paddingVertical: 40,
  },
  commentAction: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 4,
  },
  commentActions: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 16,
    marginTop: 6,
  },
  commentBody: {
    flex: 1,
    gap: 2,
  },
  commentMeta: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 6,
  },
  commentName: {
    flexShrink: 1,
  },
  commentRow: {
    flexDirection: 'row',
    gap: ROW_GAP,
  },
  commentText: {
    marginTop: 1,
  },
  composer: {
    alignItems: 'center',
    borderTopWidth: 1,
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 16,
    paddingTop: 10,
  },
  composerField: {
    flex: 1,
  },
  handleBar: {
    borderRadius: 2,
    height: 4,
    width: 36,
  },
  handleHit: {
    alignItems: 'center',
    paddingBottom: 6,
    paddingTop: 4,
  },
  header: {
    width: '100%',
  },
  list: {
    maxHeight: SCREEN_HEIGHT * 0.5,
  },
  listContent: {
    gap: 18,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  repliesDash: {
    borderRadius: 1,
    height: 1,
    width: 14,
  },
  repliesToggle: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
    marginLeft: REPLY_INDENT,
    marginTop: 10,
  },
  replyBanner: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginHorizontal: 16,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  replyBannerText: {
    flex: 1,
  },
  replyRow: {
    marginLeft: REPLY_INDENT,
    marginTop: 14,
  },
  root: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  sendButton: {
    alignItems: 'center',
    height: 40,
    justifyContent: 'center',
    width: 40,
  },
  sheet: {
    borderTopLeftRadius: 0,
    borderTopRightRadius: 0,
    maxHeight: SCREEN_HEIGHT * 0.85,
    paddingTop: 10,
  },
  thread: {
    width: '100%',
  },
  title: {
    paddingBottom: 4,
    paddingHorizontal: 16,
    paddingTop: 4,
    textAlign: 'center',
  },
});

export default CommentsSheet;
