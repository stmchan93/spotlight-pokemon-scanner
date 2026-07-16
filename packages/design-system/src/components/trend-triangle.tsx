import Svg, { Polygon } from 'react-native-svg';

export type TrendTriangleProps = {
  /** 'up' points the filled triangle up; 'down' points it down. */
  direction: 'up' | 'down';
  color: string;
  /** Rendered width/height in points. Defaults to 10. */
  size?: number;
  testID?: string;
};

/**
 * The app's shared FILLED trend triangle (▲/▼) — used by the portfolio
 * balance header, the PDP position line, and the card-grid tiles so every
 * up/down indicator is the same glyph. SVG (not a text glyph) so sizing and
 * color are exact and free of font baseline quirks.
 */
export function TrendTriangle({ direction, color, size = 10, testID }: TrendTriangleProps) {
  const points = direction === 'up' ? '5,1 9.5,9 0.5,9' : '5,9 9.5,1 0.5,1';
  return (
    <Svg height={size} testID={testID} viewBox="0 0 10 10" width={size}>
      <Polygon fill={color} points={points} />
    </Svg>
  );
}
