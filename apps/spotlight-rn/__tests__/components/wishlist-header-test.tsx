import { Animated, StyleSheet } from 'react-native';
import { fireEvent, screen } from '@testing-library/react-native';

import { glassNavBubbleSizes } from '@spotlight/design-system';

import {
  WISHLIST_HEADER_BAR_HEIGHT,
  WISHLIST_TITLE_HIDE_DISTANCE,
  WishlistHeader,
} from '@/features/wishlist/components/wishlist-header';

import { renderWithProviders } from '../test-utils';

/**
 * The Wishlist bar, which now behaves like Home's: THE BUBBLES PIN, THE TITLE
 * LEAVES. The whole bar used to sit in normal flow above the list, so it could
 * only ever scroll away as one piece — which takes the menu and the actions off
 * screen with it, the same regression `HomeHeader`'s own note exists to stop.
 *
 * These tests are about WIRING and ORIGIN, not motion. `HomeHeader` shipped a
 * `searchOpacity` prop it never applied for months because nothing asserted the
 * animation reached the tree; the fade's ANCHOR then shipped wrong on two
 * screens because nothing asserted where the range starts. Both are pinned here.
 */

function renderHeader(props: Partial<Parameters<typeof WishlistHeader>[0]> = {}) {
  return renderWithProviders(<WishlistHeader onOpenMenu={jest.fn()} {...props} />);
}

/** The `Animated.View` wrapping the title — the clip's only child. */
function titleWrapper() {
  return screen.getByTestId('wishlist-header-title-clip').props.children;
}

/**
 * The title wrapper's HOST node, whose style carries the interpolation already
 * RESOLVED to numbers (the React element above still holds animated nodes). It
 * is the only way the fade's origin is observable off-device.
 */
function titleMotionStyle() {
  return StyleSheet.flatten(screen.getByTestId('wishlist-header-title-motion').props.style) as {
    opacity: number;
    transform: { translateY: number }[];
  };
}

