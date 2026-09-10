import { fireEvent, render, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import {
  CarouselPagination,
  FollowButton,
  SpotlightThemeProvider,
  colors,
} from '@spotlight/design-system';

function renderWithTheme(node: React.ReactElement) {
  return render(<SpotlightThemeProvider>{node}</SpotlightThemeProvider>);
}

function flatten(node: { props: { style?: unknown } }) {
  return StyleSheet.flatten(node.props.style) ?? {};
}

/**
 * The follow control's ONE-WAY contract, which is the whole point of the
 * component: a followed row must not be able to unfollow by accident. Asserted
 * on the press path rather than on the styling, because "looks different" is
 * not what protects the follow graph.
 */
describe('FollowButton', () => {
  it('follows on press while un-followed', () => {
    const onPress = jest.fn();
    renderWithTheme(<FollowButton following={false} onPress={onPress} testID="follow" />);

    expect(screen.getByTestId('follow')).toBeTruthy();
    fireEvent.press(screen.getByTestId('follow'));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('exposes no button at all once following, so there is no accidental unfollow', () => {
    const { rerender } = renderWithTheme(
      <FollowButton following={false} onPress={jest.fn()} testID="follow" />,
    );
    // Un-followed: a real button, reachable by role.
    expect(screen.queryByRole('button', { name: 'Follow' })).toBeTruthy();

    rerender(
      <SpotlightThemeProvider>
        <FollowButton following onPress={jest.fn()} testID="follow" />
      </SpotlightThemeProvider>,
    );
    // Followed: the control is gone from the tree — a plain labelled View, not
    // a disabled button that could be re-enabled by a later refactor.
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByLabelText('Following')).toBeTruthy();
  });

  it('inverts its weight between the two states (quiet invite, loud confirmation)', () => {
    const { rerender } = renderWithTheme(<FollowButton following={false} testID="follow" />);
    expect(flatten(screen.getByTestId('follow'))).toMatchObject({
      backgroundColor: colors.canvasElevated,
      borderColor: colors.gray200,
    });

    rerender(
      <SpotlightThemeProvider>
        <FollowButton following testID="follow" />
      </SpotlightThemeProvider>,
    );
    expect(flatten(screen.getByTestId('follow'))).toMatchObject({
      backgroundColor: colors.gray900,
      borderColor: colors.gray900,
    });
  });
});

describe('CarouselPagination', () => {
  it('draws one bar for the active slide and a dot for every other', () => {
    renderWithTheme(<CarouselPagination activeIndex={2} count={5} testID="pager" />);

    expect(screen.getByTestId('pager-active-2')).toBeTruthy();
    expect(screen.queryByTestId('pager-dot-2')).toBeNull();
    for (const index of [0, 1, 3, 4]) {
      expect(screen.getByTestId(`pager-dot-${index}`)).toBeTruthy();
      expect(screen.queryByTestId(`pager-active-${index}`)).toBeNull();
    }
  });

  it('renders nothing for a single slide, which has no position to report', () => {
    renderWithTheme(<CarouselPagination activeIndex={0} count={1} testID="pager" />);
    expect(screen.queryByTestId('pager')).toBeNull();
  });

  it('sizes the active bar wider than a dot so the position reads at a glance', () => {
    renderWithTheme(<CarouselPagination activeIndex={0} count={3} testID="pager" />);

    const active = flatten(screen.getByTestId('pager-active-0')) as { width?: number };
    const dot = flatten(screen.getByTestId('pager-dot-1')) as { width?: number };
    expect(active.width).toBe(24);
    expect(dot.width).toBe(6);
  });
});
