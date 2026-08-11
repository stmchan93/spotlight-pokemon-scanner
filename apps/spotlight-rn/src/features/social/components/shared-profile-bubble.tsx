import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { Avatar, Text, useSpotlightTheme } from '@spotlight/design-system';
import type { InventoryCardEntry, SpotlightRepository } from '@spotlight/api-client';

import { CachedImage, imageCachePolicy } from '@/components/cached-image';
import type { UserProfile } from '@/features/auth/auth-models';
import { fetchProfileById } from '@/features/profile/profile-service';

export type SharedProfileTab = 'collection' | 'wishlist';

/**
 * One tile of the collage: a fixed-size grey slot that shows art once it lands.
 *
 * The grey is the point. The slot is already at its final size, so a tile that
 * has not loaded leaves a placeholder rather than a hole, and nothing reflows
 * when the image arrives.
 *
 * `memory-disk`, the repo's `thumbnail` policy, is what makes reopening a thread
 * instant: the bytes are already decoded, so the art paints on the first frame
 * instead of being re-fetched. This replaced a hand-rolled `fullyShownCache`
 * that tried to infer the same thing by counting `onLoad`s — see the note on the
 * collage below for why counting was the wrong instrument.
 */
function CollageTile({
  uri,
  placeholderColor,
  testID,
}: {
  uri: string | null;
  placeholderColor: string;
  testID?: string;
}) {
  return (
    <View style={[styles.slot, { backgroundColor: placeholderColor }]}>
      {uri ? (
        <CachedImage
          accessibilityIgnoresInvertColors
          cachePolicy={imageCachePolicy.thumbnail}
          contentFit="cover"
          style={styles.slotImage}
          testID={testID}
          uri={uri}
        />
      ) : null}
    </View>
  );
}

type LoadState =
  | { status: 'loading' }
  | { status: 'resolved'; profile: UserProfile; cards: InventoryCardEntry[] }
  /**
   * The profile is gone, was never visible to this reader, or a block created
   * since the send now hides it. All three look identical ON PURPOSE — telling
   * them apart would disclose the block, which is exactly what the block system
   * refuses to do.
   */
  | { status: 'unavailable' };

/** Matches `SharedPostBubble`, so the two cards line up in a mixed thread. */
const CARD_WIDTH = 240;
/** Four cards, 2x2. Fewer than four still fills the grid it has. */
const COLLAGE_SLOTS = 4;

/**
 * Last known preview per `${userId}:${tab}`, for the life of the session.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS: THE CARDS WERE RACING A SEMAPHORE
 * ───────────────────────────────────────────────────────────────────────────
 * Every card fetched from scratch on every mount, and the COLLECTION read is
 * served behind the backend's `_acquire_heavy_read_slot()`. Two cards in one
 * thread therefore queued behind each other: a screen recording showed the
 * wishlist card resolve immediately and the collection card sit on its skeleton
 * for about another second. Scrolling a card out and back re-ran the whole
 * thing, so the thread never stopped shuffling.
 *
 * STALE-WHILE-REVALIDATE, not a plain cache. A hit renders instantly — no
 * skeleton at all — and the fetch still runs underneath, so the read that
 * decides "may this reader still see this?" happens exactly as often as before.
 * A profile that has since been blocked or hidden flips to unavailable a moment
 * after it appears, which is the correct trade: the check is not skipped, only
 * the blank frame before it is.
 */
const previewCache = new Map<string, { profile: UserProfile; cards: InventoryCardEntry[] }>();

