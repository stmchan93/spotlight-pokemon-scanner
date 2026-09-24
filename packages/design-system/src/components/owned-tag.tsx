import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { useSpotlightTheme } from '../theme';
import { AppText } from './app-text';

export type OwnedTagProps = {
  /** "You own 4" / "In your collection". */
  label: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

/**
 * Pale-purple pill that marks something the viewer owns (meta feed v2
 * mockups): `purple50` fill, `brandStrong` 11/800 label, 20pt tall.
 */
export function OwnedTag({ label, style, testID }: OwnedTagProps) {
  const theme = useSpotlightTheme();
  return (
    <View
      style={[
        styles.tag,
        { backgroundColor: theme.colors.purple50, borderCurve: 'continuous', borderRadius: theme.radii.pill },
        style,
      ]}
      testID={testID}
    >
      <AppText color="brandStrong" numberOfLines={1} variant="feedTag">
        {label}
      </AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  tag: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    flexShrink: 0,
    height: 20,
    justifyContent: 'center',
    paddingHorizontal: 7,
  },
});
