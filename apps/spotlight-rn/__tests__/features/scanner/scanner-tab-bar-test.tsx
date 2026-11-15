import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import { colors } from '@spotlight/design-system';

import { getScannerTabBarHeight, ScannerTabBar } from '@/features/scanner/components/scanner-tab-bar';

jest.mock('@/components/circular-tab-avatar', () => ({
  useCircularTabAvatar: () => null,
}));
let mockAvatarURL: string | null = null;
jest.mock('@/providers/auth-provider', () => ({
  useAuth: () => ({ currentUser: mockAvatarURL ? { avatarURL: mockAvatarURL } : null }),
}));

const mockNavigate = jest.fn();
let mockFocused = true;
jest.mock('@react-navigation/native', () => ({
  ...jest.requireActual('@react-navigation/native'),
  useNavigation: () => ({ isFocused: () => mockFocused, navigate: mockNavigate }),
}));

// The route is exercised without the real scanner: the stub just exposes the
// tab bar the route wires up, which is what this file pins.
jest.mock('@/features/scanner/screens/scanner-screen', () => {
  const { ScannerTabBar: Bar } = jest.requireActual('@/features/scanner/components/scanner-tab-bar');
  return {
    ScannerScreen: ({ onSelectTab }: { onSelectTab?: (tab: string) => void }) =>
      (onSelectTab ? <Bar bottomInset={0} onSelectTab={onSelectTab} /> : null),
  };
});
jest.mock('@/components/mount-on-first-focus', () => ({
  MountOnFirstFocus: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('@/components/native-tabs-page-bridge', () => ({
  NativeTabsPageBridge: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('@/components/focused-status-bar', () => ({ FocusedStatusBar: () => null }));
jest.mock('@/providers/use-defer-data-refresh', () => ({ useDeferDataRefreshWhileFocused: () => undefined }));

describe('ScannerTabBar', () => {
  beforeEach(() => {
    mockNavigate.mockClear();
    mockFocused = true;
  });

  it('renders the five tabs with SCAN selected', () => {
    render(<ScannerTabBar bottomInset={34} onSelectTab={jest.fn()} />);

    for (const name of ['index', 'wishlist', 'scan', 'events', 'social']) {
      expect(screen.getByTestId(`scanner-tab-${name}`)).toBeTruthy();
    }
    expect(screen.getByTestId('scanner-tab-scan').props.accessibilityState).toEqual({ selected: true });
    expect(screen.getByTestId('scanner-tab-index').props.accessibilityState).toEqual({ selected: false });
    expect(screen.getAllByTestId('scanner-tab-selection')).toHaveLength(1);
    expect(StyleSheet.flatten(screen.getByTestId('scanner-tab-bar').props.style).backgroundColor)
      .toBe(colors.scannerTray);
    // Bottom padding is the Figma 25, or the home indicator when taller.
    expect(getScannerTabBarHeight(0)).toBe(8 + 54 + 25);
    expect(getScannerTabBarHeight(34)).toBe(8 + 54 + 34);
  });

  it('reports a tab press, and SCAN is a no-op', () => {
    const onSelectTab = jest.fn();
    render(<ScannerTabBar bottomInset={0} onSelectTab={onSelectTab} />);

    fireEvent.press(screen.getByTestId('scanner-tab-scan'));
    expect(onSelectTab).not.toHaveBeenCalled();

    fireEvent.press(screen.getByTestId('scanner-tab-index'));
    expect(onSelectTab).toHaveBeenCalledWith('index');
  });

  it('switches tabs from the /scan route through the tab navigator, retrying only while still focused', () => {
    jest.useFakeTimers();
    try {
      const ScanRoute = require('@/app/(tabs)/scan').default;
      render(<ScanRoute />);

      fireEvent.press(screen.getByTestId('scanner-tab-index'));
      expect(mockNavigate).toHaveBeenCalledTimes(1);
      expect(mockNavigate).toHaveBeenCalledWith('index');

      // Dropped dispatch: still focused, so it retries.
      act(() => { jest.advanceTimersByTime(350); });
      expect(mockNavigate).toHaveBeenCalledTimes(2);

      // Landed: no more retries.
      mockFocused = false;
      act(() => { jest.advanceTimersByTime(2000); });
      expect(mockNavigate).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it("draws the account's photo for SOCIAL straight from its URL", () => {
    mockAvatarURL = 'https://example.com/me.jpg';
    try {
      render(<ScannerTabBar bottomInset={0} onSelectTab={() => undefined} />);
      expect(screen.getByTestId('scanner-tab-bar-avatar')).toBeTruthy();
    } finally {
      mockAvatarURL = null;
    }
  });
});
