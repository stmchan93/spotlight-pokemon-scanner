import { EditPencil, Menu, Plus, ShareIos } from 'iconoir-react-native';
import { useMemo } from 'react';
import { Animated, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  AppText,
  GlassButtonGroup,
  GlassNavBubble,
  IconButton,
  glassButtonGroupControlSize,
  glassNavBubbleGlyphSize,
  glassNavBubbleSizes,
  useSpotlightTheme,
} from '@spotlight/design-system';

import { EditDoneButton } from '@/components/edit-done-button';

type WishlistHeaderProps = {
  /** Opens the app drawer. Wishlist is a TAB, so there is nothing to go back to. */
  onOpenMenu: () => void;
  /** Opens the card catalog search. Omit to leave the search slot empty. */
  onOpenSearch?: () => void;
  /** Share the list as text. Omitted → the control is not rendered. */
  onShare?: () => void;
  /** When true the bar shows a "Done" action instead of the edit pencil. */
  editMode?: boolean;
  /** Enables the edit-mode toggle in the right slot. */
  onToggleEditMode?: () => void;
  /**
   * FLOATING mode: absolute chrome drawn OVER the scrolling list rather than a
   * row that takes up layout — the same mode Home and Collection mount
   * `HomeHeader` in, and the only mode in which "the buttons stay, the title
   * leaves" is possible at all. An in-flow bar can only scroll away as one
   * piece, which takes the menu and the actions off screen with it.
   *
   * A floating bar contributes NOTHING to layout, so the list under it has to
   * reserve `insets.top + WISHLIST_HEADER_BAR_HEIGHT` itself.
   */
  floating?: boolean;
  /**
   * The page's scroll offset. Drives the centred "Wishlist" title sliding up out
   * of the row while the bubbles either side of it stay put; omit to keep the
   * title solid and static.
   *
   * The RAW offset, not a finished interpolation — the bar owns the motion, the
   * screen only measures the scroll. Must be a native-driven `Animated.Value`
   * (the screen feeds it from an `Animated.event`) so the title tracks the
   * finger rather than running a JS frame behind it.
   */
  scrollY?: Animated.Value;
  /**
   * The `contentOffset.y` this page RESTS at — the origin the title's fade
   * measures travel from. Defaults to 0.
   *
   * 0 for the Wishlist today: its list sets no `contentInsetAdjustmentBehavior`
   * (RN's default is `"never"`), so UIKit never insets it and it really does sit
   * at 0 on both platforms. The prop exists anyway because the day that list
   * goes `"automatic"` it starts resting at `-insets.top`, and a range anchored
   * at 0 would then hold the title fully visible for a whole safe-area inset
   * before starting to move — the exact bug just fixed on Home and Collection.
   */
  scrollRestOffset?: number;
  /**
   * False once the title has left the row. Opacity alone leaves an invisible
   * label sitting over the list — `pointerEvents` is not animatable, so the
   * disarm is a separate JS decision.
   */
  titleVisible?: boolean;
  testID?: string;
};

// Lean top bar for the Wishlist screen: a circular menu button, centred
// "Wishlist" title, and an edit slot.
//
// The left slot used to be a BACK chevron, from when Wishlist was pushed in from
// the drawer. It is one of the four TABS now, so there was nothing behind it to
// go back to — the button popped you to whatever you happened to visit before,
// or did nothing at all. A tab is a root, so it gets the hamburger, exactly like
// Home and You.
//
// The two circular actions use the shared `GlassNavBubble` so this bar reads as
// the same chrome as the Home / You top bars (it replaced a gray/50 `IconButton`
// chip from Figma 1263:3328).
//
// SIZE — `compact` (36pt), matching those bars rather than the old 44pt default.
// 44 was the odd one out twice over: every other bar in the app is a 36pt row
// (Figma 3505:14521), and this header already sat a 44pt bubble directly beside
// a 36pt `EditDoneButton`, so the two right-hand controls changed height as you
// entered edit mode. 36 makes the bar internally consistent and consistent with
// everywhere else. The 8pt `hitSlop` inside the primitive keeps the touch target
// over the 44pt minimum.
//
// SEARCH — the catalog search used to be a floating magnifier FAB
// (`CollectionAddFab`) pinned above the tab bar. It is a bubble in this bar now,
// beside Edit: same destination (/catalog/search), same accessibility label,
// same primitive as every other control here. That also matches Collection,
// whose catalog search is the top-bar "Search Cards" pill rather than anything
// floating (the in-page magnifier there was removed as a duplicate).
//
// LAYOUT — the left and right slots are equal-flex, with the title sized to its
// own content between them, so "Wishlist" stays on the true centre of the bar no
// matter how many controls the right slot carries. The title used to be the
// `flex: 1` element, which centres it in whatever is LEFT OVER — with one bubble
// on the left and two on the right that is ~24pt off-centre (and it already
// drifted when the wider "Done" pill swapped in).
//
// SCROLL — the bubbles PIN, the title LEAVES, exactly as Home's bubbles pin
// while its search pill leaves (`HomeHeader`). Mounted `floating`, the bar is
// absolute chrome the list scrolls beneath; only the centred title travels up
// out of the row and clips away. The whole bar used to sit in normal flow above
// the list, which is the shape that takes the menu and the actions off screen
// with it — the regression `HomeHeader`'s own note exists to stop.
// Trailing-pill glyphs follow the iOS-26 toolbar spec (Figma 4255:90646):
// 20px glyphs at ~2px effective stroke inside the 36px controls — deliberately
// NOT glassNavBubbleGlyphSize (24), which the Menu bubble keeps.
const BUTTON_ICON_SIZE = 20;
const BUTTON_ICON_STROKE = 2;
/**
 * Figma's toolbar (3567:22969) pads 8pt above the control row; the safe-area
 * inset supplies the rest.
 */
