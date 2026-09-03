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
import { useSafeAreaInsets } from 'react-native-safe-area-context';

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
import { capturePostHogEvent } from '@/lib/observability/posthog';
import { keyboardInsetSurcharge } from '@/lib/keyboard-insets';
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
  /**
   * A comment to open ON — set when a notification about a reply brought the
   * reader here. Its thread is expanded (a reply is collapsed by default, so it
   * would otherwise not even be rendered) and the sheet rests on it instead of
   * on the end of the thread.
   */
  focusCommentId?: string | null;
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

/*
  The keyboard OVERLAYS the app on both platforms, so the composer has to be
  lifted by its height on both.

  It is worth writing down why Android is not the exception it looks like.
  `softwareKeyboardLayoutMode` is unset, so Expo asks for `adjustResize` — but
  under EDGE-TO-EDGE, which Expo SDK 55 / RN 0.83 enable by default and Android
  15 enforces regardless, the window is NOT resized: the app draws behind the
  system bars and the IME, and is expected to consume the inset itself. So
  `adjustResize` is inert here and the keyboard covers the composer exactly as
  it does on iOS.

  Assuming the resize was real is what buried the input on Android — the lift
  was removed, and nothing took its place.

  The earlier "large white space" was a DIFFERENT bug in the same area: the
  sheet grew by a flat 0.3 x SCREEN while padding by the measured keyboard
  height. That is fixed in `sheetHeightForKeyboard`, not here.
*/
const KEYBOARD_OVERLAYS_CONTENT = true;
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
 * The tallest the sheet is ever allowed to get. A ceiling, not a target — see
 * `sheetHeightForKeyboard`.
 */
const SHEET_HEIGHT_MAX = SCREEN_HEIGHT * 0.9;
/** Gap between the composer's bottom edge and the top of the keyboard. */
const KEYBOARD_GAP = 8;
/**
 * How long the sheet takes to grow/shrink between its resting and keyboard-up
 * heights. Shared by the animation and by the post-send scroll, which must not
 * run until the sheet has stopped moving under it.
 */
const SHEET_RESIZE_MS = 250;

/**
 * The design gap under the composer — the air between the field and whatever is
 * below it. NOT the whole padding: on Android the system takes a strip of the
 * screen under this, and `composerBottomPadding` adds it. See
 * `systemBottomInset`.
 */
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
/*
  ─────────────────────────────────────────────────────────────────────────────
  THE ANDROID NAVIGATION BAR, AND WHY IT BROKE BOTH KEYBOARD STATES AT ONCE
  ─────────────────────────────────────────────────────────────────────────────
  Reported on a Galaxy A17, as two bugs:

    1. keyboard DOWN — the ||| / home / back bar covers the composer.
    2. keyboard UP   — the keyboard covers the composer, so you cannot see what
                       you are typing.

  They are ONE bug: this sheet never accounted for the navigation bar, and on
  Android that strip is missing from BOTH of the numbers the composer is
  positioned by. Traced through the platform rather than guessed:

  • THE WINDOW NEVER RESIZES, so the JS lift is the only mechanism there is.
    `ReactModalHostView` sets the dialog window to `SOFT_INPUT_ADJUST_RESIZE`
    (ReactModalHostView.kt) — but the same file's `statusBarTranslucent` /
    `navigationBarTranslucent` getters return `field || isEdgeToEdgeFeatureFlagOn`,
    and this app builds with `edgeToEdgeEnabled=true` (android/gradle.properties),
    so the dialog always takes the `enableEdgeToEdge()` branch —
    `WindowCompat.setDecorFitsSystemWindows(window, false)`. Under that,
    `adjustResize` is inert by design: the window stays full-screen, the system
    bars and the IME are drawn OVER it, and the app is expected to consume the
    insets itself. So there is no native resize to lean on and nothing to
    configure our way out of — consuming the inset in JS IS the platform-correct
    mechanism here, not a workaround for one.

  • THE NAV BAR OVERLAYS THE SHEET. Same reason: the dialog window's bottom edge
    is the physical bottom of the screen, and the navigation bar is painted on
    top of it. 16pt of padding puts the composer squarely underneath it. That is
    symptom (1).

  • THE REPORTED KEYBOARD HEIGHT EXCLUDES THE NAV BAR. This is the part that is
    easy to get wrong, and it is symptom (2): `keyboardDidShow`'s
    `endCoordinates.height` is the keyboard's height ABOVE the navigation bar, so
    the top edge of the keyboard is at `keyboardHeight + navBar` above the
    window's bottom, not at `keyboardHeight`. Padding by `keyboardHeight + 8`
    therefore left the composer ~40pt short and the keyboard drew straight over
    it. The platform citation (`ReactRootView.java:922`) and the matching iOS
    explanation are NOT repeated here — they live once, in
    `src/lib/keyboard-insets.ts`, which `systemBottomInset` below is this sheet's
    alias for. Three surfaces had derived that arithmetic independently before it
    was extracted.

  • THE INSET IS THE SAME NUMBER IN BOTH STATES. `useSafeAreaInsets().bottom`
    comes from `react-native-safe-area-context`, whose Android implementation
    (SafeAreaUtils.kt) asks for `statusBars | displayCutout | navigationBars |
    captionBar` and deliberately never includes the IME — so it does not move
    when the keyboard opens, and adding it to both states double-counts nothing.

  iOS is untouched, and that is not caution but arithmetic: `keyboardWillShow`
  reports the keyboard's frame in SCREEN coordinates, which already reaches the
  bottom of the display, and the home indicator is an overlay content is allowed
  to sit under (which is why `COMPOSER_BOTTOM_GAP` was chosen over the 34pt inset
  in the first place — 34 left the composer visibly floating). `systemBottomInset`
  therefore returns 0 on iOS and every number below is exactly what it was.
*/

