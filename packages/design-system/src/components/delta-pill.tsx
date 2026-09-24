import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { useSpotlightTheme } from '../theme';
import { AppText } from './app-text';

export type DeltaPillProps = {
  /** Preformatted signed change, e.g. "+18.4%" or "−4.1%". */
  label: string;
  /** Tint: `> 0` green, `< 0` red, `0`/null gray. */
  changePercent: number | null;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

/**
 * Arrow-less signed change chip on the Figma delta ramp (`deltaUp*` /
 * `deltaDown*`), as drawn on the meta feed mockups. Reach for `TrendPill` when
 * the design carries an arrow icon instead of a sign.
 */
export function DeltaPill({ label, changePercent, style, testID }: DeltaPillProps) {
  const theme = useSpotlightTheme();
  const palette =
    changePercent == null || changePercent === 0
      ? { bg: theme.colors.gray100, fg: theme.colors.gray700 }
      : changePercent > 0
        ? { bg: theme.colors.deltaUpSurface, fg: theme.colors.deltaUpText }
        : { bg: theme.colors.deltaDownSurface, fg: theme.colors.deltaDownText };
  return (
    <View
      style={[
        styles.pill,
        { backgroundColor: palette.bg, borderCurve: 'continuous', borderRadius: PILL_RADIUS },
        style,
      ]}
      testID={testID}
    >
      <AppText numberOfLines={1} style={{ color: palette.fg }} variant="chipLabel">
        {label}
      </AppText>
    </View>
  );
}

const PILL_RADIUS = 4;

const styles = StyleSheet.create({
  pill: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    flexDirection: 'row',
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
});
