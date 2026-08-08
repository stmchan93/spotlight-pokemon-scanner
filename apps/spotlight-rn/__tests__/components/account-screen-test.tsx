import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import * as Clipboard from 'expo-clipboard';
import * as Linking from 'expo-linking';
import { useRouter } from 'expo-router';
import { Alert, StyleSheet } from 'react-native';

import { AccountScreen } from '@/features/auth/screens/account-screen';
import { useAuth } from '@/providers/auth-provider';

import { createTestSpotlightRepository, renderWithProviders } from '../test-utils';

jest.mock('expo-router', () => ({
  useRouter: jest.fn(),
}));

jest.mock('expo-linking', () => ({
  canOpenURL: jest.fn(async () => true),
  openURL: jest.fn(async () => true),
}));

jest.mock('expo-clipboard', () => ({
  setStringAsync: jest.fn(async () => true),
}));

const mockCanOpenURL = Linking.canOpenURL as jest.MockedFunction<typeof Linking.canOpenURL>;
const mockOpenURL = Linking.openURL as jest.MockedFunction<typeof Linking.openURL>;
const mockSetStringAsync = Clipboard.setStringAsync as jest.MockedFunction<
  typeof Clipboard.setStringAsync
>;

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

  it('renders the CSV export action (import buttons removed — low ROI, hard to test)', () => {
    renderWithProviders(<AccountScreen />);

    expect(screen.queryByText('Done')).toBeNull();
    expect(screen.queryByText('Signed in with apple')).toBeNull();
    // Export stays (the differentiator); the Collectr/TCGplayer import entry points
    // were removed from the account screen — the importer code/backend remain.
    expect(screen.getByTestId('account-export-csv')).toBeTruthy();
    expect(screen.getByText('Export portfolio (CSV)')).toBeTruthy();
    expect(screen.queryByTestId('account-import-tcgplayer')).toBeNull();
    expect(screen.queryByTestId('account-import-collectr')).toBeNull();
    expect(screen.queryByText('Import from TCGplayer')).toBeNull();
    expect(screen.queryByText('Import from Collectr')).toBeNull();
    expect(StyleSheet.flatten(screen.getByText('Sign out').props.style)).toMatchObject({
      fontFamily: 'SpotlightBodySemiBold',
      fontSize: 15,
      lineHeight: 20,
    });
    expect(screen.queryByTestId('account-label-session')).toBeNull();
  });

  // App Store Guideline 1.2: a UGC app has to publish a contact method for
  // objectionable-content reports. These three tests are the guardrail on that
  // row — it must render, it must open mail, and it must never dead-end.
  it('renders the contact & support row', () => {
    renderWithProviders(<AccountScreen />);

    expect(screen.getByTestId('account-contact-support')).toBeTruthy();
    expect(screen.getByText('Contact & support')).toBeTruthy();
    expect(screen.getByText('Contact support')).toBeTruthy();
    // The raw address stays hidden until we know mail can't be opened.
    expect(screen.queryByTestId('account-support-email')).not.toBeOnTheScreen();
  });

  it('opens a prefilled support mailto when a mail client exists', async () => {
    mockCanOpenURL.mockResolvedValue(true);

    renderWithProviders(<AccountScreen />);

    await act(async () => {
      fireEvent.press(screen.getByTestId('account-contact-support'));
    });

    // Subject carries app name + version so triage has context; body stays
    // empty because it would otherwise ship user PII to our inbox.
    const expectedUrl = `mailto:team@ekalight.com?subject=${encodeURIComponent(
      'Spotlight 1.0.0 — Support',
    )}`;
    await waitFor(() => {
      expect(mockOpenURL).toHaveBeenCalledWith(expectedUrl);
    });
    expect(screen.queryByTestId('account-support-email')).not.toBeOnTheScreen();
  });

  it('reveals a copyable address when no mail client can handle the mailto', async () => {
    mockCanOpenURL.mockResolvedValue(false);

    renderWithProviders(<AccountScreen />);

    await act(async () => {
      fireEvent.press(screen.getByTestId('account-contact-support'));
    });

    // The whole point of the fallback: the address is still reachable.
    const address = await screen.findByTestId('account-support-email');
    expect(address).toHaveTextContent('team@ekalight.com');
    expect(address.props.selectable).toBe(true);
    expect(mockOpenURL).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.press(screen.getByTestId('account-support-copy'));
    });

    await waitFor(() => {
      expect(mockSetStringAsync).toHaveBeenCalledWith('team@ekalight.com');
    });
    expect(await screen.findByText('Copied')).toBeTruthy();
  });

  it('reveals the address when opening the mailto throws', async () => {
    mockCanOpenURL.mockResolvedValue(true);
    mockOpenURL.mockRejectedValue(new Error('no handler'));

    renderWithProviders(<AccountScreen />);

    await act(async () => {
      fireEvent.press(screen.getByTestId('account-contact-support'));
    });

    expect(await screen.findByTestId('account-support-email')).toHaveTextContent(
      'team@ekalight.com',
    );
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

  it('hides the admin show-mode toggle AND whitelist editor for non-admin users', () => {
    renderWithProviders(<AccountScreen />);

    expect(screen.queryByTestId('account-show-mode-toggle')).toBeNull();
    expect(screen.queryByTestId('account-whitelist-input')).toBeNull();
    expect(screen.queryByTestId('account-whitelist-add')).toBeNull();
  });

  it('shows the card show mode toggle for the admin email and toggles it', async () => {
    (useAuth as jest.Mock).mockReturnValue({
      appleSignInAvailable: true,
      configurationIssue: null,
      currentUser: {
        adminEnabled: true,
        avatarURL: null,
        displayName: 'Stephen',
        email: 'stmchan8953@gmail.com',
        id: 'admin-1',
        labelerEnabled: true,
        providers: ['email'],
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

    const getAccessStatus = jest.fn().mockResolvedValue({
      accessOpen: true,
      allowed: true,
      isAdmin: true,
      showMode: { active: true, until: null, remainingSeconds: 0 },
    });
    const setCardShowMode = jest.fn().mockResolvedValue({ accessOpen: false });
    const spotlightRepository = createTestSpotlightRepository({
      getAccessStatus,
      setCardShowMode,
    });

    renderWithProviders(<AccountScreen />, { spotlightRepository });

    const toggle = await screen.findByTestId('account-show-mode-toggle');
    expect(toggle).toBeTruthy();

    await waitFor(() => {
      expect(getAccessStatus).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(toggle.props.value).toBe(true);
    });

    await act(async () => {
      fireEvent(toggle, 'valueChange', false);
    });

    await waitFor(() => {
      expect(setCardShowMode).toHaveBeenCalledWith(false);
    });
  });

  it('lets the admin whitelist a user by email', async () => {
    (useAuth as jest.Mock).mockReturnValue({
      appleSignInAvailable: true,
      configurationIssue: null,
      currentUser: {
        adminEnabled: true,
        avatarURL: null,
        displayName: 'Stephen',
        email: 'stmchan8953@gmail.com',
        id: 'admin-1',
        labelerEnabled: true,
        providers: ['email'],
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

    const getAccessWhitelist = jest.fn().mockResolvedValue({ emails: [] });
    const addAccessWhitelistEmail = jest
      .fn()
      .mockResolvedValue({ emails: ['friend@example.com'] });
    const spotlightRepository = createTestSpotlightRepository({
      getAccessWhitelist,
      addAccessWhitelistEmail,
    });

    renderWithProviders(<AccountScreen />, { spotlightRepository });

    const input = await screen.findByTestId('account-whitelist-input');
    fireEvent.changeText(input, 'friend@example.com');
    await act(async () => {
      fireEvent.press(screen.getByTestId('account-whitelist-add'));
    });

    await waitFor(() => {
      expect(addAccessWhitelistEmail).toHaveBeenCalledWith('friend@example.com');
    });
    expect(await screen.findByText('friend@example.com')).toBeTruthy();
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
