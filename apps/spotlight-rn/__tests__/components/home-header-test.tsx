import { Animated, StyleSheet } from 'react-native';
import { act, fireEvent, screen, within } from '@testing-library/react-native';

import { glassNavBubbleSizes } from '@spotlight/design-system';

import {
  HOME_HEADER_BAR_HEIGHT,
  HOME_HEADER_ROW_HEIGHT,
  HomeHeader,
  type HomeHeaderTrailing,
} from '@/components/home-header';

import { renderWithProviders } from '../test-utils';

/**
 * The bar Home and Social share.
 *
 * THIS FILE EXISTS BECAUSE ITS ABSENCE COST US. `HomeHeader` once took a
 * `searchOpacity` prop, documented it at length, and never applied it — nothing
 * asserted the props reached the tree, and it survived several rounds of header
 * work. The lesson stands: assert WIRING, not vibes.
 *
 * The `trailing` variant is the other thing asserted here: ONE component draws
 * both frames, so the trailing control is the only difference between Social's
 * toolbar (centred lockup, messages + bell) and Home's (a lone settings gear),
 * and each variant has to exclude the other's controls rather than merely
 * include its own. Neither has a menu or an Ask Ekalight button any more (the
 * drawer was replaced by Settings; the assistant is an app-wide floating bubble).
 */

/** Social's trailing control: messages, then the bell. */
function socialTrailing(unreadCount = 0, unreadMessageCount = 0): HomeHeaderTrailing {
  return {
    kind: 'social',
    onOpenMessages: jest.fn(),
    onOpenNotifications: jest.fn(),
    unreadCount,
    unreadMessageCount,
  };
}

/** Home's trailing control: the gear. */
function profileTrailing(onOpenSettings: () => void = jest.fn()): HomeHeaderTrailing {
  return { kind: 'profile', onOpenSettings };
}

function renderHeader(props: Partial<Parameters<typeof HomeHeader>[0]> = {}) {
  return renderWithProviders(
    <HomeHeader
      testID="home-header"
      trailing={socialTrailing()}
      {...props}
    />,
  );
}

/**
 * How far the page scrolls before the pinned backdrop is fully opaque — a
 * private constant inside the bar (`HEADER_BACKDROP_FADE_DISTANCE`), pinned
 * here as a literal so a drift shows up as a failure, not a retune.
 */
const BACKDROP_FADE_DISTANCE = 56;

