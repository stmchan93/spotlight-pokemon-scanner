import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  Dimensions,
  Easing,
  Keyboard,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  type TextInput,
  View,
} from 'react-native';
import { ChatBubbleEmpty, SendDiagonal, ThumbsUp, Xmark } from 'iconoir-react-native';

import { Avatar, Text, TextField, useSpotlightTheme } from '@spotlight/design-system';

import {
  addComment,
  deleteComment,
  fetchComments,
  fetchLikedCommentIds,
  likeComment,
  type PostComment,
  unlikeComment,
} from '@/features/social/social-service';
import { getResolvedDisplayName } from '@/features/auth/auth-models';
import { useAuth } from '@/providers/auth-provider';

type CommentsSheetProps = {
  visible: boolean;
  onClose: () => void;
  /*
    NO auto-focus prop, deliberately. The sheet used to open with the keyboard
    already up when it was entered from the card's chat icon, which meant reading
    a thread started with two thirds of it covered and the newest comments
    squeezed into a strip. Opening comments is a READ; the keyboard belongs to
    the moment you tap the composer, which is what `onFocus` is for. This mirrors
    the New Post composer, which deliberately opens keyboard-down for the same
    reason.
  */
  /** The post whose thread this sheet shows. */
  postId: string;
  /** Fired after a comment is optimistically appended, so the card can bump its count. */
  onCommentAdded?: (comment: PostComment) => void;
  /**
   * Fired with the thread's actual comment count once it loads, so the card can
   * correct a stale `posts.comment_count` instead of rendering it.
   */
  onCommentCountResolved?: (count: number) => void;
  testID?: string;
};

const SCREEN_HEIGHT = Dimensions.get('window').height;
// 24px avatar (Figma 2903-7590) — the reply column is indented by the avatar
// width + row gap so a reply's avatar sits under the parent's body text.
const AVATAR_SIZE = 24;
// 6px avatar→body gap puts the body text at a 30px inset, matching the
// `left-[30px]` body/reaction/replies column in Figma 2903-7970.
const ROW_GAP = 6;
const REPLY_INDENT = AVATAR_SIZE + ROW_GAP;
/** Comment like icon, 18px per Figma 2903-7970. */
const COMMENT_ICON_SIZE = 18;
/** Resting sheet height with the keyboard down. */
const SHEET_HEIGHT_RESTING = SCREEN_HEIGHT * 0.6;
/**
 * Keyboard-up height. The sheet GROWS toward full screen rather than letting the
 * thread be squeezed by the keyboard (the Instagram comment sheet): the sheet's
 * bottom `keyboardHeight` sits behind the keyboard, so the readable strip above
 * the composer stays about half the screen and the thread keeps scrolling while
 * you type.
 */
const SHEET_HEIGHT_EXPANDED = SCREEN_HEIGHT * 0.9;
/** Gap between the composer's bottom edge and the top of the keyboard. */
const KEYBOARD_GAP = 8;
/**
 * How long the sheet takes to grow/shrink between its resting and keyboard-up
 * heights. Shared by the animation and by the post-send scroll, which must not
 * run until the sheet has stopped moving under it.
 */
const SHEET_RESIZE_MS = 250;

/** Gap under the composer when the keyboard is down. */
const COMPOSER_BOTTOM_GAP = 16;
/**
 * Long-press duration that opens a comment's destructive action. Matches
 * `CARD_LONG_PRESS_MS` in `portfolio-screen.tsx` so every "press and hold for the
 * context action" in the app has the same feel.
 */
const COMMENT_LONG_PRESS_MS = 500;
/** Drag distance past which releasing the sheet dismisses it instead of springing back. */
const DISMISS_DRAG_DISTANCE = 80;
/** Flick velocity that dismisses even on a short drag. */
const DISMISS_DRAG_VELOCITY = 0.5;

/**
 * Whether releasing a downward drag should close the sheet: either it travelled
 * far enough, or it was flicked hard enough. Matches `CardActionsSheet`.
 */