describe('WishlistHeader', () => {
  /*
    THE NUMBER, PINNED AS A LITERAL. A floating bar contributes nothing to
    layout, so the list under it reserves this height by hand — and a literal,
    not arithmetic against the same constants that produce it, or the assertion
    is tautological.

    8pt of padding above a 44pt control row. NO bottom padding, unlike Home's 56:
    the first thing in this list carries its own 24pt top margin.
  */
  it('reserves 8pt above a 44pt control row, and nothing below it', () => {
    expect(WISHLIST_HEADER_BAR_HEIGHT).toBe(52);
    expect(glassNavBubbleSizes.compact).toBe(40);
  });

  // The timing was inherited from Home's retired search pill (56) and kept as
  // a literal once the pill left — a re-picked number would read as a
  // different bar.
  it('leaves over the 56pt the retired Home pill took', () => {
    expect(WISHLIST_TITLE_HIDE_DISTANCE).toBe(56);
  });

  it('floats above the list rather than taking up a row of it', () => {
    renderHeader({ floating: true });

    const bar = StyleSheet.flatten(screen.getByTestId('wishlist-header').props.style);
    expect(bar.position).toBe('absolute');
    expect(bar.top).toBe(0);
    // Never eats the taps and scrolls meant for the list underneath.
    expect(screen.getByTestId('wishlist-header').props.pointerEvents).toBe('box-none');
  });

  describe('the title’s travel', () => {
    it('is fully visible while the page is at rest', () => {
      renderHeader({ floating: true, scrollY: new Animated.Value(0) });

      const style = titleMotionStyle();
      expect(style.opacity).toBe(1);
      expect(style.transform[0].translateY).toBe(0);
    });

    it('has begun moving one point into the scroll', () => {
      renderHeader({ floating: true, scrollY: new Animated.Value(1) });

      expect(titleMotionStyle().opacity).toBeLessThan(1);
    });

    it('is gone once the page has travelled the hide distance', () => {
      renderHeader({
        floating: true,
        scrollY: new Animated.Value(WISHLIST_TITLE_HIDE_DISTANCE),
      });

      const style = titleMotionStyle();
      expect(style.opacity).toBe(0);
      // Travelled the control row plus the padding above it, so it is entirely
      // past the clip's top edge rather than dissolving where it stands.
      expect(style.transform[0].translateY).toBe(-WISHLIST_HEADER_BAR_HEIGHT);
    });

    /*
      THE ORIGIN, NOT THE DISTANCE. This screen's list is not inset, so it rests
      at 0 — but the fade is written against `scrollRestOffset` so that the day
      it becomes an `contentInsetAdjustmentBehavior="automatic"` list resting at
      `-insets.top`, the title does not sit fully visible for a whole safe-area
      inset before starting to move. That precise bug shipped on Home AND
      Collection; this is the guard against a third screen.
    */
    it('anchors at a negative rest offset when the page is inset', () => {
      const REST = -59;
      renderHeader({
        floating: true,
        scrollRestOffset: REST,
        scrollY: new Animated.Value(REST),
      });

      expect(titleMotionStyle().opacity).toBe(1);

      screen.unmount();
      renderHeader({
        floating: true,
        scrollRestOffset: REST,
        scrollY: new Animated.Value(REST + WISHLIST_TITLE_HIDE_DISTANCE),
      });

      expect(titleMotionStyle().opacity).toBe(0);
    });

    it('turns the scroll offset into a slide AND a fade', () => {
      renderHeader({ floating: true, scrollY: new Animated.Value(0) });

      // Opacity alone reads as a title stuck to the top of the screen rather
      // than one travelling out of the row.
      const style = StyleSheet.flatten(titleWrapper().props.style);
      expect(style.transform).toBeTruthy();
      expect(style.opacity).toBeTruthy();
    });

    it('leaves the title solid and static when no scroll offset is given', () => {
      renderHeader();

      expect(StyleSheet.flatten(titleWrapper().props.style)).toBeFalsy();
      expect(screen.getByTestId('wishlist-header-title')).toBeTruthy();
    });

    // The clip is what actually REMOVES the title: without it a half-faded
    // "Wishlist" draws up beside the status-bar clock.
    it('clips the title to its own line box', () => {
      renderHeader({ floating: true, scrollY: new Animated.Value(0) });

      const clip = screen.getByTestId('wishlist-header-title-clip');
      expect(StyleSheet.flatten(clip.props.style).overflow).toBe('hidden');
    });

    // `pointerEvents` is not animatable, so this is a separate JS decision from
    // the animation. Without it an invisible label sits over the first row.
    it('disarms the title once it has left the row', () => {
      renderHeader({ floating: true, scrollY: new Animated.Value(0) });
      expect(titleWrapper().props.pointerEvents).toBe('auto');

      screen.unmount();
      renderHeader({
        floating: true,
        scrollY: new Animated.Value(WISHLIST_TITLE_HIDE_DISTANCE),
        titleVisible: false,
      });
      expect(titleWrapper().props.pointerEvents).toBe('none');
    });
  });

  /*
    THE HALF THE USER ASKED FOR. "The buttons stay but the wishlist goes away."
    Only the title carries the motion — the bubbles either side of it must be
    untouched by it and still pressable at BOTH ends of the scroll, which is
    exactly what an in-flow bar that scrolled away as one piece could not do.
  */
  describe('the pinned controls', () => {
    it.each([
      ['at rest', 0],
      ['after the title has gone', WISHLIST_TITLE_HIDE_DISTANCE],
    ])('stay put and stay tappable %s', (_label, offset) => {
      const onOpenMenu = jest.fn();
      const onOpenSearch = jest.fn();
      const onShare = jest.fn();
      const onToggleEditMode = jest.fn();
      renderHeader({
        floating: true,
        onOpenMenu,
        onOpenSearch,
        onShare,
        onToggleEditMode,
        scrollY: new Animated.Value(offset),
        titleVisible: offset === 0,
      });

      // None of the controls sit inside the clipped, animated title wrapper.
      const clip = screen.getByTestId('wishlist-header-title-clip');
      for (const testID of [
        'wishlist-header-menu',
        'wishlist-header-search',
        'wishlist-header-edit',
        'wishlist-header-share',
      ]) {
        const control = screen.getByTestId(testID);
        // Fully opaque at both ends — the fade belongs to the title alone.
        // (`?? 1` because the pressables carry their own pressed-state opacity.)
        expect(StyleSheet.flatten(control.props.style)?.opacity ?? 1).toBe(1);
        for (
          let node: typeof control | null = control.parent;
          node;
          node = node.parent
        ) {
          expect(node).not.toBe(clip);
        }
      }

      fireEvent.press(screen.getByTestId('wishlist-header-menu'));
      fireEvent.press(screen.getByTestId('wishlist-header-search'));
      fireEvent.press(screen.getByTestId('wishlist-header-edit'));
      fireEvent.press(screen.getByTestId('wishlist-header-share'));
      expect(onOpenMenu).toHaveBeenCalledTimes(1);
      expect(onOpenSearch).toHaveBeenCalledTimes(1);
      expect(onToggleEditMode).toHaveBeenCalledTimes(1);
      expect(onShare).toHaveBeenCalledTimes(1);
    });

    /*
      EDIT MODE swaps a wider "Done" pill into the right slot. It must not fight
      the title's animation, and the reason it does not is geometric: the pill is
      40 tall, exactly like the `GlassButtonGroup` it replaces and the menu
      bubble opposite it, so the row height — and therefore the bar height the
      list reserves — is identical in both modes.
    */
    it('still pins Done, mid-scroll, without disturbing the title’s travel', () => {
      const onToggleEditMode = jest.fn();
      renderHeader({
        editMode: true,
        floating: true,
        onToggleEditMode,
        scrollY: new Animated.Value(WISHLIST_TITLE_HIDE_DISTANCE / 2),
        titleVisible: true,
      });

      // The browse actions stand down in edit mode; Done takes the slot.
      expect(screen.queryByTestId('wishlist-header-actions')).toBeNull();
      fireEvent.press(screen.getByTestId('wishlist-header-done'));
      expect(onToggleEditMode).toHaveBeenCalledTimes(1);

      // Half-way through the same fade it would be running outside edit mode.
      const style = titleMotionStyle();
      expect(style.opacity).toBeCloseTo(0.5, 5);
      expect(style.transform[0].translateY).toBeCloseTo(-WISHLIST_HEADER_BAR_HEIGHT / 2, 5);
    });
  });
});
