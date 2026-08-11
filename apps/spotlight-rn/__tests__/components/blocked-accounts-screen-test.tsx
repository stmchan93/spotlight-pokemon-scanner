import { fireEvent, screen, waitFor } from '@testing-library/react-native';

import {
  BlockedAccountsScreen,
  blockedAccountName,
} from '@/features/social/screens/blocked-accounts-screen';
import {
  fetchBlockedProfiles,
  unblockUser,
  type BlockedProfile,
} from '@/features/social/social-service';

import { renderWithProviders } from '../test-utils';

jest.mock('@/features/social/social-service', () => ({
  fetchBlockedProfiles: jest.fn(async () => []),
  unblockUser: jest.fn(async () => true),
}));

const mockFetch = fetchBlockedProfiles as jest.MockedFunction<typeof fetchBlockedProfiles>;
const mockUnblock = unblockUser as jest.MockedFunction<typeof unblockUser>;

function blocked(userID: string, overrides: Partial<BlockedProfile> = {}): BlockedProfile {
  return {
    userID,
    displayName: `Collector ${userID}`,
    handle: null,
    avatarURL: null,
    ...overrides,
  };
}

describe('BlockedAccountsScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUnblock.mockResolvedValue(true);
  });

  it('lists everyone the signed-in user has blocked', async () => {
    mockFetch.mockResolvedValue([
      blocked('u-1', { displayName: 'Ash', handle: 'ash' }),
      blocked('u-2', { displayName: 'Misty' }),
    ]);

    renderWithProviders(<BlockedAccountsScreen />);

    await waitFor(() => expect(screen.getByText('Ash')).toBeTruthy());
    expect(screen.getByText('@ash')).toBeTruthy();
    expect(screen.getByText('Misty')).toBeTruthy();
    expect(screen.getByTestId('blocked-accounts-row-u-1-unblock')).toBeTruthy();
    expect(screen.getByTestId('blocked-accounts-row-u-2-unblock')).toBeTruthy();
  });

  it('shows an empty state when nobody is blocked', async () => {
    mockFetch.mockResolvedValue([]);

    renderWithProviders(<BlockedAccountsScreen />);

    await waitFor(() => expect(screen.getByTestId('blocked-accounts-empty')).toBeTruthy());
    expect(screen.getByText('No blocked accounts')).toBeTruthy();
    expect(unblockUser).not.toHaveBeenCalled();
  });

  it('confirms before unblocking, then drops the row', async () => {
    mockFetch.mockResolvedValue([blocked('u-1', { displayName: 'Ash', handle: 'ash' })]);

    renderWithProviders(<BlockedAccountsScreen />);
    await waitFor(() => expect(screen.getByText('Ash')).toBeTruthy());

    fireEvent.press(screen.getByTestId('blocked-accounts-row-u-1-unblock'));

    // The tap opens the confirmation, it does NOT unblock.
    expect(unblockUser).not.toHaveBeenCalled();
    expect(screen.getByTestId('blocked-accounts-confirm')).toBeTruthy();
    expect(screen.getByText('Unblock account?')).toBeTruthy();
    expect(screen.getByText(/Ash will be able to see your posts/)).toBeTruthy();

    fireEvent.press(screen.getByTestId('blocked-accounts-confirm-confirm'));

    await waitFor(() => expect(unblockUser).toHaveBeenCalledWith('u-1'));
    await waitFor(() => expect(screen.queryByText('Ash')).not.toBeOnTheScreen());
    // Last block lifted — the list falls back to the empty state.
    expect(screen.getByTestId('blocked-accounts-empty')).toBeTruthy();
  });

  it('cancelling the confirmation leaves the block in place', async () => {
    mockFetch.mockResolvedValue([blocked('u-1', { displayName: 'Ash' })]);

    renderWithProviders(<BlockedAccountsScreen />);
    await waitFor(() => expect(screen.getByText('Ash')).toBeTruthy());

    fireEvent.press(screen.getByTestId('blocked-accounts-row-u-1-unblock'));
    fireEvent.press(screen.getByTestId('blocked-accounts-confirm-cancel'));

    expect(unblockUser).not.toHaveBeenCalled();
    expect(screen.getByText('Ash')).toBeTruthy();
  });

  it('keeps the row and warns when the unblock fails', async () => {
    mockFetch.mockResolvedValue([blocked('u-1', { displayName: 'Ash' })]);
    mockUnblock.mockResolvedValue(false);

    renderWithProviders(<BlockedAccountsScreen />);
    await waitFor(() => expect(screen.getByText('Ash')).toBeTruthy());

    fireEvent.press(screen.getByTestId('blocked-accounts-row-u-1-unblock'));
    fireEvent.press(screen.getByTestId('blocked-accounts-confirm-confirm'));

    await waitFor(() => expect(unblockUser).toHaveBeenCalledWith('u-1'));
    // A block that is still in force must still be listed.
    expect(screen.getByText('Ash')).toBeTruthy();
    // The Toast mounts from an effect, so it lands on the next render pass.
    await waitFor(() =>
      expect(screen.getByText("Couldn't unblock that account. Please try again.")).toBeTruthy(),
    );
  });

  it('still renders a row whose profile could not be resolved', async () => {
    // social_19 makes a blocked user unreadable through `public_profiles`, so a
    // nameless row is a real state — and it must stay unblockable.
    mockFetch.mockResolvedValue([blocked('u-3', { displayName: null, handle: null })]);

    renderWithProviders(<BlockedAccountsScreen />);

    await waitFor(() => expect(screen.getByText('Blocked account')).toBeTruthy());
    expect(screen.queryByText('u-3')).toBeNull();
    fireEvent.press(screen.getByTestId('blocked-accounts-row-u-3-unblock'));
    fireEvent.press(screen.getByTestId('blocked-accounts-confirm-confirm'));
    await waitFor(() => expect(unblockUser).toHaveBeenCalledWith('u-3'));
  });

  it('names a row by handle when only the handle resolved', () => {
    expect(blockedAccountName(blocked('u-4', { displayName: null, handle: 'ash' }))).toBe('@ash');
    expect(blockedAccountName(blocked('u-5', { displayName: '  Ash  ' }))).toBe('Ash');
    expect(blockedAccountName(blocked('u-6', { displayName: null }))).toBe('Blocked account');
  });

  it('renders the back affordance only when a handler is supplied', async () => {
    mockFetch.mockResolvedValue([]);

    const onBack = jest.fn();
    const { rerender } = renderWithProviders(<BlockedAccountsScreen onBack={onBack} />);
    await waitFor(() => expect(screen.getByTestId('blocked-accounts-empty')).toBeTruthy());

    fireEvent.press(screen.getByTestId('blocked-accounts-back'));
    expect(onBack).toHaveBeenCalled();

    rerender(<BlockedAccountsScreen />);
    expect(screen.queryByTestId('blocked-accounts-back')).toBeNull();
  });
});
