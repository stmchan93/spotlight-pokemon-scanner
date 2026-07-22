import { fireEvent, screen } from '@testing-library/react-native';
import { useRouter } from 'expo-router';

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

describe('EditProfileScreen', () => {
  const back = jest.fn();
  const updateProfile = jest.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    jest.clearAllMocks();

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
  });

  it('navigates back when Cancel is pressed', () => {
    renderWithProviders(<EditProfileScreen />);

    fireEvent.press(screen.getByTestId('edit-profile-cancel'));
    expect(back).toHaveBeenCalledTimes(1);
  });
});
