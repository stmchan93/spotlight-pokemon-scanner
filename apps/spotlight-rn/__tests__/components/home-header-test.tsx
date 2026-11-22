import { Animated, StyleSheet } from 'react-native';
import { act, fireEvent, screen, within } from '@testing-library/react-native';

import {
  glassNavBubbleGroupWidth,
  glassNavBubbleSizes,
  layout,
} from '@spotlight/design-system';

import {
  HOME_HEADER_BAR_HEIGHT,
  HOME_HEADER_ROW_HEIGHT,
  HomeHeader,
  type HomeHeaderTrailing,
} from '@/components/home-header';

import { renderWithProviders } from '../test-utils';

/**
 * The bar Home and Collection share.
 *
 * THIS FILE EXISTS BECAUSE ITS ABSENCE COST US. `HomeHeader` once took a
 * `searchOpacity` prop, documented it at length, and never applied it — nothing
 * asserted the props reached the tree, and it survived several rounds of header
 * work. The scroll-linked pill motion those tests guarded is gone now (the
 * 4299:94902 bar is static), but the lesson stands: assert WIRING, not vibes.
 *
 * The `trailing` variant is the other thing asserted here: ONE component draws
 * both frames, so the trailing control is the only difference between
 * Social's toolbar (Ask Ekalight + a lone bell bubble, no search) and the
 * profile's (Ask Ekalight + a search/edit/share capsule), and each variant has
 * to exclude the other's controls rather than merely include its own.
 */

/** Social's trailing control: the bell (Ask Ekalight rides beside it). Nothing else. */
function homeTrailing(unreadCount = 0): HomeHeaderTrailing {
  return {
    kind: 'home',
    onOpenNotifications: jest.fn(),
    unreadCount,
  };
}

/** Collection's trailing pair: the edit pencil and the share glyph. */
function profileTrailing(
  overrides: Partial<Extract<HomeHeaderTrailing, { kind: 'profile' }>> = {},
): HomeHeaderTrailing {
  return {
    kind: 'profile',
    onEditProfile: jest.fn(),
    onOpenSearch: jest.fn(),
    ...overrides,
  };
}

