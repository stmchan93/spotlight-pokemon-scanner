import { EditPencil, Menu, Plus, ShareIos } from 'iconoir-react-native';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  AppText,
  GlassButtonGroup,
  GlassNavBubble,
  IconButton,
  glassButtonGroupControlSize,
  useSpotlightTheme,
} from '@spotlight/design-system';

import { EditDoneButton } from '@/components/edit-done-button';

type WishlistHeaderProps = {
  /** Opens the app drawer. Wishlist is a TAB, so there is nothing to go back to. */
  onOpenMenu: () => void;
  /** Opens the card catalog search. Omit to leave the search slot empty. */
  onOpenSearch?: () => void;
  /** When true the bar shows a "Done" action instead of the edit pencil. */
  editMode?: boolean;
  /** Enables the edit-mode toggle in the right slot. */
  onToggleEditMode?: () => void;
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
const BUTTON_ICON_SIZE = 20;
export function WishlistHeader({
  onOpenMenu,
  onOpenSearch,
  editMode = false,
  onToggleEditMode,
  testID = 'wishlist-header',
}: WishlistHeaderProps) {
  const theme = useSpotlightTheme();
  const insets = useSafeAreaInsets();

  return (
    <View style={[styles.header, { paddingTop: insets.top + 8 }]} testID={testID}>
      <View style={styles.headerSlot}>
        <GlassNavBubble
          accessibilityLabel="Open menu"
          onPress={onOpenMenu}
          size="compact"
          surface="onLight"
          testID="wishlist-header-menu"
        >
          <Menu color={theme.colors.gray900} height={BUTTON_ICON_SIZE} width={BUTTON_ICON_SIZE} />
        </GlassNavBubble>
      </View>
      <AppText
        color="textPrimary"
        numberOfLines={1}
        style={styles.headerTitle}
        testID="wishlist-header-title"
        variant="titleMedium"
      >
        Wishlist
      </AppText>
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
                <Plus color={theme.colors.gray900} height={BUTTON_ICON_SIZE} width={BUTTON_ICON_SIZE} />
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
                <EditPencil color={theme.colors.gray900} height={BUTTON_ICON_SIZE} width={BUTTON_ICON_SIZE} />
              </IconButton>
            ) : null}
            {/*
              SHARE IS A PLACEHOLDER AND DOES NOTHING, on purpose.

              Your wishlist is private: the public profile has Collection / For
              Sale / Activity and no Wishlist tab, so there is no URL to share.
              The options are a public wishlist tab (a feature, not a button),
              a text export, or a rendered image — none of them decided yet.

              It is here because it was asked for, ahead of that decision. When
              the decision lands, give `onShare` a body; until then the handler
              is deliberately empty rather than firing something arbitrary.
            */}
            <IconButton
              accessibilityLabel="Share wishlist"
              onPress={() => {}}
              shape="circle"
              size={glassButtonGroupControlSize}
              testID="wishlist-header-share"
              variant="ghost"
            >
              <ShareIos color={theme.colors.gray900} height={BUTTON_ICON_SIZE} width={BUTTON_ICON_SIZE} />
            </IconButton>
          </GlassButtonGroup>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
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
});
