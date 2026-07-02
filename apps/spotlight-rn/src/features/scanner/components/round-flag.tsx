import { Image, StyleSheet } from 'react-native';
import Svg, { Circle } from 'react-native-svg';

/**
 * Round language flag for the scan-target pill / sheet (Figma 2302:28968).
 * EN uses the round US-flag raster exported from the Figma node; JP is drawn
 * (a red disc on white — exact by construction, the design has no JP export).
 */
export function RoundFlag({ language, size = 13 }: { language: 'en' | 'jp'; size?: number }) {
  if (language === 'jp') {
    return (
      <Svg height={size} testID="round-flag-jp" viewBox="0 0 16 16" width={size}>
        <Circle cx={8} cy={8} fill="#FFFFFF" r={7.75} stroke="rgba(0,0,0,0.15)" strokeWidth={0.5} />
        {/* Official hinomaru red. */}
        <Circle cx={8} cy={8} fill="#BC002D" r={4.6} />
      </Svg>
    );
  }
  return (
    <Image
      accessibilityIgnoresInvertColors
      source={require('../../../../assets/flags/flag-us-round.png')}
      style={[styles.raster, { borderRadius: size / 2, height: size, width: size }]}
      testID="round-flag-en"
    />
  );
}

const styles = StyleSheet.create({
  raster: {
    // The export is already circular; the radius just guards against any
    // square-edge bleed at tiny sizes.
    overflow: 'hidden',
  },
});

export default RoundFlag;