const BAR_PADDING_TOP = 8;
/**
 * Height of the control row. Every control in this bar is 40 tall — the menu
 * bubble (`size="medium"`), the `GlassButtonGroup`, and the `EditDoneButton`
 * that swaps in for it — so the shared bubble token IS the row height, and it
 * does not change when edit mode swaps the wider "Done" pill in. The title
 * (`titleMedium`, 23.4pt tall) never sets it.
 */
const CONTROL_ROW_HEIGHT = glassNavBubbleSizes.medium;
/**
 * Height of the bar below the safe-area inset. Exported because a FLOATING bar
 * contributes nothing to layout, so the list under it reserves
 * `insets.top + WISHLIST_HEADER_BAR_HEIGHT` as `contentContainerStyle.paddingTop`.
 * Reading it from here keeps the reservation and the bar from drifting apart.
 *
 * NO bottom padding, unlike `HOME_HEADER_BAR_HEIGHT`. Home pads 8 under its
 * controls because the first post would otherwise ride up under the bubbles;
 * the first thing in this list is the search/filter block, which carries its own
 * 24pt `marginTop`. Adding 8 here would simply push the whole page down 8pt from
 * where it sits today.
 */
export const WISHLIST_HEADER_BAR_HEIGHT = BAR_PADDING_TOP + CONTROL_ROW_HEIGHT;
/**
 * How far the page scrolls before the title has fully left the row.
 *
 * Exported because the screen needs the SAME number to switch the title's
 * `pointerEvents` off — that is not animatable, so the disarm is a separate JS
 * decision, and if the two numbers drift the title is either dead while visible
 * or live while invisible.
 */
// 56 matched the retired Home search pill's hide timing; the number outlives the pill.
export const WISHLIST_TITLE_HIDE_DISTANCE = 56;
/**
 * How far the title travels to clear the row: the control row plus the padding
 * above it, so it is entirely past the clip's top edge at the end.
 */
const TITLE_TRAVEL = BAR_PADDING_TOP + CONTROL_ROW_HEIGHT;

