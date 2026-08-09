import { Animated, StyleSheet } from 'react-native';
import { screen } from '@testing-library/react-native';

import { HomeHeader, SEARCH_PILL_HIDE_DISTANCE } from '@/components/home-header';

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
 */
function renderHeader(props: Partial<Parameters<typeof HomeHeader>[0]> = {}) {
  return renderWithProviders(
    <HomeHeader
      addAccessibilityLabel="New post"
      onOpenAdd={jest.fn()}
      onOpenMenu={jest.fn()}
      onOpenNotifications={jest.fn()}
      onOpenSearch={jest.fn()}
      testID="home-header"
      unreadCount={0}
      {...props}
    />,
  );
}

/** The `Animated.View` wrapping the pill — the clip's only child. */
function pillWrapper() {
  return screen.getByTestId('home-header-search-clip').props.children;
}

describe('HomeHeader', () => {
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
        addAccessibilityLabel="New post"
        floating
        onOpenAdd={jest.fn()}
        onOpenMenu={jest.fn()}
        onOpenNotifications={jest.fn()}
        onOpenSearch={jest.fn()}
        scrollY={scrollY}
        searchInteractive={false}
        testID="home-header"
        unreadCount={0}
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
    renderHeader({ floating: true, scrollY: new Animated.Value(0), unreadCount: 3 });

    const clip = screen.getByTestId('home-header-search-clip');
    expect(StyleSheet.flatten(clip.props.style).overflow).toBe('hidden');

    expect(screen.getByTestId('home-header-notifications-badge')).toBeTruthy();
    expect(screen.getByText('3')).toBeTruthy();
  });
});
