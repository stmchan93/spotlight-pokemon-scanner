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
    <View style={styles.root} testID={testID}>
      {/* Full-bleed rail behind the tabs. The selected tab's 2px underline sits
          on the same baseline and paints over it. */}
      <View
        style={[
          styles.rail,
          {
            backgroundColor: theme.colors.gray200,
            height: theme.borderWidths.containerRule,
          },
        ]}
        testID={testID ? `${testID}-rail` : undefined}
      />
      <View style={styles.container}>
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
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    width: '100%',
  },
  // The gray rail runs the full width of the bar, edge to edge — it is not
  // inset by the page gutter, so it reads as one rule under all three tabs.
  rail: {
    bottom: 0,
    left: 0,
    position: 'absolute',
    right: 0,
  },
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
    // Bottom-padding-free: the 2px underline IS the tab's bottom edge (Figma
    // 3147:10092 puts it at y26 of a 28px tab), so it lands on the rail.
    paddingTop: 4,
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