export function shouldDismissOnDrag(dy: number, vy: number): boolean {
  return dy > DISMISS_DRAG_DISTANCE || vy > DISMISS_DRAG_VELOCITY;
}

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
 * Delete is SOFT: a comment that still has replies stays in the thread as a
 * TOMBSTONE so the replies underneath it remain readable, and the service marks
 * it with a boolean rather than sending the body. The flag is declared here as an
 * OPTIONAL widening of `PostComment` for two reasons: this file compiles whether
 * or not `social-service.ts` has published the field yet, and the one name the two
 * files have to agree on lives in exactly one place. If the service lands on a
 * different name, `isDeleted` changes here and nowhere else.
 */
type MaybeTombstoned = PostComment & { isDeleted?: boolean };

/** Whether this row is a tombstone: present in the thread, but its body is gone. */
export function isTombstone(comment: PostComment): boolean {
  return (comment as MaybeTombstoned).isDeleted === true;
}

/**
 * The local shape of a just-soft-deleted comment. Mirrors what the server will
 * send back on the next read: the row and its ownership survive, the body and the
 * author hydration do not. Dropping `author` here means no render path can leak
 * the name of someone whose words are gone, even one added later.
 */
function toTombstone(comment: PostComment): PostComment {
  const tombstoned: MaybeTombstoned = { ...comment, author: null, body: null, isDeleted: true };
  return tombstoned;
}

/**
 * How many comments the post should be credited with. A tombstone is a structural
 * anchor for other people's replies, not something anyone wrote, so it does not
 * count — which is also what makes a delete drop the post's count by exactly one
 * whether the row vanished or turned into a tombstone.
 */
