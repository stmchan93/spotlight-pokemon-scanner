import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Modal, Pressable, StyleSheet, View } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { useRouter } from 'expo-router';
import {
  ChatBubbleEmpty,
  CheckCircle,
  MediaImage,
  MoreHoriz,
  Repeat,
  ShareIos,
  ThumbsUp,
} from 'iconoir-react-native';

import { Avatar, Text, useSpotlightTheme } from '@spotlight/design-system';

import { ConfirmDeleteSheet } from '@/features/cards/components/confirm-delete-sheet';
import { CommentsSheet } from '@/features/social/components/comments-sheet';
import { OptionsSheet } from '@/features/social/components/options-sheet';
import { SharePostSheet } from '@/features/social/components/share-post-sheet';
import {
  blockUser,
  type FeedPost,
  type FeedPostMedia,
  fetchLikedPostIds,
  fetchRepostedPostIds,
  likePost,
  repostPost,
  reportContent,
  unlikePost,
  unrepostPost,
} from '@/features/social/social-service';
import { profileRouteSlug } from '@/features/social/profile-link';
import { signalFeedNeedsRefresh } from '@/features/social/screens/new-post-screen';
import { useAuth } from '@/providers/auth-provider';

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
  /** Same contract as `initialLiked`, for the repost glyph. */
  initialReposted?: boolean;
  /**
   * Ask the owning list to delete this post. Passing it is what turns on the ⋯
   * affordance — and only ever on the viewer's OWN post. Screens that hold the
   * post list (the feed, Portfolio → Activity) pass `usePostDeletion`'s
   * `requestDelete`; read-only surfaces simply omit it and get no menu.
   */
  onRequestDelete?: (post: FeedPost) => void;
  /**
   * Open the comment thread as soon as the card mounts. Set by the post-detail
   * screen when a notification about a comment opened it, so the tap lands on
   * the conversation it was telling you about instead of on a shut thread.
   */
  autoOpenComments?: boolean;
  testID?: string;
};

const AVATAR_SIZE = 40;
/**
 * Portrait image frame. Figma 3505:14439 draws it 393 × 491 on a 393pt frame —
 * exactly 4:5. (The layer is still NAMED "3x4" from an earlier revision; the
 * measured geometry is what ships.)
 */
const IMAGE_ASPECT_RATIO = 4 / 5;
const METRIC_ICON_SIZE = 18;
/** The ⋯ options glyph, per Figma 315:2992. */
const MORE_ICON_SIZE = 24;
// The comment icon and its count are two separate targets 4px apart, so their
// hit slops are trimmed on the facing edges instead of overlapping.
const COMMENT_ICON_HIT_SLOP = { top: 8, bottom: 8, left: 8, right: 2 } as const;
const COMMENT_COUNT_HIT_SLOP = { top: 8, bottom: 8, left: 2, right: 8 } as const;
const PLACEHOLDER_ICON_SIZE = 24;

/**
 * Re-fetch schedule for a post image the proxy refused, in ms after each failure.
 *
 * The bytes are private and the proxy only serves them to a non-author once
 * `post_media.moderation_status = 'approved'`, which the moderation worker sets
 * on a cron that runs every 2 minutes. So a reader who opens the feed seconds
 * after someone posts gets a legitimate refusal that resolves itself shortly.
 * These delays cover a little under four minutes in total — one cron miss plus
 * worker latency — and then stop, because past that the failure is no longer
 * "not approved yet", it is broken, and retrying a dead image forever is just a
 * background request loop on a list that may hold dozens of cards.
 */
const MEDIA_RETRY_DELAYS_MS = [4_000, 15_000, 30_000, 60_000, 60_000] as const;

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
 * Rendered full-bleed at a fixed 4:5 portrait frame.
 *
 * WHY THIS COMPONENT HAS A FAILURE STATE AT ALL — and why we place-hold rather
 * than hold the post back:
 *
 * The proxy serves a non-author only APPROVED media (backend/server.py,
 * `_fetch_authorized_post_media_row`); the AUTHOR is served their own media at
 * any moderation status. New uploads land as `pending`, and the moderation
 * worker's cron runs every 2 minutes. So for up to a couple of minutes the same
 * post renders complete for its author and with a hole for everyone else —
 * which is exactly the asymmetry that makes this worth handling: the author has
 * no way of knowing their post looks broken to the feed.
 *
 * Holding the whole post until its media is approved was rejected for two
 * reasons. First, the client CANNOT KNOW when to stop holding: `FeedPostMedia`
 * carries id/width/height/blurhash only — `social-service.ts` deliberately
 * omits `moderation_status` from `postMediaSelect`, so the only signal we have
 * is "the image request failed", which is indistinguishable from a flaky
 * network. Hiding a post on a failed image request would drop real posts off
 * real feeds every time a tunnel ate a request. Second, hiding is worse for the
 * author anyway: they'd see their post, other people would see nothing at all,
 * and the body text and comments would vanish along with the photo.
 *
 * So: keep the post, keep the frame at its real size so the layout does not
 * jump when the bytes arrive, say "still processing" instead of showing an
 * empty slot, and quietly retry on the schedule above until it resolves. The
 * author gets different copy because for them a failure is never moderation.
 */
