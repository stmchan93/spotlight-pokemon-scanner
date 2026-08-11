import { Bell, EditPencil, Menu, Plus, ShareIos } from 'iconoir-react-native';
import { useMemo } from 'react';
import { Animated, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  GlassNavBubble,
  GlassNavBubbleGroup,
  SearchEntryPill,
  Text,
  glassNavBubbleSizes,
  useSpotlightTheme,
  type GlassNavBubbleGroupItem,
} from '@spotlight/design-system';

import { EkalightMark } from '@/components/ekalight-mark';

/**
 * WHICH PAIR OF SYMBOLS THE TRAILING CAPSULE CARRIES — the ONE thing that
 * differs between the two frames this bar draws. Home's toolbar (3567:22969) is
 * a bell and a `+`; the profile toolbar (3670:47454) is an edit pencil and a
 * share glyph. Everything else — the 40pt menu bubble at x=16, the 8pt gaps, the
 * 215pt pill, the 90pt capsule at x=287 — is identical, which is exactly why
 * this is a variant on ONE component rather than a second bar.
 *
 * A DISCRIMINATED UNION, not a `trailing: ReactNode` render slot and not four
 * loose optional callbacks:
 *
 * - A render slot would push the capsule out to the callers, and the capsule's
 *   width is load-bearing: the row only closes at 393 because the trailing
 *   control is exactly 90 (`glassNavBubbleGroupWidth(2)`). Two screens each
 *   building their own would be two places for that to drift, and nothing would
 *   stop a third symbol being added and silently stealing 42pt from the pill.
 * - Loose optionals (`onOpenAdd?`, `onEditProfile?`, …) make every illegal
 *   combination representable — a bar with a bell and a share glyph, or with
 *   none at all — and push a runtime "which of these did I get" decision into
 *   the render. The union makes the two legal shapes the only two shapes, and
 *   the unread count belongs to the bell so it travels with it.
 *
 * The bell's unread badge stays INSIDE this file either way. It hangs outside
 * its slot at `top: -2, right: -2` and only survives because the capsule and its
 * slots are `overflow: 'visible'` — a contract between the badge and the
 * primitive that a caller composing its own children would not know to keep.
 */
export type HomeHeaderTrailing =
  | {
      kind: 'home';
      /** Spoken label for the `+`, which changes with the active profile tab. */
      addAccessibilityLabel: string;
      onOpenAdd: () => void;
      onOpenNotifications: () => void;
      unreadCount: number;
    }
  | {
      kind: 'profile';
      onEditProfile: () => void;
      onShareProfile: () => void;
    };

