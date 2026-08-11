import { Platform, StyleSheet } from 'react-native';
import { screen } from '@testing-library/react-native';
import { useRouter } from 'expo-router';

import { ScrollToTopFab } from '@/components/scroll-to-top-fab';
import { CollectionAddFab } from '@/features/portfolio/components/collection-add-fab';
import {
  NativeTabScreenProvider,
  floatingAffordanceGap,
  resolveFloatingAffordanceBottom,
} from '@/lib/tab-bar-insets';

import { renderWithProviders } from '../test-utils';

jest.mock('expo-router', () => ({
  useRouter: jest.fn(),
}));

// `test-utils` pins the safe-area metrics for every render below.
const TEST_SAFE_AREA_BOTTOM = 34;

function flattenStyle(node: { props: { style: unknown } } | null) {
  const style = node?.props.style;
  return StyleSheet.flatten(
    typeof style === 'function'
      ? (style as (state: { pressed: boolean }) => unknown)({ pressed: false })
      : style,
  ) as { bottom?: number };
}

/**
 * `ScrollToTopButton` puts the caller's `testID` on its inner `Pressable` and
 * the caller's positioning `style` on the animated wrapper around it, so the
 * placement under test lives on an ANCESTOR of the node the testID finds.
 * Walk up to the nearest absolutely-positioned one rather than hard-coding a
 * depth, which would break on any wrapper the primitive gains later.
 */
function scrollToTopFabStyle(testID: string) {
  let node: { props: { style: unknown }; parent: unknown } | null = screen.getByTestId(testID);

  while (node) {
    const style = flattenStyle(node) as { position?: string; bottom?: number };
    if (style.position === 'absolute') {
      return style;
    }
    node = node.parent as typeof node;
  }

  throw new Error(`No absolutely-positioned ancestor of "${testID}" — nothing places the FAB.`);
}

/*
  THE REGRESSION THIS FILE EXISTS FOR — twice now.

  Floating affordances used to be placed with
  `insets.bottom + bottomTabBarHeight + 28`, where `bottomTabBarHeight` is 44 —
  the height of the RETIRED JS `BottomTabBar` pill, not of the `NativeTabs` bar
  the app actually draws. The 44 was dead weight on BOTH platforms:

   • iOS — `insets.bottom` inside a native tab screen already includes the tab
     bar (expo-router mounts a per-screen `SafeAreaProvider` inside the UIKit tab
     child), so the 44 was added on top of a number that had already counted the
     bar.
   • Android — the tab container is already padded by the measured
     `BottomNavigationView` height, so BOTH the 44 and `insets.bottom` were dead
     weight.

  See `src/lib/tab-bar-insets.tsx` for the source citations. These assertions are
  exact numbers on purpose: a component that quietly re-adds a bar constant has to
  fail here rather than drift a third time.
*/
describe('floating affordance placement', () => {
  const push = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    (useRouter as jest.Mock).mockReturnValue({ push });
  });

  describe('resolveFloatingAffordanceBottom', () => {
    it('adds only the safe-area inset on iOS — UIKit has already counted the bar', () => {
      expect(
        resolveFloatingAffordanceBottom({
          os: 'ios',
          safeAreaBottom: 83, // 49pt tab bar + 34pt home indicator
          isNativeTabScreen: true,
        }),
      ).toBe(83 + floatingAffordanceGap);
    });

    it('is the bare gap on an Android tab screen — the container is pre-inset', () => {
      expect(
        resolveFloatingAffordanceBottom({
          os: 'android',
          safeAreaBottom: 48,
          isNativeTabScreen: true,
        }),
      ).toBe(floatingAffordanceGap);
    });

    it('clears the navigation bar on an Android screen with no tab bar', () => {
      // Pushed stack screens (app/(stack)/insights) are full-bleed and draw no
      // bar, so the system navigation bar is the only thing to clear.
      expect(
        resolveFloatingAffordanceBottom({
          os: 'android',
          safeAreaBottom: 48,
          isNativeTabScreen: false,
        }),
      ).toBe(48 + floatingAffordanceGap);
    });

    it('never lets a negative inset pull the affordance off-screen', () => {
      expect(
        resolveFloatingAffordanceBottom({
          os: 'ios',
          safeAreaBottom: -10,
          isNativeTabScreen: false,
        }),
      ).toBe(floatingAffordanceGap);
    });
  });

  describe('ScrollToTopFab', () => {
    it('rests exactly one gap above the chrome the safe area reports', () => {
      renderWithProviders(<ScrollToTopFab onPress={jest.fn()} testID="fab" visible />);

      expect(scrollToTopFabStyle('fab').bottom).toBe(
        TEST_SAFE_AREA_BOTTOM + floatingAffordanceGap,
      );
    });
  });

  describe('CollectionAddFab', () => {
    it('rests exactly one gap above the chrome the safe area reports', () => {
      renderWithProviders(<CollectionAddFab />);

      expect(flattenStyle(screen.getByTestId('collection-add-fab')).bottom).toBe(
        TEST_SAFE_AREA_BOTTOM + floatingAffordanceGap,
      );
    });
  });

  describe('on Android', () => {
    const realOS = Platform.OS;

    afterEach(() => {
      Object.defineProperty(Platform, 'OS', { value: realOS, configurable: true });
    });

    it('drops the safe-area inset inside a native tab screen', () => {
      Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true });

      renderWithProviders(
        <NativeTabScreenProvider>
          <ScrollToTopFab onPress={jest.fn()} testID="fab-android-tab" visible />
        </NativeTabScreenProvider>,
      );

      expect(scrollToTopFabStyle('fab-android-tab').bottom).toBe(
        floatingAffordanceGap,
      );
    });

    it('keeps it outside one, where nothing has pre-inset the container', () => {
      Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true });

      renderWithProviders(<ScrollToTopFab onPress={jest.fn()} testID="fab-android-stack" visible />);

      expect(scrollToTopFabStyle('fab-android-stack').bottom).toBe(
        TEST_SAFE_AREA_BOTTOM + floatingAffordanceGap,
      );
    });
  });
});
