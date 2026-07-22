import { render, screen } from '@testing-library/react-native';

import { Avatar, SpotlightThemeProvider } from '@spotlight/design-system';

function renderAvatar(node: React.ReactElement) {
  return render(<SpotlightThemeProvider>{node}</SpotlightThemeProvider>);
}

describe('Avatar', () => {
  it('renders the initials when no uri is provided', () => {
    renderAvatar(<Avatar initials="SC" testID="avatar" />);

    expect(screen.getByText('SC')).toBeTruthy();
  });

  it('renders an image element when a uri is provided', () => {
    renderAvatar(
      <Avatar initials="SC" testID="avatar" uri="https://example.com/me.png" />,
    );

    // The initials fall back away once an image source exists.
    expect(screen.queryByText('SC')).toBeNull();

    // expo-image is mocked as a View that spreads its props (see jest.setup.ts).
    const image = screen.getByTestId('avatar-image');
    expect(image).toBeTruthy();
    expect(image.props.source).toEqual({ uri: 'https://example.com/me.png' });
  });
});
