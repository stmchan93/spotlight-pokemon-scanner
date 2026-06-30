import { Check } from 'iconoir-react-native';
import { StyleSheet, View } from 'react-native';

import { useSpotlightTheme } from '../theme';

export type SelectionCheckCircleProps = {
  /**
   * When true the circle fills with the saturated purple token and shows a
   * white check; when false it is an empty white circle with a subtle gray
   * border (Figma selection indicator).
   */
  selected: boolean;
  /**
   * Diameter of the circle in px. The check glyph and border scale from this.
   * Defaults to 24.
   */
  size?: number;
  testID?: string;
};

/**
 * A 24×24 circular selection indicator. UNSELECTED renders an empty white
 * circle with a 1.5px gray hairline; SELECTED renders a solid purple fill
 * (`colors.purple500`) with a centered white check. Prop-driven, no internal
 * state — drive `selected` from the owning row/tile.
 */
export function SelectionCheckCircle({
  selected,
  size = 24,
  testID,
}: SelectionCheckCircleProps) {
  const theme = useSpotlightTheme();

  return (
    <View
      style={[
        styles.circle,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: selected ? theme.colors.purple500 : theme.colors.gray0,
          borderWidth: selected ? 0 : 1.5,
          borderColor: selected ? 'transparent' : theme.colors.gray300,
        },
      ]}
      testID={testID}
    >
      {selected ? (
        <Check
          color={theme.colors.gray0}
          height={size * 0.62}
          testID={testID ? `${testID}-check` : undefined}
          width={size * 0.62}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  circle: {
    alignItems: 'center',
    justifyContent: 'center',
  },
});
