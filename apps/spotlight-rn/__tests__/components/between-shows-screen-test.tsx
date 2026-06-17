import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';

import { BetweenShowsScreen } from '@/features/auth/screens/between-shows-screen';
import { useAccessGate } from '@/features/auth/access-gate-provider';
import { useAuth } from '@/providers/auth-provider';

import { createTestSpotlightRepository, renderWithProviders } from '../test-utils';

jest.mock('@/providers/auth-provider', () => ({
  useAuth: jest.fn(),
}));

jest.mock('@/features/auth/access-gate-provider', () => ({
  useAccessGate: jest.fn(),
}));

describe('BetweenShowsScreen', () => {
  const signOut = jest.fn();
  const refresh = jest.fn().mockResolvedValue(null);

  beforeEach(() => {
    jest.clearAllMocks();

    (useAuth as jest.Mock).mockReturnValue({
      currentUser: { email: 'collector@example.com' },
      isBusy: false,
      signOut,
    });
    (useAccessGate as jest.Mock).mockReturnValue({
      state: 'blocked',
      status: null,
      refresh,
    });
  });

  it('prefills the signed-in email and submits the waitlist', async () => {
    const joinAccessWaitlist = jest.fn().mockResolvedValue({ ok: true });
    const spotlightRepository = createTestSpotlightRepository({ joinAccessWaitlist });

    renderWithProviders(<BetweenShowsScreen />, { spotlightRepository });

    const emailField = screen.getByTestId('between-shows-email');
    expect(emailField.props.value).toBe('collector@example.com');

    await act(async () => {
      fireEvent.press(screen.getByTestId('between-shows-waitlist-submit'));
    });

    await waitFor(() => {
      expect(joinAccessWaitlist).toHaveBeenCalledWith('collector@example.com');
    });
    expect(await screen.findByText("You're on the list.")).toBeTruthy();
  });

  it('redeems a valid invite code then re-checks access', async () => {
    const redeemInviteCode = jest.fn().mockResolvedValue({ redeemed: true, allowed: true });
    const spotlightRepository = createTestSpotlightRepository({ redeemInviteCode });

    renderWithProviders(<BetweenShowsScreen />, { spotlightRepository });

    fireEvent.changeText(screen.getByTestId('between-shows-code'), 'ekalight_special_guest');

    await act(async () => {
      fireEvent.press(screen.getByTestId('between-shows-redeem'));
    });

    await waitFor(() => {
      expect(redeemInviteCode).toHaveBeenCalledWith('ekalight_special_guest');
    });
    await waitFor(() => {
      expect(refresh).toHaveBeenCalledTimes(1);
    });
  });

  it('shows an error when the invite code is rejected', async () => {
    const redeemInviteCode = jest.fn().mockResolvedValue({ redeemed: false, allowed: false });
    const spotlightRepository = createTestSpotlightRepository({ redeemInviteCode });

    renderWithProviders(<BetweenShowsScreen />, { spotlightRepository });

    fireEvent.changeText(screen.getByTestId('between-shows-code'), 'nope');

    await act(async () => {
      fireEvent.press(screen.getByTestId('between-shows-redeem'));
    });

    await waitFor(() => {
      expect(redeemInviteCode).toHaveBeenCalledWith('nope');
    });
    expect(await screen.findByText("That code didn't work.")).toBeTruthy();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('signs out from the secondary affordance', () => {
    renderWithProviders(<BetweenShowsScreen />);

    fireEvent.press(screen.getByTestId('between-shows-sign-out'));
    expect(signOut).toHaveBeenCalledTimes(1);
  });
});