type HomeHeaderProps = {
  onOpenMenu: () => void;
  /** Tapping the pill opens the full-screen card search. */
  onOpenSearch: () => void;
  /**
   * FLOATING mode: absolutely positioned chrome over scrolling content rather
   * than a row that takes up layout. BOTH callers (Home and Collection) pass
   * it; the in-flow branch survives only as the fallback for a bar mounted
   * somewhere that cannot reserve space for itself.
   *
   * Collection needs it — its pager owns a pinned chrome layer of its own
   * (profile block + tab bar), and putting a second in-flow bar inside that
   * layer made the two fight for the same space, which is how the profile tab
   * bar ended up drawn over the status bar.
   *
   * A floating bar contributes NOTHING to layout, so the screen under it has to
   * reserve `insets.top + HOME_HEADER_BAR_HEIGHT` itself.
   */
  floating?: boolean;
  /**
   * Fade an opaque backdrop in behind the bar as the page scrolls, so content
   * passing underneath does not show through beside the status-bar clock.
   *
   * Needed wherever something PINS directly below this bar. On Collection the
   * page-tab bar stops at the bottom of the bubbles, which leaves the tail of
   * the profile block parked in the strip above it — the backdrop is what hides
   * it. At rest the backdrop is fully transparent, so the cover photo still
   * bleeds edge to edge under the glass.
   *
   * Requires `scrollY`; without it there is nothing to fade against.
   */
  pinnedBackdrop?: boolean;
  /**
   * The page's scroll offset. Drives the pill sliding up out of the row while
   * the bubbles beside it stay put; omit to keep the pill solid and static.
   *
   * The RAW offset, not a finished interpolation. This prop used to be a
   * `searchOpacity` that each screen interpolated for itself — and the bar then
   * never applied it, so both screens spent months computing a fade that was
   * dropped on the floor here. Taking the offset keeps the motion in ONE place
   * where it is either wired up or visibly not.
   *
   * Must be a native-driven `Animated.Value` (the screens feed it from
   * `Animated.event` / the pager) so the pill tracks the finger rather than
   * running a JS frame behind it.
   */
  scrollY?: Animated.Value;
  /**
   * The `contentOffset.y` this page RESTS at — the origin every scroll-driven
   * interpolation here measures travel from. Defaults to 0.
   *
   * NEGATIVE on iOS for both callers. Home's list and every Collection page run
   * `contentInsetAdjustmentBehavior="automatic"`, so UIKit insets them and they
   * sit at `-insets.top` at the top, not at 0. Interpolating from 0 instead
   * spent the first whole safe-area inset of every scroll (~59pt on a notched
   * phone) doing nothing, and only then started the pill's 56pt fade — the
   * animation was offset by a status bar. Android takes the explicit-
   * `paddingTop` branch, rests at 0, and must pass 0.
   *
   * Same quantity `useScrollToTop`'s `topOffset` and `CollapsibleTabPager`'s
   * `contentInsetTop` describe; the screens compute it once and hand the same
   * number to all of them.
   */
  scrollRestOffset?: number;
  /**
   * False once the pill has faded out. Opacity alone leaves an invisible but
   * still tappable pill sitting over the content — `pointerEvents` is not
   * animatable, so it has to be switched off separately.
   */
  searchInteractive?: boolean;
  /**
   * Space above the control row, for the status bar.
   *
   * Explicit because it depends on what the bar is mounted INSIDE, and getting
   * it from `useSafeAreaInsets()` unconditionally double-counted: on Home the
   * bar is a row of a list whose enclosing `SafeAreaView` has already consumed
   * the top inset, so adding it again pushed the first post a full status bar
   * further down. Collection mounts it at the very top of the screen and passes
   * the real inset. Defaults to the safe-area inset for that case.
   */
  topInset?: number;
  /** The pair of symbols in the 90×40 trailing capsule. See `HomeHeaderTrailing`. */
  trailing: HomeHeaderTrailing;
  testID?: string;
};

/** Figma "Home" 3523:15499 — every control in the bar is a 40pt circle. */
const BUTTON_ICON_SIZE = 20;
/**
 * The profile glyphs match Home's 20pt, and the earlier reasoning for making
 * them smaller was wrong.
 *
 * Figma measures the pencil at 18×18 and the share glyph at 16×18 (3670:47454 /
 * 3670:48047) — but it also measures Home's bell at 16.66×18 and its `+` at
 * 18×18, and this app has always drawn those at 20. So following the frame
 * literally on ONE screen while rounding up on the other is precisely what made
 * the You bar read lighter than Home's, which is how it was reported.
 *
 * Internal consistency wins here: every glyph in this bar is optically 20,
 * whichever screen it is on. The share arrow keeps Figma's non-square ratio
 * (16:18 scaled to 20 tall ≈ 18 wide) so it does not stretch into a square.
 */
const EDIT_ICON_SIZE = BUTTON_ICON_SIZE;
const SHARE_ICON_WIDTH = 18;
const SHARE_ICON_HEIGHT = BUTTON_ICON_SIZE;
/**
 * The app-mark badge inside the search pill. Sized off the 40pt pill rather than
 * off the old 36pt one, so the mark stays a badge inside the field instead of
 * filling it. The Figma logo node is flattened, so only its outer box is
 * measurable — the mark keeps the badge's existing inner ratio.
 */
const MARK_BADGE_SIZE = 22;
const MARK_WIDTH = 16.5;
const MARK_HEIGHT = 15;
/**
 * Height of the control row itself — the bubbles and the search pill are the
 * same 40, so the shared token IS the row height. Taken from the token rather
 * than repeated as a literal: the bar's reserved height is derived from it, and
 * the two silently disagreeing is exactly how the pill ended up clipping 2pt
 * short of the top of the row.
 */
const CONTROL_ROW_HEIGHT = glassNavBubbleSizes.compact;
/**
 * Figma's toolbar (3567:22969) is padded symmetrically, 8pt above the controls
 * and 8 below. The safe-area inset adds the rest above.
 */
