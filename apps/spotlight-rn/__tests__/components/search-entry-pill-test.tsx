import { StyleSheet } from 'react-native';
import { screen } from '@testing-library/react-native';

import { SearchEntryPill, colors, radii } from '@spotlight/design-system';

import { renderWithProviders } from '../test-utils';

/**
 * The top-bar search entry, against Figma "Toolbar - Top - iPhone" 3567:22978.
 *
 * THIS FILE EXISTS BECAUSE THE PILL SILENTLY DRIFTED FROM ITS FRAME, and the
 * drift is what made testers report search as "hard to find". The frame defines
 * the pill's edge with a SHADOW and no stroke; it shipped with a 0.5pt
 * near-white hairline and no shadow — 1.23:1 against the white bar it sits on,
 * with a 1.07:1 fill. Nothing described the shape.
 *
 * Nothing anywhere else pins this component's appearance: `home-header-test`
 * asserts only the pill's WIDTH arithmetic and its scroll motion, and queries it
 * by testID rather than by look. So a colour or border change could — and did —
 * pass every existing test.
 */
describe('SearchEntryPill', () => {
  function pill() {
    return StyleSheet.flatten(screen.getByTestId('pill').props.style) as Record<string, unknown>;
  }

  /*
    THE EDGE IS A STROKE, AND IT STAYS ROUNDED.

    The frame draws this edge as a shadow with no stroke, and that was shipped
    once. It does not survive the platform: RN collapses a shadow to `elevation`
    on Android, which derives a RECTANGULAR outline, so a rounded pill came out
    looking boxed — reported the moment it landed.

    A real 1pt stroke is visible on both platforms and identical on both, which
    a shadow could never be. `searchBorder` #BEBEBE is 1.86:1 against the white
    bar, against 1.23:1 for the `gray200` hairline this replaced.
  */
  it('draws a visible 1pt stroke, and stays fully rounded', () => {
    renderWithProviders(<SearchEntryPill label="Search Cards" testID="pill" />);

    const style = pill();
    expect(style.borderWidth).toBe(1);
    expect(style.borderColor).toBe(colors.searchBorder);
    // The radius is the half of this that a shadow was never at risk of
    // breaking — and is exactly what the shadow attempt appeared to break.
    expect(style.borderRadius).toBe(radii.pill);

    // No shadow: on Android it is the rectangle, and on iOS it duplicates an
    // edge the stroke already draws.
    expect(style.shadowOpacity ?? 0).toBe(0);
    expect(style.elevation ?? 0).toBe(0);
  });

  /*
    The frame says 14pt Regular `gray600`. It drifted to 13pt Medium `gray500`,
    which measures 2.44:1 on the pill's fill — under WCAG AA's 4.5 for body
    text. `gray600` measures 4.56:1 and passes, so this assertion is holding a
    contrast floor as much as a design one.
  */
  it('labels itself in the frame’s colour, which is also the accessible one', () => {
    renderWithProviders(<SearchEntryPill label="Search Cards" testID="pill" />);

    const label = StyleSheet.flatten(screen.getByText('Search Cards').props.style) as {
      color?: string;
      fontSize?: number;
    };
    expect(label.color).toBe(colors.gray600);
    expect(label.fontSize).toBe(14);
  });

  // The pill is a BUTTON that looks like a field — pressing it opens search
  // elsewhere rather than focusing an input here.
  it('announces itself as a button carrying its own label', () => {
    renderWithProviders(<SearchEntryPill label="Search Cards" testID="pill" />);

    const node = screen.getByTestId('pill');
    expect(node.props.accessibilityRole).toBe('button');
    expect(node.props.accessibilityLabel).toBe('Search Cards');
  });
});
