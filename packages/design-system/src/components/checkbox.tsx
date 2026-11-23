import { Check } from 'iconoir-react-native';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { shadows } from '../tokens';
import { useSpotlightTheme } from '../theme';

export type CheckboxProps = {
  checked: boolean;
  /** Box edge in pt. Defaults to 20. */
  size?: number;
  /**
   * `plain` sits on a flat surface. `overlay` sits on imagery (card art): a
   * white ring plus a soft halo keep it legible on any art.
   */
  tone?: 'plain' | 'overlay';
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
  /** Root id; the check glyph is `${testID}-check`. */
  testID?: string;
};

/**
 * Square checkbox indicator (display only, no press handling). CHECKED is a
 * solid `brandStrong` fill — the primary-Button purple — with a white check;
 * UNCHECKED is a white box with a gray-300 border.
 */
export function Checkbox({
  checked,
  size = 20,
  tone = 'plain',
  accessibilityLabel,
  style,
  testID,
}: CheckboxProps) {
  const theme = useSpotlightTheme();
  const overlay = tone === 'overlay';
  const fill = checked ? theme.colors.brandStrong : theme.colors.gray0;
  const borderColor = overlay ? theme.colors.gray0 : checked ? theme.colors.brandStrong : theme.colors.gray300;
  const glyph = Math.round(size * 0.7);

  return (
    <View
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="checkbox"
      accessibilityState={{ checked }}
      accessible
      style={[
        styles.box,
        overlay ? shadows.halo : null,
        {
          backgroundColor: fill,
          borderColor,
          borderCurve: 'continuous',
          borderRadius: Math.round(size * 0.25),
          borderWidth: overlay ? 1.5 : checked ? 0 : 1.5,
          height: size,
          width: size,
        },
        style,
      ]}
      testID={testID}
    >
      {checked ? (
        <Check
          color={theme.colors.gray0}
          height={glyph}
          strokeWidth={2.5}
          testID={testID ? `${testID}-check` : undefined}
          width={glyph}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    alignItems: 'center',
    justifyContent: 'center',
  },
});
