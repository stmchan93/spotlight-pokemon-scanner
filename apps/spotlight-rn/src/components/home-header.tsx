import { Bell, ChatBubbleEmpty, Settings } from 'iconoir-react-native';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Animated, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  EkalightWordmark,
  GlassNavBubble,
  Text,
  glassNavBubbleGlyphSize,
  glassNavBubbleGlyphStrokeWidth,
  glassNavBubbleSizes,
  useSpotlightTheme,
} from '@spotlight/design-system';

import { AssistantChatPill } from '@/features/assistant/components/assistant-chat-pill';

/**
 * WHAT THE BAR'S TRAILING CONTROL IS — the ONE thing that differs between the
 * two variants this bar draws (2026-11-22 redesign):
 *
 * - `social` (Figma 6642:5420 + 6725:8999): the ekalight lockup centred, the
 *   Ask Ekalight "Chat" pill top-left, the DM inbox and bell bubbles paired on
 *   the right, each bell/inbox its own 44pt frost bubble with its own badge.
 * - `profile` (Home, Figma 6731:9875): the Chat pill top-left and a Settings
 *   gear bubble top-right (Figma draws a "…"; owner: make it the gear).
 *
 * A DISCRIMINATED UNION so the two legal shapes are the only shapes; each unread count
 * travels with the bubble it badges. The badges stay INSIDE this file: they hang
 * off the bubble as SIBLINGS (the glass clips its children to the circle), a
 * contract a caller composing its own children would not know to keep.
 */
export type HomeHeaderTrailing =
  | {
      kind: 'social';
      onOpenMessages: () => void;
      onOpenNotifications: () => void;
      /** Unread DMs across every thread. 0 draws no badge. */
      unreadMessageCount?: number;
      unreadCount: number;
    }
  | {
      kind: 'profile';
      onOpenSettings: () => void;
    };

type HomeHeaderProps = {
  /**
   * Profile variant only: fires when the bar's contrast flips (true = resting
   * over the dark cover, false = pinned on white). Lets the SCREEN mirror the
   * flip onto things the bar doesn't own — the status bar's own text, above all.
   */
  onOverCoverChange?: (overCover: boolean) => void;
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
   * Scroll distance from `scrollRestOffset` before the backdrop starts fading
   * in (and the contrast flip with it). Defaults to 0. Collection passes the
   * point where its cover's visible bottom is one fade-distance from the bar's
   * bottom edge, so the cover shows through clear until the sheet arrives —
   * fading from 0 washed a white strip over the cover after a few points.
   */
  backdropFadeStart?: number;
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
  /** Social's messages + bell, or Home's Settings gear. See `HomeHeaderTrailing`. */
  trailing: HomeHeaderTrailing;
  testID?: string;
};

/**
 * Every glyph in the bar draws at the shared glass-nav glyph size — see
 * `glassNavBubbleGlyphSize` for why that is 24 when the Figma toolbar frames
 * measure their (tight-cropped SF-Symbol) glyphs at ~20.
 */