/*
  ─────────────────────────────────────────────────────────────────────────────
  THERE IS NO `fullyShownCache` ANY MORE, AND NO CARD-LEVEL FADE.
  ─────────────────────────────────────────────────────────────────────────────
  The collage used to sit at opacity 0 until all four tiles reported `onLoad`,
  then fade in as one unit, with a 1200ms deadline underneath and a Set
  recording which collages had ever completed so a later mount could skip
  straight to shown.

  It worked with ONE card and failed with several, which is exactly how it was
  reported: "the flicker happens when I have multiple shares, not if I only have
  one message". Four images load quickly and the card is marked fully-shown, so
  its next open is instant. But N cards put 4N images in flight — and the
  collection read is behind the backend's heavy-read semaphore, so the DATA
  arrives staggered too — which means cards routinely miss the 1200ms deadline.
  A card that reveals on the deadline is deliberately NOT recorded as fully
  shown, so it repeats the blank-then-pop on every single open, forever.

  Counting `onLoad`s was the wrong instrument for "will this paint instantly?".
  The right one is an image cache: `memory-disk` on the tiles (see `CollageTile`)
  means a revisited collage paints from decoded bytes on the first frame, which
  is what the Set was trying to approximate.

  And with the slots already laid out at final size, there is nothing left for a
  fade to hide — a tile painting into its own grey square moves nothing. Four
  tiles filling in over a few frames reads as loading. A whole card blinking in
  after a blank second reads as a flicker, which is what this was.
*/

/**
 * A collection or wishlist someone pointed at, as a preview card (social_24).
 *
 * ONLY THE REFERENCE IS STORED — owner id and which page. Everything drawn here
 * is fetched on mount, so a list that has since gone private, emptied, or become
 * invisible through a block stops resolving without the message row knowing
 * anything about it. The alternative, snapshotting four card images into the
 * message, would freeze a lie: a wishlist is a live thing, and the preview would
 * keep advertising cards the owner has already pulled off it.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHY A NEUTRAL CARD, NOT A BUBBLE
 * ───────────────────────────────────────────────────────────────────────────
 * Same rule `SharedPostBubble` follows: it draws its own surface and the thread
 * does not wrap it in bubble chrome. A shared list is a thing you pointed at,
 * not a thing you said — and painting it in the sender's `purple500` tint is
 * precisely how the plain-text version of this feature ended up with an
 * invisible link.
 */