const BAR_PADDING_TOP = 8;
/**
 * The bar owns the space under its own controls now that no rule follows them.
 * It used to be 0 here and 16 further down as a gap to a hairline; the hairline
 * is gone, and without a real bottom pad the first post rides up under the
 * bubbles.
 */
const BAR_PADDING_BOTTOM = 8;
/**
 * Height of the bar below the safe-area inset — the control row plus its padding
 * above and below. Exported because a FLOATING bar contributes nothing to
 * layout, so the screen under it has to reserve
 * `insets.top + HOME_HEADER_BAR_HEIGHT` itself. Reading it from here keeps the
 * reservation and the bar from drifting apart.
 */
export const HOME_HEADER_BAR_HEIGHT =
  BAR_PADDING_TOP + CONTROL_ROW_HEIGHT + BAR_PADDING_BOTTOM;
/**
 * Height of the bar down to the BOTTOM EDGE OF THE BUBBLES — no bottom padding.
 *
 * That edge is where anything pinning under a floating bar has to stop.
 * Collection's page-tab bar uses it: pinning at 0 slid "Collection / For Sale /
 * Activity" under the status bar clock.
 */
export const HOME_HEADER_ROW_HEIGHT = BAR_PADDING_TOP + CONTROL_ROW_HEIGHT;
/**
 * How far the page scrolls before the search pill has fully left the row.
 *
 * Exported because the screens need the SAME number to switch the pill's tap
 * target off: `pointerEvents` is not animatable, so the disarm is a separate JS
 * decision from the animation, and if the two numbers drift the pill is either
 * dead while still visible or invisible while still tappable.
 */
export const SEARCH_PILL_HIDE_DISTANCE = 56;
/**
 * How far the pill travels to clear the row: its own height plus the padding
 * above it, so it is entirely past the clip's top edge at the end.
 */
const SEARCH_PILL_TRAVEL = BAR_PADDING_TOP + CONTROL_ROW_HEIGHT;

/**
 * Home's top bar (Figma "Home" 3523:15499, toolbar 3567:22969): menu, a
 * tap-to-search pill carrying the Ekalight mark, notifications, and a `+`.
 * Collection draws the same bar with the profile toolbar's trailing pair
 * (3670:47454 — edit and share); see `HomeHeaderTrailing`.
 *
 * THE ONE TOP BAR. Home (the feed) and Collection both draw this. The feed
 * briefly had its own `FeedHeader` — same controls, but solid `IconButton`s in a
 * bar that sat ABOVE the list — and that divergence is the bug this file's
 * existence prevents: the buttons read as flat chrome instead of glass, and the
 * bar occupied layout instead of floating.
 *
 * THE BUBBLES PIN, THE PILL LEAVES. Home and Collection both mount it
 * `floating`: the bar is absolute chrome, the bubbles hold their place at the
 * top of the screen for the whole scroll, and only the search pill leaves — it
 * TRAVELS, sliding up out of the row and clipping away, rather than dissolving
 * where it stands. A pill that merely faded still read as stuck to the top of
 * the screen. It briefly went the other way — the whole bar in normal
 * flow, scrolling away as one piece — and that took the nav buttons off screen
 * with it, which is the regression this note exists to stop being re-introduced.
 *
 * The buttons stay `GlassNavBubble`s rather than solid `IconButton`s. They are
 * the app's nav shape, and glass over an opaque page background simply reads as
 * a soft-tinted circle.
 *
 * NO RULE UNDERNEATH. There is deliberately no hairline under this bar. It had
 * one — the bar was drawn as a masthead, with a `gray200` line 16pt below the
 * controls that the feed rendered as its own first list row so it could scroll
 * away. The live frame draws no such line: the bar is floating glass that is
 * MEANT to hover, and a hairline pinned over scrolling content is a line hanging
 * in mid-air. The bar now reserves 8pt under its own controls and the first
 * post's 16pt top inset supplies the rest; the only hairlines left on Home are
 * the ones each post card closes with.
 */
