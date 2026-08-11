import { render, screen } from '@testing-library/react-native';
import { processColor } from 'react-native';

import { EkalightWordmark, SpotlightThemeProvider, colors } from '@spotlight/design-system';

function renderWordmark(node: React.ReactElement) {
  return render(<SpotlightThemeProvider>{node}</SpotlightThemeProvider>);
}

// react-native-svg normalizes a fill string into `{ payload: <int color> }`, so
// compare against the same processColor() output rather than the raw hex.
function fillsOf(testID: string) {
  return screen
    .getByTestId(testID)
    .findAllByType('RNSVGPath')
    .map((path: { props: { fill?: { payload?: number } } }) => path.props.fill?.payload);
}

describe('EkalightWordmark', () => {
  // The whole point of the Figma lockup (3686:58352) is that it ships in brand
  // purple — a black/inherited fill reads as the old plain-text header.
  it('fills every glyph with brand purple by default', () => {
    renderWordmark(<EkalightWordmark testID="wordmark" />);

    const fills = fillsOf('wordmark');
    // 2 mark paths + 8 letterform paths.
    expect(fills).toHaveLength(10);
    expect(new Set(fills)).toEqual(new Set([processColor(colors.purple500)]));
  });

  it('recolors every glyph when a color is supplied', () => {
    renderWordmark(<EkalightWordmark color={colors.gray0} testID="wordmark" />);

    expect(new Set(fillsOf('wordmark'))).toEqual(new Set([processColor(colors.gray0)]));
  });

  it('keeps the 104.726:32 aspect ratio when resized', () => {
    renderWordmark(<EkalightWordmark height={16} testID="wordmark" />);

    const svg = screen.getByTestId('wordmark');

    expect(svg.props.height).toBe(16);
    expect(svg.props.width).toBeCloseTo(52.363, 3);
  });
});
