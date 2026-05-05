import { fireEvent, screen } from '@testing-library/react-native';
import { useRouter } from 'expo-router';
import { StyleSheet } from 'react-native';

import { AccountScreen } from '@/features/auth/screens/account-screen';
import { useAuth } from '@/providers/auth-provider';

import { renderWithProviders } from '../test-utils';

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

  it('shows a label-session entry for labeler-enabled users and routes into the labeling flow', () => {
    (useAuth as jest.Mock).mockReturnValue({
      appleSignInAvailable: true,
      configurationIssue: null,
      currentUser: {
        adminEnabled: false,
        avatarURL: null,
        displayName: 'Labeler',
        email: 'labeler@example.com',
        id: 'user-2',
        labelerEnabled: true,
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

    renderWithProviders(<AccountScreen />);

    expect(screen.getByTestId('account-label-session')).toBeTruthy();
    expect(screen.getByText('+ Label Session')).toBeTruthy();

    fireEvent.press(screen.getByTestId('account-label-session'));

    expect(push).toHaveBeenCalledWith('/labeling/session');
  });
});
