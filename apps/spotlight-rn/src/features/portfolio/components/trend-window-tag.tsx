import { Pressable, StyleSheet } from 'react-native';

import { AppText, useSpotlightTheme } from '@spotlight/design-system';

import { useTrendWindow } from '@/features/portfolio/hooks/use-trend-window';

type TrendWindowTagProps = {
  testID?: string;
};

/**
 * Small pill toggle scoping every row/tile trend percent: `SINCE ADDED ▾` ⇄
 * `30D ▾`. One tap cycles between the two windows; the choice is persisted and
 * shared by the Collection and Wishlist screens (both view modes) via
 * `useTrendWindow`. Quiet gray micro/overline treatment matching the portfolio
 * chart's range chips — it reads as a scope label, not a primary control.
 */
export function TrendWindowTag({ testID = 'trend-window-tag' }: TrendWindowTagProps) {
  const theme = useSpotlightTheme();
  const { trendWindow, toggleTrendWindow } = useTrendWindow();

  const label = trendWindow === '30d' ? '30D ▾' : 'SINCE ADDED ▾';

  return (
    <Pressable
      accessibilityLabel={
        trendWindow === '30d'
          ? 'Trend window: last 30 days. Switch to since added.'
          : 'Trend window: since added. Switch to last 30 days.'
      }
      accessibilityRole="button"
      hitSlop={8}
      onPress={toggleTrendWindow}
      style={({ pressed }) => [
        styles.pill,
        { backgroundColor: theme.colors.gray100 },
        pressed ? { opacity: 0.7 } : null,
      ]}
      testID={testID}
    >
      <AppText color="gray700" variant="micro">
        {label}
      </AppText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  pill: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    borderRadius: 6,
    flexDirection: 'row',
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
});
