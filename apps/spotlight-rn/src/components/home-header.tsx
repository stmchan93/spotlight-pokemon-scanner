import { Bell, EditPencil, Menu, Search, ShareIos } from 'iconoir-react-native';
import { useMemo } from 'react';
import { Animated, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  GlassNavBubble,
  GlassNavBubbleGroup,
  SearchEntryPill,
  Text,
  glassNavBubbleGlyphSize,
  glassNavBubbleGlyphStrokeWidth,
  glassNavBubbleSizes,
  useSpotlightTheme,
  type GlassNavBubbleGroupItem,
} from '@spotlight/design-system';

import { EkalightMark } from '@/components/ekalight-mark';
import { EkalightLogoIntro } from '@/components/ekalight-logo-intro';

/**
 * WHAT THE BAR'S TRAILING CONTROL IS — the ONE thing that differs between the
 * two variants this bar draws. Home (Figma 4299:94902) carries a single glass
 * capsule holding a search glyph and the bell — there is NO full-width search
 * field on Home any more; search is a symbol in the trailing group. The profile
 * toolbar keeps its static search pill mid-row and carries an edit pencil and a
 * share glyph in the trailing capsule. Everything else — the 44pt menu bubble
 * at the leading edge, the row's gaps — is identical, which is exactly why this
 * is a variant on ONE component rather than a second bar.
 *
 * A DISCRIMINATED UNION, not a `trailing: ReactNode` render slot and not four
 * loose optional callbacks:
 *
 * - A render slot would push the trailing control out to the callers, and its
 *   width is load-bearing on the profile bar: the flexed pill lands on its
 *   designed width only because the trailing capsule is exactly
 *   `glassNavBubbleGroupWidth(2, 'medium')` = 104. Two screens each building
 *   their own would be two places for that to drift, and nothing would stop an
 *   extra symbol being added and silently stealing width from the pill.
 * - Loose optionals (`onOpenNotifications?`, `onEditProfile?`, …) make every
 *   illegal combination representable — a bar with a bell and a share glyph, or
 *   with none at all — and push a runtime "which of these did I get" decision
 *   into the render. The union makes the two legal shapes the only two shapes,
 *   and the unread count belongs to the bell so it travels with it.
 *
 * The bell's unread badge stays INSIDE this file either way. It hangs outside
 * the bell's 36pt slot at `top: -2, right: -2` and only survives because the
 * capsule and its slots keep `overflow: 'visible'` — a contract between the
 * badge and the primitive that a caller composing its own children would not
 * know to keep.
 */
export type HomeHeaderTrailing =
  | {
      kind: 'home';
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
  /** Opens the full-screen card search — the trailing magnifier on Home, the pill on the profile. */
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
   * The page's scroll offset. Drives the pinned backdrop's fade; omit it (or
   * omit `pinnedBackdrop`) and the bar draws no backdrop at all. The controls
   * themselves never move — the old scroll-linked search-pill slide was
   * retired with the 4299:94902 bar.
   *
   * The RAW offset, not a finished interpolation, so the fade lives in ONE
   * place where it is either wired up or visibly not. Must be a native-driven
   * `Animated.Value` (the screens feed it from `Animated.event` / the pager)
   * so the backdrop tracks the finger rather than running a JS frame behind it.
   */
  scrollY?: Animated.Value;
  /**
   * The `contentOffset.y` this page RESTS at — the origin the backdrop's fade
   * measures travel from. Defaults to 0.
   *
   * NEGATIVE on iOS for both callers. Home's list and every Collection page run
   * `contentInsetAdjustmentBehavior="automatic"`, so UIKit insets them and they
   * sit at `-insets.top` at the top, not at 0. Interpolating from 0 instead
   * spent the first whole safe-area inset of every scroll (~59pt on a notched
   * phone) doing nothing before the fade began. Android takes the explicit-
   * `paddingTop` branch, rests at 0, and must pass 0.
   *
   * Same quantity `useScrollToTop`'s `topOffset` and `CollapsibleTabPager`'s
   * `contentInsetTop` describe; the screens compute it once and hand the same
   * number to all of them.
   */
  scrollRestOffset?: number;
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
  /** The bar's rightmost control — Home's search + bell capsule or the profile's edit/share capsule. See `HomeHeaderTrailing`. */
  trailing: HomeHeaderTrailing;
  testID?: string;
};

