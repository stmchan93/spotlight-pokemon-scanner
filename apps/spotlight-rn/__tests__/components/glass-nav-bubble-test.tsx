import { fireEvent, render, screen } from '@testing-library/react-native';
import { StyleSheet, Text } from 'react-native';

import {
  GlassNavBubble,
  SpotlightThemeProvider,
  colors,
  glassNavBubbleSizes,
  shadows,
} from '@spotlight/design-system';

// The jest.setup mock forces `isLiquidGlassAvailable()` to false (real Liquid
// Glass only exists on an iOS 26 device + Xcode-26 build), so these tests assert
// the non-glass fallback that Android and every pre-iOS-26 target renders — the
// path most users actually see.
function renderBubble(node: React.ReactElement) {
  return render(<SpotlightThemeProvider>{node}</SpotlightThemeProvider>);
}

function flattenStyle(style: unknown) {
  if (typeof style === 'function') {
    return StyleSheet.flatten(style({ pressed: false })) as Record<string, unknown>;
  }

  return (StyleSheet.flatten(style as never) ?? {}) as Record<string, unknown>;
}

describe('GlassNavBubble', () => {
  /*
    THE FIGMA NUMBER, AS A LITERAL. Every other size assertion in this file
    compares the rendered style against the token that produced it, which is
    true whatever the token says. `compact` is the one size that has to agree
    with something OUTSIDE the primitive — the `SearchEntryPill` and the
    `EditDoneButton` sitting beside it in the same bar — so it is pinned here
    against the frame instead: Figma "Home" 3523:15499, toolbar 3567:22969,
    where every control in the row is 40 tall.

    It was 36 for months against a Figma node that had since been deleted.
  */
  it('sizes a bar bubble at the frame’s 40pt', () => {
    expect(glassNavBubbleSizes.compact).toBe(40);
  });

  it('renders a 44pt circle by default and a 32pt circle at size="small"', () => {
    renderBubble(
      <>
        <GlassNavBubble accessibilityLabel="Default" onPress={() => {}} testID="bubble-default">
          <Text>a</Text>
        </GlassNavBubble>
        <GlassNavBubble
          accessibilityLabel="Small"
          onPress={() => {}}
          size="small"
          testID="bubble-small"
        >
          <Text>b</Text>
        </GlassNavBubble>
      </>,
    );

    const defaultStyle = flattenStyle(screen.getByTestId('bubble-default').props.style);
    expect(defaultStyle.height).toBe(glassNavBubbleSizes.medium);
    expect(defaultStyle.width).toBe(glassNavBubbleSizes.medium);
    expect(defaultStyle.borderRadius).toBe(glassNavBubbleSizes.medium / 2);

    const smallStyle = flattenStyle(screen.getByTestId('bubble-small').props.style);
    expect(smallStyle.height).toBe(glassNavBubbleSizes.small);
    expect(smallStyle.width).toBe(glassNavBubbleSizes.small);
    expect(smallStyle.borderRadius).toBe(glassNavBubbleSizes.small / 2);
  });

  it('falls back to a solid elevated circle with a shadow on a light surface', () => {
    renderBubble(
      <GlassNavBubble accessibilityLabel="Menu" onPress={() => {}} testID="bubble-light">
        <Text>menu</Text>
      </GlassNavBubble>,
    );

    const style = flattenStyle(screen.getByTestId('bubble-light').props.style);
    expect(style.backgroundColor).toBe(colors.canvasElevated);
    expect(style.shadowRadius).toBe(shadows.card.shadowRadius);
    expect(style.shadowOpacity).toBe(shadows.card.shadowOpacity);
    // A light chip must not also draw the dark-surface ring.
    expect(style.borderWidth).toBeUndefined();
  });

  it('falls back to a transparent ring (no white fill, no shadow) on a dark surface', () => {
    renderBubble(
      <GlassNavBubble
        accessibilityLabel="Exit scanner"
        onPress={() => {}}
        size="small"
        surface="onDark"
        testID="bubble-dark"
      >
        <Text>back</Text>
      </GlassNavBubble>,
    );

    const style = flattenStyle(screen.getByTestId('bubble-dark').props.style);
    // The camera feed must stay visible through the button.
    expect(style.backgroundColor).toBeUndefined();
    expect(style.borderWidth).toBe(1);
    expect(style.borderColor).toBe(colors.gray0);
    expect(style.shadowRadius).toBeUndefined();
  });

  it('does not force a glyph color — the caller owns it on both tones', () => {
    renderBubble(
      <>
        <GlassNavBubble accessibilityLabel="Light" onPress={() => {}} testID="glyph-light">
          <Text style={{ color: colors.gray900 }} testID="glyph-light-icon">
            dark glyph
          </Text>
        </GlassNavBubble>
        <GlassNavBubble
          accessibilityLabel="Dark"
          onPress={() => {}}
          surface="onDark"
          testID="glyph-dark"
        >
          <Text style={{ color: colors.gray0 }} testID="glyph-dark-icon">
            white glyph
          </Text>
        </GlassNavBubble>
      </>,
    );

    expect(flattenStyle(screen.getByTestId('glyph-light-icon').props.style).color).toBe(
      colors.gray900,
    );
    expect(flattenStyle(screen.getByTestId('glyph-dark-icon').props.style).color).toBe(colors.gray0);
  });

  it('fires onPress and stays inert while disabled', () => {
    const onPress = jest.fn();
    const onDisabledPress = jest.fn();

    renderBubble(
      <>
        <GlassNavBubble accessibilityLabel="Tap" onPress={onPress} testID="bubble-tap">
          <Text>tap</Text>
        </GlassNavBubble>
        <GlassNavBubble
          accessibilityLabel="Off"
          disabled
          onPress={onDisabledPress}
          testID="bubble-disabled"
        >
          <Text>off</Text>
        </GlassNavBubble>
      </>,
    );

    fireEvent.press(screen.getByTestId('bubble-tap'));
    expect(onPress).toHaveBeenCalledTimes(1);

    fireEvent.press(screen.getByTestId('bubble-disabled'));
    expect(onDisabledPress).not.toHaveBeenCalled();
    expect(flattenStyle(screen.getByTestId('bubble-disabled').props.style).opacity).toBe(0.45);
  });
});
