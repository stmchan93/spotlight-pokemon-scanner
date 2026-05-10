import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useSpotlightTheme } from '../theme';

export type PageTab<V extends string> = {
  value: V;
  label: string;
};

export type PageTabsProps<V extends string> = {
  tabs: ReadonlyArray<PageTab<V>>;
  value: V;
  onChange: (value: V) => void;
  testID?: string;
};

export function PageTabs<V extends string>({
  tabs,
  value,
  onChange,
  testID,
}: PageTabsProps<V>) {
  const theme = useSpotlightTheme();

  return (
    <View style={styles.container} testID={testID}>
      {tabs.map((tab) => {
        const selected = tab.value === value;
        return (
          <Pressable
            key={tab.value}
            accessibilityRole="button"
            accessibilityState={{ selected }}
            onPress={() => onChange(tab.value)}
            style={({ pressed }) => [
              styles.tab,
              { opacity: pressed ? 0.7 : 1 },
            ]}
            testID={testID ? `${testID}-tab-${tab.value}` : undefined}
          >
            <Text
              style={[
                theme.typography.headline,
                styles.label,
                {
                  color: selected ? theme.colors.textPrimary : theme.colors.textSecondary,
                },
              ]}
            >
              {tab.label}
            </Text>
            <View
              style={[
                styles.underline,
                {
                  backgroundColor: selected ? theme.colors.textPrimary : 'transparent',
                },
              ]}
            />
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'stretch',
    backgroundColor: 'transparent',
  },
  tab: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'flex-end',
    paddingVertical: 8,
  },
  label: {
    textAlign: 'center',
    marginBottom: 8,
  },
  underline: {
    height: 2,
    alignSelf: 'stretch',
  },
});
