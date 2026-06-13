import { render, screen } from '@testing-library/react-native';

// Reanimated v4's official `/mock` entrypoint pulls in the native worklets
// runtime, which throws under jest. Override it locally with a self-contained,
// dependency-free stub so the heart renders synchronously and all animation
// helpers no-op. Declared before importing the component under test.
jest.mock('react-native-reanimated', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { View, Text, Image } = require('react-native');

  const passthrough = (value: unknown) => value;
  const Animated = {
    View,
    Text,
    Image,
    createAnimatedComponent: (Component: unknown) => Component,
  };

  return {
    __esModule: true,
    default: Animated,
    ...Animated,
    useSharedValue: (initial: unknown) => {
      const ref = React.useRef({ value: initial });
      return ref.current;
    },
    useAnimatedStyle: (fn: () => unknown) => {
      try {
        return fn();
      } catch {
        return {};
      }
    },
    useAnimatedProps: (fn: () => unknown) => {
      try {
        return fn();
      } catch {
        return {};
      }
    },
    withTiming: passthrough,
    withSpring: passthrough,
    withSequence: (...values: unknown[]) => values[values.length - 1],
    cancelAnimation: () => {},
    runOnJS: (fn: (...args: unknown[]) => unknown) => fn,
    Easing: {
      bezier: () => passthrough,
      ease: passthrough,
      out: (fn: unknown) => fn,
      in: (fn: unknown) => fn,
      inOut: (fn: unknown) => fn,
      linear: passthrough,
    },
  };
});

// eslint-disable-next-line import/first
import { HeartToggle } from '@/components/heart-toggle';

// With reanimated mocked, all animations no-op and these assertions exercise
// the static render output only.
describe('HeartToggle', () => {
  it('mounts without throwing in the resting (unfilled) state', () => {
    expect(() =>
      render(<HeartToggle filled={false} testID="heart" />),
    ).not.toThrow();

    expect(screen.getByTestId('heart')).toBeTruthy();
    // The SVG glyph layer is always rendered (outline + cross-fade fill).
    expect(screen.getByTestId('heart-svg')).toBeTruthy();
  });

  it('mounts without throwing in the filled state', () => {
    expect(() =>
      render(<HeartToggle filled testID="heart" />),
    ).not.toThrow();

    expect(screen.getByTestId('heart')).toBeTruthy();
    expect(screen.getByTestId('heart-svg')).toBeTruthy();
  });

  it('accepts the full prop surface (size, colors, bounce, burst) without throwing', () => {
    expect(() =>
      render(
        <HeartToggle
          bounce="springy"
          burst
          filled
          fill="#D93025"
          size={32}
          stroke="#999999"
          testID="heart"
        />,
      ),
    ).not.toThrow();

    expect(screen.getByTestId('heart')).toBeTruthy();
  });

  it('re-renders cleanly when toggling from unfilled to filled (like transition)', () => {
    const { rerender } = render(<HeartToggle filled={false} testID="heart" />);
    expect(screen.getByTestId('heart')).toBeTruthy();

    expect(() => rerender(<HeartToggle filled testID="heart" />)).not.toThrow();
    expect(screen.getByTestId('heart')).toBeTruthy();
  });
});
