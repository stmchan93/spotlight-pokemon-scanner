import { EditPencil, Menu, Search } from 'iconoir-react-native';
import { useMemo } from 'react';
import { Animated, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  AppText,
  GlassNavBubble,
  GlassNavBubbleGroup,
  glassNavBubbleGlyphSize,
  glassNavBubbleGlyphStrokeWidth,
  glassNavBubbleGroupWidth,
  glassNavBubbleSizes,
  useSpotlightTheme,
  type GlassNavBubbleGroupItem,
} from '@spotlight/design-system';

import { EditDoneButton } from '@/components/edit-done-button';

type WishlistHeaderProps = {
  /** Opens the app drawer. Wishlist is a TAB, so there is nothing to go back to. */
  onOpenMenu: () => void;
  /** Opens the card catalog search. Omitted → the control is not rendered. */
  onOpenSearch?: () => void;
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
   * The page's scroll offset. Drives the centred "Watchlist" title sliding up out
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
// "Watchlist" title, and an edit slot.
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
// SEARCH — the first item of the trailing capsule, beside Edit, matching
// `HomeHeader` (user, 2026-11-18). Same destination (/catalog/search) the old
// floating magnifier FAB had.
//
// LAYOUT — both side slots are the SAME fixed width, sized to the wider side
// (`wishlistHeaderSideSlotWidth`), and the title takes the middle. Equal slots
// keep the title on the screen's true centre; sizing them to the wider side
// means neither control can ever run into it (see `styles.headerSlot`).
//
// SCROLL — the bubbles PIN, the title LEAVES, exactly as Home's bubbles pin
// while its search pill leaves (`HomeHeader`). Mounted `floating`, the bar is
// absolute chrome the list scrolls beneath; only the centred title travels up
// out of the row and clips away. The whole bar used to sit in normal flow above
// the list, which is the shape that takes the menu and the actions off screen
// with it — the regression `HomeHeader`'s own note exists to stop.
// Token render size + weight: 24pt render of iconoir's padded 24-viewBox shows
// the same ~20pt of ink the Figma toolbar's tight-cropped SF glyphs measure —
// see glassNavBubbleGlyphSize's doc for why 20 here would look small and thin.
const BUTTON_ICON_SIZE = glassNavBubbleGlyphSize;
const BUTTON_ICON_STROKE = glassNavBubbleGlyphStrokeWidth;
/**
 * 0 to match `HomeHeader`: every tab bar hangs its control row directly off the
 * safe-area inset, so the bubbles sit at the same height on every tab. (Figma's
 * toolbar node 3567:22969 shows 8pt above the row, but Home ships 0 — matching
 * the live app wins over the mock; an 8 here read as "the Wishlist bar is
 * lower".)
 */
const BAR_PADDING_TOP = 0;
/**
 * Height of the control row. Every control in this bar is 40 tall — the menu
 * bubble (`size="medium"`), the `GlassNavBubbleGroup`, and the `EditDoneButton`
 * that swaps in for it — so the shared bubble token IS the row height, and it
 * does not change when edit mode swaps the wider "Done" pill in. The title
 * (`titleSmall`, 22pt line) never sets it.
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

/**
 * Width of EACH side slot: the wider of the menu bubble (left) and the
 * search/edit capsule (right). Both slots take this width so the title sits on
 * the bar's true centre and stops short of whichever side is wider. The capsule
 * width is reserved in edit mode too (the Done pill is narrower), so the title
 * never jumps when Done swaps in.
 */
export function wishlistHeaderSideSlotWidth(actionCount: number): number {
  return Math.max(glassNavBubbleSizes.medium, glassNavBubbleGroupWidth(actionCount, 'medium'));
}

export function WishlistHeader({
  onOpenMenu,
  onOpenSearch,
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
  const sideSlot = { width: wishlistHeaderSideSlotWidth((onOpenSearch ? 1 : 0) + (onToggleEditMode ? 1 : 0)) };

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
      <View style={[styles.headerSlot, sideSlot]} testID={`${testID}-leading-slot`}>
        <GlassNavBubble
          accessibilityLabel="Open menu"
          material="frost"
          onPress={onOpenMenu}
          size="medium"
          surface="onLight"
          testID="wishlist-header-menu"
        >
          <Menu color={theme.colors.gray900} height={BUTTON_ICON_SIZE} strokeWidth={BUTTON_ICON_STROKE} width={BUTTON_ICON_SIZE} />
        </GlassNavBubble>
      </View>
      {/*
        The clip is on the TITLE'S OWN wrapper. It is what actually removes the
        label: the text translates up and this cuts it off, so it reads as
        sliding under the status bar rather than dissolving in place — and,
        crucially, a half-faded title never draws up beside the clock. Clipping
        any further up the row would shave the glass controls instead.

        Safe to clip tight to the text: `titleSmall`'s 22pt line box already
        contains the font's descenders, and "Watchlist" has none to lose anyway.
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
            // One step below the card header's titleMedium (user, 2026-11-18).
            variant="titleSmall"
          >
            WATCHLIST
          </AppText>
        </Animated.View>
      </View>
      <View style={[styles.headerSlot, styles.headerSlotRight, sideSlot]} testID={`${testID}-trailing-slot`}>
        {editMode ? (
          // Edit mode still hands the whole bar over to Done — browsing the
          // catalog mid-selection is not what edit mode is for.
          onToggleEditMode ? (
            <EditDoneButton onPress={onToggleEditMode} testID="wishlist-header-done" />
          ) : null
        ) : (
          /*
            Search / edit in ONE capsule — the SAME `GlassNavBubbleGroup`
            (medium, frost) the You/profile bar draws its search / edit / share
            in (`HomeHeader`), so the two tabs' trailing controls are one
            object: same 44pt capsule, same 36pt slots on a 20pt gap, same
            frosted material, same glyph size and weight. This used to be a
            `GlassButtonGroup` of ghost `IconButton`s, which was the same
            height but a 6pt gap and plain glass — "the wishlist icons don't
            match the profile ones".
          */
          <GlassNavBubbleGroup
            items={
              [
                // Search sits on the right with the other icons (user, 2026-11-18).
                ...(onOpenSearch
                  ? [
                      {
                        accessibilityLabel: 'Search the card catalog',
                        children: (
                          <Search
                            color={theme.colors.gray900}
                            height={BUTTON_ICON_SIZE}
                            strokeWidth={BUTTON_ICON_STROKE}
                            width={BUTTON_ICON_SIZE}
                          />
                        ),
                        onPress: onOpenSearch,
                        testID: 'wishlist-header-search',
                      },
                    ]
                  : []),
                ...(onToggleEditMode
                  ? [
                      {
                        accessibilityLabel: 'Edit watchlist',
                        children: (
                          <EditPencil
                            color={theme.colors.gray900}
                            height={BUTTON_ICON_SIZE}
                            strokeWidth={BUTTON_ICON_STROKE}
                            width={BUTTON_ICON_SIZE}
                          />
                        ),
                        onPress: onToggleEditMode,
                        testID: 'wishlist-header-edit',
                      },
                    ]
                  : []),
              ] satisfies GlassNavBubbleGroupItem[]
            }
            material="frost"
            size="medium"
            surface="onLight"
            testID="wishlist-header-actions"
          />
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
  // Fixed, EQUAL side slots (width set at render from the wider side), title in
  // the flexed middle. Equal-flex slots were tried and only split the leftover
  // width, so on a narrow phone the trailing capsule outgrew its half and ran
  // into the title (design review, 2026-11-16).
  headerSlot: {
    alignItems: 'center',
    flexDirection: 'row',
    flexShrink: 0,
    gap: 12,
  },
  headerSlotRight: {
    justifyContent: 'flex-end',
  },
  headerTitle: {
    textAlign: 'center',
  },
  // Takes the middle between the equal slots; `minWidth: 0` so a very narrow
  // screen truncates the title rather than pushing a slot out.
  headerTitleClip: {
    alignItems: 'center',
    flex: 1,
    minWidth: 0,
    overflow: 'hidden',
  },
});
