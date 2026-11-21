import { act, render, screen } from '@testing-library/react-native';
import React from 'react';

import {
  GuestScannerRedirect,
  resetGuestLaunchRedirectForTests,
} from '@/features/auth/components/guest-scanner-redirect';

/*
  The declarative <Redirect> this component replaced rendered null forever
  inside native tabs on Android — a dead white tab (2026-08-13, first Play
  build). These tests pin the two behaviors that prevent a recurrence: the
  imperative tab switch fires, and a visible way out appears if it didn't work.
*/

const mockReplace = jest.fn();
const mockPush = jest.fn();
let mockPathname = '/social';
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, replace: mockReplace }),
  usePathname: () => mockPathname,
}));

const mockNavigate = jest.fn();
const mockIsFocused = jest.fn(() => true);
jest.mock('@react-navigation/native', () => ({
  useIsFocused: () => mockIsFocused(),
  useNavigation: () => ({ navigate: mockNavigate }),
}));

jest.mock('@/providers/auth-provider', () => ({
  useAuth: () => ({ ensureGuestSession: jest.fn(), isGuest: true }),
}));

describe('GuestScannerRedirect', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockNavigate.mockClear();
    mockPush.mockClear();
    mockPathname = '/social';
    mockIsFocused.mockReturnValue(true);
    resetGuestLaunchRedirectForTests();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('switches to the scanner tab via the tab navigator when focused', () => {
    render(<GuestScannerRedirect />);
    expect(mockNavigate).toHaveBeenCalledWith('scan');
  });

  it('reveals scan + sign-in actions if the tab switch never happens', () => {
    render(<GuestScannerRedirect />);
    expect(screen.queryByTestId('guest-scanner-redirect-fallback')).toBeNull();
    act(() => {
      jest.advanceTimersByTime(2500);
    });
    expect(screen.getByTestId('guest-scanner-redirect-scan')).toBeTruthy();
    expect(screen.getByTestId('guest-scanner-redirect-sign-in')).toBeTruthy();
  });

  it('does not navigate while unfocused (native tabs mount screens eagerly)', () => {
    mockIsFocused.mockReturnValueOnce(false);
    render(<GuestScannerRedirect />);
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('does not open login on its own (the launch route lands guests on the scanner)', () => {
    render(<GuestScannerRedirect />);
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('with promptLogin: opens login only — no tab switch that would close it', () => {
    const view = render(<GuestScannerRedirect promptLogin />);
    expect(mockPush).toHaveBeenCalledTimes(1);
    expect(mockPush).toHaveBeenCalledWith('/login');
    mockIsFocused.mockReturnValue(false);
    mockPathname = '/login';
    view.rerender(<GuestScannerRedirect promptLogin />);
    act(() => {
      jest.advanceTimersByTime(3000);
    });
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('with promptLogin: if login never shows, the guest still reaches the scanner', () => {
    render(<GuestScannerRedirect promptLogin />);
    act(() => {
      jest.advanceTimersByTime(1600);
    });
    expect(mockNavigate).toHaveBeenCalledWith('scan');
  });

  it('with promptLogin: closing login sends the guest to the scanner, no second login', () => {
    const view = render(<GuestScannerRedirect promptLogin />);
    // Focus drops a beat before the path flips to /login ...
    mockIsFocused.mockReturnValue(false);
    view.rerender(<GuestScannerRedirect promptLogin />);
    // ... then login covers the tabs ...
    mockPathname = '/login';
    view.rerender(<GuestScannerRedirect promptLogin />);
    // ... then Back re-focuses the gated tab.
    mockIsFocused.mockReturnValue(true);
    mockPathname = '/social';
    view.rerender(<GuestScannerRedirect promptLogin />);
    expect(mockPush).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith('scan');
  });

  it('with promptLogin: a new visit after leaving prompts again', () => {
    const view = render(<GuestScannerRedirect promptLogin />);
    // login shows ...
    mockIsFocused.mockReturnValue(false);
    mockPathname = '/login';
    view.rerender(<GuestScannerRedirect promptLogin />);
    // ... closed → scanner ...
    mockIsFocused.mockReturnValue(true);
    mockPathname = '/social';
    view.rerender(<GuestScannerRedirect promptLogin />);
    mockIsFocused.mockReturnValue(false);
    mockPathname = '/scan';
    view.rerender(<GuestScannerRedirect promptLogin />);
    // ... tapped again later.
    mockIsFocused.mockReturnValue(true);
    mockPathname = '/social';
    view.rerender(<GuestScannerRedirect promptLogin />);
    expect(mockPush).toHaveBeenCalledTimes(2);
  });

  it('Home tap with a lagging path (/scan → / → /login) keeps login open', () => {
    act(() => {
      jest.advanceTimersByTime(6000);
    });
    mockPathname = '/scan';
    const view = render(<GuestScannerRedirect promptLogin="after-launch" />);
    expect(mockPush).toHaveBeenCalledTimes(1);
    mockPathname = '/';
    view.rerender(<GuestScannerRedirect promptLogin="after-launch" />);
    expect(mockNavigate).not.toHaveBeenCalled();
    mockIsFocused.mockReturnValue(false);
    mockPathname = '/login';
    view.rerender(<GuestScannerRedirect promptLogin="after-launch" />);
    expect(mockNavigate).not.toHaveBeenCalled();
    // Back: login closes, guest goes to the scanner, no second login.
    mockIsFocused.mockReturnValue(true);
    mockPathname = '/';
    view.rerender(<GuestScannerRedirect promptLogin="after-launch" />);
    expect(mockNavigate).toHaveBeenCalledWith('scan');
    expect(mockPush).toHaveBeenCalledTimes(1);
  });

  it('after-launch (Home): a first Home TAP after the launch window opens login', () => {
    act(() => {
      jest.advanceTimersByTime(6000);
    });
    render(<GuestScannerRedirect promptLogin="after-launch" />);
    expect(mockPush).toHaveBeenCalledWith('/login');
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it("after-launch (Home): silent on the launch visit, login on later visits", () => {
    mockPathname = '/';
    const view = render(<GuestScannerRedirect promptLogin="after-launch" />);
    expect(mockPush).not.toHaveBeenCalled();
    expect(mockNavigate).toHaveBeenCalledWith('scan');
    mockIsFocused.mockReturnValue(false);
    mockPathname = '/scan';
    view.rerender(<GuestScannerRedirect promptLogin="after-launch" />);
    mockIsFocused.mockReturnValue(true);
    mockPathname = '/';
    view.rerender(<GuestScannerRedirect promptLogin="after-launch" />);
    expect(mockPush).toHaveBeenCalledTimes(1);
    expect(mockPush).toHaveBeenCalledWith('/login');
  });

  it('the manual fallback does not stick to later visits', () => {
    const view = render(<GuestScannerRedirect />);
    act(() => {
      jest.advanceTimersByTime(2500);
    });
    expect(screen.getByTestId('guest-scanner-redirect-fallback')).toBeTruthy();
    mockIsFocused.mockReturnValue(false);
    mockPathname = '/scan';
    view.rerender(<GuestScannerRedirect />);
    expect(screen.queryByTestId('guest-scanner-redirect-fallback')).toBeNull();
  });
});
