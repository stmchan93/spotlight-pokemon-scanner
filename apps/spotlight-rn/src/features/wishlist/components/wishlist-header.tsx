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
// the same chrome as Collection's floating corner bubbles (it replaced a
// gray/50 `IconButton` chip from Figma 1263:3328).
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
        surface="onLight"
        testID="wishlist-header-back"
      >
        <NavArrowLeft color={theme.colors.gray900} height={24} width={24} />
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
          surface="onLight"
          testID="wishlist-header-edit"
        >
          <EditPencil color={theme.colors.gray900} height={20} width={20} />
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