describe('HomeHeader', () => {
  /*
    THE NUMBERS, PINNED AS LITERALS. A floating bar contributes nothing to
    layout, so every screen under it reserves `HOME_HEADER_BAR_HEIGHT` by hand
    and anything pinning below it stops at `HOME_HEADER_ROW_HEIGHT` — both are
    derived constants that once quietly drifted from the frame because nothing
    read them back. Literals, not arithmetic against the same constants that
    produce them, or the assertion is tautological.

    Figma 4299:95117: a 44pt control row directly under the safe-area inset,
    10 below it.
  */
  it('reserves the frame’s bar and row heights', () => {
    expect(HOME_HEADER_BAR_HEIGHT).toBe(54);
    // The bottom edge of the bubbles — where Collection's page-tab bar pins.
    expect(HOME_HEADER_ROW_HEIGHT).toBe(44);
  });

  it('pads the control row 0pt above and 10pt below', () => {
    renderHeader({ floating: true });

    const row = StyleSheet.flatten(screen.getByTestId('home-header-row').props.style);
    expect(row.paddingTop).toBe(0);
    // The bar owns the space under its own controls; without this the first
    // post rides up under the bubbles.
    expect(row.paddingBottom).toBe(10);
  });

  describe('the trailing control', () => {
    it('Social (Figma 6642:5420): centred lockup, messages top-left, the bell top-right', () => {
      const onOpenMessages = jest.fn();
      const onOpenNotifications = jest.fn();
      renderHeader({
        floating: true,
        trailing: { kind: 'social', onOpenMessages, onOpenNotifications, unreadCount: 0 },
      });

      const row = screen.getByTestId('home-header-row');
      expect(StyleSheet.flatten(row.props.style).justifyContent).toBe('space-between');
      expect(screen.getByTestId('home-header-home-mark')).toBeTruthy();
      // The drawer menu and Ask Ekalight are gone from every variant.
      expect(screen.queryByTestId('home-header-menu')).toBeNull();
      expect(screen.queryByTestId('home-header-assistant')).toBeNull();
      expect(screen.queryByTestId('home-header-settings')).toBeNull();

      const messages = screen.getByTestId('home-header-messages');
      const bell = screen.getByTestId('home-header-notifications');
      expect(messages.props.accessibilityLabel).toBe('Messages');
      expect(bell.props.accessibilityLabel).toBe('Notifications');
      // Row order: messages leads (left edge), the bell trails (right edge).
      const order = within(row)
        .getAllByRole('button')
        .map((node) => node.props.testID);
      expect(order).toEqual(['home-header-messages', 'home-header-notifications']);

      fireEvent.press(messages);
      expect(onOpenMessages).toHaveBeenCalledTimes(1);
      fireEvent.press(bell);
      expect(onOpenNotifications).toHaveBeenCalledTimes(1);
    });

    it('draws messages and the bell as their own 44pt bubbles', () => {
      renderHeader({ floating: true, trailing: socialTrailing() });

      for (const testID of ['home-header-messages', 'home-header-notifications']) {
        const bubble = StyleSheet.flatten(screen.getByTestId(testID).props.style);
        expect(bubble.width).toBe(glassNavBubbleSizes.medium);
        expect(bubble.height).toBe(glassNavBubbleSizes.medium);
      }
    });

    // The bubble's glass clips its children, so the badge is a sibling over the
    // bell's top-right rather than a child of it.
    it('shows the unread badge over the bell and speaks the count', () => {
      renderHeader({ floating: true, trailing: socialTrailing(3) });

      const badge = screen.getByTestId('home-header-notifications-badge');
      expect(screen.getByText('3')).toBeTruthy();
      const style = StyleSheet.flatten(badge.props.style);
      expect(style.top).toBe(2);
      expect(style.right).toBe(2);
      expect(
        within(screen.getByTestId('home-header-notifications')).queryByTestId(
          'home-header-notifications-badge',
        ),
      ).toBeNull();
      expect(screen.getByTestId('home-header-notifications').props.accessibilityLabel).toBe(
        'Notifications, 3 unread',
      );
      expect(screen.queryByTestId('home-header-messages-badge')).toBeNull();
    });

    it('badges the messages bubble with the unread DM count', () => {
      renderHeader({ floating: true, trailing: socialTrailing(0, 4) });

      expect(screen.getByTestId('home-header-messages-badge')).toBeTruthy();
      expect(screen.getByText('4')).toBeTruthy();
      expect(screen.getByTestId('home-header-messages').props.accessibilityLabel).toBe(
        'Messages, 4 unread',
      );
      expect(screen.queryByTestId('home-header-notifications-badge')).toBeNull();
    });

    it('caps the badges at 9+', () => {
      renderHeader({ floating: true, trailing: socialTrailing(12) });
      expect(screen.getByText('9+')).toBeTruthy();
    });

    it('Home (Figma 6642:5964): a single gear bubble on the right that opens Settings', () => {
      const onOpenSettings = jest.fn();
      renderHeader({ floating: true, trailing: profileTrailing(onOpenSettings) });

      const row = screen.getByTestId('home-header-row');
      const children = row.children as unknown as { props: { testID?: string } }[];
      expect(children.map((child) => child.props.testID)).toEqual(['home-header-settings']);

      const gear = screen.getByTestId('home-header-settings');
      expect(gear.props.accessibilityLabel).toBe('Settings');
      const style = StyleSheet.flatten(gear.props.style);
      expect(style.width).toBe(glassNavBubbleSizes.medium);
      fireEvent.press(gear);
      expect(onOpenSettings).toHaveBeenCalledTimes(1);
    });

    // EXCLUSION, both ways: one component draws both bars.
    it('keeps Social controls off Home and the gear off Social', () => {
      renderHeader({ floating: true, trailing: profileTrailing() });
      for (const testID of [
        'home-header-notifications',
        'home-header-messages',
        'home-header-home-mark',
        'home-header-search',
        'home-header-edit',
        'home-header-menu',
        'home-header-assistant',
      ]) {
        expect(screen.queryByTestId(testID)).toBeNull();
      }
    });
  });

  /*
    The backdrop is what makes it safe for something else to PIN under this bar.
    Collection's page-tab bar rests at the bottom of the bubbles, which parks the
    tail of the profile block in the strip behind the clock; an opaque backdrop
    is the only thing covering it. It must stay transparent at rest, though, or
    the cover photo stops bleeding edge to edge.
  */
  describe('pinned backdrop', () => {
    it('is absent unless the screen asks for it', () => {
      renderHeader({ floating: true, scrollY: new Animated.Value(0) });

      expect(screen.queryByTestId('home-header-backdrop')).not.toBeOnTheScreen();
    });

    it('fills the bar and fades with the scroll offset when asked for', () => {
      renderHeader({
        floating: true,
        pinnedBackdrop: true,
        scrollY: new Animated.Value(0),
      });

      const backdrop = screen.getByTestId('home-header-backdrop');
      const style = StyleSheet.flatten(backdrop.props.style);

      // Covers the whole bar — inset, control row and all.
      expect(style.position).toBe('absolute');
      expect(style.backgroundColor).toBeTruthy();
      // FULLY TRANSPARENT AT REST. A flat opaque bar would cut the top off the
      // cover photo, which is drawn deliberately tall to bleed under the status
      // bar (`profile-header` offsets it by `-insets.top`).
      expect(style.opacity).toBe(0);
      // Never eats a tap meant for the list underneath.
      expect(backdrop.props.pointerEvents).toBe('none');
    });

    it('is solid once the page has travelled the fade distance', () => {
      renderHeader({
        floating: true,
        pinnedBackdrop: true,
        scrollY: new Animated.Value(BACKDROP_FADE_DISTANCE),
      });

      const style = StyleSheet.flatten(screen.getByTestId('home-header-backdrop').props.style);
      expect(style.opacity).toBe(1);
    });

    /*
      Collection floats this bar over a tall cover. Fading from the rest offset
      washed a white strip over the cover after a few points of scroll, so the
      fade waits `backdropFadeStart` points and then runs the usual distance.
    */
    describe('with a backdropFadeStart', () => {
      const REST = -62;
      const START = 300;
      const opacityAt = (y: number) => {
        renderHeader({
          backdropFadeStart: START,
          floating: true,
          pinnedBackdrop: true,
          scrollRestOffset: REST,
          scrollY: new Animated.Value(y),
          trailing: profileTrailing(),
        });
        return StyleSheet.flatten(screen.getByTestId('home-header-backdrop').props.style)
          .opacity;
      };

      it('stays clear until the fade start', () => {
        expect(opacityAt(REST)).toBe(0);
        expect(opacityAt(REST + START)).toBe(0);
      });

      it('is half faded mid-range and solid at the end of it', () => {
        expect(opacityAt(REST + START + BACKDROP_FADE_DISTANCE / 2)).toBeCloseTo(0.5);
        expect(opacityAt(REST + START + BACKDROP_FADE_DISTANCE)).toBe(1);
      });

      it('moves the contrast flip with the fade', () => {
        const scrollY = new Animated.Value(REST);
        const onOverCoverChange = jest.fn();
        renderHeader({
          backdropFadeStart: START,
          floating: true,
          onOverCoverChange,
          pinnedBackdrop: true,
          scrollRestOffset: REST,
          scrollY,
          trailing: profileTrailing(),
        });

        act(() => scrollY.setValue(REST + BACKDROP_FADE_DISTANCE));
        expect(onOverCoverChange).toHaveBeenLastCalledWith(true);

        act(() => scrollY.setValue(REST + START + BACKDROP_FADE_DISTANCE));
        expect(onOverCoverChange).toHaveBeenLastCalledWith(false);
      });
    });

    it('needs a scroll offset to fade against', () => {
      renderHeader({ floating: true, pinnedBackdrop: true });

      expect(screen.queryByTestId('home-header-backdrop')).not.toBeOnTheScreen();
    });
  });
});