/**
 * The strip at the bottom of the screen the SYSTEM has taken and the composer
 * must not be drawn under — the Android navigation bar (or gesture handle).
 * Zero on iOS, deliberately: see the note above.
 *
 * THIS IS THIS SHEET'S NAME FOR A SHARED FUNCTION. The body used to be here; it
 * is now `keyboardInsetSurcharge` in `src/lib/keyboard-insets.ts`, which is
 * where the `ReactRootView.java:922` citation and the iOS screen-coordinate
 * explanation live, and which `new-post-screen.tsx` and
 * `edit-profile-screen.tsx` derive their own numbers from. The alias is kept so
 * every reference in this file — and the geometry tests that import it — still
 * reads in the sheet's own vocabulary. It is the same function, so `platform`
 * is still injectable for the same reason `sheetHeightForKeyboard` takes its
 * flag: re-importing this module under a patched `Platform.OS` resets the module
 * registry and takes every other test in the file with it.
 */
export const systemBottomInset = keyboardInsetSurcharge;

/**
 * Everything the composer reserves below itself, which is also the sheet's own
 * `paddingBottom`.
 *
 * Two terms, and keeping them separate is what keeps the sheet's geometry
 * honest:
 *
 *  - the SYSTEM's strip (`systemBottomInset`), which is present in BOTH keyboard
 *    states and identical in each — the nav bar does not move when the keyboard
 *    opens, and the reported keyboard height does not include it (see above).
 *  - the gap the composer wants above whatever is beneath it:
 *    `COMPOSER_BOTTOM_GAP` at rest, `keyboardHeight + KEYBOARD_GAP` while the
 *    keyboard is up.
 *
 * Because the first term is the same in both states it CANCELS out of the
 * difference between them — which is precisely the quantity
 * `sheetHeightForKeyboard` grows the sheet by. That is why fixing the Android
 * navigation bar does not touch `composerLift`, and why it cannot reintroduce
 * the height/padding mismatch documented there: the two numbers are still
 * derived from this one function.
 */
export function composerBottomPadding(
  keyboardHeight: number,
  systemInset: number,
  keyboardOverlaysContent: boolean = KEYBOARD_OVERLAYS_CONTENT,
): number {
  const system = Math.max(0, systemInset);
  if (keyboardHeight > 0 && keyboardOverlaysContent) {
    return system + keyboardHeight + KEYBOARD_GAP;
  }
  return system + COMPOSER_BOTTOM_GAP;
}

/**
 * How tall the sheet should be for a given keyboard height.
 *
 * The sheet GROWS while the keyboard is up rather than letting the thread be
 * squeezed by it (the Instagram comment sheet): the sheet's bottom
 * `keyboardHeight` sits behind the keyboard, so the readable strip above the
 * composer stays about half the screen and the thread keeps scrolling as you
 * type.
 *
 * IT HAS TO GROW BY EXACTLY WHAT THE COMPOSER'S PADDING COSTS, and that is why
 * this is arithmetic and not a constant. The keyboard-up height used to be a flat
 * `SCREEN_HEIGHT * 0.9` while the same view padded its bottom by the MEASURED
 * `keyboardHeight + KEYBOARD_GAP` — two independent numbers that only agreed by
 * accident. The difference between them landed in the thread: a keyboard smaller
 * than the fixed growth left the list taller than it needs to be, which on a
 * short (bottom-anchored) thread is dead white space, and a keyboard larger than
 * it silently shortened the thread instead.
 *
 * So: the padding under the composer goes from `COMPOSER_BOTTOM_GAP` to
 * `keyboardHeight + KEYBOARD_GAP`, and the sheet grows by that difference. The
 * list — which takes whatever the header, composer and padding leave — then keeps
 * EXACTLY the height it had with the keyboard down.
 *
 * IT TAKES NO SAFE-AREA INSET, and that is a consequence rather than an
 * oversight. The Android navigation bar is reserved in BOTH keyboard states and
 * by the same amount (`composerBottomPadding`), so it cancels out of the
 * DIFFERENCE between them — which is the only thing this function is. Adding it
 * here as well would grow the sheet by a strip the padding did not gain, and the
 * surplus would land in the thread as exactly the white space described above.
 *
 * `SHEET_HEIGHT_MAX` is a ceiling on that, not the target. A full-size phone
 * keyboard is taller than the 0.3 of the screen there is to grow into, so the
 * sheet stops at 0.9 and the thread pays the remainder — the alternative is a
 * sheet taller than the screen.
 */