export function HomeHeader({
  onOpenMenu,
  floating = false,
  onOpenSearch,
  pinnedBackdrop = false,
  scrollRestOffset = 0,
  scrollY,
  searchInteractive = true,
  topInset,
  trailing,
  testID = 'portfolio-header',
}: HomeHeaderProps) {
  const theme = useSpotlightTheme();
  const insets = useSafeAreaInsets();

  /*
    The pill RIDES UP OUT of the row and is clipped away; the bubbles either
    side of it never move. Both interpolations run off the same offset over the
    same distance, so the slide and the fade finish together.

    ANCHORED AT THE LIST'S REST OFFSET, NOT AT 0. `scrollY` carries an ABSOLUTE
    `contentOffset.y`, which on an inset iOS list starts NEGATIVE — so a range
    beginning at 0 held the pill fully open for the first safe-area inset of
    every scroll and only then began the fade. `scrollRestOffset` is where the
    page actually sits at the top, so the range measures TRAVEL from it (0 on
    Android, where the page really does rest at 0).
  */
  const searchMotion = useMemo(() => {
    if (!scrollY) {
      return null;
    }
    const inputRange = [scrollRestOffset, scrollRestOffset + SEARCH_PILL_HIDE_DISTANCE];
    return {
      opacity: scrollY.interpolate({
        inputRange,
        outputRange: [1, 0],
        extrapolate: 'clamp',
      }),
      transform: [
        {
          translateY: scrollY.interpolate({
            inputRange,
            outputRange: [0, -SEARCH_PILL_TRAVEL],
            extrapolate: 'clamp',
          }),
        },
      ],
    };
  }, [scrollRestOffset, scrollY]);

  // Reaches full opacity over the same distance the pill takes to leave, which
  // is far shorter than the profile block's collapse — so by the time anything
  // is parked behind the bar, the backdrop is already solid. Same rest-offset
  // anchor as the pill, or the two would start at different moments.
  const backdropOpacity = useMemo(() => {
    if (!pinnedBackdrop || !scrollY) {
      return null;
    }
    return scrollY.interpolate({
      inputRange: [scrollRestOffset, scrollRestOffset + SEARCH_PILL_HIDE_DISTANCE],
      outputRange: [0, 1],
      extrapolate: 'clamp',
    });
  }, [pinnedBackdrop, scrollRestOffset, scrollY]);

  /*
    The capsule's two slots, left to right. EXACTLY TWO in both variants — the
    row closes at 393 only with a 90pt trailing control, so the count is part of
    the frame's arithmetic and not a free parameter.
  */
  const trailingItems: GlassNavBubbleGroupItem[] =
    trailing.kind === 'home'
      ? [
          {
            accessibilityLabel:
              trailing.unreadCount > 0
                ? `Notifications, ${trailing.unreadCount} unread`
                : 'Notifications',
            children: (
              <>
                <Bell
                  color={theme.colors.gray900}
                  height={BUTTON_ICON_SIZE}
                  width={BUTTON_ICON_SIZE}
                />
                {trailing.unreadCount > 0 ? (
                  <View
                    // Count capped at 9+ so the badge stays a circle — a
                    // 3-digit count would stretch it into a lozenge.
                    style={[
                      styles.notificationBadge,
                      { backgroundColor: theme.colors.dangerStrong },
                    ]}
                    testID={`${testID}-notifications-badge`}
                  >
                    <Text style={[theme.typography.overline, { color: theme.colors.gray0 }]}>
                      {trailing.unreadCount > 9 ? '9+' : String(trailing.unreadCount)}
                    </Text>
                  </View>
                ) : null}
              </>
            ),
            onPress: trailing.onOpenNotifications,
            testID: `${testID}-notifications`,
          },
          {
            accessibilityLabel: trailing.addAccessibilityLabel,
            children: (
              <Plus color={theme.colors.gray900} height={BUTTON_ICON_SIZE} width={BUTTON_ICON_SIZE} />
            ),
            onPress: trailing.onOpenAdd,
            testID: `${testID}-add`,
          },
        ]
      : [
          {
            accessibilityLabel: 'Edit profile',
            children: (
              <EditPencil
                color={theme.colors.gray900}
                height={EDIT_ICON_SIZE}
                width={EDIT_ICON_SIZE}
              />
            ),
            onPress: trailing.onEditProfile,
            testID: `${testID}-edit`,
          },
          {
            accessibilityLabel: 'Share profile',
            children: (
              <ShareIos
                color={theme.colors.gray900}
                height={SHARE_ICON_HEIGHT}
                width={SHARE_ICON_WIDTH}
              />
            ),
            onPress: trailing.onShareProfile,
            testID: `${testID}-share`,
          },
        ];

  return (
    <View
      pointerEvents={floating ? 'box-none' : 'auto'}
      style={[
        floating ? styles.floating : null,
        {
          paddingTop: topInset ?? insets.top,
          backgroundColor: floating ? 'transparent' : theme.colors.gray0,
        },
      ]}
      testID={testID}
    >
      {backdropOpacity ? (
        <Animated.View
          pointerEvents="none"
          style={[
            StyleSheet.absoluteFill,
            { backgroundColor: theme.colors.gray0, opacity: backdropOpacity },
          ]}
          testID={`${testID}-backdrop`}
        />
      ) : null}

      <View
        style={[
          styles.row,
          {
            paddingBottom: BAR_PADDING_BOTTOM,
            paddingHorizontal: theme.layout.pageGutter,
            paddingTop: BAR_PADDING_TOP,
          },
        ]}
        testID={`${testID}-row`}
      >
      <GlassNavBubble
        accessibilityLabel="Open menu"
        onPress={onOpenMenu}
        size="compact"
        testID={`${testID}-menu`}
      >
        <Menu color={theme.colors.gray900} height={BUTTON_ICON_SIZE} width={BUTTON_ICON_SIZE} />
      </GlassNavBubble>

      {/*
        The clip is on the PILL'S OWN wrapper and must stay there. Put
        `overflow: 'hidden'` any further up and it shaves the bell's unread
        badge, which hangs outside its slot in the trailing capsule at
        `top: -2, right: -2`.
      */}
      <View style={styles.searchPillClip} testID={`${testID}-search-clip`}>
      <Animated.View
        // Not animatable, so the faded pill has to be disarmed from JS —
        // otherwise it stays an invisible tap target over the first post.
        pointerEvents={searchInteractive ? 'auto' : 'none'}
        style={searchMotion}
        // On the HOST node, so a test reads the RESOLVED interpolation (numbers)
        // rather than the animated nodes the React element still holds — which
        // is the only way the fade's origin is visible off-device.
        testID={`${testID}-search-motion`}
      >
        <SearchEntryPill
          label="Search Cards"
          leading={
            <View
              style={[
                styles.markBadge,
                {
                  backgroundColor: theme.colors.purple500,
                  borderRadius: MARK_BADGE_SIZE / 2,
                },
              ]}
            >
              <EkalightMark
                color={theme.colors.gray0}
                height={MARK_HEIGHT}
                testID={`${testID}-mark`}
                width={MARK_WIDTH}
              />
            </View>
          }
          onPress={onOpenSearch}
          testID={`${testID}-search`}
        />
      </Animated.View>
      </View>

      {/*
        ONE CAPSULE, NOT TWO CIRCLES. Whichever pair it carries, the two symbols
        share a single 90×40 glass pill (`Trailing → Button Group 1`), which is
        also what leaves the flexed search pill its 215:
        `16 + 40 + 8 + 215 + 8 + 90 + 16 = 393`. Two separate 40pt bubbles with
        the row's own 8pt gap measure 88 and put the pill 2pt over.
      */}
      <GlassNavBubbleGroup items={trailingItems} testID={`${testID}-trailing`} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  floating: {
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
    // Above the pager's own chrome layer (profile block + tab bar), which sets
    // zIndex 2 and would otherwise draw over the bubbles once the bar pins.
    zIndex: 5,
  },
  row: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
  },
  markBadge: {
    alignItems: 'center',
    height: MARK_BADGE_SIZE,
    justifyContent: 'center',
    width: MARK_BADGE_SIZE,
  },
  // Sits on the bell's top-right corner, hanging past it. Both the capsule and
  // its 36pt slots are `overflow: 'visible'` (see `GlassNavBubbleGroup`), so
  // nothing between here and the row shaves it.
  notificationBadge: {
    alignItems: 'center',
    borderRadius: 9,
    height: 18,
    justifyContent: 'center',
    minWidth: 18,
    paddingHorizontal: 4,
    position: 'absolute',
    right: -2,
    top: -2,
  },
  searchPillClip: {
    flex: 1,
    // What actually removes the pill: it translates up and this cuts it off at
    // the top of the row, so it reads as sliding under the status bar rather
    // than dissolving in place.
    overflow: 'hidden',
  },
});

export default HomeHeader;