function renderHeader(props: Partial<Parameters<typeof HomeHeader>[0]> = {}) {
  return renderWithProviders(
    <HomeHeader
      onOpenMenu={jest.fn()}
      testID="home-header"
      trailing={homeTrailing()}
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

  /*
    THE TRAILING CONTROL. Social (Figma 6597:3462) trails Ask Ekalight and the
    bell as two separate 44pt bubbles 10pt apart, and has no search. The
    profile bar trails Ask Ekalight plus a search/edit/share capsule.
  */
  describe('the trailing control', () => {
    it('Social (Figma 6597:3462): menu left, centred lockup, Ask Ekalight then the bell right, no search', () => {
      const onOpenMenu = jest.fn();
      const onOpenNotifications = jest.fn();
      const onOpenAssistant = jest.fn();
      renderHeader({
        floating: true,
        onOpenAssistant,
        onOpenMenu,
        trailing: { kind: 'home', onOpenNotifications, unreadCount: 0 },
      });

      const row = screen.getByTestId('home-header-row');
      const [leading, , trailingGroup] = row.children as unknown as {
        props: { testID?: string };
        findByProps: (p: object) => unknown;
      }[];
      expect(leading.props.testID).toBe('home-header-menu');
      expect(trailingGroup.props.testID).toBe('home-header-utilities');
      expect(screen.getByTestId('home-header-home-mark')).toBeTruthy();

      // Two SEPARATE bubbles in this order: Ask Ekalight, then the bell.
      const utilities = screen.getByTestId('home-header-utilities');
      const order = (utilities.children as unknown as { props: { testID?: string } }[]).map(
        (child) => child.props.testID,
      );
      expect(order).toEqual(['home-header-assistant', undefined]);
      expect(within(utilities).getByTestId('home-header-notifications')).toBeTruthy();
      expect(StyleSheet.flatten(utilities.props.style).gap).toBe(10);

      // No search anywhere on Social.
      expect(screen.queryByTestId('home-header-search')).toBeNull();
      expect(screen.queryByText('Search Cards')).toBeNull();

      fireEvent.press(screen.getByTestId('home-header-menu'));
      expect(onOpenMenu).toHaveBeenCalledTimes(1);

      const bell = screen.getByTestId('home-header-notifications');
      expect(bell.props.accessibilityLabel).toBe('Notifications');
      fireEvent.press(bell);
      expect(onOpenNotifications).toHaveBeenCalledTimes(1);
    });

    it('draws Ask Ekalight with the two-star flare and gradient ring on Social', () => {
      const onOpenAssistant = jest.fn();
      renderHeader({ floating: true, onOpenAssistant, trailing: homeTrailing() });
      const ai = screen.getByTestId('home-header-assistant');
      expect(ai.props.accessibilityLabel).toBe('Ask Ekalight');
      expect(screen.getByTestId('ekalight-ai-flare')).toBeTruthy();
      expect(screen.getByTestId('ekalight-ai-ring')).toBeTruthy();
      fireEvent.press(ai);
      expect(onOpenAssistant).toHaveBeenCalledTimes(1);
    });

    it('draws the bell as its own 44pt bubble', () => {
      renderHeader({ floating: true, trailing: homeTrailing() });

      const bell = StyleSheet.flatten(screen.getByTestId('home-header-notifications').props.style);
      expect(bell.width).toBe(glassNavBubbleSizes.medium);
      expect(bell.height).toBe(glassNavBubbleSizes.medium);
    });

    // The bubble's glass clips its children, so the badge is a sibling over the
    // bell's top-right rather than a child of it.
    it('shows the unread badge over the bell and speaks the count', () => {
      renderHeader({ floating: true, trailing: homeTrailing(3) });

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
    });

    it('caps the badge at 9+', () => {
      renderHeader({ floating: true, trailing: homeTrailing(12) });
      expect(screen.getByText('9+')).toBeTruthy();
    });

    it('leaves the flexed profile pill 197 at a 393pt width', () => {
      // Profile: 16 + 44 + 8 + pill + 8 + 104 + 16 = 393. Everything but the
      // pill is fixed, so the pill IS the remainder — spelled out rather than
      // asserted as a bare literal, so a change to any term shows up as the
      // wrong pill.
      const profileFixed =
        layout.pageGutter * 2 +
        glassNavBubbleSizes.medium +
        8 +
        8 +
        glassNavBubbleGroupWidth(2, 'medium');
      expect(393 - profileFixed).toBe(197);
    });

    /*
      THE PROFILE VARIANT SWAPS THE TRAILING CONTROL AND NOTHING ELSE — an
      edit/share capsule where Home's search + bell capsule is, plus the static
      pill Home dropped. So the assertion that matters is EXCLUSION: a variant
      that merely added its own controls beside the existing ones would put too
      many symbols in the capsule.
    */
    it('draws search and edit (no share) instead of the bell', () => {
      renderHeader({ floating: true, trailing: profileTrailing() });

      expect(screen.getByTestId('home-header-edit')).toBeTruthy();
      // Share left Home (owner, 2026-11-21).
      expect(screen.queryByTestId('home-header-share')).toBeNull();
      // The bell belongs to Home's bar, not this one.
      expect(screen.queryByTestId('home-header-notifications')).toBeNull();

      // One capsule with TWO 36pt slots: search + edit.
      const capsule = StyleSheet.flatten(screen.getByTestId('home-header-trailing').props.style);
      expect(capsule.width).toBe(glassNavBubbleGroupWidth(2, 'medium'));
      expect(capsule.height).toBe(glassNavBubbleSizes.medium);
      for (const testID of ['home-header-search', 'home-header-edit']) {
        expect(StyleSheet.flatten(screen.getByTestId(testID).props.style).width).toBe(36);
      }
    });

    it('profile bar (Figma 6502:7657): menu alone leads, Ask Ekalight sits just before the capsule', () => {
      const onOpenAssistant = jest.fn();
      renderHeader({ floating: true, onOpenAssistant, trailing: profileTrailing() });

      const row = screen.getByTestId('home-header-row');
      // Exactly two row children: the lone menu bubble, then the trailing group.
      const [leading, trailingGroup] = row.children as unknown as {
        props: { testID?: string };
        findByProps: (p: object) => unknown;
      }[];
      expect(leading.props.testID).toBe('home-header-menu');
      expect(trailingGroup.findByProps({ testID: 'home-header-assistant' })).toBeTruthy();
      expect(trailingGroup.findByProps({ testID: 'home-header-trailing' })).toBeTruthy();
      // Same two-star flare as Social (owner, 2026-11-21).
      expect(screen.getByTestId('ekalight-ai-flare')).toBeTruthy();
      expect(screen.getByTestId('ekalight-ai-ring')).toBeTruthy();
      const ai = screen.getByTestId('home-header-assistant');
      fireEvent.press(ai);
      expect(onOpenAssistant).toHaveBeenCalledTimes(1);
    });

    it('wires each profile slot to its own action', () => {
      const onEditProfile = jest.fn();
      renderHeader({ floating: true, trailing: profileTrailing({ onEditProfile }) });

      const edit = screen.getByTestId('home-header-edit');
      // Spoken labels, since the slots are glyph-only.
      expect(edit.props.accessibilityLabel).toBe('Edit profile');
      fireEvent.press(edit);
      expect(onEditProfile).toHaveBeenCalledTimes(1);
    });

    // The reverse guard: Home must not pick up the profile pair. Both screens
    // draw ONE component, so this is the assertion that catches a variant
    // default flipping the wrong way.
    it('keeps edit and share OFF Home’s bar', () => {
      renderHeader({ floating: true, trailing: homeTrailing() });

      expect(screen.queryByTestId('home-header-edit')).toBeNull();
      expect(screen.queryByTestId('home-header-share')).toBeNull();
    });
  });

  /*
    NO PILL ON EITHER VARIANT since 4134:50957 — the profile's "Search Cards"
    pill became the search slot in the trailing capsule. The magnifier must
    keep working mid-scroll, the exact moment the retired pill's fade used to
    take search away.
  */
  describe('the search slot', () => {
    it('search works on the profile bar mid-scroll, and the pill is gone', () => {
      const onOpenSearch = jest.fn();
      renderHeader({
        floating: true,
        scrollY: new Animated.Value(240),
        trailing: profileTrailing({ onOpenSearch }),
      });

      expect(screen.queryByText('Search Cards')).toBeNull();
      fireEvent.press(screen.getByTestId('home-header-search'));
      expect(onOpenSearch).toHaveBeenCalledTimes(1);
    });

    it('does not render the pill on Home either', () => {
      renderHeader({ floating: true, trailing: homeTrailing() });

      expect(screen.queryByText('Search Cards')).toBeNull();
      expect(screen.queryByTestId('home-header-mark')).toBeNull();
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
