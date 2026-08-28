import { Animated, StyleSheet } from 'react-native';
import { fireEvent, screen } from '@testing-library/react-native';

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
 * both frames, so the rightmost control is the only difference between Home's
 * toolbar (a search + bell capsule — there is NO search pill on Home) and the
 * profile's (a static pill mid-row plus an edit/share capsule), and each
 * variant has to exclude the other's controls rather than merely include its
 * own.
 */

/** Home's trailing control: the search + bell capsule. Nothing else. */
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
    onShareProfile: jest.fn(),
    ...overrides,
  };
}

function renderHeader(props: Partial<Parameters<typeof HomeHeader>[0]> = {}) {
  return renderWithProviders(
    <HomeHeader
      onOpenMenu={jest.fn()}
      onOpenSearch={jest.fn()}
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
    THE TRAILING CONTROL. Home's is ONE 44pt glass capsule holding the search
    glyph and the bell (Figma 4299:94902) — two 36pt symbol slots on a 20pt
    gap, `glassNavBubbleGroupWidth(2, 'medium')` = 104 wide. There is NO
    full-width search pill on Home any more; search is a destination behind the
    magnifier slot. The profile bar keeps its static pill mid-row and swaps the
    capsule's contents for edit + share.
  */
  describe('the trailing control', () => {
    it('puts search and the bell in ONE capsule on Home, with no search pill', () => {
      const onOpenNotifications = jest.fn();
      const onOpenSearch = jest.fn();
      renderHeader({
        floating: true,
        onOpenSearch,
        trailing: { kind: 'home', onOpenNotifications, unreadCount: 0 },
      });

      // The full Home control set: menu | capsule(search, bell).
      expect(screen.getByTestId('home-header-menu')).toBeTruthy();
      expect(screen.getByTestId('home-header-trailing')).toBeTruthy();

      // NO SearchEntryPill on the home bar — search is a glyph slot, not a
      // field, so the pill's copy must not render anywhere.
      expect(screen.queryByText('Search Cards')).toBeNull();

      const search = screen.getByTestId('home-header-search');
      expect(search.props.accessibilityLabel).toBe('Search cards');
      fireEvent.press(search);
      expect(onOpenSearch).toHaveBeenCalledTimes(1);

      const bell = screen.getByTestId('home-header-notifications');
      expect(bell.props.accessibilityLabel).toBe('Notifications');
      fireEvent.press(bell);
      expect(onOpenNotifications).toHaveBeenCalledTimes(1);
    });

    it('draws the Home capsule 104×44 with two 36pt slots', () => {
      renderHeader({ floating: true, trailing: homeTrailing() });

      const capsule = StyleSheet.flatten(screen.getByTestId('home-header-trailing').props.style);
      expect(capsule.width).toBe(glassNavBubbleGroupWidth(2, 'medium'));
      expect(capsule.width).toBe(104);
      expect(capsule.height).toBe(glassNavBubbleSizes.medium);
      for (const testID of ['home-header-search', 'home-header-notifications']) {
        expect(StyleSheet.flatten(screen.getByTestId(testID).props.style).width).toBe(36);
      }
    });

    // The badge hangs off the bell SLOT at `top: -2, right: -2`. Moving the
    // bell from a lone bubble into the capsule is exactly the change that
    // would have clipped it, so slot and capsule must stay `overflow:
    // 'visible'`.
    it('lets the unread badge overhang the bell slot', () => {
      renderHeader({ floating: true, trailing: homeTrailing(3) });

      expect(screen.getByTestId('home-header-notifications-badge')).toBeTruthy();
      expect(screen.getByText('3')).toBeTruthy();
      expect(
        StyleSheet.flatten(screen.getByTestId('home-header-notifications').props.style).overflow,
      ).toBe('visible');
      expect(
        StyleSheet.flatten(screen.getByTestId('home-header-trailing').props.style).overflow,
      ).toBe('visible');
      // The unread count is spoken from the bell slot itself.
      expect(screen.getByTestId('home-header-notifications').props.accessibilityLabel).toBe(
        'Notifications, 3 unread',
      );
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
    it('draws edit and share instead of search and the bell', () => {
      renderHeader({ floating: true, trailing: profileTrailing() });

      expect(screen.getByTestId('home-header-edit')).toBeTruthy();
      expect(screen.getByTestId('home-header-share')).toBeTruthy();
      // The bell belongs to Home's bar, not this one.
      expect(screen.queryByTestId('home-header-notifications')).toBeNull();

      // Still one capsule with two 36pt slots — 104×44 in the medium size.
      const capsule = StyleSheet.flatten(screen.getByTestId('home-header-trailing').props.style);
      expect(capsule.width).toBe(glassNavBubbleGroupWidth(2, 'medium'));
      expect(capsule.height).toBe(glassNavBubbleSizes.medium);
      for (const testID of ['home-header-edit', 'home-header-share']) {
        expect(StyleSheet.flatten(screen.getByTestId(testID).props.style).width).toBe(36);
      }
    });

    it('wires each profile slot to its own action', () => {
      const onEditProfile = jest.fn();
      const onShareProfile = jest.fn();
      renderHeader({ floating: true, trailing: profileTrailing({ onEditProfile, onShareProfile }) });

      const edit = screen.getByTestId('home-header-edit');
      const share = screen.getByTestId('home-header-share');
      // Spoken labels, since the slots are glyph-only.
      expect(edit.props.accessibilityLabel).toBe('Edit profile');
      expect(share.props.accessibilityLabel).toBe('Share profile');

      fireEvent.press(edit);
      expect(onEditProfile).toHaveBeenCalledTimes(1);
      expect(onShareProfile).not.toHaveBeenCalled();

      fireEvent.press(share);
      expect(onShareProfile).toHaveBeenCalledTimes(1);
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
    THE PILL IS STATIC. The scroll-linked slide-and-fade (and its clip wrapper
    and disarm plumbing) left with the 4299:94902 bar: the profile pill just
    sits in the row, always visible and always tappable, whatever the scroll
    offset is doing.
  */
  describe('the search pill', () => {
    it('renders statically on the profile bar — no motion wrapper, no clip', () => {
      const onOpenSearch = jest.fn();
      renderHeader({
        floating: true,
        onOpenSearch,
        scrollY: new Animated.Value(240),
        trailing: profileTrailing(),
      });

      expect(screen.getByText('Search Cards')).toBeTruthy();
      // The old scroll-linked wrapper and its clip are gone entirely.
      expect(screen.queryByTestId('home-header-search-motion')).toBeNull();
      expect(screen.queryByTestId('home-header-search-clip')).toBeNull();

      // Still a working control mid-scroll — the exact moment the old fade
      // used to take it away.
      fireEvent.press(screen.getByTestId('home-header-search'));
      expect(onOpenSearch).toHaveBeenCalledTimes(1);
    });

    it('does not render at all on Home', () => {
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

    it('needs a scroll offset to fade against', () => {
      renderHeader({ floating: true, pinnedBackdrop: true });

      expect(screen.queryByTestId('home-header-backdrop')).not.toBeOnTheScreen();
    });
  });
});
