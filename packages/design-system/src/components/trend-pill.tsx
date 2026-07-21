import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { ArrowUp, ArrowDown, Minus, Plus } from 'iconoir-react-native';

import { Text } from './scaled-text';
import { useSpotlightTheme } from '../theme';

export type TrendPillDirection = 'up' | 'down' | 'flat' | 'plus';
export type TrendPillTone = 'positive' | 'negative' | 'neutral';
export type TrendPillSize = 'sm' | 'md';

type TrendPillProps = {
  /** Visual direction — drives which arrow icon renders. */
  direction: TrendPillDirection;
  /** Color tone. Defaults to inferring positive=up / negative=down / neutral=flat. */
  tone?: TrendPillTone;
  /** Label text — can be percent ("28%") or dollar ("$403.99") or absolute ("+18 this month"). */
  label: string;
  /** Visual size. 'sm' for inline tile usage, 'md' for stat cards. */
  size?: TrendPillSize;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

function inferTone(direction: TrendPillDirection): TrendPillTone {
  if (direction === 'up' || direction === 'plus') return 'positive';
  if (direction === 'down') return 'negative';
  return 'neutral';
}

export function TrendPill({
  direction,
  tone,
  label,
  size = 'sm',
  style,
  testID,
}: TrendPillProps) {
  const theme = useSpotlightTheme();
  const resolvedTone = tone ?? inferTone(direction);

  const palette = {
    positive: {
      bg: theme.colors.green100,
      fg: theme.colors.green400,
    },
    negative: {
      bg: theme.colors.red100,
      fg: theme.colors.red400,
    },
    neutral: {
      bg: theme.colors.gray100,
      fg: theme.colors.gray600,
    },
  }[resolvedTone];

  const sizeStyle = size === 'md' ? styles.containerMd : styles.containerSm;
  const labelStyle = size === 'md' ? styles.labelMd : styles.labelSm;
  const iconSize = size === 'md' ? 12 : 10;

  const Icon =
    direction === 'up' ? ArrowUp
      : direction === 'down' ? ArrowDown
        : direction === 'plus' ? Plus
          : Minus;

  return (
    <View
      accessibilityRole="text"
      style={[styles.container, sizeStyle, { backgroundColor: palette.bg }, style]}
      testID={testID}
    >
      <Icon color={palette.fg} height={iconSize} width={iconSize} strokeWidth={2} />
      <Text style={[labelStyle, { color: palette.fg }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    borderRadius: 4,
    flexDirection: 'row',
    gap: 2,
  },
  containerSm: {
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  containerMd: {
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  labelSm: {
    fontFamily: 'SpotlightBodySemiBold',
    fontSize: 11,
    lineHeight: 14,
  },
  labelMd: {
    fontFamily: 'SpotlightBodySemiBold',
    fontSize: 13,
    lineHeight: 16,
  },
});
