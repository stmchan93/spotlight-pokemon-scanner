import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  Dimensions,
  Easing,
  Keyboard,
  type LayoutChangeEvent,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  type TextInput,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import { ChatBubbleEmpty, MoreHoriz, SendDiagonal, ThumbsUp } from 'iconoir-react-native';

import { Avatar, Text, TextField, useSpotlightTheme } from '@spotlight/design-system';

import { ConfirmDeleteSheet } from '@/features/cards/components/confirm-delete-sheet';
import { OptionsSheet } from '@/features/social/components/options-sheet';
import {
  addComment,
  blockUser,
  deleteComment,
  fetchComments,
  fetchLikedCommentIds,
  likeComment,
  type PostComment,
  reportContent,
  unlikeComment,
} from '@/features/social/social-service';
import { getResolvedDisplayName } from '@/features/auth/auth-models';
import { profileRouteSlug } from '@/features/social/profile-link';
import { useAuth } from '@/providers/auth-provider';

type CommentsSheetProps = {
  visible: boolean;
  onClose: () => void;
  /*
    NO auto-focus prop, deliberately. The sheet used to open with the keyboard
    already up when it was entered from the card's chat icon, which meant reading
    a thread started with two thirds of it covered and the newest comments
    squeezed into a strip. Opening comments is a READ; the keyboard belongs to
    the moment you tap the composer. This mirrors the New Post composer, which
    deliberately opens keyboard-down for the same reason.
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
/**
 * The ⋯ options glyph (Figma 315:2992), same icon and role as the post card's
 * "Post options". Drawn at the comment row's own 18px icon size rather than the
 * card's 24: a comment row is built around a 24px avatar, so a 24px glyph beside
 * it would be as tall as the author's face and out-weigh the like it sits above.
 */
const COMMENT_MORE_ICON_SIZE = COMMENT_ICON_SIZE;
/**
 * The ⋯ button's own box. Explicit so the button can never be compressed to
 * nothing by the `flex: 1` comment body beside it — see `styles.moreButton`.
 */
const MORE_BUTTON_SIZE = 24;
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
 * The gap between the last comment and the composer, split evenly between the
 * list's own bottom padding and the composer's top padding so the divider ends
 * up centred in it.
 *
 * It only reads as this number because the thread is bottom-anchored — see
 * `styles.listContent`. Top-anchored, a short thread left the whole remainder of
 * the viewport here instead, which with the keyboard up was around 150pt of
 * white between the last comment and the field.
 */
const THREAD_TO_COMPOSER_GAP = 16;
/** The list's share of that gap; the composer's `paddingTop` is the other half. */
const LIST_BOTTOM_PADDING = THREAD_TO_COMPOSER_GAP / 2;
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
 * The right noun for a row. A comment with a parent is a REPLY, and a user
 * reported the mismatch: the confirmation asked "Delete reply?" and the row it
 * left behind then said "This comment was deleted". Every string that has to name
 * the thing comes from here, so the two cannot drift apart again.
 */
function commentNoun(isReply: boolean): 'comment' | 'reply' {
  return isReply ? 'reply' : 'comment';
}

/** The line a tombstone shows in place of the body it no longer has. */
export function tombstoneLabel(isReply: boolean): string {
  return `This ${commentNoun(isReply)} was deleted`;
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
/**
 * Walk a comment up to its top-level ancestor. `seen` also guards a cyclic
 * parent chain from spinning forever.
 */
function rootIdOf(byId: Map<string, PostComment>, comment: PostComment): string {
  let current = comment;
  const seen = new Set<string>();
  while (current.parentCommentId && byId.has(current.parentCommentId) && !seen.has(current.id)) {
    seen.add(current.id);
    current = byId.get(current.parentCommentId) as PostComment;
  }
  return current.id;
}

/**
 * The top-level comment whose BLOCK a row is rendered inside. The thread never
 * indents past one level, so a reply of any depth is drawn under its top-level
 * ancestor — which makes this the block that has to be brought into view when a
 * reply is posted, rather than the end of the thread the reply is not at.
 * Unknown ids answer for themselves, which is what a just-posted top-level
 * comment is.
 */
export function topLevelAncestorId(comments: PostComment[], commentId: string): string {
  const byId = new Map(comments.map((entry) => [entry.id, entry]));
  const comment = byId.get(commentId);
  return comment ? rootIdOf(byId, comment) : commentId;
}

function buildCommentThreads(comments: PostComment[]): CommentThread[] {
  const byId = new Map<string, PostComment>();
  for (const comment of comments) {
    byId.set(comment.id, comment);
  }

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
      const root = rootIdOf(byId, comment);
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
 * Drop tombstones that nothing hangs off any more.
 *
 * A tombstone exists ONLY to hold surviving replies up, so one with no replies
 * left is an empty "was deleted" line sitting over nothing. `fetchComments`
 * already applies this rule to a freshly loaded thread (`pruneChildlessTombstones`
 * in `social-service.ts`), but LOCAL state can strand one after the fact: delete a
 * comment, which stays as a tombstone because it has a reply, then delete that
 * reply — the tombstone is now childless and would sit there until the next
 * fetch. Depth-agnostic, so a stranded tombstone REPLY goes the same way as a
 * stranded top-level one.
 *
 * Run to a fixed point rather than in one pass: dropping one tombstone can strand
 * its (also tombstoned) parent. Each round strictly shrinks the set, so this
 * terminates in at most depth rounds.
 */
export function pruneOrphanedTombstones(comments: PostComment[]): PostComment[] {
  if (!comments.some(isTombstone)) {
    return comments;
  }
  let kept = comments;
  for (;;) {
    const keptIds = new Set(kept.map((entry) => entry.id));
    const parentsWithReplies = new Set<string>();
    for (const entry of kept) {
      const parentId = entry.parentCommentId;
      if (parentId && keptIds.has(parentId)) {
        parentsWithReplies.add(parentId);
      }
    }
    const next = kept.filter((entry) => !isTombstone(entry) || parentsWithReplies.has(entry.id));
    if (next.length === kept.length) {
      return next;
    }
    kept = next;
  }
}

/**
 * The one overlay the sheet can be showing over its thread: a delete
 * confirmation, the Report/Block menu, or the block confirmation.
 *
 * One slot rather than three booleans because only one is ever up, and because
 * the copy on each is derived from the comment it was opened for — which has to
 * survive the close so the sheet keeps its words while it slides away.
 */
type CommentPrompt =
  | { kind: 'delete'; comment: PostComment; keepAsTombstone: boolean; replyCount: number }
  | { kind: 'options'; comment: PostComment }
  | { kind: 'block'; comment: PostComment };

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
  const router = useRouter();

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
  /*
    ───────────────────────────────────────────────────────────────────────────
    THE ONE SCROLL THIS SHEET EVER PERFORMS
    ───────────────────────────────────────────────────────────────────────────
    The list is not a chat log — it also grows when a "N replies" toggle expands
    — so there is no unconditional scroll. Exactly one thing moves the thread:
    POSTING. Opening does not (you came to read), and neither does focusing the
    composer any more (reported: scrolling up to a comment, tapping Reply, and
    being thrown into the middle of the thread is the opposite of what Reply
    means).

    WHERE it goes is the row that was just added, NOT the end of the thread. A
    top-level comment is appended and those coincide; a REPLY is inserted under
    its parent, which can be anywhere, so "scroll to the bottom" would carry you
    away from the very thing you wrote. Both cases are therefore expressed the
    same way: put the bottom of the top-level BLOCK that now contains the new row
    at the bottom of the viewport.

    WHEN is the part that was actually broken. The scroll used to fire from
    `onContentSizeChange` alone, which lands in the middle of the sheet's own
    keyboard-down resize: `Keyboard.dismiss()` drops `paddingBottom` from
    `keyboardHeight + 8` to 16 IMMEDIATELY while the sheet's height eases from
    0.9 to 0.6 of the screen over `SHEET_RESIZE_MS`, so at that instant the list
    viewport is a third of a screen TALLER than it is about to be. An offset
    computed against it stops short on a long thread, and on a short one is
    clamped straight back to 0 — which is exactly the reported "it scrolls to the
    top after you post".

    So the target is held as a pending intent and applied on whichever
    measurement lands once the sheet has stopped moving under it. No timer: the
    triggers are the block's own `onLayout`, the list's `onLayout`, the content
    size change, and the resize animation's completion callback.
  */
  /**
   * The post-send scroll that has not landed yet: the top-level thread block
   * holding the just-posted row, and whether that block has been re-measured
   * SINCE the row was added.
   *
   * `measured` is not bookkeeping. A stale box is worse than no box: adding a
   * reply to a block measured before the reply existed resolves to an offset
   * above where the reply now is, which on a short thread clamps to 0 — the
   * "it scrolled to the top" report, reproduced exactly. The layout pass emits
   * the content-size change and the block's own layout in an order this
   * component does not get to choose, so the trigger cannot be trusted; only a
   * measurement of the target block itself can release the scroll.
   */
  const pendingScrollRef = useRef<{ rootId: string; measured: boolean } | null>(null);
  /** Measured box of each top-level thread block, in the list's scroll coordinates. */
  const threadLayoutsRef = useRef(new Map<string, { y: number; height: number }>());
  /** The list's own measured height — the viewport the target is computed against. */
  const listViewportHeightRef = useRef(0);
  /** Readable-from-a-callback mirror of `keyboardHeight`. */
  const keyboardHeightRef = useRef(0);
  /** True while the sheet is easing between its resting and keyboard-up heights. */
  const sheetResizingRef = useRef(false);
  /** The height the sheet is currently heading for, so a no-op pass is recognisable. */
  const sheetHeightTargetRef = useRef(SHEET_HEIGHT_RESTING);

  /**
   * Apply the pending post-send scroll if everything it needs is settled and
   * measured. Cheap and idempotent, so every trigger can simply call it.
   */
  const runPendingScroll = useCallback(() => {
    const pending = pendingScrollRef.current;
    if (!pending || !pending.measured) {
      return;
    }
    // Not while the keyboard is still on its way out and not while the sheet is
    // still growing or shrinking: the viewport the offset would be computed
    // against is not the one it will be measured against a moment later.
    if (keyboardHeightRef.current > 0 || sheetResizingRef.current) {
      return;
    }
    const viewport = listViewportHeightRef.current;
    const box = threadLayoutsRef.current.get(pending.rootId);
    if (!box || viewport <= 0) {
      return;
    }
    pendingScrollRef.current = null;
    // Over-scroll is clamped by the scroll view, so aiming at the true bottom of
    // the block can only be right; a short thread resolves to 0 and stays put.
    const target = Math.max(0, box.y + box.height + LIST_BOTTOM_PADDING - viewport);
    listRef.current?.scrollTo({ animated: true, y: target });
  }, []);

  /**
   * Where the thread should land once the keyboard is up and the sheet has
   * finished growing. Armed by opening the composer, spent by the resize.
   *
   *  - `end`    — tapping "Add a comment…". You are about to add to the end of
   *               the thread, so the end is what you want to see.
   *  - `thread` — tapping "Reply" on a comment. Puts the BOTTOM of that
   *               comment's block at the bottom of the viewport, i.e. the
   *               composer opens directly under the Reply button you pressed,
   *               with what you are replying to right above it.
   *
   * Neither can be done inside `onFocus`: the keyboard is still travelling, the
   * sheet is mid-grow, and the viewport an offset would be computed against is
   * not the one it will be measured against a moment later. That is precisely
   * why the earlier focus-scroll landed "in the middle of the comment page" and
   * was removed. Focus only ARMS this; the sheet's own resize-completion
   * callback spends it — the same settled beat `runPendingScroll` waits for.
   */
  const pendingFocusScrollRef = useRef<{ kind: 'end' } | { kind: 'thread'; rootId: string } | null>(
    null,
  );

  /**
   * Apply the pending focus scroll once everything it needs has settled.
   * Idempotent, so every trigger can simply call it.
   */
  const runPendingFocusScroll = useCallback(() => {
    const pending = pendingFocusScrollRef.current;
    if (!pending) {
      return;
    }
    // The mirror image of `runPendingScroll`'s guard: this one is only ever
    // wanted with the keyboard UP, and never mid-resize.
    if (keyboardHeightRef.current <= 0 || sheetResizingRef.current) {
      return;
    }
    if (pending.kind === 'end') {
      pendingFocusScrollRef.current = null;
      listRef.current?.scrollToEnd({ animated: true });
      return;
    }
    const viewport = listViewportHeightRef.current;
    const box = threadLayoutsRef.current.get(pending.rootId);
    if (!box || viewport <= 0) {
      // Not measured yet — `handleThreadLayout` will call back.
      return;
    }
    pendingFocusScrollRef.current = null;
    // Over-scroll is clamped by the scroll view, so aiming at the true bottom of
    // the block can only be right; a short thread resolves to 0 and stays put.
    const target = Math.max(0, box.y + box.height + LIST_BOTTOM_PADDING - viewport);
    listRef.current?.scrollTo({ animated: true, y: target });
  }, []);

  const handleListLayout = useCallback(
    (event: LayoutChangeEvent) => {
      listViewportHeightRef.current = event.nativeEvent.layout.height;
      runPendingScroll();
    },
    [runPendingScroll],
  );

  const handleThreadLayout = useCallback(
    (rootId: string, event: LayoutChangeEvent) => {
      const { height, y } = event.nativeEvent.layout;
      threadLayoutsRef.current.set(rootId, { height, y });
      const pending = pendingScrollRef.current;
      if (pending && pending.rootId === rootId) {
        pending.measured = true;
      }
      runPendingScroll();
      // A reply target can be armed before its block has ever been measured
      // (expanding the replies grows it), so this is the other release point.
      runPendingFocusScroll();
    },
    [runPendingFocusScroll, runPendingScroll],
  );

  const [comments, setComments] = useState<PostComment[]>([]);
  const [status, setStatus] = useState<LoadStatus>('loading');
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  /** Synchronous mirror of `sending` — see `handleSend` for why state isn't enough. */
  const sendingRef = useRef(false);
  /*
    Swallow the ONE change event the field emits as it gives up first responder.

    This is the actual mechanism behind "send just dismisses the keyboard and my
    text is still there", and it is why five fixes aimed at the button, the
    gesture and the keyboard all missed: nothing was wrong with the press, and
    the row really was written — the text came BACK afterwards.

    iOS commits any pending autocorrect/predictive suggestion when the field
    resigns, and RN reports that commit as an ordinary text change:
    `RCTBackedTextInputDelegateAdapter.textFieldDidEndEditing` compares the
    field's string against the last one it told JS about and, if they differ,
    fires `textInputDidChange` BEFORE `textInputDidEndEditing`. So the sequence
    on a successful send is: clear the draft, dismiss the keyboard, and then
    `onChangeText` arrives carrying the sentence we just posted and puts it
    straight back into `draft` — at which point React's value and the native
    text agree, so nothing ever clears it again.

    Armed immediately before the post-send `Keyboard.dismiss()` and consumed by
    the next change event. That window can hold nothing else: the keyboard is on
    its way out, so no keystroke can arrive, and re-focusing the composer to type
    again disarms it (`onFocus`) before any character can be typed.
  */
  const ignoreNextDraftChangeRef = useRef(false);
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
  // Reports in flight, so a second tap on ⋯ can't file (and acknowledge) twice.
  const reportPendingRef = useRef<Set<string>>(new Set());
  /*
    The overlay currently over the thread, and whether it is open.

    Two pieces of state, not one: the prompt is RETAINED after it closes so the
    sheet still has its title and body copy to render while it slides back down.
    Nulling it on close would blank the words mid-dismissal.
  */
  const [prompt, setPrompt] = useState<CommentPrompt | null>(null);
  const [promptOpen, setPromptOpen] = useState(false);
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
      keyboardHeightRef.current = 0;
      setKeyboardHeight(0);
      return;
    }
    // iOS gets the "will" events so the sheet tracks the keyboard's own curve;
    // Android only reliably fires the "did" pair.
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const showSub = Keyboard.addListener(showEvent, (event) => {
      const height = event.endCoordinates?.height ?? 0;
      keyboardHeightRef.current = height;
      setKeyboardHeight(height);
    });
    const hideSub = Keyboard.addListener(hideEvent, () => {
      keyboardHeightRef.current = 0;
      setKeyboardHeight(0);
    });
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, [visible]);

  // Grow the sheet toward full screen while the keyboard is up, and settle back
  // when it goes down. Same 250ms/ease-out shape as the iOS keyboard curve, so
  // the top edge rises with the keyboard instead of after it.
  useEffect(() => {
    const toValue = keyboardHeight > 0 ? SHEET_HEIGHT_EXPANDED : SHEET_HEIGHT_RESTING;
    hiddenOffsetRef.current = toValue;
    // Only a CHANGE of target actually moves the sheet. Marking every run as a
    // resize would leave the flag set by the mount pass — where the sheet is
    // already at its resting height — and a pending post-send scroll would then
    // wait for a completion callback that has nothing to complete.
    const willMove = toValue !== sheetHeightTargetRef.current;
    sheetHeightTargetRef.current = toValue;
    if (willMove) {
      sheetResizingRef.current = true;
    }
    const animation = Animated.timing(sheetHeight, {
      toValue,
      duration: SHEET_RESIZE_MS,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    });
    animation.start(({ finished }) => {
      if (!finished) {
        return;
      }
      sheetResizingRef.current = false;
      // The sheet has stopped moving, so the list's viewport is final and a
      // post-send scroll can finally aim at something that will still be true
      // one frame later. This is the beat the old content-size-only scroll
      // fired well before, and why it landed short (or was clamped to the top).
      runPendingScroll();
      // Same settled beat, opposite direction: the composer just opened and the
      // sheet has finished growing, so the focus scroll can aim truly.
      runPendingFocusScroll();
    });
    return () => animation.stop();
  }, [keyboardHeight, runPendingFocusScroll, runPendingScroll, sheetHeight]);

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
    setPromptOpen(false);
    pendingScrollRef.current = null;
    // A target armed against the PREVIOUS post's thread must not survive into
    // this one — the ids would not match, and an `end` target would scroll a
    // freshly-opened sheet that is meant to start at the top.
    pendingFocusScrollRef.current = null;
    threadLayoutsRef.current.clear();
    /*
      Opening the sheet starts at the TOP of the thread, like every other comment
      list — no scroll on open at all.

      It used to jump to the newest comment when the sheet was entered from the
      chat icon, which only made sense because that entry ALSO raised the
      keyboard: the thread was a short strip above the composer, so landing
      anywhere else showed its middle. With the keyboard no longer opening on
      entry the whole thread is visible from the top, and yanking a reader to the
      bottom of someone else's conversation would be the app deciding what they
      came to read. POSTING is the only thing that moves the thread now.
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
      const applied = keepAsTombstone
        ? before.map((entry) => (entry.id === comment.id ? toTombstone(entry) : entry))
        : before.filter((entry) => entry.id !== comment.id);
      // Removing the last reply under an OLDER tombstone leaves that tombstone
      // holding nothing up, so it goes too — and so does its parent, if that was
      // a tombstone as well.
      const after = pruneOrphanedTombstones(applied);
      const afterIds = new Set(after.map((entry) => entry.id));
      // Rows this delete swept away as a side effect. The rollback has to take
      // them from the snapshot, because the current list no longer has them.
      const strandedIds = new Set(
        applied.filter((entry) => !afterIds.has(entry.id)).map((entry) => entry.id),
      );

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
            // Originals, in their original order. Only the rows this delete
            // touched come from the snapshot — the row itself (which is what puts
            // the body back under a tombstone, or the whole row back if it was
            // removed) plus any tombstone the prune stranded on its way out.
            // Every other row is taken from the CURRENT list so a concurrent
            // change isn't clobbered, and is dropped if something else removed it.
            ...before
              .map((entry) =>
                entry.id === comment.id || strandedIds.has(entry.id)
                  ? entry
                  : currentById.get(entry.id),
              )
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

  /*
    OPENING A PROMPT, and why these are sheets rather than `Alert`s now.

    They used to be `Alert`s because this sheet is itself a `Modal` and
    `ConfirmDeleteSheet` was another `Modal`, and stacking two native modals is
    unreliable on iOS — the second can present BEHIND the first, which reads as
    the button doing nothing. That constraint was about the MODAL, not about the
    component: `ConfirmDeleteSheet` now takes `presentation="inline"` and renders
    its scrim + sheet inside whatever view tree it is given. Rendered as the last
    child of this sheet's own Modal, there is no second view controller and
    therefore nothing to collide with, so the delete confirmation is now literally
    the same component the post delete uses (`use-post-deletion.tsx`).

    The keyboard goes away first: every one of these is bottom-anchored, and a
    confirmation behind the keyboard is the same invisible-button failure by
    another route.
  */
  const openPrompt = useCallback((next: CommentPrompt) => {
    Keyboard.dismiss();
    setPrompt(next);
    setPromptOpen(true);
  }, []);

  const closePrompt = useCallback(() => {
    setPromptOpen(false);
  }, []);

  /** Confirm before deleting — Cancel, or a red Delete, exactly like a post. */
  const handleRequestDelete = useCallback(
    (comment: PostComment) => {
      if (deletePendingRef.current.has(comment.id)) {
        return;
      }
      const current = commentsRef.current;
      // Direct children decide the tombstone; descendants (children of children
      // included) are what the copy counts, because the thread flattens every
      // depth under the same top-level comment — so they all stay visible.
      openPrompt({
        kind: 'delete',
        comment,
        keepAsTombstone: current.some((entry) => entry.parentCommentId === comment.id),
        replyCount: collectDescendantIds(current, comment.id).length,
      });
    },
    [openPrompt],
  );

  /**
   * File the report. Nothing is hidden locally as a result: social_04 only hides a
   * comment once THREE distinct people report it, so pretending otherwise here
   * would promise an outcome the server does not deliver. The only feedback is the
   * acknowledgement, which is also why the failure case has to say so — a silent
   * no-op would read as "reported" to someone who reported nothing.
   */
  const runReport = useCallback((comment: PostComment) => {
    reportPendingRef.current.add(comment.id);
    void (async () => {
      const ok = await reportContent({
        reportedUserId: comment.authorId,
        commentId: comment.id,
        // `reports.reason` is nullable and there is no reason picker on this
        // surface — a second sheet to choose one would be the very Modal stacking
        // `handleRequestDelete` avoids. An empty string is stored as null rather
        // than as an invented category the moderator would have to distrust.
        reason: '',
      });
      reportPendingRef.current.delete(comment.id);
      if (ok) {
        // Deliberately the same copy whether or not this reporter had already
        // reported this comment: the write is idempotent, and telling someone
        // "you already reported this" only invites them to try to report harder.
        //
        // Short on purpose. Earlier drafts also promised anonymity and warned
        // that reporting hides nothing until three distinct people report the
        // same target — both true, both cut on request. Word-for-word identical
        // to the post card's acknowledgement: reporting is one action, and it
        // should not sound like two different features depending on what you
        // reported.
        Alert.alert(
          'Report sent',
          "Thanks for reporting this. We've received your report and will take a look at this as soon as possible.",
        );
        return;
      }
      Alert.alert("Couldn't report", 'That report did not go through. Please try again.');
    })();
  }, []);

  /**
   * Block this comment's author. Reached only from the block confirmation, which
   * is not optional: this is the one action here that changes what a whole other
   * account can see.
   *
   * The confirmation copy promises no undo on purpose: `unblockUser` exists in the
   * service but nothing in the app calls it yet, so there is no unblock surface to
   * point at. Same wording as the post card's block confirmation — one action
   * against one person should not read as two different things depending on where
   * you tapped.
   */
  const runBlock = useCallback((comment: PostComment) => {
    if (reportPendingRef.current.has(comment.id)) {
      return;
    }
    const displayName = authorDisplayName(comment);
    reportPendingRef.current.add(comment.id);
    void (async () => {
      const ok = await blockUser(comment.authorId);
      reportPendingRef.current.delete(comment.id);
      if (ok) {
        // The thread is not re-fetched here: `is_blocked` is enforced in the RLS
        // select policy, so the block takes effect on the next read. Saying so is
        // better than silently leaving their words on screen and letting the
        // viewer think the block failed.
        //
        // An `Alert` and not a sheet, here and in the other outcome messages
        // below: these are ACKNOWLEDGEMENTS, not confirmations. There is nothing
        // to choose, the post card says the same things the same way, and an
        // OS alert over a Modal is the one stacking that has never been in doubt.
        Alert.alert(
          `${displayName} is blocked`,
          'You will stop seeing them the next time this thread loads.',
        );
      } else {
        Alert.alert(
          "Couldn't block",
          `${displayName} has not been blocked. Please try again in a moment.`,
        );
      }
    })();
  }, []);

  /**
   * The safety menu for someone else's comment: Report and Block together.
   *
   * Block is here because `reportContent`'s own contract says it must be —
   * reporting hides nothing until THREE distinct people report the same target,
   * so a report-only menu leaves the viewer still reading the thing they just
   * reported. The tempting argument against ("block is an action against a
   * person, so it belongs on their post or profile") fails on the ordinary case:
   * someone commenting on YOUR post may have no post anywhere in your feed, so
   * this row is the only place you can reach them at all.
   *
   * Shaped exactly like the post card's ⋯ — menu, then a confirmation only for
   * Block. Report needs none: it is idempotent server-side (social_04's unique
   * constraint) and hides nothing, so a confirm step would only add friction to
   * the safer of the two actions.
   */
  const handleRequestReport = useCallback(
    (comment: PostComment) => {
      if (reportPendingRef.current.has(comment.id)) {
        return;
      }
      openPrompt({ kind: 'options', comment });
    },
    [openPrompt],
  );

  /**
   * Every keystroke in the composer, minus the one the keyboard's own dismissal
   * echoes back — see `ignoreNextDraftChangeRef`.
   */
  const handleDraftChange = useCallback((next: string) => {
    if (ignoreNextDraftChangeRef.current) {
      ignoreNextDraftChangeRef.current = false;
      return;
    }
    setDraft(next);
  }, []);

  /**
   * Post the draft. Returns whether it actually STARTED a send, which is what
   * lets the button fire on touch-down without risking a double post — see the
   * send button below.
   */
  const handleSend = useCallback((): boolean => {
    const text = draft.trim();
    // `sending` is STATE, so two taps inside one frame both read it as false and
    // post the comment twice. That was reachable in practice: the composer used
    // to blur on submit, which collapsed the sheet and hid the posted comment,
    // so the natural response was to press send again. The ref closes the window
    // synchronously; `sending` stays for the disabled/greyed button.
    if (sendingRef.current || sending || text.length === 0 || !postId) {
      return false;
    }
    const parent = replyTo;
    const submitted = draft;
    sendingRef.current = true;
    setSending(true);

    /*
      EMPTY THE FIELD NOW, on touch-down, not when the write comes back.

      Two reasons, and the first is the one the user actually sees: a composer
      that still holds your sentence for the length of a round trip is a
      composer that looks like it ignored you, which is what invites the second
      press. The DM composer has always cleared on this beat.

      The second is the native layer. `setDraft('')` alone asks React to push an
      empty value down; `clear()` issues the same `setTextAndSelection` command
      imperatively, at the moment of the press, so the field lets go of any
      in-progress autocorrect composition instead of holding it until the
      keyboard resigns. `TextField` forwards its ref to the underlying
      `TextInput`, so this reaches the real node.

      A failed write puts the text back below.
    */
    setDraft('');
    inputRef.current?.clear();

    void (async () => {
      const result = await addComment(postId, text, parent?.id ?? null);
      if (result.ok) {
        const optimistic: PostComment = {
          id: result.id,
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
        setReplyTo(null);
        onCommentAdded?.(optimistic);
        /*
          POST, then put the keyboard away — in that order, and only once the
          write has come back with an id. This is what was asked for: send,
          dismiss, clear.

          An earlier revision removed the dismiss because it was paired with a
          TIMED scroll that chased the sheet's collapse and regularly lost the
          race, leaving your comment at the end of a thread you were no longer
          looking at — indistinguishable from the send doing nothing. That was
          the timer's fault, not the dismissal's: the scroll is a measured target
          applied once the sheet has settled (see `runPendingScroll`), which
          cannot fire before the row exists or while the sheet is still moving.
          Both can be true at once.

          A FAILED write keeps the keyboard up and the draft intact, because that
          is what trying again needs.
        */
        // The BLOCK the new row is drawn in: its own, for a top-level comment;
        // its parent's top-level ancestor, for a reply. `commentsRef` is still
        // the pre-append list, which is exactly where the parent chain lives.
        pendingScrollRef.current = {
          measured: false,
          rootId: parent ? topLevelAncestorId(commentsRef.current, parent.id) : result.id,
        };
        // Armed on this exact beat: the dismissal is what makes the field commit
        // its pending autocorrect, and that commit arrives as a change event
        // carrying the sentence we just posted. See `ignoreNextDraftChangeRef`.
        //
        // iOS ONLY, and that restriction is load-bearing. The guard is disarmed
        // by `onFocus`, and on iOS `Keyboard.dismiss()` always blurs, so focus
        // is guaranteed to intervene before the next comment is typed. On
        // ANDROID dismissing need not blur — so the flag can survive all the way
        // to the next keystroke and swallow the first character of the next
        // comment. A test caught it doing exactly that.
        //
        // The mechanism it guards against (`textFieldDidEndEditing` committing a
        // pending suggestion) is an iOS-only behaviour anyway. It also remains
        // UNCONFIRMED on a real device: it was added as the diagnosis for the
        // two-tap send bug, and the real cause turned out to be a `ScrollView`
        // stealing the first touch. If the field clears cleanly on one tap now,
        // this guard is guarding nothing and should be deleted outright.
        ignoreNextDraftChangeRef.current = Platform.OS === 'ios';
        Keyboard.dismiss();
      } else {
        /*
          SAY SO. A failed write used to do nothing at all: the draft stayed, no
          comment appeared, and nothing was reported — which on the phone is
          exactly what a dead send button looks like. That silence is why this
          bug survived five fixes aimed at the button, the gesture and the
          keyboard while the write was the thing failing.

          `reason` is the database's own message, not a generic apology, so a
          policy rejection or a missing migration names itself instead of having
          to be guessed at from the outside.

          PUT THE TEXT BACK, too. It was cleared on touch-down, which is right
          for the case that succeeds, but trying again needs the sentence — and
          retyping it is not something to ask of someone whose comment just
          bounced. Only if the composer is still empty: if they started writing
          something else while the write was in flight, that is theirs.
        */
        setDraft((current) => (current.length === 0 ? submitted : current));
        Alert.alert("Couldn't post comment", result.reason);
      }
      sendingRef.current = false;
      setSending(false);
    })();
    return true;
  }, [currentUser, draft, onCommentAdded, postId, replyTo, sending]);

  /*
    ───────────────────────────────────────────────────────────────────────────
    WHY THE FIRST TAP ON SEND NEVER ARRIVES WHILE THE KEYBOARD IS UP
    ───────────────────────────────────────────────────────────────────────────
    Confirmed with the user: the first tap does nothing but drop the keyboard,
    and a SECOND tap posts. That is not a race, a stale draft, or an autocorrect
    echo — it is React Native's `ScrollView` doing precisely what it is written
    to do, and its own source says so word for word:

      // * the keyboard is up, keyboardShouldPersistTaps is 'never' (the default),
      // and a new touch starts with a non-textinput target (in which case the
      // first tap should be sent to the scroll view and dismiss the keyboard,
      // then the second tap goes to the actual interior view)
        — ScrollView.js, `_handleStartShouldSetResponderCapture`

    That handler is wired as `onStartShouldSetResponderCapture`. Capture is
    dispatched ROOT → TARGET, so every ScrollView ABOVE this button in the React
    tree is asked before the button is, and the first one to return true takes
    the touch outright. The one that answers is not in this file: the sheet is a
    `Modal` mounted by `PostCard`, `Modal` keeps its children in the same fiber
    tree, and the screens that host a `PostCard` (feed, post detail, public
    profile) render it inside a list that leaves `keyboardShouldPersistTaps`
    unset — i.e. `'never'`. Its `onResponderRelease` then blurs the focused
    input, which is the keyboard dropping. Six fixes aimed at this button missed
    because the thief is an ancestor OUTSIDE the sheet.

    This sheet's own `keyboardShouldPersistTaps="handled"` (on the thread list
    below) cannot help either: the composer is a SIBLING of that list, not a
    descendant, so the prop never governs these taps.

    ───────────────────────────────────────────────────────────────────────────
    WHY `onTouchEnd`, AND WHY IT CANNOT BE BEATEN
    ───────────────────────────────────────────────────────────────────────────
    Nothing inside the `Modal` can outrank an ancestor's capture handler — by
    construction, capture reaches the ancestor first. So the button stops relying
    on the responder system for its liveness.

    Raw touch events do not participate in responder negotiation at all. React
    Native runs TWO event plugins over every touch, in order and without
    short-circuiting — `ResponderEventPlugin` (which is what an ancestor wins)
    and `ReactNativeBridgeEventPlugin`, which dispatches `topTouchStart` /
    `topTouchEnd` two-phase through the fiber tree as the ordinary bubbling
    `onTouchStart` / `onTouchEnd` props. They fire on this button whether or not
    something above it stole the responder, so this is a guarantee rather than a
    race won.

    It is also robust to the one thing not proven from source: exactly WHICH
    ancestor scroller claims the touch. `onTouchEnd` does not care who took it.

    ───────────────────────────────────────────────────────────────────────────
    ONE TAP POSTS EXACTLY ONE COMMENT
    ───────────────────────────────────────────────────────────────────────────
    Four handlers can now report the same tap. In the order the runtime delivers
    them:

      onTouchStart  a gesture began — always
      onPressIn     touch-down, ONLY if this button won the responder
      onPress       release, ONLY if it won the responder — and VoiceOver, which
                    fires it with no touch events anywhere around it
      onTouchEnd    always — this is the one that survives the theft

    Two guards, because the two pairs need different rules and collapsing them
    into one flag breaks whichever case the flag was not written for.

    `sentOnPressInRef` is unchanged: `onPressIn` records whether it started a
    send and `onPress` CONSUMES that, so the responder pair posts once and a
    later screen-reader activation — which arrives as `onPress` alone — still
    posts. It has to be consumed rather than left set, or a VoiceOver user gets
    exactly one working tap per session.

    `gestureSentRef` is scoped to a physical gesture and is only ever read by
    `onTouchEnd`, which asks one question: did anything already post during this
    touch? If the responder pair ran, yes, and the touch path stays quiet. If an
    ancestor took the responder, nothing ran, and the touch path is what posts.
    Both flags are cleared at the END of the gesture — `onTouchEnd` /
    `onTouchCancel` — so no state leaks into the next tap.

    `handleSend`'s own `sendingRef` remains the backstop underneath all of it:
    it closes the window synchronously, so even a duplicate that somehow got
    past both flags could not produce a second row.
  */
  const sentOnPressInRef = useRef(false);
  /** Whether a send has already been started during the touch now in progress. */
  const gestureSentRef = useRef(false);
  /** Whether a raw touch is in progress at all — false for a VoiceOver press. */
  const gestureActiveRef = useRef(false);

  const handleSendPressIn = useCallback(() => {
    const started = handleSend();
    sentOnPressInRef.current = started;
    if (started) {
      gestureSentRef.current = true;
    }
  }, [handleSend]);
  const handleSendPress = useCallback(() => {
    if (sentOnPressInRef.current) {
      sentOnPressInRef.current = false;
      return;
    }
    if (handleSend()) {
      gestureSentRef.current = true;
    }
  }, [handleSend]);

  const handleSendTouchStart = useCallback(() => {
    gestureActiveRef.current = true;
    gestureSentRef.current = false;
  }, []);
  const endGesture = useCallback(() => {
    gestureActiveRef.current = false;
    gestureSentRef.current = false;
    sentOnPressInRef.current = false;
  }, []);
  const handleSendTouchEnd = useCallback(() => {
    // Only when the responder pair never got the chance — i.e. the tap this fix
    // exists for.
    if (gestureActiveRef.current && !gestureSentRef.current) {
      handleSend();
    }
    endGesture();
  }, [endGesture, handleSend]);

  // Renders one comment (top-level or reply): avatar + name/time + body (with an
  // optional inline blue @mention on replies) + the thumbs-up like and Reply
  // action, and a ⋯ options button whose single option depends on whose comment it
  // is — Delete on yours (which is additionally long-pressable, as it always was),
  // Report on anyone else's. A tombstone takes an early return and renders none of
  // that, including the ⋯: there is nothing left to delete or to report.
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
      // No affordances either: nothing to like, nobody to reply to, no ⋯ and no
      // long-press — a tombstone is already deleted, and there is no author left
      // on the row to report.
      if (isTombstone(comment)) {
        return (
          <View style={styles.commentRow} testID={rowTestIDForComment}>
            <Text
              style={[theme.typography.body, styles.tombstone, { color: theme.colors.gray400 }]}
              testID={`${rowTestIDForComment}-tombstone`}
            >
              {/*
                "reply", not "comment", when the row IS a reply — taken from where
                the row is actually rendered in the thread, which is the same
                thing the delete confirmation asked about. Calling a reply a
                comment here was reported by a user who had just been asked
                "Delete reply?".
              */}
              {tombstoneLabel(options.isReply)}
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

      // Same rule as the post card: the face and the name open the profile,
      // nothing else in the row does. Null for an author with neither a handle
      // nor an id, which is every TOMBSTONE — those return above this line, but
      // the guard keeps a deleted account from rendering a dead button.
      const authorLink = profileRouteSlug(comment.author?.handle, comment.authorId);
      const openAuthorProfile = () => {
        // Closing FIRST in both branches: this sheet is a `Modal`, and routing
        // underneath one leaves it presented over wherever you just landed.
        // Tapping YOURSELF goes to the You tab rather than a read-only public
        // copy of your own profile — same rule as the post card.
        if (currentUser?.id && comment.authorId === currentUser.id) {
          onClose();
          router.navigate('/you' as never);
          return;
        }
        if (authorLink) {
          onClose();
          router.push(`/u/${authorLink}` as never);
        }
      };

      const rowContent = (
        <>
          <Pressable
            accessibilityLabel={authorLink ? `View ${authorDisplayName(comment)}'s profile` : undefined}
            accessibilityRole={authorLink ? 'button' : undefined}
            disabled={!authorLink}
            onPress={openAuthorProfile}
            testID={`${rowTestIDForComment}-avatar-button`}
          >
            <Avatar
              initials={commentInitials(comment.author?.displayName ?? null, comment.author?.handle ?? null)}
              size={AVATAR_SIZE}
              uri={comment.author?.avatarUrl}
            />
          </Pressable>
          <View style={styles.commentBody}>
            <View style={styles.commentMeta}>
              <Pressable
                accessibilityLabel={authorLink ? `View ${authorDisplayName(comment)}'s profile` : undefined}
                accessibilityRole={authorLink ? 'button' : undefined}
                disabled={!authorLink}
                hitSlop={6}
                onPress={openAuthorProfile}
                style={styles.commentName}
                testID={`${rowTestIDForComment}-name-button`}
              >
                <Text
                  numberOfLines={1}
                  style={[theme.typography.bodyMedium, { color: theme.colors.gray900 }]}
                >
                  {authorDisplayName(comment)}
                </Text>
              </Pressable>
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
                  // Land the composer directly under THIS comment's Reply
                  // button, with the comment you are answering still on screen
                  // above it. Armed before `focus()` so the field's own
                  // `onFocus` sees a target and does not overwrite it with the
                  // generic "scroll to the end".
                  pendingFocusScrollRef.current = {
                    kind: 'thread',
                    rootId: topLevelAncestorId(commentsRef.current, comment.id),
                  };
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
          {/*
            The VISIBLE way in. Delete had only ever been a long press, which is
            invisible — the report that prompted this was "there's no UI I can see
            to delete the comment" — and reporting someone else's comment had no
            entry point at all.

            Same ⋯ as the post card's "Post options", and the same shape: your own
            comment has exactly one option (Delete), so the button opens that
            confirmation directly rather than an action sheet with a single row in
            it; someone else's opens the Report/Block safety menu. It sits OUTSIDE
            the meta line, at the end of the row, so the name and timestamp keep
            their positions.
          */}
          <Pressable
            accessibilityLabel="Comment options"
            accessibilityRole="button"
            // 24 + 10 either side = a 44pt target, the iOS minimum, without the
            // button itself having to be 44 wide and eat the reply column.
            hitSlop={10}
            onPress={() => (isMine ? handleRequestDelete(comment) : handleRequestReport(comment))}
            style={styles.moreButton}
            testID={`${rowTestIDForComment}-more-button`}
          >
            <MoreHoriz
              color={theme.colors.gray500}
              height={COMMENT_MORE_ICON_SIZE}
              width={COMMENT_MORE_ICON_SIZE}
            />
          </Pressable>
        </>
      );

      // The long press STAYS on your own row, on top of the ⋯ above. It is the
      // app's context-action idiom (portfolio-screen's `CARD_LONG_PRESS_MS`), it
      // costs the row no layout, and people who already learned it should not lose
      // it just because the same action finally became visible.
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
      handleRequestReport,
      handleToggleCommentLike,
      likeCountOverrides,
      likedCommentIds,
      onClose,
      router,
      testID,
      theme,
    ],
  );

  if (!isRendered) {
    return null;
  }

  const canSend = draft.trim().length > 0 && !sending;

  // Copy shared by all three prompts, derived from the comment each was opened
  // for. `prompt` outlives its own close, so these stay stable while it slides
  // away — see the state declaration.
  const promptComment = prompt?.comment ?? null;
  const promptIsReply = Boolean(promptComment?.parentCommentId);
  const promptNoun = commentNoun(promptIsReply);
  const promptAuthor = promptComment ? authorDisplayName(promptComment) : '';

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
            // Three of the four triggers for a pending post-send scroll (the
            // fourth is the sheet-resize animation finishing). Each is a moment
            // a measurement changed; `runPendingScroll` decides whether enough
            // of them have landed to aim at something final.
            onContentSizeChange={runPendingScroll}
            onLayout={handleListLayout}
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
                  <View
                    key={comment.id}
                    // The block's measured box is the post-send scroll target —
                    // a reply lands inside it, wherever in the thread it is.
                    onLayout={(event) => handleThreadLayout(comment.id, event)}
                    style={styles.thread}
                    testID={`${testID}-thread-${comment.id}`}
                  >
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

          {/*
            A LABEL, not a control. It says who you are replying to for exactly
            as long as you are replying to them, and it goes away when you leave
            the composer (`onBlur` below).

            It used to carry an X to cancel the reply, which was wrong twice
            over. Mechanically: the X sits next to a focused `TextInput` inside
            this Modal, so the first tap on it got eaten the same way the send
            button's did — the keyboard dropped, `onPress` never ran, and the
            banner stayed up still claiming you were replying. And in principle:
            "am I writing a reply or a comment?" is answered by whether the
            composer is focused on a reply, so it does not need a second,
            separate way to say no — leaving the composer already means that.
          */}
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
            </View>
          ) : null}

          <View
            style={[styles.composer, { borderTopColor: theme.colors.outlineSubtle }]}
            testID={`${testID}-composer`}
          >
            <View style={styles.composerField}>
              <TextField
                onChangeText={handleDraftChange}
                // Leaving the composer ends the reply. This is what replaced the
                // banner's X: "replying to X" is true while you are writing that
                // reply and false the moment you stop, so it needs no separate
                // control. Safe against the send path, which captures `replyTo`
                // synchronously on touch-down — a blur that follows can never
                // turn a reply into a top-level comment.
                onBlur={() => setReplyTo(null)}
                /*
                  FOCUS MOVES NOTHING. It used to scroll to the end of the thread
                  on the argument that you would want to see what you are replying
                  to — which is precisely backwards for the way Reply is actually
                  used: you scroll UP to a specific comment, tap Reply, and the
                  thread threw you back down to a conversation you had deliberately
                  left. Reported as "it scrolls to like the middle of the comment
                  page"; the ask is that the keyboard come up wherever you are.

                  The post-send scroll is what keeps this safe. That used to be
                  partly masked by this one — with the target now measured and
                  applied after the sheet settles (`runPendingScroll`), posting
                  still brings your own row into view without focus having to.
                */
                onFocus={() => {
                  // Coming back to write again disarms the post-send change
                  // guard, so the first character of the NEXT comment is never
                  // mistaken for the last one's dismissal echo.
                  ignoreNextDraftChangeRef.current = false;
                  // Tapping the field itself means "add to the end". Reply
                  // focuses this same field, but arms a THREAD target first —
                  // so never clobber a target that is already set.
                  if (!pendingFocusScrollRef.current) {
                    pendingFocusScrollRef.current = { kind: 'end' };
                  }
                  runPendingFocusScroll();
                }}
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
              onPress={handleSendPress}
              onPressIn={handleSendPressIn}
              /*
                The raw touch pair is what makes the FIRST tap work while the
                keyboard is up — see the note above `gestureSentRef`. `Pressable`
                passes both straight through to its underlying `View` (they are
                not among the props it destructures, and the handlers it does
                install are responder ones), so they reach the real node and
                cannot be shadowed. They also fire while `disabled` is true,
                which is harmless: `handleSend` re-checks the draft and the
                in-flight guard itself rather than trusting the prop.
              */
              onTouchCancel={endGesture}
              onTouchEnd={handleSendTouchEnd}
              onTouchStart={handleSendTouchStart}
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

        {/*
          The prompts, LAST inside this sheet's own Modal and outside the sheet
          itself — they cover the whole modal (thread, composer and scrim), and
          being the last children they paint over it. Each is mounted only while
          it is the active prompt and driven by `promptOpen`, which is what lets
          it animate out with its copy intact before it unmounts.
        */}
        {prompt?.kind === 'delete' ? (
          <ConfirmDeleteSheet
            confirmLabel="Delete"
            message={
              prompt.keepAsTombstone
                ? // Say what actually happens: your words go, the thread does not.
                  // Deliberately plain and countless — an earlier draft quoted the
                  // exact reply count and the tombstone's own wording back at the
                  // user, which is precision nobody asked for at the moment they
                  // are deciding whether to delete something.
                  `Your ${promptNoun} will be removed but the replies will remain. `
                  + 'Are you sure you want to continue?'
                : "This can't be undone."
            }
            onClose={closePrompt}
            onConfirm={() => {
              const { comment, keepAsTombstone } = prompt;
              closePrompt();
              runDelete(comment, keepAsTombstone);
            }}
            presentation="inline"
            testID={`${testID}-delete-confirm`}
            title={promptIsReply ? 'Delete reply?' : 'Delete comment?'}
            visible={promptOpen}
          />
        ) : null}

        {prompt?.kind === 'options' ? (
          <OptionsSheet
            actions={[
              {
                key: 'report',
                label: `Report ${promptNoun}`,
                // Not the same red as Block: a report is idempotent, hides
                // nothing on its own and is read by a human before anything
                // happens, while a block is immediate and has no undo in the app.
                tone: 'caution',
                onPress: () => {
                  const { comment } = prompt;
                  closePrompt();
                  runReport(comment);
                },
              },
              {
                key: 'block',
                label: `Block ${promptAuthor}`,
                tone: 'destructive',
                // Straight into the confirmation, replacing this menu. Both are
                // plain views, so there is no dismiss to wait on.
                onPress: () => openPrompt({ kind: 'block', comment: prompt.comment }),
              },
            ]}
            /*
              NO title and NO subtitle: the two rows say what they are, and
              "Comment options" over them was a label for a thing the user is
              already looking at. The reassurance that used to sit here — that
              the author is never told who reported or blocked them — did not go
              away with it: the block half is in the block confirmation
              (`Block <name>?`, below), and the report half is in the report
              acknowledgement (`runReport`), which is the moment it is actually
              wanted rather than one more line to read past.
            */
            onClose={closePrompt}
            testID={`${testID}-options`}
            visible={promptOpen}
          />
        ) : null}

        {prompt?.kind === 'block' ? (
          <ConfirmDeleteSheet
            confirmLabel="Block"
            message="Their posts and comments disappear from your feed, and yours disappear from theirs. They are not told that you blocked them."
            onClose={closePrompt}
            onConfirm={() => {
              const { comment } = prompt;
              closePrompt();
              runBlock(comment);
            }}
            presentation="inline"
            testID={`${testID}-block-confirm`}
            title={`Block ${promptAuthor}?`}
            visible={promptOpen}
          />
        ) : null}
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
    // The other half of THREAD_TO_COMPOSER_GAP: 8 here + 8 under the last
    // comment = 16 from the thread to the field, with the divider centred in it.
    // It was 12 + 16 = 28, which read as a gap of its own rather than as the
    // thread ending.
    paddingTop: THREAD_TO_COMPOSER_GAP - LIST_BOTTOM_PADDING,
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
    /*
      BOTTOM-ANCHOR A SHORT THREAD.

      With `flexGrow` alone the content container is the viewport's height and
      the comments sit at the TOP of it, so everything the thread does not fill
      is dead white between the last comment and the composer — around 150pt of
      it with three short comments and the keyboard up, because the sheet grows
      to 0.9 of the screen exactly then. Anchored to the end, a short thread
      rests ON the composer at the intended 16, and a thread taller than the
      viewport is unaffected: there is no free space left to distribute, so it
      scrolls exactly as before.

      The empty/loading/error states are unaffected too — each is `flex: 1`, so
      it absorbs the free space this would otherwise push down and keeps
      centring itself in the sheet.
    */
    justifyContent: 'flex-end',
    paddingBottom: LIST_BOTTOM_PADDING,
    paddingHorizontal: 16,
    paddingTop: 12,
  },
  moreButton: {
    alignItems: 'center',
    // Level with the author's name, not floating beside the middle of the body:
    // the row's height is the body's, and a centred glyph would drift down the
    // longer the comment is.
    alignSelf: 'flex-start',
    /*
      A DETERMINISTIC footprint, because this button had none.

      It is a flex sibling of `commentBody`, which is `flex: 1` AND
      `flexShrink: 1`. With no width and no `flexShrink: 0` of its own, the ⋯ was
      whatever space the body left it — so a long comment, a narrow screen, or a
      reply (indented by REPLY_INDENT, which has the least room of all) could
      squeeze it toward zero and the button the user is meant to tap simply is
      not there. Sized and unshrinkable, it always occupies exactly this box.
    */
    flexShrink: 0,
    height: MORE_BUTTON_SIZE,
    justifyContent: 'center',
    width: MORE_BUTTON_SIZE,
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