/**
 * Every glyph in the bar draws at the shared glass-nav glyph size — see
 * `glassNavBubbleGlyphSize` for why that is 24 when the Figma toolbar frames
 * measure their (tight-cropped SF-Symbol) glyphs at ~20.
 */
const BUTTON_ICON_SIZE = glassNavBubbleGlyphSize;
/**
 * The profile glyphs match Home's size — following the frame literally on ONE
 * screen while rounding up on the other is what once made the You bar read
 * lighter than Home's. The share arrow keeps Figma's non-square 16:18 ratio so
 * it does not stretch into a square.
 */
const EDIT_ICON_SIZE = BUTTON_ICON_SIZE;
const SHARE_ICON_WIDTH = Math.round(BUTTON_ICON_SIZE * 0.9);
const SHARE_ICON_HEIGHT = BUTTON_ICON_SIZE;
/**
 * The app-mark badge inside the profile bar's search pill, sized so the mark
 * stays a badge inside the field instead of filling it. The Figma logo node is
 * flattened, so only its outer box is measurable — the mark keeps the badge's
 * existing inner ratio.
 */
const MARK_BADGE_SIZE = 22;
const MARK_WIDTH = 16.5;
const MARK_HEIGHT = 15;
// Home's leading app mark: 36 tall at the mark's intrinsic 56:52 box.
const HOME_MARK_HEIGHT = 36;
const HOME_MARK_WIDTH = (HOME_MARK_HEIGHT * 56) / 52;
/**
 * Height of the control row itself — the bubbles, the trailing capsule, and the
 * profile bar's search pill are all the same 44 (Figma 4299:94902). Taken from
 * the token rather than repeated as a literal: the bar's reserved height is
 * derived from it, and the two silently disagreeing is exactly how the old pill
 * ended up clipping 2pt short of the top of the row.
 */
const CONTROL_ROW_HEIGHT = glassNavBubbleSizes.medium;
/**
 * The controls sit directly under the safe-area inset — Figma 4299:95117 pads
 * the toolbar 0 above and 10 below.
 */
const BAR_PADDING_TOP = 0;
/**
 * 10pt under the controls (Figma 4299:94902 — the bar is 8/10, not symmetric).
 * The bar owns the space under its own controls: without a real bottom pad the
 * first post rides up under the bubbles.
 */
const BAR_PADDING_BOTTOM = 10;
/**
 * Height of the bar below the safe-area inset — the 44pt control row plus 10
 * below = 54. Exported because a FLOATING bar contributes nothing
 * to layout, so the screen under it has to reserve
 * `insets.top + HOME_HEADER_BAR_HEIGHT` itself. Reading it from here keeps the
 * reservation and the bar from drifting apart.
 */
export const HOME_HEADER_BAR_HEIGHT =
  BAR_PADDING_TOP + CONTROL_ROW_HEIGHT + BAR_PADDING_BOTTOM;
/**
 * Height of the bar down to the BOTTOM EDGE OF THE BUBBLES (0 + 44 = 44) — no
 * bottom padding.
 *
 * That edge is where anything pinning under a floating bar has to stop.
 * Collection's page-tab bar uses it: pinning at 0 slid "Collection / For Sale /
 * Activity" under the status bar clock.
 */
export const HOME_HEADER_ROW_HEIGHT = BAR_PADDING_TOP + CONTROL_ROW_HEIGHT;
/**
 * How far the page scrolls before the pinned backdrop is fully opaque. The 56
 * is inherited from the retired search-pill fade, which the backdrop was timed
 * against — the timing survives the pill because it still reads right: by the
 * time anything parks behind the bar the backdrop is already solid.
 */
const HEADER_BACKDROP_FADE_DISTANCE = 56;
/**
 * How far the page scrolls before Home's decorative app mark has fully faded.
 * Shorter than the backdrop's distance so the mark is gone before content
 * starts parking behind the bar.
 */
const HOME_MARK_FADE_DISTANCE = 40;