export function sheetHeightForKeyboard(
  keyboardHeight: number,
  // Injectable so the Android branch is testable without re-importing the
  // module under a patched `Platform.OS` — doing that resets the module
  // registry and takes every other test in the file with it.
  keyboardOverlaysContent: boolean = KEYBOARD_OVERLAYS_CONTENT,
): number {
  if (keyboardHeight <= 0 || !keyboardOverlaysContent) {
    // Android resizes the WINDOW instead of overlaying (see
    // `KEYBOARD_OVERLAYS_CONTENT`), so the composer is already clear of the
    // keyboard and there is nothing for extra height to pay for. Growing here
    // would make the sheet taller than the window it now lives in.
    return SHEET_HEIGHT_RESTING;
  }
  // Written out rather than as `composerBottomPadding(k, i) -
  // composerBottomPadding(0, i)` because the two are the same thing and this
  // form is the one the comment above explains. The system inset would cancel
  // either way.
  const composerLift = keyboardHeight + KEYBOARD_GAP - COMPOSER_BOTTOM_GAP;
  return Math.min(SHEET_HEIGHT_MAX, SHEET_HEIGHT_RESTING + composerLift);
}

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
 * Delete is SOFT: a deleted comment stays in the thread as a TOMBSTONE — always,
 * whether or not anything hangs off it — so the thread says the same thing about
 * every comment that has been deleted, and the service marks it with a boolean
 * rather than sending the body. The flag is declared here as an
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
 * How many comments the post should be credited with.
 *
 * A tombstone is NOT one. The count answers "how many comments are there to
 * read", and a "This comment was deleted" line is the absence of one — so a
 * delete always drops the post's count by exactly one even though the row it
 * leaves behind is still on screen.
 *
 * This is not a free choice either: `posts.comment_count` is maintained by a DB
 * trigger that decrements on the `deleted_at` transition and "asks nothing about
 * replies" (social_17 §4). Counting tombstones here would put the sheet
 * permanently one ahead of the number the card shows from the server.
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
 * The block at the END of the thread — the last top-level comment, replies and
 * all. Null for an empty thread.
 *
 * One definition, because two places need the same answer to "where does this
 * thread end": the sheet's opening position and the composer-focus scroll. Both
 * mean the last BLOCK rather than the last row: a reply is drawn inside its
 * top-level ancestor, so the newest comment in the list is not necessarily the
 * lowest thing on screen.
 */
