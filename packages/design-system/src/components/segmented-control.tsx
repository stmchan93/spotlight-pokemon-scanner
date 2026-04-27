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
    minHeight: 50,
    paddingHorizontal: 22,
    paddingVertical: 10,
  },
  md: {
    containerPadding: 4,
    minHeight: 34,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  scanner: {
    containerPadding: 4,
    minHeight: 48,
    paddingHorizontal: 22,
    paddingVertical: 9,
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
  const shellColors = tone === 'inverted'
    ? {
        backgroundColor: theme.colors.scannerTray,
        selectedBackgroundColor: theme.colors.brand,
        selectedTextColor: theme.colors.textInverse,
        textColor: theme.colors.scannerTextPrimary,
      }
    : {
        backgroundColor: theme.colors.surfaceMuted,
        selectedBackgroundColor: theme.colors.brand,
        selectedTextColor: theme.colors.textPrimary,
        textColor: theme.colors.textPrimary,
      };

  return (
    <View
      style={[
        styles.container,
        {
          backgroundColor: shellColors.backgroundColor,
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
                backgroundColor: selected ? shellColors.selectedBackgroundColor : 'transparent',
                minHeight: metrics.minHeight,
                opacity: pressed ? 0.86 : 1,
                paddingHorizontal: metrics.paddingHorizontal,
                paddingVertical: metrics.paddingVertical,
              },
            ]}
          >
            <Text
              style={[
                theme.typography.control,
                {
                  color: selected ? shellColors.selectedTextColor : shellColors.textColor,
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
    borderRadius: 999,
    flexDirection: 'row',
    gap: 4,
  },
  segment: {
    alignItems: 'center',
    borderRadius: 999,
    flex: 1,
    justifyContent: 'center',
  },
});
