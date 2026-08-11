import { render, screen } from '@testing-library/react-native';
import { Platform } from 'react-native';

/**
 * The `You` tab's icon: the signed-in user's face on iOS, a glyph on Android.
 *
 * THE ANDROID HALF IS NOT AN OVERSIGHT, AND THIS TEST EXISTS TO STOP IT BEING
 * "FIXED" BY DELETING THE PLATFORM CHECK. Full derivation is in the comment on
 * the `you` trigger in `src/app/(tabs)/_layout.tsx`; the short version is that
 * every Android tab icon in this bar is a BITMAP that Material tints SRC_IN
 * (`NavigationBarItemView.setIcon` applies `iconTint` whenever the tint list is
 * non-null, and react-native-screens always sets one), so a photograph comes
 * out as a solid gray900 circle. Removing the `Platform.OS === 'ios'` check
 * does not show the user's face on Android — it shows a dark blob.
 *
 * What this locks:
 *  - iOS renders the rasterised avatar, untinted (`renderingMode="original"`),
 *    and passes NO `sf`, because iOS resolves `sf` > `xcasset` > `src` and a
 *    symbol would win over the photo.
 *  - iOS with no photo (guest, no upload, or the frame before the raster
 *    lands) falls back to the person glyph.
 *  - Android keeps the `account_circle` glyph EVEN WHEN A PHOTO EXISTS.
 *
 * jest cannot see a tab bar. What it can see is which icon props the layout
 * hands to expo-router, which is the whole of the decision being pinned.
 */

const mockAvatarIcon: { current: unknown } = { current: null };

jest.mock('@/components/circular-tab-avatar', () => ({
  useCircularTabAvatar: () => mockAvatarIcon.current,
}));

jest.mock('expo-router', () => ({
  usePathname: () => '/',
}));

// Hook-free, like every other mock here: the layout is re-required under
// `jest.resetModules()`, so a REAL hook in its tree runs on a second React
// copy and throws "invalid hook call".
jest.mock('@/lib/use-keyboard-visible', () => ({
  useKeyboardVisible: () => false,
}));

jest.mock('expo-router/unstable-native-tabs', () => {
  // Required inline because a jest.mock factory is hoisted above the imports.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Text, View } = require('react-native');

  // The real `Icon` writes into navigation options and renders nothing, so its
  // props are read from the ELEMENT rather than from a rendered component —
  // which also keeps this mock hook-free, and so immune to the second React
  // copy that `jest.resetModules()` hands the re-required layout.
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
      ({ children }: { children?: React.ReactNode }) => <View>{children}</View>,
      { Trigger },
    ),
  };
});

const AVATAR_SOURCE = {
  uri: 'data:image/png;base64,PNGBYTES',
  width: 28,
  height: 28,
  scale: 3,
};

function renderTabsLayout() {
  // Required after the mocks so the layout picks them up, and re-required per
  // test so `Platform.OS` is read at the render that needs it.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const TabsLayout = require('@/app/(tabs)/_layout').default;
  return render(<TabsLayout />);
}

function youIconProps() {
  return JSON.parse(screen.getByTestId('icon-props-you').props.children as string) as Record<
    string,
    unknown
  >;
}

describe('tabs layout — the You icon', () => {
  const originalOS = Platform.OS;

  afterEach(() => {
    Platform.OS = originalOS;
    mockAvatarIcon.current = null;
    jest.resetModules();
  });

  it('draws the rasterised photo on iOS, untinted and with no competing symbol', () => {
    Platform.OS = 'ios';
    mockAvatarIcon.current = AVATAR_SOURCE;
    renderTabsLayout();

    const props = youIconProps();
    expect(props.src).toEqual(AVATAR_SOURCE);
    // `tintColor` on <NativeTabs> makes expo-router default images to
    // `template`, and a templated photograph is a flat silhouette.
    expect(props.renderingMode).toBe('original');
    // iOS resolves `sf` > `xcasset` > `src`, so a symbol here would always win.
    expect(props.sf).toBeUndefined();
  });

  it('falls back to the person glyph on iOS when there is no photo', () => {
    Platform.OS = 'ios';
    mockAvatarIcon.current = null;
    renderTabsLayout();

    const props = youIconProps();
    expect(props.src).toBeUndefined();
    expect(props.sf).toEqual({
      default: 'person.crop.circle',
      selected: 'person.crop.circle.fill',
    });
  });

  it('keeps the glyph on Android even when the account HAS a photo', () => {
    // Not a missing feature: Material tints every bitmap tab icon SRC_IN, which
    // turns the photo into a solid gray900 circle. See the trigger comment in
    // `src/app/(tabs)/_layout.tsx`. If this ever becomes possible, it needs a
    // react-native-screens change and a NATIVE BUILD — not a gate flip here.
    Platform.OS = 'android';
    mockAvatarIcon.current = AVATAR_SOURCE;
    renderTabsLayout();

    const props = youIconProps();
    expect(props.src).toBeUndefined();
    expect(props.md).toBe('account_circle');
  });

  it('shows the same glyph on Android for an account with no photo', () => {
    Platform.OS = 'android';
    mockAvatarIcon.current = null;
    renderTabsLayout();

    expect(youIconProps().md).toBe('account_circle');
  });
});
