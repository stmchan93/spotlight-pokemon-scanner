import { StyleSheet, Text, View } from 'react-native';

import { fontFamilies, useSpotlightTheme } from '@spotlight/design-system';

type AuthWordmarkProps = {
  /** Optional override for the tagline under the wordmark. */
  tagline?: string;
  testID?: string;
};

/**
 * The EKALIGHT wordmark + tagline block shown on every auth screen (Figma
 * 1543:2170): Plus Jakarta ExtraBold 57 over a Regular 18 tagline, centered.
 */
export function AuthWordmark({
  tagline = 'Scan, Price, and Track your collection',
  testID,
}: AuthWordmarkProps) {
  const theme = useSpotlightTheme();

  return (
    <View style={styles.root} testID={testID}>
      <Text
        style={[styles.wordmark, { color: theme.colors.gray900 }]}
        testID="auth-brand-wordmark"
      >
        EKALIGHT
      </Text>
      <Text style={[styles.tagline, { color: theme.colors.gray900 }]}>
        {tagline}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    gap: 10,
    width: '100%',
  },
  tagline: {
    fontFamily: fontFamilies.bodyRegular,
    fontSize: 18,
    lineHeight: 24,
    textAlign: 'center',
  },
  wordmark: {
    fontFamily: fontFamilies.display,
    fontSize: 57,
    letterSpacing: -1,
    lineHeight: 64,
    textAlign: 'center',
  },
});
