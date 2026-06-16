import { StyleSheet, Text, View } from 'react-native';

import { fontFamilies, useSpotlightTheme } from '@spotlight/design-system';

type AuthWordmarkProps = {
  /** Tagline under the wordmark; pass null to show the wordmark on its own. */
  tagline?: string | null;
  testID?: string;
};

/**
 * The EKALIGHT wordmark + optional tagline shown on the auth screens (Figma
 * 1481:4380): Plus Jakarta ExtraBold 57 in white over a Regular 18 tagline,
 * left-aligned against the black wave background.
 */
export function AuthWordmark({
  tagline = 'Scan, Price, and Track your collection',
  testID,
}: AuthWordmarkProps) {
  const theme = useSpotlightTheme();

  return (
    <View style={styles.root} testID={testID}>
      <Text
        style={[styles.wordmark, { color: theme.colors.gray0 }]}
        testID="auth-brand-wordmark"
      >
        EKALIGHT
      </Text>
      {tagline ? (
        <Text style={[styles.tagline, { color: theme.colors.gray400 }]}>
          {tagline}
        </Text>
      ) : null}
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
    textAlign: 'left',
  },
  wordmark: {
    fontFamily: fontFamilies.display,
    fontSize: 57,
    letterSpacing: -1,
    lineHeight: 64,
    textAlign: 'left',
  },
});
