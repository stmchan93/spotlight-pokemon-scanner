import { render, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import { Button, SpotlightThemeProvider } from '@spotlight/design-system';

function renderButton(node: React.ReactElement) {
  return render(<SpotlightThemeProvider>{node}</SpotlightThemeProvider>);
}

function flattenPressableStyle(style: unknown): Record<string, unknown> {
  const resolved = typeof style === 'function'
    ? (style as (state: { pressed: boolean }) => unknown)({ pressed: false })
    : style;
  return (StyleSheet.flatten(resolved as never) as Record<string, unknown>) ?? {};
}

function labelStyleFor(testID: string): Record<string, unknown> {
  const label = screen.getByText(testID === 'label-style' ? 'Labeled' : 'Action');
  return (StyleSheet.flatten(label.props.style as never) as Record<string, unknown>) ?? {};
}

describe('Button', () => {
  describe("variant='outline'", () => {
    it('renders a white card with a gray200 border and a gray900 label', () => {
      renderButton(<Button label="Action" testID="outline-button" variant="outline" />);

      const button = screen.getByTestId('outline-button');
      const flattened = flattenPressableStyle(button.props.style);
      // canvasElevated is white (#FFFFFF) in the theme.
      expect(flattened.backgroundColor).toMatch(/^#?[Ff][Ff][Ff]/);
      // gray200 (#E8E8E8) border.
      expect(flattened.borderColor).toBe('#E8E8E8');

      const label = StyleSheet.flatten(screen.getByText('Action').props.style as never) as Record<
        string,
        unknown
      >;
      // gray900 (#1A1A1A) label.
      expect(label.color).toBe('#1A1A1A');
    });
  });

  describe("variant='accent'", () => {
    it('renders a purple500 fill with a white label', () => {
      renderButton(<Button label="Action" testID="accent-button" variant="accent" />);

      const button = screen.getByTestId('accent-button');
      const flattened = flattenPressableStyle(button.props.style);
      // purple500 (#A54BFA) fill and matching border.
      expect(flattened.backgroundColor).toBe('#A54BFA');
      expect(flattened.borderColor).toBe('#A54BFA');

      const label = StyleSheet.flatten(screen.getByText('Action').props.style as never) as Record<
        string,
        unknown
      >;
      // gray0 (#FFFFFF) white label.
      expect(label.color).toBe('#FFFFFF');
    });
  });

  describe("variant='dark'", () => {
    it('renders a gray900 black fill with a white label', () => {
      renderButton(<Button label="Action" testID="dark-button" variant="dark" />);

      const button = screen.getByTestId('dark-button');
      const flattened = flattenPressableStyle(button.props.style);
      // gray900 (#1A1A1A) black fill and matching border.
      expect(flattened.backgroundColor).toBe('#1A1A1A');
      expect(flattened.borderColor).toBe('#1A1A1A');

      const label = StyleSheet.flatten(screen.getByText('Action').props.style as never) as Record<
        string,
        unknown
      >;
      // gray0 (#FFFFFF) white label.
      expect(label.color).toBe('#FFFFFF');
    });
  });

  describe("variant='destructive'", () => {
    it('renders a dangerStrong red fill with a white label', () => {
      renderButton(<Button label="Action" testID="destructive-button" variant="destructive" />);

      const button = screen.getByTestId('destructive-button');
      const flattened = flattenPressableStyle(button.props.style);
      // dangerStrong (#D93025) red fill and matching border.
      expect(flattened.backgroundColor).toBe('#D93025');
      expect(flattened.borderColor).toBe('#D93025');

      const label = StyleSheet.flatten(screen.getByText('Action').props.style as never) as Record<
        string,
        unknown
      >;
      // gray0 (#FFFFFF) white label.
      expect(label.color).toBe('#FFFFFF');
    });
  });

  describe("shape", () => {
    it("applies radius 8 when shape='rounded'", () => {
      renderButton(<Button label="Action" shape="rounded" testID="rounded-button" variant="outline" />);

      const flattened = flattenPressableStyle(screen.getByTestId('rounded-button').props.style);
      expect(flattened.borderRadius).toBe(8);
    });

    it('defaults to a pill radius (999)', () => {
      renderButton(<Button label="Action" testID="pill-button" variant="primary" />);

      const flattened = flattenPressableStyle(screen.getByTestId('pill-button').props.style);
      expect(flattened.borderRadius).toBe(999);
    });
  });

  describe("labelStyleVariant='label'", () => {
    it('uses the 13px label typography', () => {
      renderButton(
        <Button label="Labeled" labelStyleVariant="label" testID="label-style" variant="accent" />,
      );

      const label = labelStyleFor('label-style');
      expect(label.fontSize).toBe(13);
    });
  });
});
