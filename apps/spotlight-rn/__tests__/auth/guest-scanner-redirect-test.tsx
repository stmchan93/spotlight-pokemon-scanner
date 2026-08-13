import { act, render, screen } from '@testing-library/react-native';
import React from 'react';

import { GuestScannerRedirect } from '@/features/auth/components/guest-scanner-redirect';

/*
  The declarative <Redirect> this component replaced rendered null forever
  inside native tabs on Android — a dead white tab (2026-08-13, first Play
  build). These tests pin the two behaviors that prevent a recurrence: the
  imperative tab switch fires, and a visible way out appears if it didn't work.
*/

const mockReplace = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), replace: mockReplace }),
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
      jest.advanceTimersByTime(900);
    });
    expect(screen.getByTestId('guest-scanner-redirect-scan')).toBeTruthy();
    expect(screen.getByTestId('guest-scanner-redirect-sign-in')).toBeTruthy();
  });

  it('does not navigate while unfocused (native tabs mount screens eagerly)', () => {
    mockIsFocused.mockReturnValueOnce(false);
    render(<GuestScannerRedirect />);
    expect(mockNavigate).not.toHaveBeenCalled();
  });
});
