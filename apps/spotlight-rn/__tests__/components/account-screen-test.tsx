import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { useRouter } from 'expo-router';
import { Alert, StyleSheet } from 'react-native';

import { AccountScreen } from '@/features/auth/screens/account-screen';
import { useAuth } from '@/providers/auth-provider';

import { createTestSpotlightRepository, renderWithProviders } from '../test-utils';

jest.mock('expo-router', () => ({
  useRouter: jest.fn(),
}));

jest.mock('@/providers/auth-provider', () => ({
  useAuth: jest.fn(),
}));

describe('AccountScreen', () => {
  const push = jest.fn();
  const back = jest.fn();
  const signOut = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();

    (useRouter as jest.Mock).mockReturnValue({
      back,
      push,
    });
    (useAuth as jest.Mock).mockReturnValue({
      appleSignInAvailable: true,
      configurationIssue: null,
      currentUser: {
        adminEnabled: false,
        avatarURL: null,
        displayName: 'Collector',
        email: 'collector@example.com',
        id: 'user-1',
        labelerEnabled: false,
        providers: ['apple'],
      },
      errorMessage: null,
      isBusy: false,
      isConfigured: true,
      profileDraftName: '',
      setProfileDraftName: jest.fn(),
      signInWithApple: jest.fn(),
      signInWithGoogle: jest.fn(),
      signOut,
      state: 'authenticated',
      submitProfile: jest.fn(),
    });
  });

  it('does not render unsupported inventory import actions', () => {
    renderWithProviders(<AccountScreen />);

    expect(screen.queryByText('Done')).toBeNull();
    expect(screen.queryByText('Signed in with apple')).toBeNull();
    expect(screen.queryByText('Import from Collectr')).toBeNull();
    expect(screen.queryByText('Import from TCGplayer')).toBeNull();
    expect(screen.queryByTestId('account-import-collectr_csv_v1')).toBeNull();
    expect(screen.queryByTestId('account-import-tcgplayer_csv_v1')).toBeNull();
    expect(StyleSheet.flatten(screen.getByText('Sign out').props.style)).toMatchObject({
      fontFamily: 'SpotlightBodySemiBold',
      fontSize: 15,
      lineHeight: 20,
    });
    expect(screen.queryByTestId('account-label-session')).toBeNull();
  });

  it('uses the shared left-aligned back button chrome', () => {
    renderWithProviders(<AccountScreen />);

    fireEvent.press(screen.getByTestId('account-close'));
    expect(back).toHaveBeenCalledTimes(1);
  });

  it('renders a destructive Delete Account action', () => {
    renderWithProviders(<AccountScreen />);

    expect(screen.getByTestId('account-delete')).toBeTruthy();
    expect(screen.getByText('Delete Account')).toBeTruthy();
  });

  it('deletes the account then signs out after confirming the alert', async () => {
    const alertSpy = jest.spyOn(Alert, 'alert');
    const deleteAccount = jest.fn().mockResolvedValue({ deleted: true });
    const spotlightRepository = createTestSpotlightRepository({ deleteAccount });

    renderWithProviders(<AccountScreen />, { spotlightRepository });

    fireEvent.press(screen.getByTestId('account-delete'));

    expect(alertSpy).toHaveBeenCalledTimes(1);
    const buttons = alertSpy.mock.calls[0][2];
    const destructiveButton = buttons?.find((button) => button.style === 'destructive');
    expect(destructiveButton).toBeDefined();

    await act(async () => {
      destructiveButton?.onPress?.();
    });

    await waitFor(() => {
      expect(deleteAccount).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(signOut).toHaveBeenCalledTimes(1);
    });

    alertSpy.mockRestore();
  });

  it('does not sign out when account deletion fails', async () => {
    const alertSpy = jest.spyOn(Alert, 'alert');
    const deleteAccount = jest.fn().mockRejectedValue(new Error('boom'));
    const spotlightRepository = createTestSpotlightRepository({ deleteAccount });

    renderWithProviders(<AccountScreen />, { spotlightRepository });

    fireEvent.press(screen.getByTestId('account-delete'));
    const destructiveButton = alertSpy.mock.calls[0][2]?.find(
      (button) => button.style === 'destructive',
    );
    await act(async () => {
      destructiveButton?.onPress?.();
    });

    await waitFor(() => {
      expect(deleteAccount).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(alertSpy).toHaveBeenCalledTimes(2);
    });
    expect(signOut).not.toHaveBeenCalled();

    alertSpy.mockRestore();
  });
});