export function PostImage({
  media,
  uri,
  accessToken,
  viewerIsAuthor,
  testID,
}: {
  media: FeedPostMedia;
  uri: string;
  accessToken: string;
  /** The author is authorized for their own pending media, so a failure they
   * see is a transport/storage problem, never "awaiting moderation". */
  viewerIsAuthor: boolean;
  testID?: string;
}) {
  const theme = useSpotlightTheme();
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState(false);

  // Re-arm the next attempt after a failure. Clearing `failed` swaps the
  // placeholder back for the image, and the bumped `attempt` changes the source
  // uri, which is what makes expo-image issue a fresh request instead of
  // replaying its cached failure.
  useEffect(() => {
    if (!failed) {
      return;
    }
    const delay = MEDIA_RETRY_DELAYS_MS[attempt];
    if (delay === undefined) {
      return;
    }
    const timer = setTimeout(() => {
      setFailed(false);
      setAttempt((current) => current + 1);
    }, delay);
    return () => clearTimeout(timer);
  }, [attempt, failed]);

  const frameStyle = [
    styles.image,
    { aspectRatio: IMAGE_ASPECT_RATIO, backgroundColor: theme.colors.surfaceMuted },
  ];

  if (failed) {
    const willRetry = MEDIA_RETRY_DELAYS_MS[attempt] !== undefined;
    const label = viewerIsAuthor
      ? "Photo didn't load"
      : willRetry
        ? 'Photo is still processing'
        : 'Photo unavailable';
    return (
      <View style={[frameStyle, styles.mediaPlaceholder]} testID={`${testID}-placeholder`}>
        <MediaImage color={theme.colors.gray600} height={PLACEHOLDER_ICON_SIZE} width={PLACEHOLDER_ICON_SIZE} />
        <Text style={[theme.typography.caption, { color: theme.colors.gray600 }]}>{label}</Text>
      </View>
    );
  }

  return (
    <ExpoImage
      accessibilityIgnoresInvertColors
      cachePolicy="memory-disk"
      contentFit="cover"
      onError={() => setFailed(true)}
      placeholder={media.blurhash ? { blurhash: media.blurhash } : undefined}
      source={{
        // The backend routes on `parsed.path`, so an extra query param is inert
        // server-side and only exists to give expo-image a new cache key.
        uri: attempt > 0 ? `${uri}?retry=${attempt}` : uri,
        headers: { Authorization: `Bearer ${accessToken}` },
      }}
      style={frameStyle}
      testID={testID}
    />
  );
}

/**
 * Post card (Figma 3505:14460, home feed): a full-bleed card — header row
 * (avatar + name/date + a ⋯ options button), body text, an optional card chip,
 * full-bleed 3:4 image(s), and a metrics row (like + comment + repost on the
 * left, share on the right) closed by a hairline divider. Interactions are
 * preserved: the like keeps its optimistic toggle+rollback (now a thumbs-up that
 * tints to the accent color when liked) and the card chip opens the anchored
 * card's PDP. Both comment targets — the chat icon and the count — open the full
 * thread sheet; the icon additionally focuses its composer.
 *
 * TWO WAYS TO PASS A POST ON, and they are different things:
 *
 *  • REPOST (Figma 3523:15548) is public endorsement. It adds a `post_reposts`
 *    row (social_23) — the count goes up, the author is notified, and the post
 *    joins your profile's Activity. It does not republish anything, and it does
 *    not put the post in anyone's feed: Home is `fetchGlobalFeed`, so everyone
 *    already sees the original.
 *  • SHARE is private delivery: the post is SENT to someone in DMs, carrying
 *    only an id so the preview is re-checked against moderation on every read.
 *
 * Neither one copies a post, which is what keeps a removed post removed
 * everywhere. A QUOTE repost — a real new post with this one attached — is the
 * open extension; see docs/timeline-reshare-and-wishlist-sharing-plan.
 */
