import { NavArrowUp } from 'iconoir-react-native';
import { Pressable, StyleSheet, View } from 'react-native';

import { useSpotlightTheme } from '../theme';
import { AppText } from './app-text';

export type ListPaginationFooterProps = {
  /**
   * When true, renders the "View More" button. Hide it once every row is
   * already visible.
   */
  canViewMore: boolean;
  /** Reveal the next page of rows. */
  onViewMore: () => void;
  /**
   * Optional "Back to top" handler. When provided, renders the up-chevron
   * "Back to top" affordance below the View More button.
   */
  onBackToTop?: () => void;
  viewMoreLabel?: string;
  testID?: string;
};

/**
 * Footer shown beneath a long list view (Collection / Wishlist) per Figma
 * node 669-8499: a gray "View More" pill that reveals more rows, plus an
 * optional "Back to top" affordance.
 */
export function ListPaginationFooter({
  canViewMore,
  onViewMore,
  onBackToTop,
  viewMoreLabel = 'View More',
  testID = 'list-pagination-footer',
}: ListPaginationFooterProps) {
  const theme = useSpotlightTheme();

  if (!canViewMore && !onBackToTop) {
    return null;
  }

  return (
    <View style={styles.container} testID={testID}>
      {canViewMore ? (
        <Pressable
          accessibilityRole="button"
          onPress={onViewMore}
          style={({ pressed }) => [
            styles.viewMore,
            {
              backgroundColor: theme.colors.gray100,
              opacity: pressed ? 0.85 : 1,
            },
          ]}
          testID={`${testID}-view-more`}
        >
          <AppText color="gray800" variant="label">
            {viewMoreLabel}
          </AppText>
        </Pressable>
      ) : null}

      {onBackToTop ? (
        <Pressable
          accessibilityRole="button"
          hitSlop={8}
          onPress={onBackToTop}
          style={({ pressed }) => [styles.backToTop, { opacity: pressed ? 0.7 : 1 }]}
          testID={`${testID}-back-to-top`}
        >
          <NavArrowUp color={theme.colors.gray600} height={24} width={24} />
          <AppText color="gray600" variant="caption">
            Back to top
          </AppText>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  backToTop: {
    alignItems: 'center',
    flexDirection: 'column',
    justifyContent: 'center',
  },
  container: {
    alignItems: 'center',
    gap: 16,
    paddingVertical: 16,
  },
  viewMore: {
    alignItems: 'center',
    borderRadius: 8,
    justifyContent: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
});