const BUTTON_ICON_SIZE = glassNavBubbleGlyphSize;
// Home's leading brand lockup: the mark + "ekalight" wordmark, 36 tall
// (Figma 5067:2029 — the shared primitive's own 104.726:32 box scaled to it,
// which lands on the frame's 117.817 exactly). The width follows the artwork.
const HOME_WORDMARK_HEIGHT = 32;
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
 * Height of Social's bar below the safe-area inset — the 44pt control row plus
 * 10 below = 54. Exported because a FLOATING bar contributes nothing
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
export const HEADER_BACKDROP_FADE_DISTANCE = 56;
/**
 * The shared top bar: messages top-left + bell top-right on Social (Figma
 * 6642:5420, lockup centred), and on Home just the status-bar strip; see
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
  floating = false,
  onOverCoverChange,
  pinnedBackdrop = false,
  scrollRestOffset = 0,
  backdropFadeStart = 0,
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
  const fadeOrigin = scrollRestOffset + Math.max(backdropFadeStart, 0);
  const backdropOpacity = useMemo(() => {
    if (!pinnedBackdrop || !scrollY) {
      return null;
    }
    return scrollY.interpolate({
      inputRange: [fadeOrigin, fadeOrigin + HEADER_BACKDROP_FADE_DISTANCE],
      outputRange: [0, 1],
      extrapolate: 'clamp',
    });
  }, [fadeOrigin, pinnedBackdrop, scrollY]);

  /*
    CONTENT CONTRAST FLIP, profile variant only. At rest the profile bar floats
    over the cover photo's guaranteed scrim (ProfileHeader darkens the top of
    every cover, black 0.6 → clear), so the bubbles pin the DARK material with
    white glyphs — dark glyphs on a dark cover were the "can't see the icons"
    report. As the page scrolls, the pinned backdrop fades the strip to white,
    so at the fade's midpoint the content flips to the light treatment. Driven
    by the same scrollY as the backdrop; a profile bar without a scrollY stays
    in its resting over-cover form.
  */
  const [isOverCover, setIsOverCover] = useState(trailing.kind === 'profile');
  useEffect(() => {
    if (trailing.kind !== 'profile') {
      setIsOverCover(false);
      return undefined;
    }
    setIsOverCover(true);
    if (!scrollY) {
      return undefined;
    }
    const threshold = fadeOrigin + HEADER_BACKDROP_FADE_DISTANCE / 2;
    const listenerId = scrollY.addListener(({ value }) => {
      setIsOverCover((current) => {
        const next = value < threshold;
        return next === current ? current : next;
      });
    });
    return () => scrollY.removeListener(listenerId);
  }, [fadeOrigin, scrollY, trailing.kind]);
  const overCover = trailing.kind === 'profile' && isOverCover;
  useEffect(() => {
    onOverCoverChange?.(overCover);
  }, [onOverCoverChange, overCover]);
  // Figma 4134:49509/49518: the bubbles are FROSTED LIGHT (white Liquid Glass,
  // dark glyphs); the contrast flip drives only the status bar.
  const glyphColor = theme.colors.gray900;

  // Social: the Chat pill leads (Figma 6725:8999, it replaced the floating
  // bubble); messages + bell pair on the right. Each is its own 44pt frost
  // bubble; a badge is a SIBLING of its bubble, not a child — the bubble's glass
  // clips its children to the circle.
  const messagesControl =
    trailing.kind === 'social' ? (
      <BadgedBubble
        accessibilityLabel={
          trailing.unreadMessageCount
            ? `Messages, ${trailing.unreadMessageCount} unread`
            : 'Messages'
        }
        // The inbox's own purple: unread mail is not a warning (red is danger).
        badgeColor={theme.colors.purple500}
        count={trailing.unreadMessageCount ?? 0}
        onPress={trailing.onOpenMessages}
        testID={`${testID}-messages`}
      >
        <ChatBubbleEmpty
          color={glyphColor}
          strokeWidth={glassNavBubbleGlyphStrokeWidth}
          height={BUTTON_ICON_SIZE}
          width={BUTTON_ICON_SIZE}
        />
      </BadgedBubble>
    ) : null;
  const trailingControl =
    trailing.kind === 'social' ? (
      <BadgedBubble
        accessibilityLabel={
          trailing.unreadCount > 0
            ? `Notifications, ${trailing.unreadCount} unread`
            : 'Notifications'
        }
        badgeColor={theme.colors.dangerStrong}
        count={trailing.unreadCount}
        onPress={trailing.onOpenNotifications}
        testID={`${testID}-notifications`}
      >
        <Bell
          color={glyphColor}
          strokeWidth={glassNavBubbleGlyphStrokeWidth}
          height={BUTTON_ICON_SIZE}
          width={BUTTON_ICON_SIZE}
        />
      </BadgedBubble>
    ) : null;

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
        {trailing.kind === 'social' ? (
          /* Figma 6642:5420: the black lockup CENTRED on the screen. Permanent
             chrome: no entrance or scroll animation (2026-09-09). */
          <View pointerEvents="none" style={styles.centerMark}>
            <EkalightWordmark color={theme.colors.gray900} height={HOME_WORDMARK_HEIGHT} testID={`${testID}-home-mark`} />
          </View>
        ) : null}
        <AssistantChatPill testID={`${testID}-chat`} />
        {trailing.kind === 'social' ? (
          <View style={styles.trailingGroup}>
            {messagesControl}
            {trailingControl}
          </View>
        ) : (
          <GlassNavBubble
            accessibilityLabel="Settings"
            material="frost"
            onPress={trailing.onOpenSettings}
            size="medium"
            surface="onLight"
            testID={`${testID}-settings`}
          >
            <Settings
              color={glyphColor}
              height={BUTTON_ICON_SIZE}
              strokeWidth={glassNavBubbleGlyphStrokeWidth}
              width={BUTTON_ICON_SIZE}
            />
          </GlassNavBubble>
        )}
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
  trailingGroup: {
    flexDirection: 'row',
    gap: 8,
  },
  row: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 8,
  },
  // Fills the row and centres the lockup on the SCREEN, not between the side
  // controls (whose widths differ).
  centerMark: {
    alignItems: 'center',
    bottom: 0,
    justifyContent: 'center',
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
  },
  badgedBubble: {
    overflow: 'visible',
  },
  // Over the bubble's top-right, inset 2pt from the 44pt box.
  badge: {
    alignItems: 'center',
    borderCurve: 'continuous',
    borderRadius: 9,
    height: 18,
    justifyContent: 'center',
    minWidth: 18,
    paddingHorizontal: 4,
    position: 'absolute',
    right: 2,
    top: 2,
  },
});

/** A 44pt frost bubble with an optional unread badge hung off its top-right. */
/** A 44pt frost nav bubble with an unread badge hung off its top-right (a sibling: the glass clips its children). */
export function BadgedBubble({
  accessibilityLabel,
  badgeColor,
  children,
  count,
  onPress,
  testID,
}: {
  accessibilityLabel: string;
  badgeColor: string;
  children: ReactNode;
  count: number;
  onPress: () => void;
  testID: string;
}) {
  const theme = useSpotlightTheme();
  return (
    <View style={styles.badgedBubble}>
      <GlassNavBubble
        accessibilityLabel={accessibilityLabel}
        material="frost"
        onPress={onPress}
        size="medium"
        surface="onLight"
        testID={testID}
      >
        {children}
      </GlassNavBubble>
      {count > 0 ? (
        <View
          pointerEvents="none"
          // Capped at 9+ so the badge stays a circle.
          style={[styles.badge, { backgroundColor: badgeColor }]}
          testID={`${testID}-badge`}
        >
          <Text style={[theme.typography.overline, { color: theme.colors.gray0 }]}>
            {count > 9 ? '9+' : String(count)}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

export default HomeHeader;
