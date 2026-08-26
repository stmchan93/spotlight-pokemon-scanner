import { render, screen } from '@testing-library/react-native';

/**
 * Home and Wishlist must go black when selected (Figma 3523:15619). They are the
 * only raster icons in the bar, and a PNG only follows `tintColor` if it reaches
 * UIKit as a TEMPLATE — expo-router otherwise defaults to `'original'`, which
 * ignores the tint and drew both tabs black in every state.
 *
 * Only visible on the tab you are NOT on, hence a test. Android is unpinned: it
 * has no rendering mode and tints these unconditionally.
 */

// Hook-free, like every other mock here: the layout is re-required under
// `jest.resetModules()`, so a REAL hook in its tree runs on a second React
// copy and throws "invalid hook call".
jest.mock('@/lib/use-keyboard-visible', () => ({
  useKeyboardVisible: () => false,
}));

jest.mock('@/components/circular-tab-avatar', () => ({
  useCircularTabAvatar: () => null,
}));

jest.mock('expo-router', () => ({
  usePathname: () => '/',
}));

jest.mock('expo-router/unstable-native-tabs', () => {
  // Required inline because a jest.mock factory is hoisted above the imports.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Text, View } = require('react-native');

  // The real `Icon` writes into navigation options and renders nothing, so its
  // props are read off the ELEMENT rather than from anything it rendered.
  const Icon = () => null;

  const Trigger = Object.assign(
    ({ children, name }: { children?: React.ReactNode; name?: string }) => {
      const iconElement = React.Children.toArray(children).find(
        (child: { type?: unknown }) => React.isValidElement(child) && child.type === Icon,
      );
      return (
        <View>
          <Text testID={`icon-props-${name}`}>
            {JSON.stringify(iconElement ? iconElement.props : null)}
          </Text>
          {children}
        </View>
      );
    },
    {
      Icon,
      Label: ({ children }: { children?: React.ReactNode }) => <Text>{children}</Text>,
    },
  );

  return {
    NativeTabs: Object.assign(
      ({ children, ...props }: { children?: React.ReactNode }) => (
        <View>
          <Text testID="native-tabs-props">{JSON.stringify(props)}</Text>
          {children}
        </View>
      ),
      { Trigger },
    ),
  };
});

function renderTabsLayout() {
  // Required after the mocks so the layout picks them up.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const TabsLayout = require('@/app/(tabs)/_layout').default;
  return render(<TabsLayout />);
}

function iconProps(tab: string) {
  return JSON.parse(screen.getByTestId(`icon-props-${tab}`).props.children as string) as Record<
    string,
    unknown
  >;
}

describe('tabs layout — the raster glyphs follow the selected tint', () => {
  afterEach(() => {
    jest.resetModules();
  });

  it.each([
    ['index', 'home.png'],
    ['wishlist', 'wishlist.png'],
  ])('renders %s as a template, so the bar can tint it', (tab) => {
    renderTabsLayout();

    // The whole fix. Omitting this resolves to `'original'` — see the header.
    expect(iconProps(tab).renderingMode).toBe('template');
    // A template is tinted by the bar, so it must not also carry a colour of
    // its own; `selectedColor` here would override `tintColor` for this one tab
    // and put the bar's four glyphs on two different sources of truth.
    expect(iconProps(tab).selectedColor).toBeUndefined();
  });

  it.each(['index', 'wishlist'])(
    '%s carries both an outline default and a filled selected image (Figma 4299:95029)',
    (tab) => {
      renderTabsLayout();

      // `require()` resolves to a numeric asset id under Metro/Jest; the point
      // pinned here is the SHAPE — a {default, selected} pair, and two
      // DIFFERENT images, so selecting the tab actually swaps to the filled
      // glyph on iOS instead of re-showing the outline.
      const src = iconProps(tab).src as { default?: unknown; selected?: unknown };
      expect(src.default).toBeDefined();
      expect(src.selected).toBeDefined();
      expect(src.selected).not.toBe(src.default);
    },
  );

  it('tints the selected glyph gray900, which is what "black when selected" means', () => {
    renderTabsLayout();

    const props = JSON.parse(screen.getByTestId('native-tabs-props').props.children as string) as {
      tintColor?: string;
    };
    // Figma 3523:15619 — `Color/gray/900`. A literal, so the design number is
    // pinned rather than restated from the token it is read out of.
    expect(props.tintColor).toBe('#1A1A1A');
  });
});
