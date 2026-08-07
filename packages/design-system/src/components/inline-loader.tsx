import { ActivityIndicator, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { useSpotlightTheme } from '../theme';
import { Text } from './scaled-text';

type InlineLoaderProps = {
  label?: string;
  size?: 'small' | 'large';
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

/**
 * Chromeless "still fetching" marker: a spinner over one line of secondary copy,
 * with no card, border, or fill behind it. Use this for transient in-place loads
 * (a tab's list, a section that will be replaced by content) — a bordered
 * `StateCard` reads as a permanent result and is reserved for empty/error states
 * the user has to act on.
 */
export function InlineLoader({ label, size = 'small', style, testID }: InlineLoaderProps) {
  const theme = useSpotlightTheme();

  return (
    <View style={[styles.root, style]} testID={testID}>
      <ActivityIndicator color={theme.colors.textSecondary} size={size} />
      {label ? (
        <Text style={[theme.typography.body, styles.label, { color: theme.colors.gray600 }]}>
          {label}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  label: {
    textAlign: 'center',
  },
  root: {
    alignItems: 'center',
    gap: 10,
    justifyContent: 'center',
    paddingVertical: 32,
  },
});