export function visibleCommentCount(comments: PostComment[]): number {
  return comments.filter((comment) => !isTombstone(comment)).length;
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
  // A tombstoned parent mentions nobody: printing "@misty" directly above a row
  // that says the comment was deleted would hand back the exact attribution the
  // tombstone exists to withhold.
  const mentionHandleOf = (comment: PostComment): string | null => {
    const parent = comment.parentCommentId ? byId.get(comment.parentCommentId) : undefined;
    if (!parent || isTombstone(parent)) {
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
 * Every comment below `rootId` in the reply tree, at any depth (`rootId` itself is
 * NOT included). Deleting a comment no longer touches these — they are exactly the
 * replies that SURVIVE underneath the tombstone, which is what the delete
 * confirmation now counts so the copy matches what the user will see afterwards.
 */
export function collectDescendantIds(comments: PostComment[], rootId: string): string[] {
  const childIdsByParent = new Map<string, string[]>();
  for (const comment of comments) {
    if (!comment.parentCommentId) {
      continue;
    }
    const siblings = childIdsByParent.get(comment.parentCommentId) ?? [];
    siblings.push(comment.id);
    childIdsByParent.set(comment.parentCommentId, siblings);
  }

  const descendants: string[] = [];
  const seen = new Set<string>([rootId]);
  const queue: string[] = [rootId];
  while (queue.length > 0) {
    const id = queue.shift() as string;
    for (const childId of childIdsByParent.get(id) ?? []) {
      // `seen` also guards a cyclic parent chain from spinning forever.
      if (seen.has(childId)) {
        continue;
      }
      seen.add(childId);
      descendants.push(childId);
      queue.push(childId);
    }
  }
  return descendants;
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
  onCommentCountResolved,
  testID = 'comments-sheet',
}: CommentsSheetProps) {
  const theme = useSpotlightTheme();

  const { currentUser } = useAuth();
  const [isRendered, setIsRendered] = useState(visible);
  const translateY = useRef(new Animated.Value(SHEET_HEIGHT_RESTING)).current;
  const sheetHeight = useRef(new Animated.Value(SHEET_HEIGHT_RESTING)).current;
  const backdropOpacity = useRef(new Animated.Value(0)).current;
  // How far the sheet has to travel to clear the screen edge — its own current
  // height, which changes when the keyboard grows it. Held in a ref so the
  // open/close animation reads the latest value without re-running on keyboard
  // events.
  const hiddenOffsetRef = useRef(SHEET_HEIGHT_RESTING);
  const inputRef = useRef<TextInput | null>(null);
  const listRef = useRef<ScrollView | null>(null);
  /**
   * Pin the thread to its newest row once the keyboard is down after a post.
   *
   * The list is not a chat log — it also grows when a "N replies" toggle expands
   * — so there is deliberately no unconditional `onContentSizeChange` scroll the
   * way the DM thread has. Scrolling only ever happens at moments the user
   * caused: focusing the composer, and posting.
   *
   * Set by a successful send and consumed by the list's `onContentSizeChange`,
   * which is the one moment the just-posted row is laid out and the end position
   * is final. The flag is what keeps that handler from being unconditional.
   */
  const scrollAfterSendRef = useRef(false);

  const scrollToLatest = useCallback((animated: boolean) => {
    listRef.current?.scrollToEnd({ animated });
  }, []);

  const [comments, setComments] = useState<PostComment[]>([]);
  const [status, setStatus] = useState<LoadStatus>('loading');
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  /** Synchronous mirror of `sending` — see `handleSend` for why state isn't enough. */
  const sendingRef = useRef(false);
  const [replyTo, setReplyTo] = useState<PostComment | null>(null);
  // Which top-level comments have their replies revealed (tap "N replies" to toggle).
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  // Optimistic per-comment like state. Absent id = not liked; the count override map
  // holds the adjusted like_count so the row reflects the tap before any refetch.
  const [likedCommentIds, setLikedCommentIds] = useState<Set<string>>(new Set());
  const [likeCountOverrides, setLikeCountOverrides] = useState<Record<string, number>>({});
  const likePendingRef = useRef<Set<string>>(new Set());
  // Deletes in flight, so a second long-press on the same row can't fire a
  // second request (or a second rollback).
  const deletePendingRef = useRef<Set<string>>(new Set());
  // Latest thread, readable from a callback without putting `comments` in its
  // deps. The delete flow needs the CURRENT list twice — once to snapshot what it
  // removed, once to put it back on failure — and a stale closure there would
  // resurrect the wrong rows.
  const commentsRef = useRef<PostComment[]>([]);
  useEffect(() => {
    commentsRef.current = comments;
  }, [comments]);
  // Live keyboard height. The sheet is bottom-anchored, so wrapping it in a
  // KeyboardAvoidingView padded the WHOLE sheet upward — header, thread and all —
  // which left a tall dead gap above the composer. Instead we take the keyboard
  // height ourselves: the composer is padded clear of the keyboard, and the sheet
  // grows to `SHEET_HEIGHT_EXPANDED` so that padding comes out of new height
  // rather than out of the thread.
  const [keyboardHeight, setKeyboardHeight] = useState(0);

  useEffect(() => {
    if (!visible) {
      setKeyboardHeight(0);
      return;
    }
    // iOS gets the "will" events so the sheet tracks the keyboard's own curve;
    // Android only reliably fires the "did" pair.
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const showSub = Keyboard.addListener(showEvent, (event) => {
      setKeyboardHeight(event.endCoordinates?.height ?? 0);
    });
    const hideSub = Keyboard.addListener(hideEvent, () => setKeyboardHeight(0));
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, [visible]);

  // Grow the sheet toward full screen while the keyboard is up, and settle back
  // when it goes down. Same 250ms/ease-out shape as the iOS keyboard curve, so
  // the top edge rises with the keyboard instead of after it.
  useEffect(() => {
    hiddenOffsetRef.current = keyboardHeight > 0 ? SHEET_HEIGHT_EXPANDED : SHEET_HEIGHT_RESTING;
    const animation = Animated.timing(sheetHeight, {
      toValue: keyboardHeight > 0 ? SHEET_HEIGHT_EXPANDED : SHEET_HEIGHT_RESTING,
      duration: SHEET_RESIZE_MS,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    });
    animation.start();
    return () => animation.stop();
  }, [keyboardHeight, sheetHeight]);

  // Slide the sheet in on open, out on close, with the scrim fading in alongside
  // it. Two things used to make this read as a hard pop rather than a transition:
  // the scrim appeared at full opacity on the first frame, and `translateY`
  // travelled a whole SCREEN_HEIGHT when the sheet is only ~60% of the screen
  // tall — so most of the spring played out below the screen edge and the part
  // you could actually see was its final, fastest slice. Travel exactly the
  // sheet's own height, on a softer spring.
  useEffect(() => {
    if (visible) {
      setIsRendered(true);
      translateY.setValue(hiddenOffsetRef.current);
      const animation = Animated.parallel([
        Animated.spring(translateY, {
          toValue: 0,
          damping: 30,
          mass: 1,
          stiffness: 210,
          useNativeDriver: false,
        }),
        Animated.timing(backdropOpacity, {
          toValue: 1,
          duration: 240,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: false,
        }),
      ]);
      animation.start();
      return () => animation.stop();
    }

    const animation = Animated.parallel([
      Animated.timing(translateY, {
        toValue: hiddenOffsetRef.current,
        duration: 220,
        easing: Easing.in(Easing.cubic),
        useNativeDriver: false,
      }),
      Animated.timing(backdropOpacity, {
        toValue: 0,
        duration: 200,
        easing: Easing.in(Easing.cubic),
        useNativeDriver: false,
      }),
    ]);
    animation.start(({ finished }) => {
      if (finished) {
        setIsRendered(false);
      }
    });
    return () => animation.stop();
  }, [backdropOpacity, translateY, visible]);

  // Drag-to-dismiss from the header. The sheet tracks the finger down (never up —
  // it is already at its resting height) and either closes past a deliberate
  // threshold or springs back. `onMoveShouldSetPanResponder` only claims a
  // downward drag, so a stationary tap on the handle still fires its onPress.
  const dragResponder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_event, gesture) =>
          gesture.dy > 4 && Math.abs(gesture.dy) > Math.abs(gesture.dx),
        onPanResponderGrant: () => {
          // Dragging the sheet down while typing should put the keyboard away
          // first, the way every other bottom sheet behaves.
          Keyboard.dismiss();
        },
        onPanResponderMove: (_event, gesture) => {
          translateY.setValue(Math.max(0, gesture.dy));
        },
        onPanResponderRelease: (_event, gesture) => {
          if (shouldDismissOnDrag(gesture.dy, gesture.vy)) {
            onClose();
            return;
          }
          Animated.spring(translateY, {
            toValue: 0,
            damping: 34,
            mass: 1,
            stiffness: 320,
            useNativeDriver: false,
          }).start();
        },
      }),
    [onClose, translateY],
  );

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
    scrollAfterSendRef.current = false;
    /*
      Opening the sheet starts at the TOP of the thread, like every other comment
      list — no scroll on open at all.

      It used to jump to the newest comment when the sheet was entered from the
      chat icon, which only made sense because that entry ALSO raised the
      keyboard: the thread was a short strip above the composer, so landing
      anywhere else showed its middle. With the keyboard no longer opening on
      entry the whole thread is visible from the top, and yanking a reader to the
      bottom of someone else's conversation would be the app deciding what they
      came to read. Tapping the composer still scrolls to the end (`onFocus`),
      and so does posting — both are moments the user asked for.
    */
    void (async () => {
      try {
        const loaded = await fetchComments(postId);
        if (cancelled) {
          return;
        }
        setComments(loaded);
        setStatus('ready');
        // Report the thread's real size. `posts.comment_count` is maintained by
        // a DB trigger; when that count is stale the card would otherwise keep
        // showing it (a post you just commented on reads as 0 comments).
        // Tombstones are excluded — see `visibleCommentCount`.
        onCommentCountResolved?.(visibleCommentCount(loaded));
        // Restore which of these comments the viewer already liked, so an
        // already-liked comment shows filled instead of inviting a second like.
        // Tombstones carry no like affordance, so don't ask about them.
        const likedIds = await fetchLikedCommentIds(
          loaded.filter((comment) => !isTombstone(comment)).map((comment) => comment.id),
        );
        if (!cancelled) {
          setLikedCommentIds(likedIds);
        }
      } catch {
        if (!cancelled) {
          setStatus('error');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // `onCommentCountResolved` is a reporting callback; re-running the fetch
    // when the parent re-creates it would refetch the thread on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  /**
   * Optimistically apply a SOFT delete, then reconcile: on failure put the row
   * back exactly as it was and say so. Same shape as the DM composer's send —
   * apply locally, reconcile on the response, surface the failure rather than
   * silently losing the write.
   *
   * Two local outcomes, mirroring the server:
   *   - the comment has replies → it becomes a TOMBSTONE IN PLACE. The row has to
   *     survive or the replies underneath it lose their anchor and disappear with
   *     it, which is the bug this replaced: deleting your own comment destroyed
   *     other people's.
   *   - the comment has none → the row goes, as before, since nothing depends on it.
   *
   * Either way the post's comment count drops by exactly ONE, because a tombstone
   * is not counted (`visibleCommentCount`).
   */
  const runDelete = useCallback(
    (comment: PostComment, keepAsTombstone: boolean) => {
      deletePendingRef.current.add(comment.id);
      const before = commentsRef.current;
      const after = keepAsTombstone
        ? before.map((entry) => (entry.id === comment.id ? toTombstone(entry) : entry))
        : before.filter((entry) => entry.id !== comment.id);

      setComments(after);
      onCommentCountResolved?.(visibleCommentCount(after));
      // You can't reply to something that is no longer there to be replied to.
      setReplyTo((current) => (current && current.id === comment.id ? null : current));
      setExpandedIds((current) => {
        const next = new Set(current);
        if (keepAsTombstone) {
          // Show the replies immediately: the confirmation just promised they
          // would stay, so the thread should prove it rather than collapse them
          // behind a toggle.
          next.add(comment.id);
        } else {
          next.delete(comment.id);
        }
        return next;
      });

      void (async () => {
        const ok = await deleteComment(comment.id);
        if (!ok) {
          const current = commentsRef.current;
          const currentById = new Map(current.map((entry) => [entry.id, entry]));
          const beforeIds = new Set(before.map((entry) => entry.id));
          const restored = [
            // Originals, in their original order. Only the row this delete
            // touched comes from the snapshot — that is what puts the body back
            // under a tombstone, or the whole row back if it was removed. Every
            // other row is taken from the CURRENT list so a concurrent change
            // isn't clobbered, and is dropped if something else removed it.
            ...before
              .map((entry) => (entry.id === comment.id ? entry : currentById.get(entry.id)))
              .filter((entry): entry is PostComment => Boolean(entry)),
            // Anything posted while the delete was in flight.
            ...current.filter((entry) => !beforeIds.has(entry.id)),
          ];
          setComments(restored);
          onCommentCountResolved?.(visibleCommentCount(restored));
          Alert.alert("Couldn't delete", 'That comment is still there. Please try again.');
        }
        deletePendingRef.current.delete(comment.id);
      })();
    },
    [onCommentCountResolved],
  );

  /**
   * Confirm before deleting. A plain `Alert` on purpose: this sheet is itself a
   * `Modal`, and `ConfirmDeleteSheet` is another `Modal` — stacking them is
   * unreliable on iOS (the second sheet can present behind this one, and its copy
   * is Collection-specific anyway). `Alert` is OS-level, so it always renders
   * above the sheet, and it is already this app's confirmation idiom.
   */
  const handleRequestDelete = useCallback(
    (comment: PostComment) => {
      if (deletePendingRef.current.has(comment.id)) {
        return;
      }
      const current = commentsRef.current;
      // Direct children decide the tombstone; descendants (children of children
      // included) are what the copy counts, because the thread flattens every
      // depth under the same top-level comment — so they all stay visible.
      const hasReplies = current.some((entry) => entry.parentCommentId === comment.id);
      const replyCount = collectDescendantIds(current, comment.id).length;
      Alert.alert(
        comment.parentCommentId ? 'Delete reply?' : 'Delete comment?',
        hasReplies
          ? // Say what actually happens now: your words go, the thread does not.
            // The old copy warned that the replies went too — they no longer do.
            `Your words are removed, but the ${replyCount} ${replyCount === 1 ? 'reply' : 'replies'} underneath stay, under a “comment was deleted” line. This can't be undone.`
          : "This can't be undone.",
        [
          { style: 'cancel', text: 'Cancel' },
          {
            onPress: () => runDelete(comment, hasReplies),
            style: 'destructive',
            text: 'Delete',
          },
        ],
      );
    },
    [runDelete],
  );

  const handleSend = useCallback(() => {
    const text = draft.trim();
    // `sending` is STATE, so two taps inside one frame both read it as false and
    // post the comment twice. That was reachable in practice: the composer used
    // to blur on submit, which collapsed the sheet and hid the posted comment,
    // so the natural response was to press send again. The ref closes the window
    // synchronously; `sending` stays for the disabled/greyed button.
    if (sendingRef.current || sending || text.length === 0 || !postId) {
      return;
    }
    const parent = replyTo;
    sendingRef.current = true;
    setSending(true);

    void (async () => {
      const newId = await addComment(postId, text, parent?.id ?? null);
      if (newId) {
        const optimistic: PostComment = {
          id: newId,
          postId,
          // The author is the signed-in user, whose profile we already hold.
          // Leaving these empty made a just-posted comment render as the
          // anonymous "Collector" fallback until the thread was refetched.
          authorId: currentUser?.id ?? '',
          author: currentUser
            ? {
                displayName: getResolvedDisplayName(currentUser),
                handle: currentUser.handle ?? null,
                avatarUrl: currentUser.avatarURL ?? null,
                isVerified: currentUser.isVerified === true,
              }
            : null,
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
        /*
          THE KEYBOARD STAYS UP, and the thread scrolls to what you just wrote.

          Sending used to `Keyboard.dismiss()` and then chase the resulting sheet
          collapse with a timed scroll. From the outside that is indistinguishable
          from the send doing nothing: the keyboard drops, the sheet shrinks, and
          your comment is at the end of a thread you are not looking at. The
          collapse was also the only thing that made the write visible, so when
          the timed scroll lost its race there was no feedback at all.

          Leaving the keyboard where it is means the sheet keeps its full height,
          your comment lands directly above the composer, and you can write
          another without tapping back in.
        */
        scrollAfterSendRef.current = true;
      }
      sendingRef.current = false;
      setSending(false);
    })();
  }, [currentUser, draft, onCommentAdded, postId, replyTo, sending]);

  // Renders one comment (top-level or reply): avatar + name/time + body (with an
  // optional inline blue @mention on replies) + the thumbs-up like and Reply
  // action. Your OWN row is additionally long-pressable to delete it. A tombstone
  // takes an early return and renders none of that.
  const renderComment = useCallback(
    (comment: PostComment, options: { isReply: boolean; mentionHandle?: string | null }) => {
      const rowTestIDForComment = `${testID}-comment-${comment.id}`;

      // A tombstone: the row survives only so the replies underneath it keep an
      // anchor. It shows NO author, NO avatar and NO timestamp — deliberately.
      // The body is what was withdrawn; leaving the name and face attached would
      // still tell the thread that this specific person said something here and
      // then took it back, which is most of what deleting was meant to undo. The
      // one other place this app has removed content (DM moderation) surfaces
      // nothing at all and "neither invents a placeholder"; the only reason this
      // one prints a line is that the replies need something to hang from.
      //
      // No affordances either: nothing to like, nobody to reply to, and no
      // long-press — a tombstone is already deleted.
      if (isTombstone(comment)) {
        return (
          <View style={styles.commentRow} testID={rowTestIDForComment}>
            <Text
              style={[theme.typography.body, styles.tombstone, { color: theme.colors.gray400 }]}
              testID={`${rowTestIDForComment}-tombstone`}
            >
              This comment was deleted
            </Text>
          </View>
        );
      }

      const liked = likedCommentIds.has(comment.id);
      const likeCount = likeCountOverrides[comment.id] ?? comment.likeCount;
      const mention = options.mentionHandle?.trim();
      const viewerId = currentUser?.id;
      // Courtesy only — `comments_delete` RLS (author_id = auth.uid()) is what
      // actually stops you deleting someone else's comment.
      const isMine = Boolean(viewerId) && comment.authorId === viewerId;
      const rowTestID = rowTestIDForComment;

      const rowContent = (
        <>
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
              {/*
                `caption` (12), not `bodyMedium` (14). At 14 Medium the
                timestamp was the same size AND weight as the author's name
                beside it, just greyer — so the meta line read as two names. 12
                matches the post card's date, which is the same piece of
                information one screen away.
              */}
              <Text style={[theme.typography.caption, { color: theme.colors.gray400 }]}>
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
                  height={COMMENT_ICON_SIZE}
                  width={COMMENT_ICON_SIZE}
                />
                {likeCount > 0 ? (
                  <Text style={[theme.typography.bodyMedium, { color: theme.colors.gray600 }]}>
                    {likeCount}
                  </Text>
                ) : null}
              </Pressable>
              <Pressable
                accessibilityRole="button"
                hitSlop={8}
                onPress={() => {
                  setReplyTo(comment);
                  // Otherwise "Reply" only swaps the placeholder — the composer
                  // is off at the bottom of the sheet with no keyboard up.
                  inputRef.current?.focus();
                }}
                style={styles.commentAction}
                testID={`${testID}-comment-${comment.id}-reply`}
              >
                <Text style={[theme.typography.bodyMedium, { color: theme.colors.gray600 }]}>
                  Reply
                </Text>
              </Pressable>
            </View>
          </View>
        </>
      );

      // Delete is a long-press on your own row, not an inline control. The row is
      // a 24px avatar next to a two-action strip (like + Reply); a third action
      // would crowd Reply, and anything in the meta line would push the
      // name/timestamp around. Press-and-hold is already the app's context-action
      // idiom (portfolio-screen's `CARD_LONG_PRESS_MS`), and it costs the row no
      // layout at all.
      if (!isMine) {
        return (
          <View style={styles.commentRow} testID={rowTestID}>
            {rowContent}
          </View>
        );
      }
      return (
        <Pressable
          // A long press is invisible to VoiceOver, so also publish it as a
          // rotor action — otherwise a screen-reader user has no way to delete.
          accessibilityActions={[{ label: 'Delete comment', name: 'longpress' }]}
          accessibilityHint="Press and hold to delete your comment"
          delayLongPress={COMMENT_LONG_PRESS_MS}
          onAccessibilityAction={(event) => {
            if (event.nativeEvent.actionName === 'longpress') {
              handleRequestDelete(comment);
            }
          }}
          onLongPress={() => handleRequestDelete(comment)}
          style={styles.commentRow}
          testID={rowTestID}
        >
          {rowContent}
        </Pressable>
      );
    },
    [
      currentUser?.id,
      handleRequestDelete,
      handleToggleCommentLike,
      likeCountOverrides,
      likedCommentIds,
      testID,
      theme,
    ],
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
      <View style={styles.root}>
        <Animated.View style={[styles.backdrop, { opacity: backdropOpacity }]}>
          <Pressable
            accessibilityLabel="Close"
            accessibilityRole="button"
            onPress={onClose}
            style={StyleSheet.absoluteFill}
            testID={`${testID}-backdrop`}
          />
        </Animated.View>
        <Animated.View
          style={[
            styles.sheet,
            {
              backgroundColor: theme.colors.gray0,
              height: sheetHeight,
              // Lift the composer clear of the keyboard. The sheet grew by the
              // same amount, so the thread keeps its height instead of paying
              // for the composer.
              //
              // Keyboard down: a flat 16, NOT max(insets.bottom, …). The safe
              // inset is 34 on a notched iPhone, which left the composer
              // floating well above the sheet's edge. 16 is the design spec and
              // still clears the home indicator, since the sheet's own rounded
              // bottom is inset from the screen edge anyway.
              paddingBottom:
                keyboardHeight > 0 ? keyboardHeight + KEYBOARD_GAP : COMPOSER_BOTTOM_GAP,
              transform: [{ translateY }],
            },
          ]}
          testID={testID}
        >
          <View style={styles.header} testID={`${testID}-header`} {...dragResponder.panHandlers}>
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
            // The ONLY reliable moment to scroll to a just-posted comment: the
            // content has grown by exactly that row, so the end position is
            // final. Scheduling it off the send instead — a frame, a timeout —
            // races the layout and lands short on a long thread.
            onContentSizeChange={() => {
              if (!scrollAfterSendRef.current) {
                return;
              }
              scrollAfterSendRef.current = false;
              scrollToLatest(true);
            }}
            ref={listRef}
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
                // Starting to type should put you at the end of the thread, so
                // you can see what you are replying to and watch your own
                // comment arrive under it. rAF so the scroll runs after the
                // keyboard-up relayout has shortened the list, not before it.
                onFocus={() => requestAnimationFrame(() => scrollToLatest(true))}
                onSubmitEditing={handleSend}
                placeholder={replyTo ? 'Add a reply…' : 'Add a comment…'}
                ref={inputRef}
                returnKeyType="send"
                /*
                  Keep the keyboard up after the return key posts.

                  A single-line TextInput defaults to `blurAndSubmit`, and the
                  return key here is LABELLED "Send" — so the obvious way to post
                  also blurred, which dropped `keyboardHeight` to 0 and shrank the
                  sheet from 0.9 to 0.6 of the screen. The comment really had
                  posted, but the thread collapsed and never scrolled to it, so it
                  read as "the button just closed the comments" and invited a
                  second press (see the send guard in `handleSend`).
                */
                submitBehavior="submit"
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
      </View>
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
    flex: 1,
    gap: 8,
    justifyContent: 'center',
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
    // 12px between actions and 12px above them — the body→actions→replies
    // column rhythm in Figma 2903-7970.
    gap: 12,
    marginTop: 12,
  },
  commentBody: {
    flex: 1,
    // No `gap` here — the meta→body and body→actions steps are different sizes
    // (2 / 12) and a container gap silently added itself to both.
    flexShrink: 1,
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
    marginTop: 2,
  },
  composer: {
    alignItems: 'center',
    borderTopWidth: 1,
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 16,
    // 8 here + 8 under the last comment = 16 from the thread to the field, with
    // the divider centred in it. It was 12 + 16 = 28, which read as a gap of its
    // own rather than as the thread ending.
    paddingTop: 8,
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
    // Takes whatever the header and composer leave inside the sheet's fixed
    // height, so the thread scrolls in place while the keyboard is up.
    flex: 1,
  },
  listContent: {
    // Fill the scroll viewport so the empty/loading states can center in it.
    flexGrow: 1,
    // 20 between threads so a thread's own 12px body→actions→replies rhythm
    // stays visibly tighter than the gap to the next comment.
    gap: 20,
    // Half of the 16 to the composer; the composer's `paddingTop` is the rest.
    paddingBottom: 8,
    paddingHorizontal: 16,
    paddingTop: 12,
  },
  repliesDash: {
    borderRadius: 1,
    height: 1,
    width: 16,
  },
  repliesToggle: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 6,
    marginLeft: REPLY_INDENT,
    marginTop: 12,
  },
  replyBanner: {
    alignItems: 'center',
    borderRadius: 10,
    flexDirection: 'row',
    gap: 8,
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
    // height is applied inline — it animates between the resting and
    // keyboard-up heights.
    paddingTop: 10,
  },
  thread: {
    width: '100%',
  },
  tombstone: {
    // No avatar next to it, so the line takes the row's full width and sits
    // flush left — visibly not shaped like somebody's comment.
    flex: 1,
  },
  title: {
    paddingBottom: 4,
    paddingHorizontal: 16,
    paddingTop: 4,
    textAlign: 'center',
  },
});

export default CommentsSheet;
