import { fireEvent, render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';

import { AppTabBar, getAppTabBarHeight, TAB_BAR_LABELS } from '@/components/tab-pager/app-tab-bar';

let mockAvatarURL: string | null = null;
let mockRaster: unknown = null;

jest.mock('@/providers/auth-provider', () => ({
  useAuth: () => ({ currentUser: mockAvatarURL ? { avatarURL: mockAvatarURL } : null }),
}));

jest.mock('@/components/circular-tab-avatar', () => ({
  TAB_ICON_POINTS: 28,
  useCircularTabAvatar: () => mockRaster,
}));

function renderBar(focusedPage = 0, onSelectPage = jest.fn()) {
  // The reanimated jest mock reads `.value` straight off a plain object.
  const position = { value: focusedPage } as never;
  render(<AppTabBar bottomInset={34} focusedPage={focusedPage} onSelectPage={onSelectPage} position={position} />);
  return onSelectPage;
}

describe('AppTabBar', () => {
  beforeEach(() => {
    mockAvatarURL = null;
    mockRaster = null;
  });

  it('labels the five tabs in bar order, in capitals — WATCHLIST, never WISHLIST', () => {
    renderBar();
    const labels = screen.UNSAFE_getAllByType(Text).map((node) => node.props.children);
    expect(labels).toEqual(['HOME', 'WATCHLIST', 'SCAN', 'EVENTS', 'SOCIAL']);
    expect(Object.values(TAB_BAR_LABELS)).not.toContain('WISHLIST');
  });

  it('marks the focused page selected for accessibility', () => {
    renderBar(2);
    expect(screen.getByTestId('app-tab-scan').props.accessibilityState).toEqual({ selected: true });
    expect(screen.getByTestId('app-tab-index').props.accessibilityState).toEqual({ selected: false });
  });

  it('reports taps by page index, including a re-tap of the focused page (scroll-to-top)', () => {
    const onSelectPage = renderBar(1);
    fireEvent.press(screen.getByTestId('app-tab-events'));
    fireEvent.press(screen.getByTestId('app-tab-wishlist'));
    expect(onSelectPage.mock.calls).toEqual([[3], [1]]);
  });

  it('draws the account photo on SOCIAL when there is one', () => {
    mockAvatarURL = 'https://example.com/me.jpg';
    renderBar();
    expect(screen.getByTestId('app-tab-bar-avatar-image').props.source).toEqual({ uri: 'https://example.com/me.jpg' });
    expect(screen.queryByTestId('app-tab-bar-avatar-glyph')).toBeNull();
  });

  it('falls back to the circular raster, then to the glyph', () => {
    mockRaster = { uri: 'data:image/png;base64,PNG' };
    const first = render(
      <AppTabBar bottomInset={0} focusedPage={0} onSelectPage={jest.fn()} position={{ value: 0 } as never} />,
    );
    expect(screen.getByTestId('app-tab-bar-avatar-image').props.source).toEqual(mockRaster);
    first.unmount();

    mockRaster = null;
    renderBar();
    expect(screen.queryByTestId('app-tab-bar-avatar')).toBeNull();
    expect(screen.getAllByTestId('app-tab-bar-avatar-glyph').length).toBeGreaterThan(0);
  });

  it('falls back from a photo that fails to load instead of drawing an empty circle', () => {
    mockAvatarURL = 'https://example.com/broken.jpg';
    renderBar();
    fireEvent(screen.getByTestId('app-tab-bar-avatar-image'), 'error');
    expect(screen.queryByTestId('app-tab-bar-avatar-image')).toBeNull();
    expect(screen.getAllByTestId('app-tab-bar-avatar-glyph').length).toBeGreaterThan(0);
  });

  it('draws both the light material and the dark scanner slab, so the drag can blend them', () => {
    renderBar();
    expect(screen.getByTestId('app-tab-bar-dark')).toBeTruthy();
    // Every iOS version gets the frosted full-width blur (no see-through glass capsule).
    expect(screen.getByTestId('app-tab-bar-blur')).toBeTruthy();
  });

  it('keeps the scanner bar geometry: 8 + 54 row + max(25, home indicator)', () => {
    expect(getAppTabBarHeight(0)).toBe(8 + 54 + 25);
    expect(getAppTabBarHeight(34)).toBe(8 + 54 + 34);
    renderBar();
    expect(screen.getByTestId('app-tab-bar').props.style).toEqual(
      expect.arrayContaining([expect.objectContaining({ height: 96 })]),
    );
  });
});