export function WishlistHeader({
  onOpenMenu,
  onOpenSearch,
  onShare,
  editMode = false,
  floating = false,
  onToggleEditMode,
  scrollRestOffset = 0,
  scrollY,
  titleVisible = true,
  testID = 'wishlist-header',
}: WishlistHeaderProps) {
  const theme = useSpotlightTheme();
  const insets = useSafeAreaInsets();

  /*
    The title RIDES UP OUT of the row and is clipped away; the bubbles either
    side of it never move. Both interpolations run off the same offset over the
    same distance, so the slide and the fade finish together.

    ANCHORED AT THE LIST'S REST OFFSET, NOT AT 0 — see `scrollRestOffset`. It is
    0 for this screen today, but the range is written against the prop so an
    inset list would be handled rather than silently mis-anchored.
  */
  const titleMotion = useMemo(() => {
    if (!scrollY) {
      return null;
    }
    const inputRange = [scrollRestOffset, scrollRestOffset + WISHLIST_TITLE_HIDE_DISTANCE];
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
            outputRange: [0, -TITLE_TRAVEL],
            extrapolate: 'clamp',
          }),
        },
      ],
    };
  }, [scrollRestOffset, scrollY]);

  return (
    <View
      // `box-none` so the strip either side of the controls does not eat taps
      // and scrolls meant for the list underneath.
      pointerEvents={floating ? 'box-none' : 'auto'}
      style={[
        floating ? styles.floating : null,
        styles.header,
        { paddingTop: insets.top + BAR_PADDING_TOP },
      ]}
      testID={testID}
    >
      <View style={styles.headerSlot}>
        <GlassNavBubble
          accessibilityLabel="Open menu"
          onPress={onOpenMenu}
          size="medium"
          surface="onLight"
          testID="wishlist-header-menu"
        >
          <Menu color={theme.colors.gray900} height={BUTTON_ICON_SIZE} width={BUTTON_ICON_SIZE} />
        </GlassNavBubble>
      </View>
      {/*
        The clip is on the TITLE'S OWN wrapper. It is what actually removes the
        label: the text translates up and this cuts it off, so it reads as
        sliding under the status bar rather than dissolving in place — and,
        crucially, a half-faded title never draws up beside the clock. Clipping
        any further up the row would shave the glass controls instead.

        Safe to clip tight to the text: `titleMedium`'s 23.4pt line box already
        contains the font's descenders, and "Wishlist" has none to lose anyway.
      */}
      <View style={styles.headerTitleClip} testID={`${testID}-title-clip`}>
        <Animated.View
          // Not animatable, so the departed title has to be disarmed from JS —
          // otherwise an invisible label sits over the first list row.
          pointerEvents={titleVisible ? 'auto' : 'none'}
          style={titleMotion}
          // On the HOST node, so a test reads the RESOLVED interpolation
          // (numbers) rather than the animated nodes the React element still
          // holds — the only way the fade's origin is visible off-device.
          testID={`${testID}-title-motion`}
        >
          <AppText
            color="textPrimary"
            numberOfLines={1}
            style={styles.headerTitle}
            testID="wishlist-header-title"
            variant="titleMedium"
          >
            Wishlist
          </AppText>
        </Animated.View>
      </View>
      <View style={[styles.headerSlot, styles.headerSlotRight]}>
        {/* Stands down in edit mode, exactly as the old FAB did: the bar is
            handed over to Done, and browsing the catalog mid-selection is not
            what edit mode is for. */}
        {editMode ? (
          // Edit mode still hands the whole bar over to Done — browsing the
          // catalog mid-selection is not what edit mode is for.
          onToggleEditMode ? (
            <EditDoneButton onPress={onToggleEditMode} testID="wishlist-header-done" />
          ) : null
        ) : (
          /*
            Add / edit / share in ONE pill (Figma 3725:59578), the same
            `GlassButtonGroup` card detail uses. Three separate bubbles read as
            three unrelated buttons; one pill reads as this list's actions.
          */
          <GlassButtonGroup testID="wishlist-header-actions">
            {onOpenSearch ? (
              <IconButton
                accessibilityLabel="Search the card catalog"
                onPress={onOpenSearch}
                shape="circle"
                size={glassButtonGroupControlSize}
                testID="wishlist-header-search"
                variant="ghost"
              >
                {/* A plus, not a magnifier: the destination is the same catalog
                    search, but from here the INTENT is "add a card". */}
                <Plus color={theme.colors.gray900} height={BUTTON_ICON_SIZE} strokeWidth={BUTTON_ICON_STROKE} width={BUTTON_ICON_SIZE} />
              </IconButton>
            ) : null}
            {onToggleEditMode ? (
              <IconButton
                accessibilityLabel="Edit wishlist"
                onPress={onToggleEditMode}
                shape="circle"
                size={glassButtonGroupControlSize}
                testID="wishlist-header-edit"
                variant="ghost"
              >
                <EditPencil color={theme.colors.gray900} height={BUTTON_ICON_SIZE} strokeWidth={BUTTON_ICON_STROKE} width={BUTTON_ICON_SIZE} />
              </IconButton>
            ) : null}
            {/*
              Shares the LIST — "here is what I'm hunting" — as text. The macro
              counterpart to card detail's per-card share.

              No link, because there is nothing to link to: the wishlist is
              private and the public profile has no Wishlist tab. A URL that
              404s for the recipient would be worse than plain text.
            */}
            {onShare ? (
              <IconButton
                accessibilityLabel="Share wishlist"
                onPress={onShare}
                shape="circle"
                size={glassButtonGroupControlSize}
                testID="wishlist-header-share"
                variant="ghost"
              >
                <ShareIos color={theme.colors.gray900} height={BUTTON_ICON_SIZE} strokeWidth={BUTTON_ICON_STROKE} width={BUTTON_ICON_SIZE} />
              </IconButton>
            ) : null}
          </GlassButtonGroup>
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
    // Same layer `HomeHeader` claims, so the bar stays over the list (and over
    // anything a future in-page chrome layer draws) rather than under it.
    zIndex: 5,
  },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
    paddingHorizontal: 16,
  },
  // Equal-flex side slots keep the title on the bar's true centre; the bubbles
  // never shrink because each slot is wider than the controls it holds even at
  // 320pt.
  headerSlot: {
    alignItems: 'center',
    flex: 1,
    flexDirection: 'row',
    gap: 12,
  },
  headerSlotRight: {
    justifyContent: 'flex-end',
  },
  headerTitle: {
    textAlign: 'center',
  },
  // Sized to the title's own content, exactly as the bare `AppText` was, so the
  // equal-flex side slots still put "Wishlist" on the bar's true centre.
  headerTitleClip: {
    overflow: 'hidden',
  },
});
