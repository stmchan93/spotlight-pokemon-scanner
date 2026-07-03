import Svg, { Circle, ClipPath, Defs, G, Rect } from 'react-native-svg';

/**
 * Round language flag for the scan-target pill / sheet (Figma 2302:28968).
 * BOTH flags are drawn with react-native-svg on purpose — the US flag was
 * originally a bundled PNG, and after an OTA the asset registry misresolved it
 * into other require()'d image slots (a stretched "horizontal American flag"
 * flashed in the TCGplayer-logo slot on card rows). Vector-drawn icons ship in
 * the JS bundle itself, so there is no asset table to get out of sync.
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
  // Simplified round US flag: alternating stripes + blue canton, clipped to a
  // circle. Stars are omitted — invisible at pill size (13px).
  const stripeHeight = 16 / 7;
  return (
    <Svg height={size} testID="round-flag-en" viewBox="0 0 16 16" width={size}>
      <Defs>
        <ClipPath id="round-flag-en-clip">
          <Circle cx={8} cy={8} r={7.75} />
        </ClipPath>
      </Defs>
      <G clipPath="url(#round-flag-en-clip)">
        <Rect fill="#FFFFFF" height={16} width={16} x={0} y={0} />
        {[0, 2, 4, 6].map((row) => (
          <Rect
            fill="#B22234"
            height={stripeHeight}
            key={row}
            width={16}
            x={0}
            y={row * stripeHeight}
          />
        ))}
        <Rect fill="#3C3B6E" height={6.9} width={8} x={0} y={0} />
      </G>
      <Circle cx={8} cy={8} fill="none" r={7.75} stroke="rgba(0,0,0,0.15)" strokeWidth={0.5} />
    </Svg>
  );
}

export default RoundFlag;
