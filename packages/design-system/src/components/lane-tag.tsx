import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { useSpotlightTheme } from '../theme';
import { AppText } from './app-text';

export type LaneTagLane = 'raw' | 'graded';

export type LaneTagProps = {
  /** `graded` = dark fill, white label; `raw` = gray100 fill, gray700 label. */
  lane: LaneTagLane;
  /** Overrides the default "RAW" / "GRADED" label (e.g. "PSA 10"). */
  label?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

/**
 * Small uppercase RAW / GRADED marker that sits after a group or card name,
 * so a raw price move is never read as a slab move (meta feed mockups).
 */
export function LaneTag({ lane, label, style, testID }: LaneTagProps) {
  const theme = useSpotlightTheme();
  const graded = lane === 'graded';
  return (
    <View
      accessibilityLabel={label ?? (graded ? 'Graded' : 'Raw')}
      style={[
        styles.tag,
        {
          backgroundColor: graded ? theme.colors.gray900 : theme.colors.gray100,
          borderCurve: 'continuous',
          borderRadius: TAG_RADIUS,
        },
        style,
      ]}
      testID={testID}
    >
      <AppText
        numberOfLines={1}
        style={{ color: graded ? theme.colors.gray0 : theme.colors.gray700 }}
        variant="tag"
      >
        {label ?? (graded ? 'GRADED' : 'RAW')}
      </AppText>
    </View>
  );
}

const TAG_RADIUS = 4;

const styles = StyleSheet.create({
  tag: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    height: 18,
    justifyContent: 'center',
    paddingHorizontal: 6,
  },
});
