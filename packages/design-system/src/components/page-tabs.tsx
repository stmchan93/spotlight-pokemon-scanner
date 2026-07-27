import { Pressable, StyleSheet, View } from 'react-native';

import { Text } from './scaled-text';
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
                theme.typography.bodyMedium,
                styles.label,
                {
                  // Active tab is medium/gray-900; inactive stays regular-weight
                  // gray-600 (Figma 3184-17337).
                  fontFamily: selected
                    ? theme.typography.bodyMedium.fontFamily
                    : theme.typography.body.fontFamily,
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
  // Centered row with wide gaps and content-width tabs (Figma 3184-17337), rather
  // than full-width flex:1 tabs. The underline hugs the label width.
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 40,
    backgroundColor: 'transparent',
  },
  tab: {
    alignItems: 'center',
    justifyContent: 'flex-end',
    paddingVertical: 4,
  },
  label: {
    textAlign: 'center',
    marginBottom: 6,
  },
  underline: {
    height: 2,
    alignSelf: 'stretch',
  },
});
