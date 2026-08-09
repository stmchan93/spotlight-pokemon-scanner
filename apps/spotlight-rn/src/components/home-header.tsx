import { Bell, Menu, Plus } from 'iconoir-react-native';
import { Animated, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  GlassNavBubble,
  SearchEntryPill,
  Text,
  borderWidths,
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
   * FLOATING mode: absolutely positioned chrome over scrolling content, with no
   * rule. Collection needs it — its pager owns a pinned chrome layer of its own
   * (profile block + tab bar), and putting a second in-flow bar inside that
   * layer made the two fight for the same space, which is how the profile tab
   * bar ended up drawn over the status bar. Home has no such layer, so its bar
   * is a real list row that scrolls away and carries the rule.
   */
  floating?: boolean;
  /**
   * 1 → 0 as the page scrolls, so the pill gets out of the way while the
   * bubbles beside it stay put. Native-driven by the screen, so it tracks the
   * finger instead of running a JS frame behind it. Omit to keep it solid.
   */
  searchOpacity?: Animated.AnimatedInterpolation<number>;
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
/**
 * Gap between the control row and the rule below it — Figma 3505:14520 puts the
 * rule at y=120 against controls ending at y=104.
 */
const RULE_GAP = 16;
/**
 * Height of the bar below the safe-area inset — the 36pt control row plus its
 * padding. Exported because a FLOATING bar contributes nothing to layout, so the
 * screen under it has to reserve `insets.top + HOME_HEADER_BAR_HEIGHT` itself.
 * Reading it from here keeps the reservation and the bar from drifting apart.
 */
export const HOME_HEADER_BAR_HEIGHT = BAR_PADDING_TOP + 36 + RULE_GAP;

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
 * THE BUBBLES PIN, THE PILL LEAVES. Home and Collection both mount it
 * `floating`: the bar is absolute chrome, the bubbles hold their place at the
 * top of the screen for the whole scroll, and only the search pill fades out
 * from between them. It briefly went the other way — the whole bar in normal
 * flow, scrolling away as one piece — and that took the nav buttons off screen
 * with it, which is the regression this note exists to stop being re-introduced.
 *
 * The buttons stay `GlassNavBubble`s rather than solid `IconButton`s. They are
 * the app's nav shape, and glass over an opaque page background simply reads as
 * a soft-tinted circle.
 *
 * THE RULE UNDERNEATH IS THE POINT. Figma 3505:14520 puts a hairline 16pt below
 * the 36pt control row (controls end at y=104, rule at y=120) and starts content
 * 16pt below that. It is what makes the bar look like the page's masthead
 * instead of something hovering over it. It previously came for free from
 * `PageTabs`' full-bleed rail under the Following/Global switch and vanished
 * with those tabs, which is why it is drawn explicitly here now.
 */
export function HomeHeader({
  addAccessibilityLabel,
  onOpenAdd,
  onOpenMenu,
  onOpenNotifications,
  floating = false,
  onOpenSearch,
  searchInteractive = true,
  searchOpacity,
  topInset,
  unreadCount,
  testID = 'portfolio-header',
}: HomeHeaderProps) {
  const theme = useSpotlightTheme();
  const insets = useSafeAreaInsets();

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
      <View
        style={[
          styles.row,
          {
            paddingHorizontal: theme.layout.pageGutter,
            paddingTop: BAR_PADDING_TOP,
          },
        ]}
      >
      <GlassNavBubble
        accessibilityLabel="Open menu"
        onPress={onOpenMenu}
        size="compact"
        testID={`${testID}-menu`}
      >
        <Menu color={theme.colors.gray900} height={BUTTON_ICON_SIZE} width={BUTTON_ICON_SIZE} />
      </GlassNavBubble>

      <View style={styles.searchPill}>
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
      </View>

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

      {/*
        Full-bleed, so it reads as the page's own rule rather than a boxed
        divider — it runs edge to edge while the controls above it keep the page
        gutter.

        Only in the IN-FLOW bar. A floating bar draws no rule of its own, because
        a hairline pinned over scrolling content is a line hanging in mid-air;
        those screens render `HomeHeaderRule` as the first row of their content
        instead, which puts it in the same place at rest and lets it scroll away.
      */}
      {floating ? null : (
        <View
          style={[
            styles.rule,
            { backgroundColor: theme.colors.gray200, marginTop: RULE_GAP },
          ]}
          testID={`${testID}-rule`}
        />
      )}
    </View>
  );
}

/**
 * The hairline under the bar (Figma 3505:14283), for screens whose bar FLOATS.
 *
 * It belongs to the page, not to the chrome. The bar reserves `RULE_GAP` at the
 * bottom of `HOME_HEADER_BAR_HEIGHT`, so dropping this in as the first row of
 * the scrolling content lands it exactly where the frame puts it — 16pt under
 * the control row, 16pt above the first post — and then lets it travel up with
 * the content while the bubbles above stay put. Pinning it instead would leave a
 * grey line floating over posts with nothing above it to rule off.
 */
export function HomeHeaderRule({ testID }: { testID?: string }) {
  const theme = useSpotlightTheme();

  return (
    <View
      style={[styles.rule, { backgroundColor: theme.colors.gray200 }]}
      testID={testID}
    />
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
  rule: {
    height: borderWidths.rule,
    width: '100%',
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
