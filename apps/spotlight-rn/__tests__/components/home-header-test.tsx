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
  SEARCH_PILL_HIDE_DISTANCE,
  type HomeHeaderTrailing,
} from '@/components/home-header';

import { renderWithProviders } from '../test-utils';

/**
 * The bar Home and Collection share.
 *
 * THIS FILE EXISTS BECAUSE ITS ABSENCE COST US. `HomeHeader` took a
 * `searchOpacity` prop, documented it at length, and never applied it — the pill
 * was a plain `<View>` with no opacity, no transform, no `pointerEvents`. Both
 * screens computed the interpolation and passed it in to be dropped on the
 * floor, so the pill sat pinned at the top while posts scrolled under it, and it
 * survived several rounds of header work because nothing asserted the props
 * reached the tree.
 *
 * So these tests are about WIRING, not motion: that the scroll offset produces a
 * real animated style and that the tap target can be switched off. The
 * interpolated VALUES are not asserted — jest runs no native driver, so a
 * `scrollY` that never advances would report the resting style either way.
 *
 * The `trailing` variant is the other thing asserted here: ONE component draws
 * both frames, so the rightmost control is the only difference between Home's
 * toolbar (a lone bell bubble — the `+` compose control was removed and the
 * pill widened into its space) and the profile's (3670:47454, an edit/share
 * capsule), and each variant has to exclude the other's controls rather than
 * merely include its own.
 */

/** Home's trailing control: the bell (optionally badged). Nothing else. */
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

/** The `Animated.View` wrapping the pill — the clip's only child. */
function pillWrapper() {
  return screen.getByTestId('home-header-search-clip').props.children;
}

/**
 * The pill wrapper's HOST node, whose style carries the interpolation already
 * RESOLVED to numbers (the React element above still holds animated nodes). It
 * is the only way the fade's origin is observable off-device.
 */
function pillMotionStyle() {
  return StyleSheet.flatten(screen.getByTestId('home-header-search-motion').props.style) as {
    opacity: number;
    transform: { translateY: number }[];
  };
}