export function PostCard({
  post,
  apiBaseUrl,
  accessToken,
  onPressCard,
  initialLiked,
  initialReposted,
  onRequestDelete,
  autoOpenComments = false,
  testID = 'post-card',
}: PostCardProps) {
  const theme = useSpotlightTheme();
  const { currentUser } = useAuth();
  const router = useRouter();

  const author = post.author;
  const displayName = author?.displayName?.trim() || (author?.handle ? `@${author.handle}` : 'Collector');
  // Navigating from here rather than via a prop: every caller would pass the
  // identical handler, and the comment thread — a Modal with no navigation
  // callbacks at all — needs the same behaviour. One rule, one implementation.
  const authorLink = profileRouteSlug(author?.handle, post.authorId);
  const openAuthorProfile = useCallback(() => {
    // Tapping YOURSELF goes to the You tab, not to `/u/<your handle>`. The
    // public route would push a read-only copy of your own profile on top of the
    // feed — no Edit, no Collection tabs, and a back button to get out of a
    // place you already live. You is the real thing.
    if (currentUser?.id && post.authorId === currentUser.id) {
      router.navigate('/you' as never);
      return;
    }
    if (authorLink) {
      router.push(`/u/${authorLink}` as never);
    }
  }, [authorLink, currentUser?.id, post.authorId, router]);
  const postDate = useMemo(() => formatPostDate(post.createdAt), [post.createdAt]);

  // Who the ⋯ menu belongs to. `viewerId` is null for a signed-out/guest viewer,
  // and EVERY branch below tests it explicitly: without that, `undefined ===
  // undefined` would make a stray post look self-authored (the original bug),
  // and the inverse — a guest treated as "not the author" and therefore offered
  // Report/Block — would hand an anonymous viewer two writes they cannot make.
  // Both reports and blocks are keyed on the reporter's/blocker's own id, so a
  // guest's tap could only ever fail; the menu is not offered to them at all.
  const viewerId = currentUser?.id ?? null;
  const isOwnPost = viewerId != null && post.authorId === viewerId;
  // Own post → Delete, but only where the owning list can actually act on one.
  const canDeletePost = Boolean(onRequestDelete) && isOwnPost;
  // Someone else's post → Report + Block. Independent of `onRequestDelete`:
  // safety must not depend on a screen happening to support deletion.
  const canReportPost = viewerId != null && Boolean(post.authorId) && !isOwnPost;
  const showMoreButton = canDeletePost || canReportPost;

  // A block takes effect in Postgres (`public.is_blocked` sits in the RLS select
  // policies for posts/post_media/comments), but the list already in memory
  // doesn't re-run those policies. Dropping this card immediately makes the
  // confirmation copy true the moment it is dismissed instead of a promise that
  // waits for the next refresh.
  const [blockedByViewer, setBlockedByViewer] = useState(false);
  // De-dupes a second tap on Report/Block while the first write is in flight.
  const safetyWritePending = useRef(false);

  /*
    The ⋯ safety flow: the menu, then the block confirmation, in ONE `Modal` the
    card mounts only while one of them is up.

    One modal for both, deliberately. RN cannot present a second
    `overFullScreen` modal while the first is tearing down — that collision is
    what froze the app in `CardActionsSheet`, and chaining it off `Modal`'s
    `onDismiss` is not an option either, because `onDismiss` is iOS-only (see
    react-native's Modal.js) and the follow-up would simply never run on
    Android. Rendering both as INLINE overlays inside one host modal is the same
    composition the comments sheet already uses, and it has nothing to collide
    with on either platform.

    `prompt` is RETAINED after `promptOpen` goes false so the sheet keeps its
    copy while it slides away — nulling it would blank the words mid-dismissal.
  */
  const [prompt, setPrompt] = useState<{ kind: 'options' | 'block' | 'share' } | null>(null);
  const [promptOpen, setPromptOpen] = useState(false);
  const openPrompt = useCallback((kind: 'options' | 'block' | 'share') => {
    setPrompt({ kind });
    setPromptOpen(true);
  }, []);
  const closePrompt = useCallback(() => setPromptOpen(false), []);

  const canShowImages = Boolean(apiBaseUrl) && Boolean(accessToken) && post.media.length > 0;
  const trimmedBase = apiBaseUrl ? apiBaseUrl.replace(/\/+$/, '') : '';

  // Interaction state. `liked` / `likeCount` are optimistic; they reconcile to the
  // post prop on the next feed read. `likePending` de-dupes a double-tap while the
  // write is in flight. `commentCount` folds in comments added from the sheet.
  const [liked, setLiked] = useState(initialLiked ?? false);
  const [likeCount, setLikeCount] = useState(post.likeCount);
  const [likePending, setLikePending] = useState(false);
  const [commentCount, setCommentCount] = useState(post.commentCount);
  // Repost is the same machinery as the like, deliberately: one row per user per
  // post, optimistic with rollback. What differs is what it MEANS — see the
  // repost button below.
  const [reposted, setReposted] = useState(initialReposted ?? false);
  const [repostCount, setRepostCount] = useState(post.repostCount);
  const [repostPending, setRepostPending] = useState(false);
  // Both the chat icon and the count open the SAME thread sheet — they sit a few
  // pixels apart, and having the icon pop a composer-only sheet made whether you
  // saw the existing comments feel random. The icon just also focuses the
  // composer so you can type straight away.
  // Seeded, not driven by an effect: the sheet should be open on the FIRST
  // frame when a notification opened this post, so the thread does not appear to
  // pop up a moment after the screen settles.
  const [commentsVisible, setCommentsVisible] = useState(autoOpenComments);

  // Keep the optimistic counters in sync when a fresh copy of the post arrives
  // (e.g. a feed refresh). The optimistic writes above win only until then.
  useEffect(() => {
    setLikeCount(post.likeCount);
  }, [post.likeCount]);
  useEffect(() => {
    setCommentCount(post.commentCount);
  }, [post.commentCount]);
  useEffect(() => {
    setRepostCount(post.repostCount);
  }, [post.repostCount]);

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

  // Self-resolve the viewer's reposted state, same contract as the liked one:
  // without it a scrolled-back feed shows every card un-reposted, so something
  // you already passed on invites you to do it again.
  useEffect(() => {
    if (initialReposted !== undefined) {
      return;
    }
    let cancelled = false;
    void fetchRepostedPostIds([post.id])
      .then((repostedIds) => {
        if (!cancelled) {
          setReposted(repostedIds.has(post.id));
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [initialReposted, post.id]);

  // Same optimistic flip + rollback as the like.
  const handleToggleRepost = useCallback(() => {
    if (repostPending) {
      return;
    }
    const wasReposted = reposted;
    const nextReposted = !wasReposted;

    setReposted(nextReposted);
    setRepostCount((count) => Math.max(0, count + (nextReposted ? 1 : -1)));
    setRepostPending(true);

    void (async () => {
      const ok = await (nextReposted ? repostPost(post.id) : unrepostPost(post.id));
      if (!ok) {
        setReposted(wasReposted);
        setRepostCount((count) => Math.max(0, count + (nextReposted ? -1 : 1)));
      } else {
        // A repost changes what the feed AND the reposter's Activity should
        // contain, and both lists are lazy — without this the row only appears
        // after a cold restart. Signalled on undo too, so the row disappears.
        signalFeedNeedsRefresh();
      }
      setRepostPending(false);
    })();
  }, [repostPending, reposted, post.id]);

  // File the report, then say what it did and did NOT do. Reporting hides
  // nothing on its own — social_04's threshold trigger needs three distinct
  // reporters — so the confirmation points at Block, which is the control that
  // actually makes the account go away for this viewer.
  const handleReportPost = useCallback(() => {
    if (safetyWritePending.current) {
      return;
    }
    safetyWritePending.current = true;
    void (async () => {
      const ok = await reportContent({
        reportedUserId: post.authorId,
        postId: post.id,
        // `reports.reason` is the REPORTER's stated reason, and there is no
        // reason picker on this surface yet, so it stays null. A provenance
        // marker ("reported_from_post_card") would sit in the column a
        // moderator reads as "why", answering a question nobody asked —
        // which screen it came from belongs in analytics, not the queue.
        // The comment sheet files reports the same way; two surfaces
        // reporting the same table must not disagree about this field.
        reason: '',
      });
      safetyWritePending.current = false;
      if (ok) {
        // Short on purpose. Earlier drafts also promised anonymity and warned
        // that reporting hides nothing — both true, both cut on request. Keep
        // this identical to the comment thread's acknowledgement: one action,
        // one sentence, wherever you reported from.
        Alert.alert(
          'Report sent',
          "Thanks for reporting this. We've received your report and will take a look at this as soon as possible.",
        );
      } else {
        Alert.alert("Couldn't send report", 'Nothing was reported. Please try again in a moment.');
      }
    })();
    // No `displayName`: the acknowledgement names nobody now, so depending on it
    // would rebuild this callback every time an author's profile hydrates.
  }, [post.authorId, post.id]);

  // Blocking is mutual and, right now, one-way in the UI: `unblockUser` exists in
  // the service but nothing in the app calls it, so the copy must not promise an
  // undo that isn't there. Reached only from the confirmation below.
  const runBlock = useCallback(() => {
    if (safetyWritePending.current) {
      return;
    }
    safetyWritePending.current = true;
    void (async () => {
      const ok = await blockUser(post.authorId);
      safetyWritePending.current = false;
      if (ok) {
        setBlockedByViewer(true);
      } else {
        Alert.alert(
          "Couldn't block",
          `${displayName} has not been blocked. Please try again in a moment.`,
        );
      }
    })();
  }, [displayName, post.authorId]);

  // One ⋯ target, two meanings. Delete stays a direct jump to its confirmation
  // (unchanged); the non-author case needs a real choice, so it opens the same
  // `OptionsSheet` a comment's ⋯ opens. It was an `Alert` with the author's name
  // as its title, which meant the app's two safety menus were two different
  // objects — an OS alert on a post, a bottom sheet on a comment — for one
  // decision. One component now, so they cannot drift.
  const handleMorePress = useCallback(() => {
    if (canDeletePost) {
      onRequestDelete?.(post);
      return;
    }
    openPrompt('options');
  }, [canDeletePost, onRequestDelete, openPrompt, post]);

  // Liked = solid purple thumb (stroke + fill) with a matching count.
  const likeColor = liked ? theme.colors.purple500 : theme.colors.gray700;
  // Reposted tints stroke + count, but does NOT fill: the repeat glyph is an
  // open path (two arrows), so filling it floods the space between them into a
  // purple blob instead of reading as a solid shape the way the thumb does.
  const repostColor = reposted ? theme.colors.purple500 : theme.colors.gray700;

  // Blocked from this card: the post the viewer just acted on leaves the screen
  // straight away. Everything else by this author goes on the next feed read,
  // where RLS drops the rows before they reach the client.
  if (blockedByViewer) {
    return null;
  }

  return (
    <View
      style={[styles.card, { backgroundColor: theme.colors.gray0 }]}
      testID={`${testID}-${post.id}`}
    >
      <View style={styles.headerRow}>
        {/*
          The face and the name are the way into someone's profile — the only
          way, from the feed. Two separate targets rather than one wrapping the
          whole header, because the row also carries the post's DATE, and a tap
          on a timestamp should not navigate anywhere.

          `authorLink` is null for an author who has neither a handle nor an id
          (a deleted account), and both controls fall back to plain, unpressable
          views rather than buttons that promise a profile and open nothing.
        */}
        <Pressable
          accessibilityLabel={authorLink ? `View ${displayName}'s profile` : undefined}
          accessibilityRole={authorLink ? 'button' : undefined}
          disabled={!authorLink}
          onPress={openAuthorProfile}
          testID={`${testID}-avatar-button`}
        >
          <Avatar
            initials={authorInitials(author?.displayName ?? null, author?.handle ?? null)}
            size={AVATAR_SIZE}
            testID={`${testID}-avatar`}
            uri={author?.avatarUrl}
          />
        </Pressable>
        <View style={styles.headerText}>
          <View style={styles.nameRow}>
            <Pressable
              accessibilityLabel={authorLink ? `View ${displayName}'s profile` : undefined}
              accessibilityRole={authorLink ? 'button' : undefined}
              disabled={!authorLink}
              hitSlop={6}
              onPress={openAuthorProfile}
              testID={`${testID}-author-name-button`}
            >
              <Text
                numberOfLines={1}
                style={[theme.typography.bodyMedium, { color: theme.colors.gray900 }]}
                testID={`${testID}-author-name`}
              >
                {displayName}
              </Text>
            </Pressable>
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
              // `caption` (12), not `cardMeta` (11). 11 is the floor of the
              // whole scale — it is what badges use — and a post's date was
              // sitting there while Instagram gives the same line 12. Swapped by
              // USAGE rather than by raising `cardMeta`, because that token also
              // sizes the collection grid tiles and has no business growing here.
              style={[theme.typography.caption, { color: theme.colors.gray600 }]}
              testID={`${testID}-date`}
            >
              {postDate}
            </Text>
          ) : null}
        </View>
        {/*
          One ⋯ target, two meanings, decided by whose post this is:
            • your own post  → Delete (straight to its confirmation, unchanged)
            • someone else's → Report post / Block <name>
          Before this, ⋯ rendered ONLY on your own post, which meant the app
          shipped with no way to report or block anybody at all. A signed-out
          viewer still gets no button, because they can make neither write.
        */}
        {showMoreButton ? (
          <Pressable
            accessibilityLabel="Post options"
            accessibilityRole="button"
            hitSlop={8}
            onPress={handleMorePress}
            style={styles.moreButton}
            testID={`${testID}-more-button`}
          >
            <MoreHoriz
              color={theme.colors.gray700}
              height={MORE_ICON_SIZE}
              width={MORE_ICON_SIZE}
            />
          </Pressable>
        ) : null}
      </View>

      {post.body ? (
        <Text
          // `body` (15), not `bodySmall` (14). A post used to render SMALLER
          // than the comments replying to it, which is what made the feed read
          // undersized — the comparison was right there on screen. 15 is also
          // what X and Threads use for a post, and it makes one reading size
          // across the app instead of two a point apart.
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
              viewerIsAuthor={isOwnPost}
            />
          ))}
        </View>
      ) : null}

      <View style={styles.metricsRow} testID={`${testID}-metrics`}>
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
              onPress={() => setCommentsVisible(true)}
              testID={`${testID}-comment-button`}
            >
              <ChatBubbleEmpty color={theme.colors.gray700} height={METRIC_ICON_SIZE} width={METRIC_ICON_SIZE} />
            </Pressable>
            <Pressable
              accessibilityLabel="View comments"
              accessibilityRole="button"
              hitSlop={COMMENT_COUNT_HIT_SLOP}
              onPress={() => setCommentsVisible(true)}
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
          {/*
            REPOST — Figma 3523:15548 (glyph) + 3523:15551 (count).

            An ENDORSEMENT, not a second copy. It adds you to `post_reposts`
            (social_23): the count here ticks up, the author is notified, and the
            post joins your profile's Activity as something you passed on.
            Nothing is republished, so no copy of a post can outlive the
            original.

            It does NOT push the post into anyone's feed, because it cannot:
            Home reads `fetchGlobalFeed`, so every reader is already looking at
            the original and a second copy would just be the same post twice in
            one list. These rows are exactly what a follow-scoped feed would read
            later — the endorsement is the cheap half of that.
          */}
          <Pressable
            accessibilityLabel={reposted ? 'Undo repost' : 'Repost'}
            accessibilityRole="button"
            accessibilityState={{ selected: reposted }}
            hitSlop={8}
            onPress={handleToggleRepost}
            style={styles.metricItem}
            testID={`${testID}-repost-button`}
          >
            <Repeat
              color={repostColor}
              height={METRIC_ICON_SIZE}
              testID={`${testID}-repost-icon`}
              width={METRIC_ICON_SIZE}
            />
            <Text
              style={[theme.typography.bodyMedium, { color: repostColor }]}
              testID={`${testID}-repost-count`}
            >
              {repostCount}
            </Text>
          </Pressable>
        </View>
        {/*
          Sends the post to someone in DMs — the Instagram shape. NOT a repost:
          nothing is republished, the message carries an id, and the preview is
          hydrated from `posts` on every read, so moderation still applies.

          Opened through the same `prompt` machine as the ⋯ menu so this shares
          the card's ONE Modal — see the note above `prompt` for why a second
          native modal here is unreliable.
        */}
        <Pressable
          accessibilityLabel="Share post"
          accessibilityRole="button"
          hitSlop={8}
          onPress={() => openPrompt('share')}
          style={styles.metricItem}
          testID={`${testID}-share-button`}
        >
          <ShareIos color={theme.colors.gray700} height={METRIC_ICON_SIZE} width={METRIC_ICON_SIZE} />
        </Pressable>
      </View>

      {/*
        Figma 3505:14450 — the rule between posts is #D4D4D4 (= gray300) at 0.5.
        It was `outlineSubtle`, i.e. rgba(0,0,0,0.08), which composites to about
        #EBEBEB on white and read as washed out next to the design. gray300 is
        the same value the Figma stroke uses, so this is the token, not a nudge.
      */}
      <View
        style={[
          styles.divider,
          { backgroundColor: theme.colors.gray300, height: theme.borderWidths.rule },
        ]}
      />

      <CommentsSheet
        onClose={() => setCommentsVisible(false)}
        onCommentAdded={() => setCommentCount((count) => count + 1)}
        onCommentCountResolved={setCommentCount}
        postId={post.id}
        testID={`${testID}-comments`}
        visible={commentsVisible}
      />

      {/*
        The safety menu and the block confirmation, hosted in one modal that is
        mounted only once a ⋯ has been tapped — a feed of twenty cards carries
        twenty of these otherwise. Both children are INLINE overlays: see the
        `prompt` state for why they must not each be a modal of their own.
      */}
      {prompt ? (
        <Modal
          animationType="none"
          onRequestClose={closePrompt}
          presentationStyle="overFullScreen"
          statusBarTranslucent
          transparent
          visible={promptOpen}
        >
          <View style={styles.promptHost}>
            {prompt.kind === 'share' ? (
              <SharePostSheet
                // NOT closed on send: the sheet's own "Sent" row is the
                // confirmation, and sharing is usually plural. See the sheet.
                onClose={closePrompt}
                payload={{ kind: 'post', postId: post.id }}
                testID={`${testID}-share-sheet`}
                visible={promptOpen}
              />
            ) : prompt.kind === 'options' ? (
              <OptionsSheet
                actions={[
                  {
                    key: 'report',
                    label: 'Report post',
                    // Softer than Block on purpose — see `OptionsSheetActionTone`.
                    tone: 'caution',
                    onPress: () => {
                      closePrompt();
                      handleReportPost();
                    },
                  },
                  {
                    key: 'block',
                    label: `Block ${displayName}`,
                    tone: 'destructive',
                    onPress: () => openPrompt('block'),
                  },
                ]}
                // No title, no subtitle: two labelled rows and a Cancel need no
                // heading. The anonymity promise that used to sit here lives on
                // the report acknowledgement and in the block confirmation below.
                onClose={closePrompt}
                testID={`${testID}-options`}
                visible={promptOpen}
              />
            ) : (
              <ConfirmDeleteSheet
                confirmLabel="Block"
                // Word-for-word the comment thread's block confirmation: one
                // action against one person must not read as two different
                // things depending on where you tapped.
                message="Their posts and comments disappear from your feed, and yours disappear from theirs. They are not told that you blocked them."
                onClose={closePrompt}
                onConfirm={() => {
                  closePrompt();
                  runBlock();
                }}
                presentation="inline"
                testID={`${testID}-block-confirm`}
                title={`Block ${displayName}?`}
                visible={promptOpen}
              />
            )}
          </View>
        </Modal>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  bodyText: {
    paddingHorizontal: 16,
  },
  card: {
    // Figma 3505:14460 stacks the whole card on an 8px rhythm (header→body 8,
    // body→image 8, image→metrics 8) and separates cards by 16 after the
    // hairline divider — which is what this top inset provides, so the list
    // itself carries no inter-item gap.
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
  // Same frame as the image it stands in for, so an arriving photo never shifts
  // the metrics row under the reader's thumb.
  mediaPlaceholder: {
    alignItems: 'center',
    gap: 8,
    justifyContent: 'center',
  },
  metricItem: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 4,
  },
  metricsLeft: {
    alignItems: 'center',
    flexDirection: 'row',
    // Figma 3505:14441 — 12 between reaction groups, 4 inside one.
    gap: 12,
  },
  metricsRow: {
    // Figma 3505:14440 baselines the row on its bottom edge, so the 18pt share
    // glyph lines up with the reaction glyphs rather than floating above them.
    alignItems: 'flex-end',
    flexDirection: 'row',
    justifyContent: 'space-between',
    // NO `paddingBottom`. The card's own `gap: 8` already supplies the 8pt the
    // frame leaves between the action glyphs and the divider; a pad here is
    // ADDED to it and put every divider 16pt below the glyphs.
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
  // Fills the host modal so the inline sheets inside it have a full-screen box
  // to absolutely-fill.
  promptHost: {
    flex: 1,
  },
});
