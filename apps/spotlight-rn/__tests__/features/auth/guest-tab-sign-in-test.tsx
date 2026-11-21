import { fireEvent, screen } from '@testing-library/react-native';

import { GuestTabSignIn } from '@/features/auth/components/guest-tab-sign-in';

import { renderWithProviders } from '../../test-utils';

const mockOpenLogin = jest.fn();
jest.mock('@/features/auth/use-guest-gate', () => ({
  useGuestGate: () => ({ openLogin: mockOpenLogin }),
}));

describe('GuestTabSignIn', () => {
  it('asks a guest to sign in in place, with no redirect', () => {
    renderWithProviders(<GuestTabSignIn message="Save the cards you scan." title="Sign in to track your collection" />);
    expect(screen.getByText('Sign in to track your collection')).toBeTruthy();
    fireEvent.press(screen.getByTestId('guest-tab-sign-in-button'));
    expect(mockOpenLogin).toHaveBeenCalledTimes(1);
  });
});
