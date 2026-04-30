import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import { useRouter } from 'expo-router';
import { StyleSheet } from 'react-native';

import { AccountScreen } from '@/features/auth/screens/account-screen';
import {
  peekPendingPortfolioImportFile,
  setPendingPortfolioImportFile,
} from '@/features/portfolio-import/portfolio-import-session';
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
    setPendingPortfolioImportFile(null);

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

  afterEach(() => {
    setPendingPortfolioImportFile(null);
  });

  it('picks a Collectr CSV and routes into the import review screen', async () => {
    jest.spyOn(DocumentPicker, 'getDocumentAsync').mockResolvedValueOnce({
      canceled: false,
      assets: [{
        lastModified: Date.now(),
        mimeType: 'text/csv',
        name: 'collectr.csv',
        size: 128,
        uri: 'file:///collectr.csv',
      }],
    });
    jest.spyOn(FileSystem, 'readAsStringAsync').mockResolvedValueOnce('name,set\nTreecko,SM7');

    renderWithProviders(<AccountScreen />);

    expect(screen.queryByText('Done')).toBeNull();
    expect(screen.queryByText('Signed in with apple')).toBeNull();
    expect(screen.queryByText('Bring Your Inventory Over')).toBeNull();
    expect(StyleSheet.flatten(screen.getByText('Import from Collectr').props.style)).toMatchObject({
      fontFamily: 'SpotlightBodySemiBold',
      fontSize: 15,
      lineHeight: 20,
    });
    expect(StyleSheet.flatten(screen.getByText('Sign out').props.style)).toMatchObject({
      fontFamily: 'SpotlightBodySemiBold',
      fontSize: 15,
      lineHeight: 20,
    });

    fireEvent.press(screen.getByTestId('account-import-collectr_csv_v1'));

    await waitFor(() => {
      expect(push).toHaveBeenCalledWith('/account/import');
    });

    expect(peekPendingPortfolioImportFile()).toMatchObject({
      csvText: 'name,set\nTreecko,SM7',
      fileName: 'collectr.csv',
      sourceType: 'collectr_csv_v1',
    });
  });

  it('uses the shared left-aligned back button chrome', () => {
    renderWithProviders(<AccountScreen />);

    fireEvent.press(screen.getByTestId('account-close'));
    expect(back).toHaveBeenCalledTimes(1);
  });

  it('shows an import error card when the CSV cannot be read', async () => {
    jest.spyOn(DocumentPicker, 'getDocumentAsync').mockResolvedValueOnce({
      canceled: false,
      assets: [{
        lastModified: Date.now(),
        mimeType: 'text/csv',
        name: 'tcgplayer.csv',
        size: 64,
        uri: 'file:///tcgplayer.csv',
      }],
    });
    jest.spyOn(FileSystem, 'readAsStringAsync').mockRejectedValueOnce(new Error('bad file'));

    renderWithProviders(<AccountScreen />);

    fireEvent.press(screen.getByTestId('account-import-tcgplayer_csv_v1'));

    expect(await screen.findByText('Import unavailable')).toBeTruthy();
    expect(screen.getByText('bad file')).toBeTruthy();
    expect(push).not.toHaveBeenCalled();
  });
});
