import Svg, { G, Path } from 'react-native-svg';

/*
  Only the Scan glyph survives here. Collection and Wishlist went with
  `app-bottom-tab-bar` / `nav-tab-symbols` when the JS tab bar was deleted — the
  bottom bar is Apple's now and draws its own SF Symbols. This one is still
  rendered by the empty-collection "Scan to add" chip in `portfolio-screen`.
*/
type NavTabIconProps = {
  color?: string;
  size?: number;
};

const DEFAULT_SIZE = 16;
const DEFAULT_COLOR = '#1A1A1A';

// Barcode-style scan glyph — Figma nav "Scan" (node 629:6650). The design uses
// the same glyph whether selected or not.
const SCAN_STROKES = [
  'M6.66665 8V4H7.33332',
  'M6.66665 8H7.33332V4',
  'M6.66665 12V10H7.33332',
  'M7.33332 10V12H6.66665',
  'M4.66665 4V8',
  'M4.66665 10V12',
  'M9.33335 4V8',
  'M9.33335 10V12',
  'M11.3333 4V8',
  'M11.3333 10V12',
  'M4 2H2V4',
  'M1.33335 8H8.00002H14.6667',
  'M12 2H14V4',
  'M4 14H2V12',
  'M12 14H14V12',
];

export function ScanTabIcon({ color = DEFAULT_COLOR, size = DEFAULT_SIZE }: NavTabIconProps) {
  return (
    <Svg fill="none" height={size} viewBox="0 0 16 16" width={size}>
      <G>
        {SCAN_STROKES.map((d) => (
          <Path d={d} key={d} stroke={color} strokeLinecap="round" strokeLinejoin="round" />
        ))}
      </G>
    </Svg>
  );
}