export function lastThreadBlockId(comments: PostComment[]): string | null {
  const threads = buildCommentThreads(comments);
  return threads.length > 0 ? threads[threads.length - 1].comment.id : null;
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

/*
  THERE IS NO TOMBSTONE PRUNE ANY MORE, and its absence is the feature.

  This file used to export `pruneOrphanedTombstones`, the local mirror of
  `pruneChildlessTombstones` in `social-service.ts`: a tombstone existed ONLY to
  hold surviving replies up, so one with nothing under it was swept away and the
  row simply vanished. That was working as designed, and the design is what the
  user asked to change — because it made the thread inconsistent in the one way a
  reader can actually see. Delete a comment somebody had replied to and the thread
  says "This comment was deleted"; delete the one next to it that nobody answered
  and the row is gone without a word. The reported symptom was "only the FIRST
  deleted comment says it was deleted", and the difference between them was never
  visible from the outside.

  So a delete now always leaves a tombstone, at every depth, replies or not, and
  nothing sweeps one away afterwards. The cost is stated plainly: a thread whose
  author deletes everything they wrote becomes a column of "This comment was
  deleted" lines. That is the user's explicit call — one rule, said the same way
  every time — and it is why the count stays honest (`visibleCommentCount`) even
  though the rows do not disappear.

  The fetch side had to change with it or the fix would have been worse than the
  bug: a tombstone that appears on delete and vanishes on the next load is a
  third behaviour, not a fix. See `fetchComments` in `social-service.ts`.
*/

/**
 * The one overlay the sheet can be showing over its thread: a delete
 * confirmation, the Report/Block menu, or the block confirmation.
 *
 * One slot rather than three booleans because only one is ever up, and because
 * the copy on each is derived from the comment it was opened for — which has to
 * survive the close so the sheet keeps its words while it slides away.
 */
type CommentPrompt =
  | { kind: 'delete'; comment: PostComment; replyCount: number }
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
  focusCommentId = null,
  onCommentAdded,
  onCommentCountResolved,
  testID = 'comments-sheet',
}: CommentsSheetProps) {
  const theme = useSpotlightTheme();
  const router = useRouter();
  /*
    REAL VALUES INSIDE THIS `Modal`, and it is worth saying why, because the
    usual warning about safe-area context not crossing a modal boundary is about
    a different library shape.

    `useSafeAreaInsets` reads a React CONTEXT, and RN's `Modal` keeps its
    children in the same fiber tree — so the value here is the one published by
    the `<SafeAreaProvider>` at the app root (`src/app/_layout.tsx`), which
    measures the ACTIVITY's root window. That is the right window to measure:
    the dialog this sheet lives in is edge-to-edge and full-screen (see the note
    above `systemBottomInset`), so its bottom edge and the activity's are the
    same physical edge and the navigation bar sits over both.

    The repo already depends on exactly this: `OptionsSheet` and
    `ConfirmDeleteSheet` are rendered as children of THIS Modal, below, and both
    pad themselves with `Math.max(insets.bottom, 16) + 8`.
  */
  const insets = useSafeAreaInsets();
  const bottomInset = systemBottomInset(insets.bottom);

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
   * The post-send scroll that has not landed yet: the top-level thread block the
   * just-posted row is drawn in, the row ITSELF when that row is a reply, and
   * whether the thing being aimed at has been measured SINCE the row was added.
   *
   * `measured` is not bookkeeping. A stale box is worse than no box: adding a
   * reply to a block measured before the reply existed resolves to an offset
   * above where the reply now is, which on a short thread clamps to 0 — the
   * "it scrolled to the top" report, reproduced exactly. The layout pass emits
   * the content-size change and the block's own layout in an order this
   * component does not get to choose, so the trigger cannot be trusted; only a
   * measurement of the target itself can release the scroll.
   */
  const pendingScrollRef = useRef<{
    rootId: string;
    replyId: string | null;
    measured: boolean;
    /**
     * Whether the reader should SEE this scroll happen.
     *
     * True for everything that answers something they just did — posting,
     * opening the composer, tapping Reply — because the movement is the
     * feedback. False for the sheet's OPENING position: arriving already at the
     * end of the thread is where the thread rests, and animating there would
     * read as the sheet jumping the moment you looked at it.
     */
    animated: boolean;
    /**
     * Refuse to scroll PAST the target's own top edge.
     *
     * Only the composer's scroll asks for this, and only because its target is
     * something the reader has to keep LOOKING at while they type. Aiming a
     * block's bottom above the composer scrolls its top off the screen as soon
     * as the block is taller than the viewport — which for a top-level comment
     * means the comment you tapped Reply on, since a block is the comment plus
     * every reply under it. Reported as replying scrolling the thread down away
     * from what you are answering.
     *
     * The other two targets must NOT clamp: the opening scroll aims at the end
     * of the last block on purpose, and a post-send scroll aims at the row you
     * just wrote. Both WANT the bottom, and both are routinely taller than the
     * viewport, so clamping them would pin the thread to the wrong end.
     */
    keepTopVisible: boolean;
  } | null>(null);
  /** Measured box of each top-level thread block, in the list's scroll coordinates. */
  const threadLayoutsRef = useRef(new Map<string, { y: number; height: number }>());
  /**
   * Measured box of each REPLY row, in its own thread block's coordinates (the
   * row is a child of the block, so `onLayout` reports it relative to that).
   * Kept apart from `threadLayoutsRef` for exactly that reason — the two maps are
   * in different coordinate spaces and adding them is the whole point.
   */
  const replyLayoutsRef = useRef(new Map<string, { y: number; height: number }>());
  /** The list's own measured height — the viewport the target is computed against. */
  const listViewportHeightRef = useRef(0);
  /** Readable-from-a-callback mirror of `keyboardHeight`. */
  const keyboardHeightRef = useRef(0);
  /**
   * True while the sheet's height is changing — or is certain to start changing
   * in a moment, which is the same thing to anything trying to measure against it.
   */
  const sheetResizingRef = useRef(false);
  /** The height the sheet is currently heading for, so a no-op pass is recognisable. */
  const sheetHeightTargetRef = useRef(SHEET_HEIGHT_RESTING);

  /**
   * Where the list has to be scrolled to put the bottom of one row at the bottom
   * of the viewport, with `LIST_BOTTOM_PADDING` of air under it. Null while
   * anything it needs is unmeasured.
   *
   * `replyId` is what makes a reply land on ITSELF rather than on the bottom of
   * the block it happens to sit in: the thread flattens every depth under one
   * top-level block, so "the block" is only the right answer while the row is the
   * last thing in it. Falls back to the block's own bottom when the row has not
   * been measured — that is the older behaviour, and it is a floor, not a guess.
   */
  const scrollTargetFor = useCallback(
    (rootId: string, replyId: string | null, keepTopVisible = false): number | null => {
      const viewport = listViewportHeightRef.current;
      const block = threadLayoutsRef.current.get(rootId);
      if (!block || viewport <= 0) {
        return null;
      }
      const reply = replyId ? replyLayoutsRef.current.get(replyId) : undefined;
      const top = reply ? block.y + reply.y : block.y;
      const bottom = reply ? block.y + reply.y + reply.height : block.y + block.height;
      // Over-scroll is clamped by the scroll view, so aiming at the true bottom can
      // only be right; a short thread resolves to 0 and stays put.
      const atBottom = bottom + LIST_BOTTOM_PADDING - viewport;
      /*
        Never scroll past the target's own top when the reader has to keep it in
        sight (see `keepTopVisible`). For anything shorter than the viewport the
        two agree — `atBottom` is already at or above `top` — so this only ever
        binds on the tall block that was the bug.
      */
      return Math.max(0, keepTopVisible ? Math.min(atBottom, top) : atBottom);
    },
    [],
  );

  /**
   * Apply the pending post-send scroll if everything it needs is settled and
   * measured. Cheap and idempotent, so every trigger can simply call it.
   */
  const runPendingScroll = useCallback(() => {
    const pending = pendingScrollRef.current;
    if (!pending || !pending.measured) {
      return;
    }
    /*
      NOT WHILE THE VIEWPORT IS STILL CHANGING — and that is all this asks.

      It used to also refuse whenever `keyboardHeightRef.current > 0`, which was
      shorthand for the same thing back when the only way to reach here was a send
      that had just called `Keyboard.dismiss()`: keyboard still up meant the hide
      had not landed yet. As a standing rule it is wrong, and it silently
      ABANDONED scrolls — a target armed by a send, then measured after the
      composer was reopened, sat there forever because the keyboard was up again.
      `sheetResizingRef` is the real signal, and the send path sets it itself
      before dismissing (see `handleSend`) so the pre-hide window is still covered.
    */
    if (sheetResizingRef.current) {
      return;
    }
    const target = scrollTargetFor(pending.rootId, pending.replyId, pending.keepTopVisible);
    if (target === null) {
      return;
    }
    pendingScrollRef.current = null;
    /*
      A SHORT THREAD ASKS FOR NOTHING ON OPEN.

      `scrollTargetFor` clamps at 0, and a thread shorter than the viewport
      resolves there — but a freshly-opened list is already at 0, so issuing the
      command would be a native round trip that moves nothing. The bottom anchor
      (`styles.listContent`) is what already has that case right.

      Only the un-animated OPENING scroll may be skipped this way. For the
      animated ones the list can be anywhere the reader left it, so y = 0 is a
      real move — back to the top of a thread whose first comment is the one
      that was just answered — and must still be issued.
    */
    if (target === 0 && !pending.animated) {
      return;
    }
    listRef.current?.scrollTo({ animated: pending.animated, y: target });
  }, [scrollTargetFor]);

  /*
    ───────────────────────────────────────────────────────────────────────────
    OPENING THE COMPOSER: TWO CASES, AND THEY ARE NOT THE SAME CASE
    ───────────────────────────────────────────────────────────────────────────
    Both raise the keyboard through the same `TextInput`, so it is tempting to
    give them one rule. Two rounds of bug reports say otherwise, one in each
    direction:

      CASE 1 — tapping the FIELD ("Add a comment…"). SCROLL TO THE BOTTOM.
        You are about to add to the END of the thread. Leaving a long thread
        wherever it happened to be reads as broken: reported as "it just opened
        the keyboard and it feels like it's in the middle because it didn't
        scroll down to the bottom".

      CASE 2 — tapping REPLY. PUT THAT COMMENT JUST ABOVE THE COMPOSER.
        Not the end of the thread, and not "stay put" either: "it should scroll
        to be right under the reply button" — you want to see what you are
        answering while you type it. Reply focuses this same FIELD, so it arms
        its own target BEFORE calling `focus()` and case 1 stands down on
        finding one already in flight.

    Both are the same shape — put the bottom of one measured box at the bottom
    of the viewport — so both are the same code, and neither is a special
    scroll. Case 1 aims at the LAST top-level block; case 2 aims at the row you
    tapped Reply on (its own box when it is a reply, its block when it is a
    top-level comment, which is also what puts its replies on screen with it).

    ───────────────────────────────────────────────────────────────────────────
    AND NEITHER OF THEM MAY EVER BE `scrollToEnd`
    ───────────────────────────────────────────────────────────────────────────
    Both symptoms this sheet was reported for — the dead white space under a
    long thread, and the earlier "with lots of comments it scrolls to like the
    middle of the comment page" — were ONE bug, and it was not that these
    scrolls should not exist. It was how they were executed: `scrollToEnd()`,
    which is the obvious way to write "scroll to the bottom" and is the one
    scroll command React Native does NOT clamp on iOS:

    • `RCTScrollViewComponentView.scrollTo:` (RN 0.83,
      React/Fabric/.../RCTScrollViewComponentView.mm, ~line 915) builds a
      `maxRect` from `contentSize - bounds + contentInset` and clamps the
      requested offset into it. `scrollToEnd:`, twenty lines below at ~942,
      computes `contentSize.height - bounds.size.height + contentInset.bottom`
      and applies only `fmax(offsetY, 0)` — there is no upper bound. UIScrollView
      keeps a programmatic offset past the end of its content, so whatever it
      overshoots by stays on screen as DEAD WHITE SPACE under the last row until
      you touch the list.

    • And this sheet is guaranteed to hand it a viewport that is mid-change. The
      composer's `paddingBottom` jumps to `keyboardHeight + KEYBOARD_GAP` on the
      keyboard event while the sheet's height EASES to its new value over
      `SHEET_RESIZE_MS` (see the resize effect), so for that quarter second the
      list is `SHEET_HEIGHT_RESTING - chrome - (keyboardHeight + 8)` tall — about
      56pt on an 852pt iPhone against a settled ~312. The bounds a native command
      reads are the last MOUNTED layout, not the value JS just finished
      animating, and every point of that lag was a point of dead space.

    • That is why the white gap needed a LONG thread (`fmax(offsetY, 0)` pins
      anything shorter than the viewport to 0, so it cannot overshoot) and why it
      never appeared on Android (`ReactScrollViewManager.scrollToEnd` aims at
      `child.height + paddingBottom`, deliberately past the end, and
      `ScrollView.scrollTo`/`smoothScrollTo` clamp into the scroll range on the
      way in).

    So both cases arm the SAME `pendingScrollRef` the post-send scroll uses and
    are spent by the SAME `runPendingScroll`: a `scrollTo` — the clamped command
    — at a target computed by `scrollTargetFor`, released only once
    `sheetResizingRef` says the sheet has stopped moving. One settle signal, one
    scroll path, three callers. An overshoot is clamped instead of parked, and a
    target computed against a viewport that is still easing is not issued at all.

    The gap above the composer comes free and is not a new number:
    `scrollTargetFor` adds `LIST_BOTTOM_PADDING`, which with the composer's own
    `paddingTop` is the `THREAD_TO_COMPOSER_GAP` the whole sheet is spaced by —
    so the comment you are answering sits 16pt clear of the field rather than
    jammed against it.

    `measured: true` is correct on both and is not a shortcut: the flag exists to
    stop a target aiming at a box measured BEFORE a new row was added to it, and
    focusing adds nothing. The blocks' boxes are as current as the last layout
    pass. A target already in flight always wins — a post-send one aims at the
    row you just wrote, and Reply's aims at the row you tapped; both are more
    specific answers than "the end of the thread".
  */

  /**
   * Arm the scroll that opening the composer owes, for whichever of the two
   * cases above asked for it, and let `runPendingScroll` spend it on the settled
   * beat. See the note above for why this is never `scrollToEnd`.
   */
  const armComposerScroll = useCallback(
    (rootId: string, replyId: string | null, keepTopVisible = false) => {
      // Never clobber a target already in flight — see the note above.
      if (pendingScrollRef.current) {
        return;
      }
      pendingScrollRef.current = {
        animated: true,
        /*
          Only case 2 asks to stay ON its target. Case 1 aims at the END of the
          thread because that is where the comment you are about to write will
          go, and clamping it would stop the list at the last block's top.
        */
        keepTopVisible,
        measured: true,
        replyId,
        rootId,
      };
      /*
        On a cold focus the keyboard event has not landed yet, so the sheet's
        resize-completion callback is what spends this — which is exactly the
        wait that stops the target being computed against a viewport still
        easing through `SHEET_RESIZE_MS`.

        If the keyboard is ALREADY up (tapping the field again mid-session, or
        Reply while typing) no keyboard event is coming, so no resize is coming
        either, and there is nothing to wait for: the viewport is final now.
        `runPendingScroll` still re-checks `sheetResizingRef` itself.
      */
      if (keyboardHeightRef.current > 0) {
        runPendingScroll();
      }
    },
    [runPendingScroll],
  );

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
      // Only for a target that IS this block. A reply target waits for the reply
      // row's own box (`handleReplyLayout`) — releasing it here would aim at the
      // block's bottom, which is the approximation this stopped making.
      if (pending && pending.replyId === null && pending.rootId === rootId) {
        pending.measured = true;
      }
      runPendingScroll();
    },
    [runPendingScroll],
  );

  /**
   * A reply row reporting its box inside its block. Its own measurement is what
   * releases a post-send scroll aimed at that reply — the block's would do so a
   * frame early, and against a height the reply is not necessarily at the bottom
   * of.
   */
  const handleReplyLayout = useCallback(
    (replyId: string, event: LayoutChangeEvent) => {
      const { height, y } = event.nativeEvent.layout;
      replyLayoutsRef.current.set(replyId, { height, y });
      const pending = pendingScrollRef.current;
      if (pending && pending.replyId === replyId) {
        pending.measured = true;
      }
      runPendingScroll();
    },
    [runPendingScroll],
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
  // grows by exactly that padding (`sheetHeightForKeyboard`) so it comes out of
  // new height rather than out of the thread.
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
    /*
      CLAIM THE RESIZE HERE, NOT WHERE IT IS ANIMATED.

      Both listeners write `keyboardHeightRef` synchronously and then ask React
      for a re-render. The effect below — the one that actually moves the sheet
      and sets `sheetResizingRef` — does not run until that render COMMITS. In
      between, the sheet reports a keyboard that is up and a geometry that is
      settled, and neither is true: it is settled at a size it is about to leave.

      That gap is not theoretical, and it is not narrow. On iOS the keyboard
      notification is posted from inside `becomeFirstResponder`, so it is
      delivered BEFORE RN dispatches `onFocus` for the very tap that raised it —
      which put `armComposerScroll`'s "the keyboard is already up, so nothing is
      coming" fast path squarely inside the gap. It computed the end of the
      thread against the keyboard-DOWN viewport and spent the target on it.

      Reported as: post a comment, tap the field again, and the thread does not
      scroll. Posting leaves the list AT the keyboard-down end of the thread, so
      the premature target equalled the offset the list was already at — a scroll
      that moved nothing, and the real one (72pt further down, once the sheet had
      grown and the list had shrunk) never happened because the target was gone.
      The FIRST tap looked fine because the list was nowhere near the end, so the
      same error was a large scroll that merely stopped short.

      Claiming the resize on the event that causes it closes the gap from both
      sides: whichever of the keyboard event and `onFocus` lands first, the
      target is now released only by the resize completion. `handleSend` already
      does exactly this before its `Keyboard.dismiss()`, for the same reason.

      Guarded by the same comparison the effect uses, so a keyboard event that
      does not change the sheet's height claims nothing — otherwise the flag
      would be set by an event React bails out of re-rendering for, and nothing
      would ever clear it.
    */
    const claimResizeFor = (height: number) => {
      if (sheetHeightForKeyboard(height) !== sheetHeightTargetRef.current) {
        sheetResizingRef.current = true;
      }
    };
    const showSub = Keyboard.addListener(showEvent, (event) => {
      const height = event.endCoordinates?.height ?? 0;
      keyboardHeightRef.current = height;
      claimResizeFor(height);
      setKeyboardHeight(height);
    });
    const hideSub = Keyboard.addListener(hideEvent, () => {
      keyboardHeightRef.current = 0;
      claimResizeFor(0);
      setKeyboardHeight(0);
    });
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, [visible]);

  // Grow the sheet by whatever the keyboard costs the composer, and settle back
  // when it goes down. Same 250ms/ease-out shape as the iOS keyboard curve, so
  // the top edge rises with the keyboard instead of after it.
  useEffect(() => {
    const toValue = sheetHeightForKeyboard(keyboardHeight);
    hiddenOffsetRef.current = toValue;
    // Only a CHANGE of target actually moves the sheet. Marking every run as a
    // resize would leave the flag set by the mount pass — where the sheet is
    // already at its resting height — and a pending post-send scroll would then
    // wait for a completion callback that has nothing to complete.
    //
    // Still a plain number comparison now that the target is computed rather than
    // one of two constants: the same keyboard height always resolves to the same
    // height, so a keyboard event that changes nothing (an accessory bar
    // re-reporting the same size) is still recognised as a no-op.
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
    });
    return () => animation.stop();
  }, [keyboardHeight, runPendingScroll, sheetHeight]);

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
    threadLayoutsRef.current.clear();
    replyLayoutsRef.current.clear();
    /*
      ─────────────────────────────────────────────────────────────────────────
      A LONG THREAD OPENS AT ITS END
      ─────────────────────────────────────────────────────────────────────────
      A comment thread is read newest-last. Opening at comment #1 of forty puts
      the reader in the archive with nothing to say there is more below, which is
      also how the composer-focus scroll came to be doing this job by proxy: the
      only way to reach the conversation was to tap the field, and the report was
      that the sheet "feels like it's in the middle".

      This spot used to argue the opposite — that jumping to the newest comment
      "would be the app deciding what they came to read". That argument expired
      with the thing it was about. It was written when entering from the chat
      icon ALSO raised the keyboard, which squeezed the thread into a strip above
      the composer; landing anywhere but the top then showed you its middle, so
      the top was the only readable answer. The sheet no longer opens the
      keyboard (see the `CommentsSheetProps` note), the whole viewport is thread,
      and the end of it is what the reader came for.

      A SHORT thread is untouched: its target clamps to 0 and is dropped
      (`runPendingScroll`), and the bottom anchor in `styles.listContent` already
      rests it on the composer.

      Armed here and spent by the same `pendingScrollRef` / `runPendingScroll`
      machinery as everything else, released by the blocks' own `onLayout` — NOT
      by a load-time timer, which would be racing the first layout for the right
      to compute a target against a viewport that has not been measured yet.
      `animated: false` because this is where the thread RESTS; see the field's
      own note.
    */
    void (async () => {
      try {
        const loaded = await fetchComments(postId);
        if (cancelled) {
          return;
        }
        setComments(loaded);
        setStatus('ready');
        /*
          A notification about a reply opens ON that reply, not at the end of
          the thread. Replies are collapsed by default, so the target has to be
          EXPANDED first or there is nothing on screen to scroll to.

          `measured: false` (unlike the end-of-thread case below): the target is
          a reply inside a block that has not been laid out yet, so only its own
          measurement can release the scroll. That is the same arming the
          post-send path uses for exactly the same reason.
        */
        const focusTarget = focusCommentId
          ? loaded.find((entry) => entry.id === focusCommentId)
          : undefined;
        if (focusTarget) {
          const rootId = topLevelAncestorId(loaded, focusTarget.id);
          const isReply = rootId !== focusTarget.id;
          if (isReply) {
            setExpandedIds((current) => new Set(current).add(rootId));
          }
          pendingScrollRef.current = {
            animated: false,
            keepTopVisible: false,
            measured: false,
            replyId: isReply ? focusTarget.id : null,
            rootId,
          };
        } else {
          const endOfThread = lastThreadBlockId(loaded);
          if (endOfThread) {
            pendingScrollRef.current = {
              animated: false,
              // The end of the thread is the point; clamping would pin it to the
              // last block's TOP instead.
              keepTopVisible: false,
              measured: true,
              replyId: null,
              rootId: endOfThread,
            };
          }
        }
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
    // `focusCommentId` is read at LOAD time only — re-running on a change would
    // refetch the thread just to move the scroll.
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
   * ONE local outcome, at every depth and whether or not anything hangs off the
   * row: it becomes a TOMBSTONE IN PLACE. Nothing is ever removed from the list
   * by a delete, so nothing can be stranded by one either.
   *
   *   - with replies, the row has to survive or the replies underneath it lose
   *     their anchor and disappear with it — the bug this replaced, where deleting
   *     your own comment destroyed other people's.
   *   - with none, it survives because the thread should say the same thing about
   *     every comment that has been deleted. See the note above `visibleCommentCount`.
   *
   * The post's comment count drops by exactly ONE either way, because a tombstone
   * is not counted (`visibleCommentCount`).
   */
  const runDelete = useCallback(
    (comment: PostComment) => {
      deletePendingRef.current.add(comment.id);
      const before = commentsRef.current;
      const after = before.map((entry) =>
        entry.id === comment.id ? toTombstone(entry) : entry,
      );

      setComments(after);
      onCommentCountResolved?.(visibleCommentCount(after));
      // You can't reply to something that is no longer there to be replied to.
      setReplyTo((current) => (current && current.id === comment.id ? null : current));
      // Show the replies immediately: the confirmation just promised they would
      // stay, so the thread should prove it rather than collapse them behind a
      // toggle. A no-op for a comment that has none.
      setExpandedIds((current) => new Set(current).add(comment.id));

      void (async () => {
        const ok = await deleteComment(comment.id);
        if (!ok) {
          const current = commentsRef.current;
          const currentById = new Map(current.map((entry) => [entry.id, entry]));
          const beforeIds = new Set(before.map((entry) => entry.id));
          const restored = [
            // Originals, in their original order. Only the row this delete
            // touched comes from the snapshot — which is what puts the body and
            // the author back under the tombstone. Every other row is taken from
            // the CURRENT list so a concurrent change isn't clobbered, and is
            // dropped if something else removed it.
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
      // Nothing here decides WHETHER a tombstone is left — it always is. The
      // descendant count (children of children included, because the thread
      // flattens every depth under the same top-level comment, so they all stay
      // visible) only decides whether the copy has replies to promise about.
      openPrompt({
        kind: 'delete',
        comment,
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
        capturePostHogEvent('comment_posted', {
          is_reply: parent != null,
        });
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
        /*
          WHERE THE THREAD GOES NEXT.

          A top-level comment is appended, so the block it makes IS the end of the
          thread and putting that block's bottom at the bottom of the viewport is
          the "scroll down so I can see my comment" that was asked for.

          A REPLY is inserted under its parent, anywhere in the thread, so it gets
          two coordinates: the top-level BLOCK it is drawn in (the thread never
          indents past one level, so a reply of any depth lands in its top-level
          ancestor's block) and the reply ROW itself. The row is what the viewport
          is aimed at — the block is only the same answer while the reply happens
          to be the last thing in it.

          `commentsRef` is still the pre-append list, which is exactly where the
          parent chain lives.
        */
        pendingScrollRef.current = {
          animated: true,
          // You want to SEE what you just posted, which is at the bottom.
          keepTopVisible: false,
          measured: false,
          replyId: parent ? result.id : null,
          rootId: parent ? topLevelAncestorId(commentsRef.current, parent.id) : result.id,
        };
        // The dismissal below shrinks the sheet, and the list's viewport with it.
        // Claim the resize NOW rather than when the keyboard event lands: between
        // the two, a layout pass can measure the just-posted row against a
        // viewport a third of a screen taller than the one it is about to have,
        // and a scroll computed there stops short (or, on a short thread, clamps
        // to 0 — "it scrolled to the top after I posted"). The resize effect
        // clears it when the sheet actually stops moving.
        if (keyboardHeightRef.current > 0) {
          sheetResizingRef.current = true;
        }
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
        // The twin that matters. This whole failure branch exists because a
        // silently-lost write is indistinguishable from a dead button, and it
        // stayed invisible for five attempted fixes. Now it is visible from the
        // outside too, without waiting for someone to report it.
        //
        // `reason` is the database's own message, truncated: it names a policy
        // rejection or a missing migration exactly, but a constraint violation
        // can echo part of the submitted text, and none of that is worth
        // shipping past the first line.
        capturePostHogEvent('comment_failed', {
          is_reply: parent != null,
          reason: result.reason.slice(0, 200),
        });
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
                  /*
                    CASE 2 (see the note above `armComposerScroll`): land the
                    composer RIGHT UNDER this comment, so what you are answering
                    sits immediately above the input while you write.

                    Every row is aimed at as ITSELF — replies were always
                    measured in their own right (`handleReplyLayout`), and
                    top-level comment rows now are too. Aiming a top-level
                    comment at its BLOCK put the input under the block's LAST
                    reply instead of under the comment that was tapped.

                    When the row's bottom cannot reach the composer (not enough
                    content below it), the scroll view's own clamp lands the
                    list at its end — which is exactly the asked-for fallback:
                    as close as it can get, else the bottom.

                    Armed BEFORE `focus()`, so the field's own `onFocus` finds a
                    target already in flight and does not overwrite it with case
                    1's "the end of the thread".
                  */
                  armComposerScroll(
                    topLevelAncestorId(commentsRef.current, comment.id),
                    comment.id,
                    // A pathological row taller than the viewport still shows
                    // its top, not its tail.
                    true,
                  );
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
      /*
        A TOP-LEVEL row is measured in its own right, exactly like a reply row.
        Reply's composer scroll aims at the tapped ROW's bottom — without this
        box, a top-level comment could only be aimed at as its whole block,
        which lands the input under the block's last reply instead of under the
        comment itself. Direct child of the block, so the box is block-relative,
        same coordinate space `handleReplyLayout` already stores.
      */
      const measureRow = options.isReply
        ? undefined
        : (event: LayoutChangeEvent) => handleReplyLayout(comment.id, event);
      if (!isMine) {
        return (
          <View onLayout={measureRow} style={styles.commentRow} testID={rowTestID}>
            {rowContent}
          </View>
        );
      }
      return (
        <Pressable
          onLayout={measureRow}
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
      armComposerScroll,
      currentUser?.id,
      handleReplyLayout,
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
              // Lift the composer clear of the keyboard, and of the Android
              // navigation bar underneath it. `sheetHeightForKeyboard` grows the
              // sheet by exactly the increase between the two keyboard states,
              // so the thread keeps its height instead of paying for the
              // composer — up to `SHEET_HEIGHT_MAX`, past which there is no more
              // screen to grow into and the thread does pay the remainder.
              //
              // On iOS this is still a flat 16 with the keyboard down, NOT
              // max(insets.bottom, …): the safe inset is 34 on a notched iPhone,
              // which left the composer floating well above the sheet's edge.
              // The home indicator is an overlay content may sit under; the
              // Android nav bar is not. See `composerBottomPadding`.
              paddingBottom: composerBottomPadding(keyboardHeight, bottomInset),
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
                          <View
                            key={reply.id}
                            // Measured inside its block, so a just-posted reply
                            // can be brought to the bottom of the viewport as
                            // ITSELF rather than as whatever the block ends at.
                            onLayout={(event) => handleReplyLayout(reply.id, event)}
                            style={styles.replyRow}
                            testID={`${testID}-reply-row-${reply.id}`}
                          >
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
                  /*
                    CASE 1 (see the note above `armComposerScroll`): tapping the
                    field means "add to the end", so bring the end into view —
                    aimed at the LAST block, spent once the sheet has stopped
                    growing, via the clamped `scrollTo`. NEVER `scrollToEnd`:
                    that is the unclamped command, and against this sheet's
                    mid-resize viewport it parked the list past the end of its
                    content as dead white space.

                    NOT DEAD CODE now that the sheet opens at the end. That
                    covers the first frame only, and the reader moves: this is
                    what brings the end back after posting, after a "N replies"
                    toggle has grown a block, and after scrolling up to read and
                    then tapping the field to write. It is a no-op in the one
                    case where it has nothing to do, because the target resolves
                    to where the list already is.

                    Reply reaches this same handler, having already armed its own
                    target — `armComposerScroll` leaves that one alone.
                  */
                  const endOfThread = lastThreadBlockId(commentsRef.current);
                  if (endOfThread) {
                    armComposerScroll(endOfThread, null);
                  }
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
              prompt.replyCount > 0
                ? // Say what actually happens: your words go, the thread does not.
                  // Deliberately plain and countless — an earlier draft quoted the
                  // exact reply count and the tombstone's own wording back at the
                  // user, which is precision nobody asked for at the moment they
                  // are deciding whether to delete something.
                  `Your ${promptNoun} will be removed but the replies will remain. `
                  + 'Are you sure you want to continue?'
                : // No replies to promise about, but the row does NOT vanish any
                  // more — it stays as a "was deleted" line. Saying so is the
                  // difference between a confirmation and a surprise. Still no
                  // quoting of the tombstone's own wording back at the user.
                  `Your ${promptNoun} will be removed and the thread will show it was `
                  + "deleted. This can't be undone."
            }
            onClose={closePrompt}
            onConfirm={() => {
              const { comment } = prompt;
              closePrompt();
              runDelete(comment);
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
      TOP-ANCHORED. This was `justifyContent: 'flex-end'` for a while —
      bottom-anchoring a short thread so it rested on the composer — but that
      moves ALL the free space above the FIRST comment, and with the keyboard
      down and a tall sheet a three-comment thread opened on a huge white void
      under the title ("why is there this large white space?"). Comments read
      top-down from the title, like every comments surface; free space below
      the last comment is just where the thread ends.
    */
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
