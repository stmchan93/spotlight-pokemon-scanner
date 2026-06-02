import Svg, { G, Path } from 'react-native-svg';

type ViewToggleIconProps = {
  color?: string;
  size?: number;
  width?: number;
  height?: number;
};

const DEFAULT_SIZE = 16;

/**
 * List/table view glyph — Figma node 863:2257.
 * A bordered rectangle divided into three horizontal rows.
 */
export function ListViewIcon({
  color = '#A0A0A0',
  size = DEFAULT_SIZE,
  width,
  height,
}: ViewToggleIconProps) {
  return (
    <Svg
      fill="none"
      height={height ?? size}
      viewBox="0 0 16 16"
      width={width ?? size}
    >
      <G>
        <Path
          d="M2 8H5H8H11H14M2 8V11M2 8V5M14 8V11M14 8V5M2 11V13.6C2 13.8209 2.17909 14 2.4 14H5H8H11H13.6C13.8209 14 14 13.8209 14 13.6V11M2 11H5H8H11H14M2 5V2.4C2 2.17909 2.17909 2 2.4 2H5H8H11H13.6C13.8209 2 14 2.17909 14 2.4V5M2 5H5H8H11H14"
          stroke={color}
        />
      </G>
    </Svg>
  );
}

/**
 * Card/grid view glyph — Figma node 863:2249.
 * A bordered rectangle divided into a 2x2 grid of squares.
 */
export function GridViewIcon({
  color = '#A0A0A0',
  size = DEFAULT_SIZE,
  width,
  height,
}: ViewToggleIconProps) {
  return (
    <Svg
      fill="none"
      height={height ?? size}
      viewBox="0 0 16 16"
      width={width ?? size}
    >
      <G>
        <Path
          d="M14 2.4V8H8V2H13.6C13.8209 2 14 2.17909 14 2.4Z"
          stroke={color}
        />
        <Path
          d="M14 13.6V8H8V14H13.6C13.8209 14 14 13.8209 14 13.6Z"
          stroke={color}
        />
        <Path
          d="M2 8V2.4C2 2.17909 2.17909 2 2.4 2H8V8H2Z"
          stroke={color}
        />
        <Path
          d="M2 8V13.6C2 13.8209 2.17909 14 2.4 14H8V8H2Z"
          stroke={color}
        />
      </G>
    </Svg>
  );
}
