import { render, screen } from '@testing-library/react-native';
import { Platform } from 'react-native';

import { colors } from '@spotlight/design-system';

/**
 * The Scanner's full-bleed chrome, as a contract on the tab layout.
 *
 * Every prop asserted here was added to fix a REAL Android layout bug and every
 * one of them is invisible on iOS, so nothing else in the suite would notice if
 * it were dropped:
 *
 *  - `hidden` on <NativeTabs> is what gives the camera the whole screen. It is
 *    also the only reason `disableAutomaticContentInsets` below is safe.
 *  - `disableAutomaticContentInsets` removes expo-router's ANDROID-ONLY
 *    `<SafeAreaView edges={{ bottom: true }}>` wrapper (`NativeTabsView.js`),
 *    which insets a tab's content by max(tab-bar height, nav-bar height). With
 *    the bar hidden that reserved a strip for chrome nobody draws and pushed the
 *    viewfinder up.
 *  - `contentStyle` overrides the React Navigation theme background that
 *    expo-router paints under every tab — `#FFFFFF` in this app — so no white
 *    sheet sits under the viewfinder. Android only, on purpose: iOS is left
 *    byte-for-byte alone.
 *
 * Real Android layout cannot be asserted from jest. What these lock is that the
 * props survive, and that the Android-only ones stay Android-only.
 */

const mockPathname = jest.fn(() => '/');

jest.mock('@/components/circular-tab-avatar', () => ({
  useCircularTabAvatar: () => null,
}));

jest.mock('expo-router', () => ({
  usePathname: () => mockPathname(),
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
  const { Text, View } = require('react-native');
  const Trigger = Object.assign(
    ({
      children,
      name,
      ...rest
    }: {
      children?: React.ReactNode;
      name?: string;
      [key: string]: unknown;
    }) => (
      <View>
        {/* Serialise the whole prop bag so a silently DROPPED prop fails here. */}
        <Text testID={`trigger-props-${name}`}>
          {JSON.stringify({
            contentStyle: rest.contentStyle ?? null,
            disableAutomaticContentInsets: rest.disableAutomaticContentInsets ?? null,
          })}
        </Text>
        {children}
      </View>
    ),
    {
      Icon: () => null,
      Label: ({ children }: { children?: React.ReactNode }) => <Text>{children}</Text>,
    },
  );
  return {
    NativeTabs: Object.assign(
      ({ children, hidden }: { children?: React.ReactNode; hidden?: boolean }) => (
        <View>
          <Text testID="native-tabs-hidden">{String(hidden)}</Text>
          {children}
        </View>
      ),
      { Trigger },
    ),
  };
});

function renderTabsLayout() {
  // Required after the mocks so the layout picks them up, and re-required per
  // test so `Platform.OS` is read at the render that needs it.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const TabsLayout = require('@/app/(tabs)/_layout').default;
  return render(<TabsLayout />);
}

function scanTriggerProps() {
  return JSON.parse(screen.getByTestId('trigger-props-scan').props.children as string) as {
    contentStyle: { backgroundColor?: string } | null;
    disableAutomaticContentInsets: boolean | null;
  };
}

describe('tabs layout — scanner chrome', () => {
  const originalOS = Platform.OS;

  afterEach(() => {
    Platform.OS = originalOS;
    mockPathname.mockReturnValue('/');
    jest.resetModules();
  });

  it('hides the tab BAR on /scan and nowhere else', () => {
    mockPathname.mockReturnValue('/scan');
    renderTabsLayout();
    expect(screen.getByTestId('native-tabs-hidden').props.children).toBe('true');

    screen.unmount();
    mockPathname.mockReturnValue('/wishlist');
    renderTabsLayout();
    expect(screen.getByTestId('native-tabs-hidden').props.children).toBe('false');
  });

  it('keeps the automatic content inset off the Scan tab', () => {
    renderTabsLayout();
    expect(scanTriggerProps().disableAutomaticContentInsets).toBe(true);
  });

  it('paints the Scan tab canvas with the scanner black on Android', () => {
    Platform.OS = 'android';
    renderTabsLayout();
    expect(scanTriggerProps().contentStyle).toEqual({
      backgroundColor: colors.scannerCanvas,
    });
  });

  it('leaves the Scan tab canvas untouched on iOS', () => {
    Platform.OS = 'ios';
    renderTabsLayout();
    expect(scanTriggerProps().contentStyle).toBeNull();
  });

  it('does not give the other tabs a content style on either platform', () => {
    Platform.OS = 'android';
    renderTabsLayout();
    for (const name of ['index', 'wishlist', 'you']) {
      const props = JSON.parse(
        screen.getByTestId(`trigger-props-${name}`).props.children as string,
      ) as { contentStyle: unknown; disableAutomaticContentInsets: unknown };
      // Their bar is drawn, so they MUST keep expo-router's bottom inset and the
      // theme canvas. "Fix the scanner" must never mean "break Home/Wishlist/You".
      expect(props.contentStyle).toBeNull();
      expect(props.disableAutomaticContentInsets).toBeNull();
    }
  });
});
