import { Alert } from 'react-native';
import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { useRouter } from 'expo-router';

import { isHandleAvailable } from '@/features/auth/auth-service';
import { EditProfileScreen } from '@/features/profile/screens/edit-profile-screen';
import { useAuth } from '@/providers/auth-provider';

import { renderWithProviders } from '../test-utils';

// The shared jest.setup.ts iconoir mock only allowlists a subset of icon names;
// this screen also uses Camera / NavArrowRight, so extend the mock here.
jest.mock('iconoir-react-native', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { View } = require('react-native');
  const make = (name: string) => {
    const Component = (props: Record<string, unknown>) =>
      React.createElement(View, { ...props, testID: props.testID ?? `iconoir-${name}` });
    Component.displayName = `MockIconoir(${name})`;
    return Component;
  };
  return {
    Camera: make('camera'),
    Check: make('check'),
    NavArrowLeft: make('nav-arrow-left'),
    NavArrowRight: make('nav-arrow-right'),
  };
});

jest.mock('expo-router', () => ({
  useRouter: jest.fn(),
}));

jest.mock('@/providers/auth-provider', () => ({
  useAuth: jest.fn(),
}));

// Keep ProfileUpdateError real (the screen instanceof-checks it); stub only the
// network probe.
jest.mock('@/features/auth/auth-service', () => ({
  ...jest.requireActual('@/features/auth/auth-service'),
  isHandleAvailable: jest.fn().mockResolvedValue(true),
}));

describe('EditProfileScreen', () => {
  const back = jest.fn();
  const updateProfile = jest.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    jest.clearAllMocks();
    // clearAllMocks wipes calls but keeps implementations, so re-arm the default.
    (isHandleAvailable as jest.Mock).mockResolvedValue(true);

    (useRouter as jest.Mock).mockReturnValue({ back, push: jest.fn() });
    (useAuth as jest.Mock).mockReturnValue({
      currentUser: {
        avatarURL: null,
        bio: 'Collector of holos',
        displayName: 'Ash',
        handle: 'ash',
        id: 'user-1',
        location: 'Pallet Town',
        socialLink: 'https://example.com',
      },
      updateProfile,
    });
  });

  it('renders the four field placeholders and the Save/Cancel actions', () => {
    renderWithProviders(<EditProfileScreen />);

    expect(screen.getByPlaceholderText('Enter Profile Name')).toBeTruthy();
    expect(screen.getByPlaceholderText('Enter Social Link')).toBeTruthy();
    expect(screen.getByPlaceholderText('Enter Location')).toBeTruthy();
    expect(screen.getByPlaceholderText('Tell us about you...')).toBeTruthy();

    expect(screen.getByTestId('edit-profile-save')).toBeTruthy();
    expect(screen.getByTestId('edit-profile-cancel')).toBeTruthy();
    expect(screen.getByText('SAVE')).toBeTruthy();
    expect(screen.getByText('CANCEL')).toBeTruthy();
  });

  it('prefills the form from the current user', () => {
    renderWithProviders(<EditProfileScreen />);

    expect(screen.getByDisplayValue('Ash')).toBeTruthy();
    expect(screen.getByDisplayValue('https://example.com')).toBeTruthy();
    expect(screen.getByDisplayValue('Pallet Town')).toBeTruthy();
    expect(screen.getByDisplayValue('Collector of holos')).toBeTruthy();

    // A filled field also floats its label above the value (Figma 3083:9800).
    expect(screen.getByText('Profile Name')).toBeTruthy();
    expect(screen.getByText('Social Link')).toBeTruthy();
    expect(screen.getByText('Location')).toBeTruthy();
  });

  it('navigates back when Cancel is pressed', () => {
    renderWithProviders(<EditProfileScreen />);

    fireEvent.press(screen.getByTestId('edit-profile-cancel'));
    expect(back).toHaveBeenCalledTimes(1);
  });

  it('stays open and does not dismiss when the save fails', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    updateProfile.mockRejectedValueOnce(new Error('write failed'));

    renderWithProviders(<EditProfileScreen />);

    fireEvent.press(screen.getByTestId('edit-profile-save'));

    await waitFor(() => expect(updateProfile).toHaveBeenCalled());
    // The whole point of the fix: a failed write is surfaced, not swallowed, and
    // the screen does NOT close as though it saved.
    expect(alert).toHaveBeenCalledWith('Could not save', expect.any(String));
    expect(back).not.toHaveBeenCalled();

    alert.mockRestore();
  });

  describe('handle field (removed)', () => {
    it('no longer renders a handle field or availability check', () => {
      renderWithProviders(<EditProfileScreen />);

      expect(screen.queryByTestId('edit-profile-handle-input')).toBeNull();
      expect(screen.queryByTestId('edit-profile-handle-status')).toBeNull();
      // The saved handle isn't prefilled anywhere either…
      expect(screen.queryByDisplayValue('ash')).toBeNull();
      // …and nothing probes availability now that there's nothing to claim.
      expect(isHandleAvailable).not.toHaveBeenCalled();
    });

    it('OMITS handle from the patch so saving never releases the account handle', async () => {
      renderWithProviders(<EditProfileScreen />);

      fireEvent.press(screen.getByTestId('edit-profile-save'));

      await waitFor(() => expect(updateProfile).toHaveBeenCalled());
      // `updateProfile` writes any key that is present, so a `handle: null` here
      // would drop the user's @handle on every profile save. The key must be
      // absent, not null.
      const patch = updateProfile.mock.calls[0][0];
      expect(patch).not.toHaveProperty('handle');
      expect(back).toHaveBeenCalled();
    });
  });
});
