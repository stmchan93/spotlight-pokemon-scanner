import Svg, { G, Path } from 'react-native-svg';

type NavTabIconProps = {
  color?: string;
  size?: number;
  /** Selected state — renders the solid/filled glyph (Collection, Events). */
  filled?: boolean;
};

const DEFAULT_SIZE = 16;
const DEFAULT_COLOR = '#1A1A1A';

// 2x2 rounded-square grid — Figma nav "Collection" (nodes 662:4021 / 662:4598).
// Outline = four stroked squares; selected = the same squares filled.
const COLLECTION_SQUARES = [
  'M9.33335 13.6V9.73333C9.33335 9.5124 9.51242 9.33333 9.73335 9.33333H13.6C13.8209 9.33333 14 9.5124 14 9.73333V13.6C14 13.8209 13.8209 14 13.6 14H9.73335C9.51242 14 9.33335 13.8209 9.33335 13.6Z',
  'M2 13.6V9.73333C2 9.5124 2.17909 9.33333 2.4 9.33333H6.26667C6.48758 9.33333 6.66667 9.5124 6.66667 9.73333V13.6C6.66667 13.8209 6.48758 14 6.26667 14H2.4C2.17909 14 2 13.8209 2 13.6Z',
  'M9.33335 6.26667V2.4C9.33335 2.17909 9.51242 2 9.73335 2H13.6C13.8209 2 14 2.17909 14 2.4V6.26667C14 6.48758 13.8209 6.66667 13.6 6.66667H9.73335C9.51242 6.66667 9.33335 6.48758 9.33335 6.26667Z',
  'M2 6.26667V2.4C2 2.17909 2.17909 2 2.4 2H6.26667C6.48758 2 6.66667 2.17909 6.66667 2.4V6.26667C6.66667 6.48758 6.48758 6.66667 6.26667 6.66667H2.4C2.17909 6.66667 2 6.48758 2 6.26667Z',
];

export function CollectionTabIcon({
  color = DEFAULT_COLOR,
  size = DEFAULT_SIZE,
  filled = false,
}: NavTabIconProps) {
  return (
    <Svg fill="none" height={size} viewBox="0 0 16 16" width={size}>
      <G>
        {COLLECTION_SQUARES.map((d) => (
          <Path d={d} fill={filled ? color : 'none'} key={d} stroke={color} />
        ))}
      </G>
    </Svg>
  );
}

// Bookmark banner — nav "Wishlist" (matches the drawer's iconoir Bookmark).
// Outline = stroked banner; selected = the same banner filled.
const WISHLIST_BOOKMARK =
  'M4 13.6V3.2C4 2.53726 4.53726 2 5.2 2H10.8C11.4627 2 12 2.53726 12 3.2V13.6L8 10.9333L4 13.6Z';

export function WishlistTabIcon({
  color = DEFAULT_COLOR,
  size = DEFAULT_SIZE,
  filled = false,
}: NavTabIconProps) {
  return (
    <Svg fill="none" height={size} viewBox="0 0 16 16" width={size}>
      <G>
        <Path
          d={WISHLIST_BOOKMARK}
          fill={filled ? color : 'none'}
          stroke={color}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </G>
    </Svg>
  );
}

// Barcode-style scan glyph — Figma nav "Scan" (node 629:6650). The design uses
// the same glyph whether selected or not, so `filled` is intentionally ignored.
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
