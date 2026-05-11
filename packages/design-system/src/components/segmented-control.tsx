import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useSpotlightTheme } from '../theme';

export type SegmentedControlItem<T extends string> = {
  label: string;
  value: T;
};

type SegmentedControlProps<T extends string> = {
  items: readonly SegmentedControlItem<T>[];
  onChange: (value: T) => void;
  size?: 'md' | 'lg' | 'scanner';
  testID?: string;
  tone?: 'default' | 'inverted';
  value: T;
};

const sizeMetrics = {
  lg: {
    containerPadding: 6,
    fontSize: undefined,
    minHeight: 50,
    paddingHorizontal: 22,
    paddingVertical: 10,
  },
  md: {
    containerPadding: 4,
    fontSize: undefined,
    minHeight: 34,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  scanner: {
    containerPadding: 2,
    fontSize: 13,
    minHeight: undefined,
    paddingHorizontal: 8,
    paddingVertical: 5,
  },
} as const;

export function SegmentedControl<T extends string>({
  items,
  onChange,
  size = 'md',
  testID,
  tone = 'default',
  value,
}: SegmentedControlProps<T>) {
  const theme = useSpotlightTheme();
  const metrics = sizeMetrics[size];
  const shell = tone === 'inverted'
    ? {
        backgroundColor: 'transparent' as const,
        borderColor: theme.colors.gray300,
        borderWidth: 0.5,
        containerBorderRadius: 12,
        segmentBorderRadius: 10,
        selectedBackgroundColor: theme.colors.gray0,
        selectedTextColor: theme.colors.gray900,
        textColor: theme.colors.gray900,
      }
    : {
        backgroundColor: theme.colors.surfaceMuted,
        borderColor: 'transparent' as const,
        borderWidth: 0,
        containerBorderRadius: 999,
        segmentBorderRadius: 999,
        selectedBackgroundColor: theme.colors.brand,
        selectedTextColor: theme.colors.textPrimary,
        textColor: theme.colors.textPrimary,
      };

  const labelStyle = size === 'scanner' ? theme.typography.label : theme.typography.control;

  return (
    <View
      style={[
        styles.container,
        {
          backgroundColor: shell.backgroundColor,
          borderColor: shell.borderColor,
          borderRadius: shell.containerBorderRadius,
          borderWidth: shell.borderWidth,
          padding: metrics.containerPadding,
        },
      ]}
      testID={testID}
    >
      {items.map((item) => {
        const selected = item.value === value;
        return (
          <Pressable
            key={item.value}
            accessibilityRole="button"
            onPress={() => onChange(item.value)}
            testID={testID ? `${testID}-${String(item.value).toLowerCase()}` : undefined}
            style={({ pressed }) => [
              styles.segment,
              {
                backgroundColor: selected ? shell.selectedBackgroundColor : 'transparent',
                borderRadius: shell.segmentBorderRadius,
                opacity: pressed ? 0.86 : 1,
                paddingHorizontal: metrics.paddingHorizontal,
                paddingVertical: metrics.paddingVertical,
                ...(metrics.minHeight != null ? { minHeight: metrics.minHeight } : {}),
              },
            ]}
          >
            <Text
              style={[
                labelStyle,
                {
                  color: selected ? shell.selectedTextColor : shell.textColor,
                  ...(metrics.fontSize != null ? { fontSize: metrics.fontSize } : {}),
                },
              ]}
            >
              {item.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    gap: 4,
  },
  segment: {
    alignItems: 'center',
    flex: 1,
    justifyContent: 'center',
  },
});