/**
 * The shared top bar (Figma 4299:94902): a 44pt glass menu bubble leading, and
 * ONE 44pt glass capsule trailing. On Home the capsule holds a search glyph and
 * the bell — there is no full-width search field on Home; search is a
 * destination behind the magnifier. On Collection the same bar swaps the
 * capsule's contents for the profile pair (edit + share) and keeps a static
 * 44pt "Search Cards" pill flexed between the controls; see
 * `HomeHeaderTrailing`.
 *
 * THE ONE TOP BAR. Home (the feed) and Collection both draw this. The feed
 * briefly had its own `FeedHeader` — same controls, but solid `IconButton`s in a
 * bar that sat ABOVE the list — and that divergence is the bug this file's
 * existence prevents: the buttons read as flat chrome instead of glass, and the
 * bar occupied layout instead of floating.
 *
 * THE CONTROLS PIN. Both callers mount it `floating`: the bar is absolute
 * chrome that holds its place at the top of the screen for the whole scroll.
 * Nothing in the bar moves with the page any more — the old scroll-linked
 * search-pill slide left with the full-width pill. It briefly went the other
 * way — the whole bar in normal flow, scrolling away as one piece — and that
 * took the nav buttons off screen with it, which is the regression this note
 * exists to stop being re-introduced.
 *
 * The buttons stay `GlassNavBubble`s rather than solid `IconButton`s. They are
 * the app's nav shape, and glass over an opaque page background simply reads as
 * a soft-tinted circle.
 *
 * NO RULE UNDERNEATH. There is deliberately no hairline under this bar. It had
 * one — the bar was drawn as a masthead, with a `gray200` line 16pt below the
 * controls that the feed rendered as its own first list row so it could scroll
 * away. The live frame draws no such line: the bar is floating glass that is
 * MEANT to hover. The bar reserves 10pt under its own controls and the first
 * post's top inset supplies the rest; the only hairlines left on Home are the
 * ones each post card closes with.
 */