describe('HomeHeader', () => {
  /*
    THE NUMBERS, PINNED AS LITERALS. A floating bar contributes nothing to
    layout, so every screen under it reserves `HOME_HEADER_BAR_HEIGHT` by hand
    and anything pinning below it stops at `HOME_HEADER_ROW_HEIGHT` — both are
    derived constants that quietly drifted from the frame (the bar padded 10pt
    above the row and nothing below it, against a symmetric 8/8) because nothing
    read them back. Literals, not arithmetic against the same constants that
    produce them, or the assertion is tautological.

    Figma "Home" 3523:15499, toolbar 3567:22969: 8 + a 40pt control row + 8.
  */
  it('reserves the frame’s bar and row heights', () => {
    expect(HOME_HEADER_BAR_HEIGHT).toBe(56);
    // The bottom edge of the bubbles — where Collection's page-tab bar pins.
    expect(HOME_HEADER_ROW_HEIGHT).toBe(48);
  });

  it('pads the control row symmetrically, 8pt above and below', () => {
    renderHeader({ floating: true });

    const row = StyleSheet.flatten(screen.getByTestId('home-header-row').props.style);
    expect(row.paddingTop).toBe(8);
    // The bar owns the space under its own controls now that no rule follows
    // them; without this the first post rides up under the bubbles.
    expect(row.paddingBottom).toBe(8);
  });

  /*
    THE TRAILING CONTROL. Home's is a LONE 40pt bell bubble — the `+` compose
    control was removed, so there is no capsule left on Home and the flexed
    pill takes the width the 90pt bell-and-`+` group used to hold. The profile
    pair still shares a single 90×40 `Button Group` (`Trailing → Button
    Group 1`, two 36pt symbol frames at x=6 and x=48) rather than two 40pt
    circles — Apple's iOS 26 grouped-toolbar pattern, and the 2pt: that row
    only closes at 393 with a 90pt trailing control, and two circles plus the
    row's gap measure 88.
  */
  describe('the trailing control', () => {
    it('renders NO create-post control on Home — just menu, pill, and bell', () => {
      const onOpenNotifications = jest.fn();
      renderHeader({
        floating: true,
        trailing: { kind: 'home', onOpenNotifications, unreadCount: 0 },
      });

      // The `+` is gone entirely, not merely re-homed somewhere else in the bar.
      expect(screen.queryByTestId('home-header-add')).toBeNull();
      // And with one symbol left there is no capsule either — the bell stands
      // alone, so the pill (flex: 1) stretches into the freed space.
      expect(screen.queryByTestId('home-header-trailing')).toBeNull();

      // The full Home control set: menu | pill | bell, bell rightmost.
      expect(screen.getByTestId('home-header-menu')).toBeTruthy();
      expect(screen.getByTestId('home-header-search')).toBeTruthy();
      const bell = screen.getByTestId('home-header-notifications');
      expect(bell.props.accessibilityLabel).toBe('Notifications');

      fireEvent.press(bell);
      expect(onOpenNotifications).toHaveBeenCalledTimes(1);
    });

    it('draws the bell as a 40pt bubble, level with the menu bubble', () => {
      renderHeader({ floating: true, trailing: homeTrailing() });

      const bell = StyleSheet.flatten(screen.getByTestId('home-header-notifications').props.style);
      expect(bell.width).toBe(glassNavBubbleSizes.compact);
      expect(bell.height).toBe(glassNavBubbleSizes.compact);
    });

    it('leaves the flexed search pill 265 on Home and 215 on the profile at a 393pt width', () => {
      // Home: 16 + 40 + 8 + pill + 8 + 40 + 16 = 393. Everything but the pill
      // is fixed, so the pill IS the remainder — spelled out rather than
      // asserted as a bare literal, so a change to any term shows up as the
      // wrong pill. The trailing term is a lone 40pt bubble now; the 50 the
      // 90pt capsule held beyond that went to the pill (215 → 265).
      const homeFixed = layout.pageGutter * 2 + glassNavBubbleSizes.compact * 2 + 8 + 8;
      expect(393 - homeFixed).toBe(265);

      // Profile: 16 + 40 + 8 + pill + 8 + 90 + 16 = 393 — unchanged.
      const profileFixed =
        layout.pageGutter * 2 + glassNavBubbleSizes.compact + 8 + 8 + glassNavBubbleGroupWidth(2);
      expect(393 - profileFixed).toBe(215);
    });

    // The badge hangs off the bell at `top: -2, right: -2`. Moving the bell
    // between shells is exactly the change that would have clipped it, so the
    // bubble must stay `overflow: 'visible'`.
    it('still lets the unread badge overhang the bell bubble', () => {
      renderHeader({ floating: true, trailing: homeTrailing(3) });

      expect(screen.getByTestId('home-header-notifications-badge')).toBeTruthy();
      expect(screen.getByText('3')).toBeTruthy();
      expect(
        StyleSheet.flatten(screen.getByTestId('home-header-notifications').props.style).overflow,
      ).toBe('visible');
    });

    /*
      THE PROFILE VARIANT SWAPS THE TRAILING CONTROL AND NOTHING ELSE. Figma
      3670:47454 is Home's toolbar with an edit/share capsule where the bell
      is — same 40pt menu bubble, same 8pt gaps, same flexed pill (215 here,
      against the 90pt capsule). So the assertion that matters is EXCLUSION: a
      variant that merely added its own controls beside the existing ones would
      put too many symbols in the capsule.
    */
    it('draws edit and share instead of the bell', () => {
      renderHeader({ floating: true, trailing: profileTrailing() });

      expect(screen.getByTestId('home-header-edit')).toBeTruthy();
      expect(screen.getByTestId('home-header-share')).toBeTruthy();
      // The bell belongs to Home's bar, not this one — and the old `+` compose
      // control belongs to neither.
      expect(screen.queryByTestId('home-header-notifications')).toBeNull();
      expect(screen.queryByTestId('home-header-add')).toBeNull();

      // Still one 90pt capsule with two 36pt slots — the geometry is shared.
      const capsule = StyleSheet.flatten(screen.getByTestId('home-header-trailing').props.style);
      expect(capsule.width).toBe(90);
      expect(capsule.height).toBe(glassNavBubbleSizes.compact);
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
    WHERE THE FADE STARTS. `scrollY` carries an ABSOLUTE `contentOffset.y`, and
    both callers run `contentInsetAdjustmentBehavior="automatic"` on iOS, so
    their lists REST at `-insets.top` — not 0. Interpolating from 0 left the
    pill fully open for the first whole safe-area inset of every scroll and only
    then began its 56pt fade.

    These are the assertions that are invisible unless the test models the
    negative rest offset, so they use a real device inset (59pt) rather than 0.
  */
  describe('the pill’s fade origin', () => {
    const IOS_REST = -59;

    it('is fully open at an inset list’s rest offset, not a status bar later', () => {
      renderHeader({
        floating: true,
        scrollRestOffset: IOS_REST,
        scrollY: new Animated.Value(IOS_REST),
      });

      const style = pillMotionStyle();
      expect(style.opacity).toBe(1);
      expect(style.transform[0].translateY).toBe(0);
    });

    it('has begun fading one point into the scroll', () => {
      renderHeader({
        floating: true,
        scrollRestOffset: IOS_REST,
        scrollY: new Animated.Value(IOS_REST + 1),
      });

      // The bug: at this offset the old range was still clamped wide open.
      expect(pillMotionStyle().opacity).toBeLessThan(1);
    });

    it('is fully gone after travelling the hide distance, not the inset plus it', () => {
      renderHeader({
        floating: true,
        scrollRestOffset: IOS_REST,
        scrollY: new Animated.Value(IOS_REST + SEARCH_PILL_HIDE_DISTANCE),
      });

      const style = pillMotionStyle();
      expect(style.opacity).toBe(0);
      // Travelled its own height plus the padding above it — clear of the clip.
      expect(style.transform[0].translateY).toBe(-HOME_HEADER_ROW_HEIGHT);
    });

    // ANDROID IS UNCHANGED. It takes the explicit-`paddingTop` branch, genuinely
    // rests at 0, and passes 0 — so the default has to behave exactly as before.
    it('still anchors at 0 for a list that rests at 0', () => {
      renderHeader({ floating: true, scrollY: new Animated.Value(0) });

      expect(pillMotionStyle().opacity).toBe(1);

      screen.unmount();
      renderHeader({ floating: true, scrollY: new Animated.Value(SEARCH_PILL_HIDE_DISTANCE) });

      expect(pillMotionStyle().opacity).toBe(0);
    });
  });

  it('turns the scroll offset into a slide AND a fade on the pill', () => {
    const scrollY = new Animated.Value(0);
    renderHeader({ floating: true, scrollY });

    // Both halves of the motion have to be present. Opacity alone was the old
    // (never-applied) design and read as the pill being stuck to the top of the
    // screen rather than travelling out of the row.
    const style = StyleSheet.flatten(pillWrapper().props.style);
    expect(style.transform).toBeTruthy();
    expect(style.opacity).toBeTruthy();
  });

  it('leaves the pill solid and static when no scroll offset is given', () => {
    renderHeader();

    expect(StyleSheet.flatten(pillWrapper().props.style)).toBeFalsy();
    // Still a working control, just one that never moves.
    expect(screen.getByTestId('home-header-search')).toBeTruthy();
  });

  // `pointerEvents` is not animatable, so this is a separate JS decision from
  // the animation. Without it the invisible pill stays a live tap target
  // hovering over the first post.
  it('disarms the pill once it has left the row', () => {
    const scrollY = new Animated.Value(0);
    const { rerender } = renderHeader({ floating: true, scrollY });

    expect(pillWrapper().props.pointerEvents).toBe('auto');

    rerender(
      <HomeHeader
        floating
        onOpenMenu={jest.fn()}
        onOpenSearch={jest.fn()}
        scrollY={scrollY}
        searchInteractive={false}
        testID="home-header"
        trailing={homeTrailing()}
      />,
    );

    expect(pillWrapper().props.pointerEvents).toBe('none');
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

    it('is solid by the time the pill has gone', () => {
      renderHeader({
        floating: true,
        pinnedBackdrop: true,
        scrollY: new Animated.Value(SEARCH_PILL_HIDE_DISTANCE),
      });

      const style = StyleSheet.flatten(screen.getByTestId('home-header-backdrop').props.style);
      expect(style.opacity).toBe(1);
    });

    it('needs a scroll offset to fade against', () => {
      renderHeader({ floating: true, pinnedBackdrop: true });

      expect(screen.queryByTestId('home-header-backdrop')).not.toBeOnTheScreen();
    });
  });

  // The clip is what actually removes the pill, and it has to stay on the
  // pill's OWN wrapper: the unread badge hangs outside its bubble at
  // `top: -2, right: -2`, so clipping any further up the row would shave it.
  it('clips the pill without clipping the unread badge', () => {
    renderHeader({ floating: true, scrollY: new Animated.Value(0), trailing: homeTrailing(3) });

    const clip = screen.getByTestId('home-header-search-clip');
    expect(StyleSheet.flatten(clip.props.style).overflow).toBe('hidden');

    expect(screen.getByTestId('home-header-notifications-badge')).toBeTruthy();
    expect(screen.getByText('3')).toBeTruthy();
  });
});
