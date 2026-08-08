import { Bell, Menu, Plus } from 'iconoir-react-native';
import { Animated, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  GlassNavBubble,
  SearchEntryPill,
  Text,
  useSpotlightTheme,
} from '@spotlight/design-system';

import { EkalightMark } from '@/components/ekalight-mark';

type HomeHeaderProps = {
  /** Spoken label for the `+`, which changes with the active profile tab. */
  addAccessibilityLabel: string;
  onOpenAdd: () => void;
  onOpenMenu: () => void;
  onOpenNotifications: () => void;
  /** Tapping the pill opens the full-screen card search. */
  onOpenSearch: () => void;
  /**
   * 1 → 0 as the page scrolls. Driven natively off the pager's scroll offset, so
   * the fade runs on the UI thread rather than a JS frame behind the finger.
   */
  searchOpacity: Animated.AnimatedInterpolation<number>;
  /**
   * False once the pill has faded out. Opacity alone would leave an invisible
   * but still tappable pill sitting over the collection, so the taps have to be
   * turned off separately — `pointerEvents` is not animatable.
   */
  searchInteractive: boolean;
  unreadCount: number;
  testID?: string;
};

/** Figma 3505:14521 — every control in the bar is a 36pt circle. */
const BUTTON_ICON_SIZE = 20;
/** The app-mark badge inside the search pill (Figma 3505:14529). */
const MARK_BADGE_SIZE = 28;
const MARK_WIDTH = 21;
const MARK_HEIGHT = 19;
/** Figma 3505:14521 pads the bar 10pt above the row; the safe area adds the rest. */
const BAR_PADDING_TOP = 10;
const BAR_PADDING_BOTTOM = 10;
/**
 * Height of the bar BELOW the safe-area inset — the 36pt control row plus its
 * padding. `GlassNavBubble` at `compact` and `SearchEntryPill` are both 36, so
 * the row is 36 whichever is tallest.
 *
 * Exported because the bar is absolutely positioned and therefore contributes
 * nothing to layout: a screen that floats content under it has to reserve the
 * space itself as `insets.top + HOME_HEADER_BAR_HEIGHT` of `paddingTop`. Reading
 * it from here is what keeps that reservation and the bar from drifting apart.
 */
export const HOME_HEADER_BAR_HEIGHT = BAR_PADDING_TOP + 36 + BAR_PADDING_BOTTOM;

/**
 * Home's top bar (Figma 3505:14521): menu, a tap-to-search pill carrying the
 * Ekalight mark, notifications, and a `+`.
 *
 * THE ONE TOP BAR. Home (the feed) and Collection both draw this. The feed
 * briefly had its own `FeedHeader` — same controls, but solid `IconButton`s in a
 * bar that sat ABOVE the list — and that divergence is the bug this file's
 * existence prevents: the buttons read as flat chrome instead of glass, and the
 * bar occupied layout instead of floating.
 *
 * Two properties define it, and both come from floating chrome over scrolling
 * content rather than sitting above it:
 *
 *  - the four buttons are `GlassNavBubble`s, not solid `IconButton`s, because
 *    content scrolls UNDERNEATH them — this bar has no background of its own,
 *    and `box-none` lets every touch that misses a control fall through to the
 *    list;
 *  - the pill fades out as the page scrolls while the bubbles stay put. The
 *    bubbles do NOT move or fade: they are the persistent way back to the menu,
 *    notifications and `+` at any scroll depth.
 *
 * The bar is positioned absolutely by this component (top-left-right), so the
 * screen renders it as a plain sibling AFTER its scroller and it paints on top
 * by tree order. Rendering it after the scroller is load-bearing for a second
 * reason on tab screens: UIKit finds the scroll view to track for
 * minimize-on-scroll by walking `subviews[0]`, so the scroller has to be the
 * first child or the native tab bar stops collapsing.
 */
export function HomeHeader({
  addAccessibilityLabel,
  onOpenAdd,
  onOpenMenu,
  onOpenNotifications,
  onOpenSearch,
  searchOpacity,
  searchInteractive,
  unreadCount,
  testID = 'portfolio-header',
}: HomeHeaderProps) {
  const theme = useSpotlightTheme();
  const insets = useSafeAreaInsets();

  return (
    <View
      // The bar only occupies the strip its controls need; `box-none` keeps the
      // container itself from swallowing touches meant for the list below.
      pointerEvents="box-none"
      style={[
        styles.bar,
        {
          paddingHorizontal: theme.layout.pageGutter,
          paddingTop: insets.top + BAR_PADDING_TOP,
        },
      ]}
      testID={testID}
    >
      <GlassNavBubble
        accessibilityLabel="Open menu"
        onPress={onOpenMenu}
        size="compact"
        testID={`${testID}-menu`}
      >
        <Menu color={theme.colors.gray900} height={BUTTON_ICON_SIZE} width={BUTTON_ICON_SIZE} />
      </GlassNavBubble>

      <Animated.View
        pointerEvents={searchInteractive ? 'auto' : 'none'}
        style={[styles.searchPill, { opacity: searchOpacity }]}
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

      <GlassNavBubble
        accessibilityLabel={
          unreadCount > 0 ? `Notifications, ${unreadCount} unread` : 'Notifications'
        }
        onPress={onOpenNotifications}
        size="compact"
        testID={`${testID}-notifications`}
      >
        <Bell color={theme.colors.gray900} height={BUTTON_ICON_SIZE} width={BUTTON_ICON_SIZE} />
        {unreadCount > 0 ? (
          <View
            // Count capped at 9+ so the badge stays a circle — a 3-digit count
            // would stretch it into a lozenge that overhangs the bubble.
            style={[styles.notificationBadge, { backgroundColor: theme.colors.dangerStrong }]}
            testID={`${testID}-notifications-badge`}
          >
            <Text style={[theme.typography.overline, { color: theme.colors.gray0 }]}>
              {unreadCount > 9 ? '9+' : String(unreadCount)}
            </Text>
          </View>
        ) : null}
      </GlassNavBubble>

      <GlassNavBubble
        accessibilityLabel={addAccessibilityLabel}
        onPress={onOpenAdd}
        size="compact"
        testID={`${testID}-add`}
      >
        <Plus color={theme.colors.gray900} height={BUTTON_ICON_SIZE} width={BUTTON_ICON_SIZE} />
      </GlassNavBubble>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
    left: 0,
    paddingBottom: BAR_PADDING_BOTTOM,
    position: 'absolute',
    right: 0,
    top: 0,
    // Above the pager's own chrome layer (the profile block + tab bar), which
    // sets `zIndex: 2` and would otherwise draw over the bubbles once the tab
    // bar pins to the top.
    zIndex: 5,
  },
  markBadge: {
    alignItems: 'center',
    height: MARK_BADGE_SIZE,
    justifyContent: 'center',
    width: MARK_BADGE_SIZE,
  },
  // Sits on the bell's top-right corner. The parent bubble is
  // `overflow: 'visible'`, so the badge can hang past its edge without clipping.
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
  searchPill: {
    flex: 1,
  },
});

export default HomeHeader;