export function HomeHeader({
  onOpenMenu,
  floating = false,
  onOpenSearch,
  pinnedBackdrop = false,
  scrollRestOffset = 0,
  scrollY,
  topInset,
  trailing,
  testID = 'portfolio-header',
}: HomeHeaderProps) {
  const theme = useSpotlightTheme();
  const insets = useSafeAreaInsets();

  // Reaches full opacity well before the profile block's collapse finishes —
  // so by the time anything is parked behind the bar, the backdrop is already
  // solid. ANCHORED AT THE LIST'S REST OFFSET, NOT AT 0: `scrollY` carries an
  // ABSOLUTE `contentOffset.y`, which on an inset iOS list starts NEGATIVE, so
  // a range beginning at 0 would spend the first safe-area inset of every
  // scroll doing nothing.
  const backdropOpacity = useMemo(() => {
    if (!pinnedBackdrop || !scrollY) {
      return null;
    }
    return scrollY.interpolate({
      inputRange: [scrollRestOffset, scrollRestOffset + HEADER_BACKDROP_FADE_DISTANCE],
      outputRange: [0, 1],
      extrapolate: 'clamp',
    });
  }, [pinnedBackdrop, scrollRestOffset, scrollY]);

  // Home's leading app mark is decoration, not a control — so unlike the
  // bubbles it does NOT hold its place while the page scrolls: it fades out
  // over the first stretch of travel and returns at rest. Same rest-offset
  // anchoring as the backdrop above. Without a scrollY it simply stays.
  const homeMarkOpacity = useMemo(() => {
    if (!scrollY) {
      return null;
    }
    return scrollY.interpolate({
      inputRange: [scrollRestOffset, scrollRestOffset + HOME_MARK_FADE_DISTANCE],
      outputRange: [1, 0],
      extrapolate: 'clamp',
    });
  }, [scrollRestOffset, scrollY]);

  /*
    The bar's rightmost control — ONE capsule on both variants, with EXACTLY
    TWO slots. On Home that is search + bell (Figma 4299:94902); on the profile
    it is edit + share. The slot count is part of the frame's arithmetic, not a
    free parameter: the capsule is `glassNavBubbleGroupWidth(2, 'medium')` =
    104 wide, and on the profile bar the flexed pill's width is the row's
    remainder against exactly that.
  */
  const trailingControl =
    trailing.kind === 'home' ? (
      <GlassNavBubbleGroup
        items={
          [
            {
              accessibilityLabel: 'Search cards',
              children: (
                <Search
                  color={theme.colors.gray900}
                  strokeWidth={glassNavBubbleGlyphStrokeWidth}
                  height={BUTTON_ICON_SIZE}
                  width={BUTTON_ICON_SIZE}
                />
              ),
              onPress: onOpenSearch,
              testID: `${testID}-search`,
            },
            {
              accessibilityLabel:
                trailing.unreadCount > 0
                  ? `Notifications, ${trailing.unreadCount} unread`
                  : 'Notifications',
              children: (
                <>
                  <Bell
                    color={theme.colors.gray900}
                    strokeWidth={glassNavBubbleGlyphStrokeWidth}
                    height={BUTTON_ICON_SIZE}
                    width={BUTTON_ICON_SIZE}
                  />
                  {trailing.unreadCount > 0 ? (
                    <View
                      // Hangs off the 36pt slot's top-right corner; survives
                      // because the capsule and its slots never clip. Count
                      // capped at 9+ so the badge stays a circle — a 3-digit
                      // count would stretch it into a lozenge.
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
          ] satisfies GlassNavBubbleGroupItem[]
        }
        size="medium"
        testID={`${testID}-trailing`}
      />
    ) : (
      <GlassNavBubbleGroup
        items={
          [
            {
              accessibilityLabel: 'Edit profile',
              children: (
                <EditPencil
                  color={theme.colors.gray900}
                  strokeWidth={glassNavBubbleGlyphStrokeWidth}
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
                  strokeWidth={glassNavBubbleGlyphStrokeWidth}
                  height={SHARE_ICON_HEIGHT}
                  width={SHARE_ICON_WIDTH}
                />
              ),
              onPress: trailing.onShareProfile,
              testID: `${testID}-share`,
            },
          ] satisfies GlassNavBubbleGroupItem[]
        }
        size="medium"
        testID={`${testID}-trailing`}
      />
    );

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
        <View style={styles.leadingGroup}>
          <GlassNavBubble
            accessibilityLabel="Open menu"
            onPress={onOpenMenu}
            size="medium"
            testID={`${testID}-menu`}
          >
            <Menu color={theme.colors.gray900} strokeWidth={glassNavBubbleGlyphStrokeWidth} height={BUTTON_ICON_SIZE} width={BUTTON_ICON_SIZE} />
          </GlassNavBubble>
          {trailing.kind === 'home' ? (
            <Animated.View
              pointerEvents="none"
              style={homeMarkOpacity ? { opacity: homeMarkOpacity } : null}
            >
              <EkalightLogoIntro testID={`${testID}-home-mark`} />
            </Animated.View>
          ) : null}
        </View>

        {/*
          THE PROFILE PILL'S WIDTH IS THE ROW'S REMAINDER, so the trailing
          capsule's width is load-bearing there. At a 393pt width the profile
          row closes as `16 + 44 + 8 + 197 + 8 + 104 + 16 = 393` — menu bubble,
          flexed pill, and the 104pt edit/share capsule
          (`glassNavBubbleGroupWidth(2, 'medium')`).

          Home has NO pill: menu leads, the search + bell capsule trails, and
          `space-between` opens the middle of the bar (Figma 4299:94902). The
          pill renders in a plain flexed view — static, no scroll-linked motion
          and no clip; the old slide-away wrapper left with the Home pill.
        */}
        {trailing.kind === 'profile' ? (
          <View style={styles.searchPillSlot}>
            <SearchEntryPill
              label="Search Cards"
              variant="glass"
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
          </View>
        ) : null}

        {trailingControl}
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
    // What lays Home out: menu leading, capsule trailing, nothing between. On
    // the profile the flexed pill fills the middle anyway, so this is inert.
    justifyContent: 'space-between',
  },
  leadingGroup: {
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
  // Sits on the bell slot's top-right corner, hanging past it. The capsule and
  // its slots are `overflow: 'visible'`, so nothing between here and the row
  // shaves it.
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
  searchPillSlot: {
    flex: 1,
  },
});

export default HomeHeader;
