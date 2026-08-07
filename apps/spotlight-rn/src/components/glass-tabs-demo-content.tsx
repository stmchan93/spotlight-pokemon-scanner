import { ScrollView, StyleSheet, View } from 'react-native';

import { Text, useSpotlightTheme } from '@spotlight/design-system';

/**
 * THROWAWAY SPIKE — delete with the rest of `glass-tabs-demo/`.
 *
 * Deliberately long and colourful. Both things we're evaluating only show up
 * against moving content: Liquid Glass refracts whatever passes UNDER the bar
 * (a flat grey page would look identical to today's solid bar), and
 * `minimizeBehavior` needs real scroll to fire. Hence saturated bands rather
 * than lorem text.
 *
 * Lives in src/components/, NOT in src/app/: every file under the app directory
 * is a route, so parking it beside the layout would mount it as a fourth tab.
 */
export function DemoContent({ title }: { title: string }) {
  const theme = useSpotlightTheme();

  // Vivid, high-contrast bands so refraction through the glass is obvious.
  const bands = ['#1A6FE8', '#A54BFA', '#E8471A', '#12B76A', '#F5A623', '#1A1A1A'];

  return (
    <ScrollView
      contentContainerStyle={styles.content}
      contentInsetAdjustmentBehavior="automatic"
      style={{ backgroundColor: theme.colors.gray0 }}
      testID={`glass-tabs-demo-${title.toLowerCase()}`}
    >
      <Text style={[theme.typography.titleMedium, { color: theme.colors.gray900 }]}>{title}</Text>
      <Text style={[theme.typography.body, { color: theme.colors.gray600 }]}>
        Scroll down: the bar should shrink to the active icon, then come back when you scroll up.
        On iOS 26 these colours should bend through the bar rather than sit behind a flat blur.
      </Text>

      {Array.from({ length: 12 }, (_, index) => (
        <View
          key={index}
          style={[styles.band, { backgroundColor: bands[index % bands.length] }]}
        >
          <Text style={[theme.typography.bodyStrong, { color: '#FFFFFF' }]}>Row {index + 1}</Text>
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  band: {
    alignItems: 'center',
    borderRadius: 12,
    height: 96,
    justifyContent: 'center',
  },
  content: {
    gap: 12,
    padding: 16,
    paddingBottom: 160,
  },
});
