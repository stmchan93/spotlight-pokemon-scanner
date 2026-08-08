import { render, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import { SpotlightThemeProvider, colors } from '@spotlight/design-system';

import { ProfileHeader } from '../../src/features/profile/components/profile-header';

function renderHeader(node: React.ReactElement) {
  return render(<SpotlightThemeProvider>{node}</SpotlightThemeProvider>);
}

describe('ProfileHeader', () => {
  it('renders the display name', () => {
    renderHeader(<ProfileHeader displayName="Ash Ketchum" initials="AK" />);

    expect(screen.getByText('Ash Ketchum')).toBeTruthy();
  });

  it('renders the Verified badge when isVerified is set', () => {
    renderHeader(<ProfileHeader displayName="Ash Ketchum" initials="AK" isVerified />);

    expect(screen.getByText('Verified')).toBeTruthy();
  });

  it('renders the bio text', () => {
    renderHeader(
      <ProfileHeader
        bio="Gotta collect them all."
        displayName="Ash Ketchum"
        initials="AK"
      />,
    );

    expect(screen.getByText('Gotta collect them all.')).toBeTruthy();
  });

  it('renders the three stat counts', () => {
    renderHeader(
      <ProfileHeader
        displayName="Ash Ketchum"
        followerCount={12}
        followingCount={34}
        initials="AK"
        reputation={56}
      />,
    );

    expect(screen.getByText('12')).toBeTruthy();
    expect(screen.getByText('34')).toBeTruthy();
    expect(screen.getByText('56')).toBeTruthy();
  });

  it('renders the initials when avatarUrl is absent', () => {
    renderHeader(<ProfileHeader displayName="Ash Ketchum" initials="AK" />);

    expect(screen.getByText('AK')).toBeTruthy();
  });

  it('falls back to a very light gray cover banner, not the tinted surface', () => {
    renderHeader(<ProfileHeader displayName="Ash Ketchum" initials="AK" />);

    const placeholder = screen.getByTestId('profile-header-cover-placeholder');
    expect(StyleSheet.flatten(placeholder.props.style).backgroundColor).toBe(colors.gray100);
  });

  it('renders the uploaded cover banner instead of the placeholder', () => {
    renderHeader(
      <ProfileHeader
        coverUrl="https://cdn.test/covers/user-1.jpg"
        displayName="Ash Ketchum"
        initials="AK"
      />,
    );

    const cover = screen.getByTestId('profile-header-cover');
    // Cropped to fill the banner band — a portrait photo must not letterbox.
    expect(cover.props.contentFit).toBe('cover');
    expect(cover.props.source).toEqual({ uri: 'https://cdn.test/covers/user-1.jpg' });
    expect(screen.queryByTestId('profile-header-cover-placeholder')).toBeNull();
  });
});
