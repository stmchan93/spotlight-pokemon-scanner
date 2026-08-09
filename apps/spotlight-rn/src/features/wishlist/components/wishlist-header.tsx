import { EditPencil, NavArrowLeft } from 'iconoir-react-native';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppText, GlassNavBubble, useSpotlightTheme } from '@spotlight/design-system';

import { EditDoneButton } from '@/components/edit-done-button';

type WishlistHeaderProps = {
  onBack: () => void;
  /** When true the bar shows a "Done" action instead of the edit pencil. */
  editMode?: boolean;
  /** Enables the edit-mode toggle in the right slot. */
  onToggleEditMode?: () => void;
  testID?: string;
};

// Lean top bar for the Wishlist screen: a circular back button, centred
// "Wishlist" title, and an edit slot. Wishlist is reached by pushing in from the
// drawer, so it carries a back button rather than the hamburger (that lives on
// the root Collection screen).
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
const BUTTON_ICON_SIZE = 20;
export function WishlistHeader({
  onBack,
  editMode = false,
  onToggleEditMode,
  testID = 'wishlist-header',
}: WishlistHeaderProps) {
  const theme = useSpotlightTheme();
  const insets = useSafeAreaInsets();

  return (
    <View style={[styles.header, { paddingTop: insets.top + 8 }]} testID={testID}>
      <GlassNavBubble
        accessibilityLabel="Back"
        onPress={onBack}
        size="compact"
        surface="onLight"
        testID="wishlist-header-back"
      >
        {/* 20, not 24 — a 24pt glyph in a 36pt circle leaves a 6pt ring and
            reads as a chevron in a box. 20 is what the Home bar's glyphs use. */}
        <NavArrowLeft color={theme.colors.gray900} height={BUTTON_ICON_SIZE} width={BUTTON_ICON_SIZE} />
      </GlassNavBubble>
      <AppText
        color="textPrimary"
        numberOfLines={1}
        style={styles.headerTitle}
        testID="wishlist-header-title"
        variant="titleMedium"
      >
        Wishlist
      </AppText>
      {onToggleEditMode && editMode ? (
        <EditDoneButton onPress={onToggleEditMode} testID="wishlist-header-done" />
      ) : onToggleEditMode ? (
        <GlassNavBubble
          accessibilityLabel="Edit wishlist"
          onPress={onToggleEditMode}
          size="compact"
          surface="onLight"
          testID="wishlist-header-edit"
        >
          <EditPencil color={theme.colors.gray900} height={BUTTON_ICON_SIZE} width={BUTTON_ICON_SIZE} />
        </GlassNavBubble>
      ) : null}
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
  headerTitle: {
    flex: 1,
    textAlign: 'center',
  },
});
