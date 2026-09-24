import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { useSpotlightTheme } from '../theme';
import { AppText } from './app-text';

export type RankBadgeVariant = 'badge' | 'plain';

export type RankBadgeProps = {
  /** 1-based position. */
  rank: number;
  /**
   * `badge` — 22pt gray900 circle with a white number, laid over card art
   * (Hot on Ekalight tiles). `plain` — a 14pt-wide bold number column for
   * ranked list rows (Set spotlight top 10).
   */
  variant?: RankBadgeVariant;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

export function RankBadge({ rank, variant = 'badge', style, testID }: RankBadgeProps) {
  const theme = useSpotlightTheme();
  if (variant === 'plain') {
    return (
      <View style={[styles.plain, style]} testID={testID}>
        <AppText color="gray900" variant="priceCaption">
          {rank}
        </AppText>
      </View>
    );
  }
  return (
    <View
      accessibilityLabel={`Rank ${rank}`}
      style={[
        styles.badge,
        {
          backgroundColor: theme.colors.gray900,
          borderCurve: 'continuous',
          borderRadius: theme.radii.pill,
        },
        style,
      ]}
      testID={testID}
    >
      <AppText color="gray0" variant="chipLabel">
        {rank}
      </AppText>
    </View>
  );
}

const BADGE_SIZE = 22;

const styles = StyleSheet.create({
  badge: {
    alignItems: 'center',
    height: BADGE_SIZE,
    justifyContent: 'center',
    minWidth: BADGE_SIZE,
    paddingHorizontal: 4,
  },
  plain: {
    width: 14,
  },
});