export function SharedProfileBubble({
  userId,
  tab,
  repository,
  onOpen,
  testID = 'shared-profile',
}: {
  userId: string;
  tab: SharedProfileTab;
  repository: SpotlightRepository;
  onOpen: (userId: string, tab: SharedProfileTab) => void;
  testID?: string;
}) {
  const theme = useSpotlightTheme();
  const cacheKey = `${userId}:${tab}`;
  // Seeded from the cache, so a card that has been seen before renders its
  // content on the FIRST frame instead of a skeleton.
  const [state, setState] = useState<LoadState>(() => {
    const cached = previewCache.get(cacheKey);
    return cached
      ? { status: 'resolved', profile: cached.profile, cards: cached.cards }
      : { status: 'loading' };
  });

  useEffect(() => {
    let cancelled = false;
    // Only blank out when there is nothing to show. Resetting to `loading` on a
    // cache hit would reintroduce the skeleton this exists to remove.
    if (!previewCache.has(cacheKey)) {
      setState({ status: 'loading' });
    }

    void (async () => {
      try {
        /*
          Profile and cards together: a card with a name and four blank frames
          reads as broken, and one with art but no owner does not say whose list
          it is. Either half missing means the preview is not worth drawing.
        */
        const [profile, cards] = await Promise.all([
          fetchProfileById(userId),
          tab === 'wishlist'
            ? repository.getProfileWishlistEntries(userId, { limit: COLLAGE_SLOTS })
            : repository.getProfileDeckEntries(userId, { limit: COLLAGE_SLOTS }),
        ]);
        /*
          NO PREFETCH PASS HERE, deliberately.

          There was one: it raced `Image.prefetch` on all four URLs before
          resolving, on the theory that warm images mount instantly. They do not
          — each <Image> still decodes independently, so the tiles still arrived
          one at a time, just sooner. Once the collage learned to wait for its
          tiles' own `onLoad`, the prefetch became a SECOND wait for the same
          bytes: up to 1.2s before the card resolved, then the reveal wait on top.
          It delayed the whole thread to buy nothing.
        */
        if (profile) {
          previewCache.set(cacheKey, { cards: cards ?? [], profile });
        } else {
          // Gone or no longer visible — drop it, so the next mount does not
          // resurrect a preview the reader may not see any more.
          previewCache.delete(cacheKey);
        }
        if (cancelled) {
          return;
        }
        setState(
          profile ? { status: 'resolved', profile, cards: cards ?? [] } : { status: 'unavailable' },
        );
      } catch {
        /*
          A failed read is indistinguishable here from a hidden one. But a
          NETWORK failure must not blank a card that is already on screen from
          cache — that would turn a dropped request into "this is no longer
          available", which reads as content being taken away. Keep what we have
          and let the next mount try again.
        */
        if (!cancelled && !previewCache.has(cacheKey)) {
          setState({ status: 'unavailable' });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [cacheKey, repository, tab, userId]);


  if (state.status === 'loading') {
    /*
      THE SKELETON IS THE SAME LAYOUT, NOT A FIXED HEIGHT.

      It was a flat 220pt box against a resolved card of ~375, so every shared
      card grew ~155pt the moment it loaded. In a thread that auto-scrolls to the
      bottom on content-size change, that is: scroll, reflow, scroll again —
      which is what "opening my messages flickers" looks like.

      Rendering the real structure with empty tiles means the height is right by
      CONSTRUCTION, and stays right when the tile ratio or the header changes.
      Nothing to keep in sync, so nothing to drift.
    */
    return (
      <View
        style={[
          styles.card,
          { backgroundColor: theme.colors.gray0, borderColor: theme.colors.gray200 },
        ]}
        testID={`${testID}-loading`}
      >
        <View style={styles.header}>
          <View style={[styles.skeletonAvatar, { backgroundColor: theme.colors.gray100 }]} />
          <View style={[styles.skeletonLine, { backgroundColor: theme.colors.gray100 }]} />
        </View>
        <View style={styles.collage}>
          {Array.from({ length: COLLAGE_SLOTS }, (_, index) => (
            <View
              key={`skeleton-${index}`}
              style={[styles.slot, { backgroundColor: theme.colors.gray100 }]}
            />
          ))}
        </View>
        <View style={[styles.footer, styles.skeletonFooter, { backgroundColor: theme.colors.gray100 }]} />
      </View>
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
        <Text style={[theme.typography.label, { color: theme.colors.gray600 }]}>
          This is no longer available
        </Text>
      </View>
    );
  }

  const { profile, cards } = state;
  const owner = profile.displayName?.trim() || (profile.handle ? `@${profile.handle}` : 'Collector');
  /*
    An INVITATION, not a caption. "Misty's wishlist" labels the card; "See
    Misty's wishlist!" is the thing the sender would have typed, which is the
    whole message now that no body travels beside it.

    "See" rather than "Check out" because the line has to survive a long display
    name on a 240pt card: "Check out stephen chanted's wishlist!" truncated to
    "Check out stephen chanted'…", losing the part that says WHICH list it is.
  */
  const label = `See ${owner}'s ${tab}!`;
  // Without the invitation wrapper, so a screen reader announces the action
  // rather than reading the sender's phrasing back as a button name.
  const destination = `${owner}'s ${tab}`;
  // Four slots always, so a two-card list still renders a 2x2 grid rather than a
  // ragged row that changes the card's height.
  /*
    ONE TILE PER CARD — no padding out to four.

    This used to be `Array.from({ length: COLLAGE_SLOTS }, (_, i) => cards[i] ?? null)`,
    which drew an empty grey tile for every slot the list did not fill. On a
    one-item wishlist that is a card beside a phantom card, and the phantom reads
    as "there is something else in here that failed to load" rather than as
    blank space.

    The fixed four earns its place in the SKELETON above, where the count is
    genuinely unknown and the grid's height is what stops the bubble reflowing
    when the data lands. Here the count is known, so the structure can simply be
    the truth: 1 or 2 cards make one row, 3 or 4 make two.
  */
  const slots = cards.slice(0, COLLAGE_SLOTS);

  return (
    <Pressable
      accessibilityLabel={`Open ${destination}`}
      accessibilityRole="button"
      onPress={() => onOpen(userId, tab)}
      style={[
        styles.card,
        { backgroundColor: theme.colors.gray0, borderColor: theme.colors.gray200 },
      ]}
      testID={`${testID}-card`}
    >
      <View style={styles.header}>
        <Avatar
          initials={(owner.replace(/^@/, '')[0] ?? '?').toUpperCase()}
          size={24}
          uri={profile.avatarURL ?? undefined}
        />
        {/*
          Two lines, not one. A long display name still overflows 240pt even
          after shortening the verb, and truncating drops the word that says
          which list it is — "See stephen chanted'…" is the one shape this line
          must never take.
        */}
        <Text
          numberOfLines={2}
          style={[theme.typography.label, styles.headerName, { color: theme.colors.gray900 }]}
        >
          {label}
        </Text>
      </View>

      {/*
        LAID OUT THE WHOLE TIME, so nothing reflows and the tiles simply fill in.

        Two earlier attempts tried to make the four arrive together —
        `Image.prefetch` (warms the network cache, but each image still decodes
        on its own schedule) and then an all-tiles-ready fade. Both were solving
        the wrong problem: with the slots already at final size, a tile painting
        into its own grey square moves nothing, so there is no reflow left to
        synchronise away. See the note above `previewCache` for how the fade
        turned into the multi-card flicker it was meant to prevent.
      */}
      <View style={styles.collage} testID={`${testID}-collage`}>
        {slots.map((entry, index) => (
          <CollageTile
            key={entry.id}
            // A REAL card with no artwork still gets its grey tile: that one is
            // honest — the card is in the list, the picture is missing.
            placeholderColor={theme.colors.gray100}
            testID={`${testID}-slot-${index}`}
            uri={entry.smallImageUrl || entry.imageUrl || null}
          />
        ))}
      </View>

      <Text
        numberOfLines={1}
        style={[theme.typography.caption, styles.footer, { color: theme.colors.gray600 }]}
      >
        {cards.length === 0
          ? 'Nothing here yet'
          : `${cards.length}${cards.length === COLLAGE_SLOTS ? '+' : ''} ${
              cards.length === 1 ? 'card' : 'cards'
            }`}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
    padding: 8,
    width: CARD_WIDTH,
  },
  collage: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    /*
      Percentage widths with `space-between`, NOT a computed pixel width.

      This was `(CARD_WIDTH - padding - gap) / 2 = 110`, so two slots plus the
      gap came to exactly the 224 of content width — and the card's hairline
      border eats ~1.3 of that, leaving 222.7. Two slots no longer fitted, so
      every card wrapped onto its own row and the "2x2 collage" shipped as a
      vertical stack. Percentages have no such cliff.
    */
    justifyContent: 'space-between',
    rowGap: 4,
  },
  footer: {
    marginTop: 6,
  },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
    marginBottom: 8,
    /*
      Two lines' worth, always. The label wraps to one line for a short name and
      two for a long one, and letting the header size to its content means the
      whole card changes height the moment the name resolves — a smaller version
      of the reflow the skeleton above exists to stop. Fixed here so the skeleton
      and every resolved state agree.
    */
    minHeight: 36,
  },
  headerName: {
    flexShrink: 1,
  },
  // Skeleton pieces, sized to match what replaces them so nothing reflows.
  skeletonAvatar: {
    borderRadius: 12,
    height: 24,
    width: 24,
  },
  skeletonFooter: {
    borderRadius: 4,
    // 16, not 14: the resolved footer is `typography.caption`, whose lineHeight
    // is 16. Two off is invisible on one card and a 2pt nudge per card once a
    // thread holds several — the same class of drift as the old 220pt box.
    height: 16,
    width: 64,
  },
  skeletonLine: {
    borderRadius: 4,
    flexShrink: 1,
    height: 14,
    width: 140,
  },
  slot: {
    // 48% each leaves a 4% gutter between the pair — always two per row.
    // Card-shaped, not square: squaring the tile crops the art.
    aspectRatio: 5 / 7,
    borderRadius: 4,
    overflow: 'hidden',
    width: '48%',
  },
  slotImage: {
    height: '100%',
    width: '100%',
  },
  unavailable: {
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 72,
  },
});
